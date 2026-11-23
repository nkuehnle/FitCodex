//! Home body-composition scales: scale profiles, screenshots read with OCR, scans from any importer
//! (merged with what's there), open BIA estimates, and Bluetooth weigh-ins.
//!
//! Bluetooth: the Android plugin (`ScaleBlePlugin.kt`, Tauri plugin "scaleble") only scans, connects
//! and moves bytes. `scale_ble_pump`, called a few times a second by the UI, collects notifications,
//! runs them through `fitledger_core::scales::qn::QnSession` and writes its replies back, so the
//! protocol is plain, tested Rust. Every frame in and out is kept in a capture log that can be shared
//! and replayed (`scale_ble_replay`) when a scale needs a different setting.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::Instant;

use chrono::{Datelike, Local, TimeZone};
use fitledger_core::body::{InBodyScan, MergeOutcome, INBODY_FIELDS};
use fitledger_core::db::Db;
use fitledger_core::scales::bia::BiaEstimate;
use fitledger_core::scales::qn::{self, QnConfig, QnReading, QnSession};
use fitledger_core::scales::ScaleProfile;
use serde::Serialize;
use tauri::{Manager, State};

use crate::{with, AppState, CmdResult};

const TIME_FMT: &str = "%Y-%m-%d %H:%M:%S";
const LB: f64 = 0.453_592_37;

#[tauri::command]
pub fn scale_profiles(state: State<AppState>) -> CmdResult<Vec<ScaleProfile>> {
    with(&state, |db| db.scale_profiles())
}

#[tauri::command]
pub fn save_scale_profile(state: State<AppState>, json: String) -> CmdResult<ScaleProfile> {
    with(&state, |db| db.save_scale_profile(&json))
}

#[tauri::command]
pub fn delete_scale_profile(state: State<AppState>, id: String) -> CmdResult<()> {
    with(&state, |db| db.delete_scale_profile(&id))
}

/// The scans analyses use: every device's (see `Db::analysis_scans`).
#[tauri::command]
pub fn analysis_scans(state: State<AppState>) -> CmdResult<Vec<InBodyScan>> {
    with(&state, |db| db.analysis_scans())
}

#[derive(Serialize, Default)]
pub struct MergeSummary {
    inserted: usize,
    merged: usize,
    unchanged: usize,
}

/// Saves scans from an importer, merging each with a scan of the same weigh-in.
#[tauri::command]
pub fn merge_body_comp_scans(app: tauri::AppHandle, state: State<AppState>, scans: Vec<InBodyScan>) -> CmdResult<MergeSummary> {
    let out = with(&state, |db| {
        let mut out = MergeSummary::default();
        for s in &scans {
            match db.merge_body_comp_scan(s)?.0 {
                MergeOutcome::Inserted => out.inserted += 1,
                MergeOutcome::Merged => out.merged += 1,
                MergeOutcome::Unchanged => out.unchanged += 1,
            }
        }
        Ok(out)
    })?;
    crate::weigh_in_reminder_check(&app, &state)?;
    Ok(out)
}

// ---- Weigh-ins to check (shared scales) ------------------------------------------------------------

#[tauri::command]
pub fn pending_weigh_ins(state: State<AppState>) -> CmdResult<Vec<fitledger_core::pending::PendingWeighIn>> {
    with(&state, |db| db.pending_weigh_ins())
}

/// "That's me" (`mine`) saves the weigh-in; "Not me" drops it for good.
#[tauri::command]
pub fn resolve_pending_weigh_in(app: tauri::AppHandle, state: State<AppState>, id: i64, mine: bool) -> CmdResult<()> {
    with(&state, |db| db.resolve_pending_weigh_in(id, mine))?;
    crate::weigh_in_reminder_check(&app, &state)
}

/// Why a weigh-in might be someone else's (far from your recent weight), if it might.
#[tauri::command]
pub fn weigh_in_doubt(state: State<AppState>, at: String, weight_kg: f64) -> CmdResult<Option<String>> {
    with(&state, |db| db.weigh_in_doubt(&at, weight_kg))
}

struct Person {
    female: bool,
    age: Option<u8>,
    height_cm: Option<f64>,
}

fn person(db: &Db) -> fitledger_core::Result<Person> {
    let year = db.setting("birth_year")?.and_then(|y| y.parse::<i32>().ok());
    Ok(Person {
        female: db.setting("sex")?.as_deref() == Some("female"),
        age: year.map(|y| (Local::now().year() - y).clamp(1, 120) as u8),
        height_cm: db.setting("height_cm")?.and_then(|h| h.parse().ok()),
    })
}

/// Open (Sun 2003) estimate from a scan's raw impedance, with the profile's sex and height.
#[tauri::command]
pub fn bia_estimate(state: State<AppState>, values: BTreeMap<String, f64>) -> CmdResult<Option<BiaEstimate>> {
    with(&state, |db| {
        let p = person(db)?;
        Ok(p.height_cm.and_then(|h| fitledger_core::scales::bia::estimate(&values, h, p.female)))
    })
}

#[derive(Serialize)]
pub struct ScreenshotRead {
    measured_at: Option<String>,
    /// Field -> value in storage units (kg).
    values: BTreeMap<String, f64>,
    /// Fields worth a look: masses whose unit wasn't printed (the display unit was assumed).
    doubtful: Vec<String>,
    /// Every line of text read, for checking and for writing profile labels.
    text: Vec<String>,
}

/// Reads a vendor-app screenshot (base64) with the labels of a scale profile. The first read
/// downloads the OCR models (12 MB).
#[tauri::command]
pub async fn read_body_comp_screenshot(app: tauri::AppHandle, state: State<'_, AppState>, data: String, profile: String, mass_unit: String) -> CmdResult<ScreenshotRead> {
    use base64::Engine;
    let profile = with(&state, |db| db.scale_profile(&profile))?;
    let specs: Vec<fitledger_ocr::labels::LabelSpec> = profile
        .labels
        .iter()
        .filter_map(|(field, labels)| {
            let kind = INBODY_FIELDS.iter().find(|f| f.0 == field)?.2;
            Some(fitledger_ocr::labels::LabelSpec { field: field.clone(), kind: kind.into(), labels: labels.clone() })
        })
        .collect();
    if specs.is_empty() {
        return Err(format!("the {} profile has no labels to look for", profile.name));
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("ocr-models");
    let r = tauri::async_runtime::spawn_blocking(move || {
        fitledger_ocr::ensure_models(&dir)?;
        fitledger_ocr::labels::read_labeled(&bytes, &dir, &specs)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    let mut doubtful = Vec::new();
    let values = r
        .values
        .into_iter()
        .map(|(k, v)| {
            let kind = INBODY_FIELDS.iter().find(|f| f.0 == k).map(|f| f.2).unwrap_or("");
            if kind != "kg" {
                return (k, v);
            }
            let unit = r.units.get(&k).map(String::as_str).unwrap_or_else(|| {
                doubtful.push(k.clone());
                mass_unit.as_str()
            });
            let kg = if unit == "lb" { v * LB } else { v };
            (k, (kg * 1000.0).round() / 1000.0)
        })
        .collect();
    Ok(ScreenshotRead { measured_at: r.measured_at, values, doubtful, text: r.text })
}

// ---- Bluetooth --------------------------------------------------------------------------------

struct BleSession {
    qn: QnSession,
    profile: ScaleProfile,
    log: Vec<String>,
    last_rx: Instant,
    idle_done: bool,
}

/// The current or last session, and what the last scan saw (the start of the capture log).
#[derive(Default)]
pub struct ScaleBle(Mutex<Option<BleSession>>, Mutex<Vec<String>>);

#[cfg(target_os = "android")]
pub struct ScaleBleHandle(pub tauri::plugin::PluginHandle<tauri::Wry>);

/// Its own Tauri plugin name: Android keys native plugins by it.
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("scaleble")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle = _api.register_android_plugin("io.github.njk639.fitledger", "ScaleBlePlugin")?;
                _app.manage(ScaleBleHandle(handle));
            }
            _app.manage(ScaleBle::default());
            Ok(())
        })
        .build()
}

async fn ble_call(app: &tauri::AppHandle, method: &'static str, args: serde_json::Value) -> CmdResult<serde_json::Value> {
    #[cfg(target_os = "android")]
    {
        let app = app.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            let h = app.try_state::<ScaleBleHandle>().ok_or("Bluetooth isn't set up")?;
            h.0.run_mobile_plugin::<serde_json::Value>(method, args).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, method, args);
        Err("Bluetooth scales work in the Android app".into())
    }
}

/// Setting with this phone's user number on a scale (`<key><profile id>`): each person in a
/// household uses their own number, so the scale keeps their weigh-ins apart.
const SLOT_KEY: &str = "scale_slot.";

fn session_for(db: &Db, profile: &str, unit_lb: bool) -> fitledger_core::Result<(QnSession, ScaleProfile)> {
    let profile = db.scale_profile(profile)?;
    let mut bluetooth = profile
        .bluetooth
        .clone()
        .ok_or_else(|| fitledger_core::Error::Format(format!("the {} profile has no Bluetooth settings", profile.name)))?;
    if let Some(slot) = db.setting(&format!("{SLOT_KEY}{}", profile.id))?.and_then(|s| s.parse::<u8>().ok()).filter(|s| (1..=8).contains(s)) {
        bluetooth.slot = slot;
    }
    let p = person(db)?;
    let (Some(age), Some(height_cm)) = (p.age, p.height_cm) else {
        return Err(fitledger_core::Error::Format("set your sex, height and birth year under Body → Body comp first: the scale needs them".into()));
    };
    Ok((QnSession::new(QnConfig { bluetooth, unit_lb, female: p.female, age, height_cm }), profile))
}

/// Finds scales nearby for a profile: { devices: [...], others: [...] } (see the Android plugin),
/// keeping what it saw for the capture log. With `address` (a remembered scale) it ends as soon as
/// that one is seen.
#[tauri::command]
pub async fn scale_ble_scan(app: tauri::AppHandle, state: State<'_, AppState>, ble: State<'_, ScaleBle>, profile: String, address: Option<String>) -> CmdResult<serde_json::Value> {
    let names = with(&state, |db| db.scale_profile(&profile))?.bluetooth.map(|b| b.names).unwrap_or_default();
    let r = ble_call(&app, "scan", serde_json::json!({ "names": names, "timeoutMs": 10000, "address": address.unwrap_or_default() })).await;
    let mut log = vec![format!("# FitCodex scale scan: profile {profile}, {}", Local::now().format(TIME_FMT))];
    match &r {
        Ok(v) => {
            for (kind, key) in [("scale", "devices"), ("other", "others")] {
                for d in v[key].as_array().into_iter().flatten() {
                    log.push(format!(
                        "# {kind}: {} \"{}\" rssi {} services [{}] manufacturer [{}]",
                        d["address"].as_str().unwrap_or(""),
                        d["name"].as_str().unwrap_or(""),
                        d["rssi"],
                        d["services"].as_str().unwrap_or(""),
                        d["manufacturer"].as_str().unwrap_or("")
                    ));
                }
            }
            if log.len() == 1 {
                log.push("# nothing found nearby".into());
            }
        }
        Err(e) => log.push(format!("# scan failed: {e}")),
    }
    *ble.1.lock().map_err(|e| e.to_string())? = log;
    r
}

#[tauri::command]
pub async fn scale_ble_connect(app: tauri::AppHandle, state: State<'_, AppState>, ble: State<'_, ScaleBle>, profile: String, address: String, mass_unit: String) -> CmdResult<()> {
    let (qn, profile) = with(&state, |db| session_for(db, &profile, mass_unit == "lb"))?;
    let bt = &qn.config().bluetooth;
    let head = format!("# FitCodex scale capture: profile {}, {}, {address}, user {} key {}", profile.id, Local::now().format(TIME_FMT), bt.slot, bt.user_key);
    *ble.0.lock().map_err(|e| e.to_string())? = Some(BleSession {
        qn,
        log: vec![head],
        profile,
        last_rx: Instant::now(),
        idle_done: false,
    });
    ble_call(&app, "connect", serde_json::json!({ "address": address })).await.map(|_| ())
}

#[derive(Serialize, Default)]
pub struct PumpResult {
    /// idle | connecting | ready | closed
    state: String,
    error: Option<String>,
    live_weight_kg: Option<f64>,
    stable: bool,
    /// A finished weigh-in, as a scan ready to save.
    readings: Vec<InBodyScan>,
    /// Weigh-ins the scale kept from before (replay only: a live session holds them for checking).
    stored: Vec<InBodyScan>,
    /// Weigh-ins the scale kept from before, now waiting to be checked (see `pending_weigh_ins`).
    held: usize,
    notes: Vec<String>,
}

fn local_time(unix: Option<i64>) -> String {
    let t = unix.and_then(|u| Local.timestamp_opt(u, 0).single()).unwrap_or_else(Local::now);
    t.naive_local().format(TIME_FMT).to_string()
}

fn to_scan(r: &QnReading, profile: &ScaleProfile) -> InBodyScan {
    InBodyScan {
        id: None,
        measured_at_local: local_time(r.recorded_unix),
        values: r.values(),
        device: Some(profile.name.clone()),
        notes: r.adjusted.as_ref().map(|a| format!("Scale-corrected impedance (Ω, LA/RA/LL/RL/trunk at 20 and 100 kHz): {}", a.iter().map(|v| format!("{v}")).collect::<Vec<_>>().join(" "))),
        source: Some(profile.id.clone()),
    }
}

/// Feeds every frame received since the last call through the session and sends its replies.
#[tauri::command]
pub async fn scale_ble_pump(app: tauri::AppHandle, state: State<'_, AppState>, ble: State<'_, ScaleBle>) -> CmdResult<PumpResult> {
    let polled = ble_call(&app, "poll", serde_json::json!({})).await?;
    let mut out = PumpResult {
        state: polled["state"].as_str().unwrap_or("idle").to_string(),
        error: polled["error"].as_str().map(String::from),
        ..Default::default()
    };
    let now = Local::now().timestamp();
    let writes = {
        let mut guard = ble.0.lock().map_err(|e| e.to_string())?;
        let Some(s) = guard.as_mut() else { return Ok(out) };
        let seen = format!("# state: {}{}", out.state, out.error.as_deref().map(|e| format!(", {e}")).unwrap_or_default());
        if s.log.iter().rev().find(|l| l.starts_with("# state: ")) != Some(&seen) {
            s.log.push(seen);
        }
        let mut writes = Vec::new();
        let mut steps = Vec::new();
        for line in polled["notifications"].as_array().into_iter().flatten().filter_map(|l| l.as_str()) {
            s.log.push(line.to_string());
            // "<ms> < hex" is from the scale, "<ms> > hex" what was written.
            let Some((_, rest)) = line.split_once(' ') else { continue };
            let Some(hex) = rest.strip_prefix("< ") else { continue };
            if let Some(bytes) = qn::parse_hex(hex) {
                s.last_rx = Instant::now();
                s.idle_done = false;
                steps.push(s.qn.on_notification(&bytes, now));
            }
        }
        if out.state == "ready" && !s.idle_done && s.last_rx.elapsed().as_millis() > 1200 {
            s.idle_done = true;
            steps.push(s.qn.on_idle());
        }
        for st in steps {
            writes.extend(st.writes.iter().map(|w| qn::hex(w)));
            if st.live_weight_kg.is_some() {
                out.live_weight_kg = st.live_weight_kg;
                out.stable = st.stable;
            }
            out.readings.extend(st.readings.iter().map(|r| to_scan(r, &s.profile)));
            // Weigh-ins the scale kept while no phone was connected may be anyone's who used it:
            // they wait for "That's me" or "Not me".
            for r in &st.stored {
                let scan = to_scan(r, &s.profile);
                let when = scan.measured_at_local.clone();
                let user = r.slot.map(|n| format!(" (user {n} on the scale)")).unwrap_or_default();
                with(&state, |db| {
                    let doubt = db.weigh_in_doubt(&when, r.weight_kg)?.map(|d| format!("; {d}")).unwrap_or_default();
                    db.hold_weigh_in(&scan, &format!("Kept on the scale while no phone was connected{user}{doubt}: is this you?"))
                })?;
                out.held += 1;
            }
            for n in st.notes {
                s.log.push(format!("# {n}"));
                out.notes.push(n);
            }
        }
        writes
    };
    if !writes.is_empty() {
        ble_call(&app, "write", serde_json::json!({ "frames": writes })).await?;
    }
    Ok(out)
}

#[tauri::command]
pub async fn scale_ble_disconnect(app: tauri::AppHandle) -> CmdResult<()> {
    ble_call(&app, "disconnect", serde_json::json!({})).await.map(|_| ())
}

/// The capture log of the current or last session (every frame in and out, with times).
#[tauri::command]
pub fn scale_ble_log(ble: State<ScaleBle>) -> CmdResult<String> {
    let mut log = ble.1.lock().map_err(|e| e.to_string())?.clone();
    log.extend(ble.0.lock().map_err(|e| e.to_string())?.iter().flat_map(|s| s.log.iter().cloned()));
    Ok(log.join("\n"))
}

/// Replays a capture log (or plain hex frames, one per line) through a profile's decoder, on any
/// platform: what would have been measured.
#[tauri::command]
pub fn scale_ble_replay(state: State<AppState>, profile: String, log: String, mass_unit: String) -> CmdResult<PumpResult> {
    let (mut qn, profile) = with(&state, |db| session_for(db, &profile, mass_unit == "lb"))?;
    Ok(replay(&mut qn, &profile, &log))
}

fn replay(qn: &mut QnSession, profile: &ScaleProfile, log: &str) -> PumpResult {
    let mut out = PumpResult { state: "closed".into(), ..Default::default() };
    let now = Local::now().timestamp();
    for line in log.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
        // Capture lines are "<ms> < hex"; writes ("<ms> > hex") are skipped; bare hex is a frame.
        let hex = match line.split_once(' ') {
            Some((_, rest)) if rest.starts_with("> ") => continue,
            Some((_, rest)) if rest.starts_with("< ") => &rest[2..],
            _ => line,
        };
        let Some(bytes) = qn::parse_hex(hex) else { continue };
        let st = qn.on_notification(&bytes, now);
        out.readings.extend(st.readings.iter().map(|r| to_scan(r, profile)));
        out.stored.extend(st.stored.iter().map(|r| to_scan(r, profile)));
        out.notes.extend(st.notes);
    }
    out.readings.extend(qn.on_idle().readings.iter().map(|r| to_scan(r, profile)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_reads_a_capture_log() {
        let mut db = Db::open_in_memory().unwrap();
        db.set_setting("sex", "male").unwrap();
        db.set_setting("birth_year", "1991").unwrap();
        db.set_setting("height_cm", "180").unwrap();
        let (mut qn, profile) = session_for(&db, "arboleaf", false).unwrap();
        // A classic 4-electrode weigh-in, with the writes the log would also hold.
        let f = |b: &[u8]| qn::hex(&qn::with_checksum(b.to_vec()));
        let log = format!(
            "# capture\n10 < {}\n12 > {}\n20 < {}\n{}\n",
            f(&[0x12, 0x11, 0x02, 1, 2, 3, 4, 5, 6, 0, 0x01, 0, 0, 0, 0, 0]),
            f(&[0x13, 0x09, 0x02, 0x01, 0x10, 0, 0, 0]),
            f(&[0x10, 0x0b, 0x02, 0x1f, 0x40, 0x01, 0, 0, 0, 0]),
            f(&[0x10, 0x0b, 0x02, 0x1f, 0x40, 0x01, 0x01, 0xf6, 0x01, 0xf4]),
        );
        let r = replay(&mut qn, &profile, &log);
        assert_eq!(r.readings.len(), 1);
        let s = &r.readings[0];
        assert_eq!((s.source.as_deref(), s.values["weight_kg"], s.values["impedance_ohm"]), (Some("arboleaf"), 80.0, 502.0));
        db.merge_body_comp_scan(s).unwrap();
        assert_eq!(db.weigh_ins(false).unwrap()[0].source, "arboleaf");
    }

    #[test]
    fn each_phone_uses_its_own_user_number() {
        let db = Db::open_in_memory().unwrap();
        db.set_setting("sex", "male").unwrap();
        db.set_setting("birth_year", "1991").unwrap();
        db.set_setting("height_cm", "180").unwrap();
        assert_eq!(session_for(&db, "arboleaf", false).unwrap().0.profile_frame()[3], 1);
        db.set_setting("scale_slot.arboleaf", "3").unwrap();
        let (qn, _) = session_for(&db, "arboleaf", false).unwrap();
        // Profile frame and start frame (stored weigh-ins for unassigned + user 3) use it.
        assert_eq!(qn.profile_frame()[3], 3);
        assert_eq!(qn.start_frame()[4], 0b1001);
    }

    #[test]
    fn bluetooth_needs_the_profile_of_the_person() {
        let db = Db::open_in_memory().unwrap();
        assert!(session_for(&db, "arboleaf", false).is_err());
        assert!(session_for(&db, "inbody", false).is_err(), "no Bluetooth settings");
    }
}
