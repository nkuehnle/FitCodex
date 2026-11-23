//! The Qingniu ("QN-Scale", Yolanda) Bluetooth protocol used by Arboleaf and many other
//! body-composition scales, as a pure state machine: feed it each notification from the scale and it
//! says what to write back and what it measured. The Android side only moves bytes.
//!
//! Byte layouts follow the reverse-engineering documented by the ble-scale-sync project
//! (github.com/KristianP26/ble-scale-sync, `src/scales/qn-scale`), openScale's QNHandler and
//! Qingniu's published SDK notes; this is an independent implementation, and the test frames are
//! built here from those layouts rather than taken from anyone's captures.
//!
//! Frames end in a checksum (sum of the preceding bytes, mod 256); `[1]` is usually the length.
//!
//! Handshake (notification -> reply):
//! - `0x12` scale info (`[2]` protocol byte echoed in later commands) -> `0x13` config (unit)
//! - `0x14` ready (`[3]` bit 0: muscle and bone come as % of weight) -> `0x20` time (seconds since
//!   2000-01-01 UTC, LE) and an `0xA2` age frame
//! - `0x21` asks for the user -> `0xA0 0x0D 0x02` profile (slot, user key, sex, age, height in mm,
//!   algorithm) and `0x22` start / stored-data query for the slot
//!
//! Measurements:
//! - Classic `0x10`: weight BE `[3..5]`, stable `[5]`, two whole-body resistances `[6..10]`.
//! - 8-electrode `0x10`, 20 bytes `10 14 ..`: `[3]` status (0 measuring, 1 stable, 2 result), weight
//!   BE `[5..7]` / 100. A result is three parts (`[4]` = 0x31, 0x32, 0x33) carrying ten channels in
//!   0.1 Ω (left/right hand, left/right foot, trunk; each at 20 and 100 kHz) as measured and as the
//!   scale corrected them, its body fat and heart rate; then `0x15` and `0x16` with its own results.
//! - Stored weigh-ins (taken while no phone was connected): three `0x23` parts, `0x24`, `0x25`.
//! - Extended dialect: one `0xB1` record (114 bytes, LE values), possibly split into parts.

use std::collections::BTreeMap;

use serde::Serialize;

use super::BluetoothConfig;

/// Seconds from 1970-01-01 to 2000-01-01 (the scale's epoch), UTC.
const EPOCH_2000: i64 = 946_684_800;
const CHANNELS: usize = 10;
/// Fields for the ten channels, in the scale's order.
const CHANNEL_FIELDS: [&str; CHANNELS] = [
    "imp_left_arm_20k_ohm",
    "imp_left_arm_100k_ohm",
    "imp_right_arm_20k_ohm",
    "imp_right_arm_100k_ohm",
    "imp_left_leg_20k_ohm",
    "imp_left_leg_100k_ohm",
    "imp_right_leg_20k_ohm",
    "imp_right_leg_100k_ohm",
    "imp_trunk_20k_ohm",
    "imp_trunk_100k_ohm",
];

/// Who is weighing in (the scale computes its own results from these) and how to talk to it.
#[derive(Debug, Clone)]
pub struct QnConfig {
    pub bluetooth: BluetoothConfig,
    pub unit_lb: bool,
    pub female: bool,
    pub age: u8,
    pub height_cm: f64,
}

/// The scale's own results.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct QnComposition {
    pub bmi: f64,
    pub water_pct: f64,
    /// Raw muscle and bone: % of weight × 10 when `percent`, else kg × 100.
    pub muscle_raw: u16,
    pub bone_raw: u16,
    pub percent: bool,
    pub visceral: u8,
    pub body_age: u8,
    pub bmr: u16,
    pub protein_pct: f64,
    pub lean_pct: f64,
    pub subcutaneous_pct: f64,
    pub skeletal_muscle_pct: f64,
    pub score: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct QnReading {
    /// When the scale stamped it (stored weigh-ins), Unix seconds UTC; live ones are "now".
    pub recorded_unix: Option<i64>,
    pub slot: Option<u8>,
    pub weight_kg: f64,
    pub fat_pct: Option<f64>,
    pub heart_rate: Option<u8>,
    /// Ten channels as measured, Ω, in the scale's order (see `CHANNEL_FIELDS`).
    pub channels: Option<Vec<f64>>,
    /// The same, as the scale corrected them.
    pub adjusted: Option<Vec<f64>>,
    /// Whole-body resistances of 4-electrode scales, Ω.
    pub resistance: Vec<f64>,
    pub composition: Option<QnComposition>,
}

fn r2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

impl QnReading {
    /// As body-composition fields (`INBODY_FIELDS` columns); masses in kg.
    pub fn values(&self) -> BTreeMap<String, f64> {
        let mut v = BTreeMap::new();
        let mut put = |k: &str, x: f64| {
            if x.is_finite() && x > 0.0 {
                v.insert(k.to_string(), r2(x));
            }
        };
        let w = self.weight_kg;
        put("weight_kg", w);
        if let Some(f) = self.fat_pct.filter(|f| *f > 0.0) {
            put("pbf", f);
            put("body_fat_mass_kg", w * f / 100.0);
        }
        if let Some(hr) = self.heart_rate {
            put("heart_rate_bpm", hr as f64);
        }
        if let Some(ch) = &self.channels {
            for (f, x) in CHANNEL_FIELDS.iter().zip(ch) {
                put(f, *x);
            }
        }
        if let Some(r) = self.resistance.iter().find(|r| **r > 0.0) {
            put("impedance_ohm", *r);
        }
        if let Some(c) = &self.composition {
            let mass = |raw: u16| if c.percent { w * raw as f64 / 1000.0 } else { raw as f64 / 100.0 };
            put("bmi", c.bmi);
            put("body_water_pct", c.water_pct);
            put("muscle_mass_kg", mass(c.muscle_raw));
            put("bone_mass_kg", mass(c.bone_raw));
            put("visceral_fat_level", c.visceral as f64);
            put("metabolic_age", c.body_age as f64);
            put("bmr_kcal", c.bmr as f64);
            put("protein_pct", c.protein_pct);
            put("subcutaneous_fat_pct", c.subcutaneous_pct);
            put("skeletal_muscle_pct", c.skeletal_muscle_pct);
            put("smm_kg", w * c.skeletal_muscle_pct / 100.0);
            if c.lean_pct > 0.0 {
                put("fat_free_mass_kg", w * c.lean_pct / 100.0);
            }
        }
        if let (None, Some(f)) = (v.get("fat_free_mass_kg"), v.get("body_fat_mass_kg").copied()) {
            v.insert("fat_free_mass_kg".into(), r2(w - f));
        }
        v
    }
}

/// What to do after a notification.
#[derive(Debug, Clone, Default, Serialize)]
pub struct QnStep {
    /// Frames to write to the scale, in order.
    pub writes: Vec<Vec<u8>>,
    /// The weight on the display, while measuring.
    pub live_weight_kg: Option<f64>,
    pub stable: bool,
    /// A finished weigh-in.
    pub readings: Vec<QnReading>,
    /// Weigh-ins the scale kept from earlier.
    pub stored: Vec<QnReading>,
    /// Things worth telling the user or logging.
    pub notes: Vec<String>,
}

pub fn with_checksum(mut body: Vec<u8>) -> Vec<u8> {
    let sum = body.iter().fold(0u8, |a, b| a.wrapping_add(*b));
    body.push(sum);
    body
}

pub fn checksum_ok(d: &[u8]) -> bool {
    d.len() >= 2 && d[..d.len() - 1].iter().fold(0u8, |a, b| a.wrapping_add(*b)) == d[d.len() - 1]
}

fn be(d: &[u8], at: usize) -> u16 {
    u16::from_be_bytes([d[at], d[at + 1]])
}
fn le(d: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([d[at], d[at + 1]])
}

fn swap_bits(b: u8, i: u8, j: u8) -> u8 {
    if (b >> i) & 1 == (b >> j) & 1 { b } else { b ^ ((1 << i) | (1 << j)) }
}

/// Undoes the byte scrambling some firmware applies to resistances (each byte: bits 3↔5, 0↔4).
pub fn unscramble(raw: u16) -> u16 {
    let f = |b: u8| swap_bits(swap_bits(b, 3, 5), 0, 4);
    let [hi, lo] = raw.to_be_bytes();
    u16::from_be_bytes([f(hi), f(lo)])
}

/// Ten raw channels (0.1 Ω) to Ω, unscrambled when configured, or when `None` and only the
/// unscrambled values are body-like (limbs 50–1500 Ω, trunk 5–300 Ω).
fn channels_ohm(raw: &[u16], scrambled: Option<bool>) -> Vec<f64> {
    let plausible = |v: &[u16]| {
        v.iter().enumerate().all(|(i, &r)| {
            let ohm = r as f64 / 10.0;
            if i >= 8 { (5.0..=300.0).contains(&ohm) } else { (50.0..=1500.0).contains(&ohm) }
        })
    };
    let un: Vec<u16> = raw.iter().map(|r| unscramble(*r)).collect();
    let use_un = match scrambled {
        Some(s) => s,
        None => !plausible(raw) && plausible(&un),
    };
    (if use_un { &un } else { raw }).iter().map(|r| *r as f64 / 10.0).collect()
}

/// The scale's own results from the `0x15`/`0x16` pair (or `0x24`/`0x25`): values from `[3]`.
fn composition(c: &[u8], d: &[u8], percent: bool) -> Option<QnComposition> {
    if c.len() < 15 || d.len() < 15 {
        return None;
    }
    Some(QnComposition {
        bmi: be(c, 3) as f64 / 10.0,
        water_pct: be(c, 5) as f64 / 10.0,
        muscle_raw: be(c, 7),
        visceral: c[9],
        body_age: c[10],
        bmr: be(c, 11),
        protein_pct: be(c, 13) as f64 / 10.0,
        bone_raw: be(d, 4),
        lean_pct: be(d, 6) as f64 / 10.0,
        subcutaneous_pct: be(d, 8) as f64 / 10.0,
        skeletal_muscle_pct: be(d, 10) as f64 / 10.0,
        score: be(d, 12) as f64 / 10.0,
        percent,
    })
}

pub struct QnSession {
    cfg: QnConfig,
    protocol: u8,
    divisor: f64,
    percent: bool,
    ready: bool,
    profile_sent: bool,
    live_done: bool,
    parts: Vec<Vec<u8>>,
    result: Option<QnReading>,
    c15: Option<Vec<u8>>,
    stored: Vec<Vec<u8>>,
    b1_parts: Vec<Vec<u8>>,
}

impl QnSession {
    pub fn new(cfg: QnConfig) -> Self {
        Self {
            cfg,
            protocol: 0xff,
            divisor: 100.0,
            percent: true,
            ready: false,
            profile_sent: false,
            live_done: false,
            parts: Vec::new(),
            result: None,
            c15: None,
            stored: Vec::new(),
            b1_parts: Vec::new(),
        }
    }

    fn unit_flag(&self) -> u8 {
        if self.cfg.unit_lb { 0x02 } else { 0x01 }
    }

    pub fn config_frame(&self) -> Vec<u8> {
        with_checksum(vec![0x13, 0x09, self.protocol, self.unit_flag(), 0x10, 0x00, 0x00, 0x00])
    }

    pub fn time_frame(&self, now_unix: i64) -> Vec<u8> {
        let s = (now_unix - EPOCH_2000).max(0) as u32;
        let mut f = vec![0x20, 0x08, self.protocol];
        f.extend(s.to_le_bytes());
        with_checksum(f)
    }

    pub fn profile_frame(&self) -> Vec<u8> {
        let bt = &self.cfg.bluetooth;
        let mm = (self.cfg.height_cm * 10.0).round().clamp(0.0, 65535.0) as u16;
        let [k1, k2] = bt.user_key.to_be_bytes();
        let [h1, h2] = mm.to_be_bytes();
        with_checksum(vec![0xa0, 0x0d, 0x02, bt.slot, k1, k2, self.cfg.female as u8, self.cfg.age.max(1), h1, h2, bt.algorithm, 0x02])
    }

    pub fn start_frame(&self) -> Vec<u8> {
        let mask: u16 = 1 | (1 << self.cfg.bluetooth.slot.min(15));
        let [m1, m2] = mask.to_be_bytes();
        with_checksum(vec![0x22, 0x06, self.protocol, m1, m2])
    }

    fn ack_frame(&self) -> Vec<u8> {
        with_checksum(vec![0x1f, 0x05, self.protocol, 0x10])
    }

    /// Call when the scale has been quiet for a second or so: sends the user profile and start if
    /// the scale never asked for them, and finishes a result block that came without its own results.
    pub fn on_idle(&mut self) -> QnStep {
        let mut step = QnStep::default();
        if self.ready && !self.profile_sent {
            self.send_profile(&mut step);
        }
        if let Some(r) = self.result.take() {
            step.readings.push(r);
            self.live_done = true;
        }
        step
    }

    fn send_profile(&mut self, step: &mut QnStep) {
        step.writes.push(self.profile_frame());
        step.writes.push(self.start_frame());
        self.profile_sent = true;
    }

    pub fn on_notification(&mut self, d: &[u8], now_unix: i64) -> QnStep {
        let mut step = QnStep::default();
        if d.is_empty() {
            return step;
        }
        let op = d[0];
        // The info frame is answered even with an odd checksum (some firmware pads it).
        if op != 0x12 && !checksum_ok(d) {
            step.notes.push(format!("ignored frame with a bad checksum: {}", hex(d)));
            return step;
        }
        match op {
            0x12 => {
                if d.len() > 2 {
                    self.protocol = d[2];
                }
                if d.len() > 10 && d.len() < 18 {
                    self.divisor = if d[10] & 0x01 != 0 { 100.0 } else { 10.0 };
                }
                step.writes.push(self.config_frame());
            }
            0x14 => {
                self.ready = true;
                if d.len() > 4 {
                    self.percent = d[3] & 0x01 != 0;
                }
                step.writes.push(self.time_frame(now_unix));
                step.writes.push(with_checksum(vec![0xa2, 0x06, 0x01, 0x32, self.cfg.age.max(1)]));
            }
            0x21 if !self.profile_sent => self.send_profile(&mut step),
            0xa1 if d.len() >= 5 && d[2] == 0x02 => {
                if d[4] == 0 {
                    step.notes.push(format!(
                        "the scale refused the user profile (user key {}); if no weight comes through, try another user_key (e.g. 1000) in the scale profile",
                        self.cfg.bluetooth.user_key
                    ));
                }
            }
            0x10 if d.len() == 20 && d[1] == 0x14 => self.eight_frame(d, &mut step),
            0x10 if d.len() >= 10 => self.classic_frame(d, &mut step),
            0x15 if d.len() == 16 => self.c15 = Some(d.to_vec()),
            0x16 if d.len() == 16 => {
                let c15 = self.c15.take();
                if let Some(mut r) = self.result.take() {
                    r.composition = c15.and_then(|c| composition(&c, d, self.percent));
                    step.readings.push(r);
                    self.live_done = true;
                    if self.cfg.bluetooth.result_ack {
                        step.writes.push(self.ack_frame());
                    }
                }
            }
            0x23 | 0x24 | 0x25 => self.stored_frame(d, &mut step),
            0xb1 => self.b1_frame(d, &mut step),
            _ => {}
        }
        step
    }

    fn classic_frame(&mut self, d: &[u8], step: &mut QnStep) {
        // ES-30M style carries its length and a user slot: weight [5..7], resistances [7..11].
        let (w_at, stable, r_at) = if d[1] as usize == d.len() && (14..=15).contains(&d.len()) { (5, d[4] == 2, 7) } else { (3, d[5] == 1, 6) };
        let kg = be(d, w_at) as f64 / self.divisor;
        step.live_weight_kg = Some(kg);
        step.stable = stable;
        if !stable || self.live_done || kg < 5.0 {
            return;
        }
        let resistance: Vec<f64> = [be(d, r_at), be(d, r_at + 2)].into_iter().filter(|r| *r > 0).map(f64::from).collect();
        if resistance.is_empty() {
            // Stable weight first; impedance follows on a later frame.
            return;
        }
        self.live_done = true;
        step.readings.push(QnReading { weight_kg: kg, resistance, ..Default::default() });
        step.writes.push(self.ack_frame());
    }

    fn eight_frame(&mut self, d: &[u8], step: &mut QnStep) {
        let part = d[4];
        if d[3] == 0x02 && part == 0x31 {
            self.parts = vec![d.to_vec()];
            return;
        }
        if !self.parts.is_empty() && (part == 0x32 || part == 0x33) && self.parts.len() == (part - 0x31) as usize {
            self.parts.push(d.to_vec());
            if self.parts.len() == 3 {
                let (p1, p2, p3) = (&self.parts[0], &self.parts[1], &self.parts[2]);
                let ch = |f: &[u8], at: &[usize]| at.iter().map(|&i| be(f, i)).collect::<Vec<_>>();
                let original: Vec<u16> = [ch(p1, &[7, 9, 11, 13, 15, 17]), ch(p2, &[2, 5, 7, 9])].concat();
                let adjusted: Vec<u16> = [ch(p2, &[11, 13, 15, 17]), ch(p3, &[2, 5, 7, 9, 11, 13])].concat();
                let weight_kg = be(p1, 5) as f64 / 100.0;
                let fat = be(p3, 15) as f64 / 10.0;
                self.result = (weight_kg > 0.0).then(|| QnReading {
                    slot: Some(p1[2]),
                    weight_kg,
                    fat_pct: (fat > 0.0).then_some(fat),
                    heart_rate: (p3[17] > 0).then_some(p3[17]),
                    channels: original.iter().any(|c| *c > 0).then(|| channels_ohm(&original, self.cfg.bluetooth.scrambled)),
                    adjusted: adjusted.iter().any(|c| *c > 0).then(|| channels_ohm(&adjusted, self.cfg.bluetooth.scrambled)),
                    ..Default::default()
                });
                self.parts.clear();
            }
            return;
        }
        if self.live_done {
            return;
        }
        step.live_weight_kg = Some(be(d, 5) as f64 / 100.0);
        step.stable = d[3] == 0x01;
    }

    fn stored_frame(&mut self, d: &[u8], step: &mut QnStep) {
        if !self.cfg.bluetooth.stored_records {
            return;
        }
        match d[0] {
            0x23 if d.len() == 20 && d[4] == 0x31 => self.stored = vec![d.to_vec()],
            0x23 if d.len() == 20 && (d[4] == 0x32 || d[4] == 0x33) && self.stored.len() == (d[4] - 0x31) as usize => self.stored.push(d.to_vec()),
            0x24 if d.len() == 19 && self.stored.len() == 3 => self.stored.push(d.to_vec()),
            0x25 if d.len() >= 16 && self.stored.len() == 4 => {
                let (s1, s2, s3, s24) = (&self.stored[0], &self.stored[1], &self.stored[2], &self.stored[3]);
                let ch = |f: &[u8], at: &[usize]| at.iter().map(|&i| be(f, i)).collect::<Vec<_>>();
                let original: Vec<u16> = [ch(s1, &[11, 13, 15, 17]), ch(s2, &[1, 5, 7, 9, 11, 13])].concat();
                let adjusted: Vec<u16> = [ch(s2, &[15, 17]), ch(s3, &[1, 5, 7, 9, 11, 13, 15, 17])].concat();
                let secs = u32::from_le_bytes([s1[5], s1[6], s1[7], s1[8]]) as i64;
                let weight_kg = be(s1, 9) as f64 / 100.0;
                let fat = be(s24, 15) as f64 / 10.0;
                if weight_kg > 0.0 {
                    step.stored.push(QnReading {
                        recorded_unix: Some(EPOCH_2000 + secs),
                        slot: Some(s1[1]),
                        weight_kg,
                        fat_pct: (fat > 0.0).then_some(fat),
                        heart_rate: (s24[17] > 0).then_some(s24[17]),
                        channels: original.iter().any(|c| *c > 0).then(|| channels_ohm(&original, self.cfg.bluetooth.scrambled)),
                        adjusted: adjusted.iter().any(|c| *c > 0).then(|| channels_ohm(&adjusted, self.cfg.bluetooth.scrambled)),
                        resistance: Vec::new(),
                        composition: composition(s24, d, self.percent),
                    });
                }
                self.stored.clear();
            }
            _ => {}
        }
    }

    fn b1_frame(&mut self, d: &[u8], step: &mut QnStep) {
        if d.len() < 6 || d[1] as usize != d.len() {
            return;
        }
        let (count, index) = (d[2], d[3]);
        if index == 1 {
            self.b1_parts.clear();
        }
        if index as usize != self.b1_parts.len() + 1 {
            return;
        }
        self.b1_parts.push(d[4..d.len() - 1].to_vec());
        if self.b1_parts.len() < count as usize {
            return;
        }
        let rec: Vec<u8> = self.b1_parts.concat();
        self.b1_parts.clear();
        if rec.len() < 71 {
            step.notes.push(format!("extended result too short ({} bytes)", rec.len()));
            return;
        }
        // Record offsets (frame offset − 4 for a one-part frame).
        let tenth = |at: usize| le(&rec, at) as f64 / 10.0;
        let ch = |from: usize| (0..CHANNELS).map(|i| le(&rec, from + 2 * i)).collect::<Vec<u16>>();
        let (original, adjusted) = (ch(3), ch(23));
        let weight_kg = le(&rec, 1) as f64 / 100.0;
        let fat = tenth(43);
        let comp = QnComposition {
            bmi: tenth(47),
            water_pct: tenth(49),
            muscle_raw: le(&rec, 51),
            visceral: rec[53],
            body_age: rec[54],
            bmr: le(&rec, 55),
            protein_pct: tenth(57),
            bone_raw: le(&rec, 60),
            lean_pct: tenth(62),
            subcutaneous_pct: tenth(64),
            skeletal_muscle_pct: tenth(66),
            score: tenth(68),
            percent: self.percent,
        };
        if weight_kg > 0.0 && !self.live_done {
            self.live_done = true;
            step.readings.push(QnReading {
                slot: Some(rec[0]),
                weight_kg,
                fat_pct: (fat > 0.0).then_some(fat),
                heart_rate: (rec[45] > 0).then_some(rec[45]),
                channels: original.iter().any(|c| *c > 0).then(|| channels_ohm(&original, Some(false))),
                adjusted: adjusted.iter().any(|c| *c > 0).then(|| channels_ohm(&adjusted, Some(false))),
                resistance: Vec::new(),
                composition: Some(comp),
                recorded_unix: None,
            });
            if self.cfg.bluetooth.result_ack {
                step.writes.push(self.ack_frame());
            }
        }
    }
}

pub fn hex(d: &[u8]) -> String {
    d.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(" ")
}

/// Parses "10 14 01 .." or "101401..".
pub fn parse_hex(s: &str) -> Option<Vec<u8>> {
    let s: String = s.chars().filter(|c| !c.is_whitespace() && *c != ':' && *c != '-').collect();
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> QnConfig {
        QnConfig {
            bluetooth: crate::scales::bundled_profiles().into_iter().find(|p| p.id == "arboleaf").unwrap().bluetooth.unwrap(),
            unit_lb: false,
            female: false,
            age: 34,
            height_cm: 180.0,
        }
    }

    /// A frame from its bytes before the checksum.
    fn f(body: &[u8]) -> Vec<u8> {
        with_checksum(body.to_vec())
    }

    fn put(buf: &mut [u8], at: usize, v: u16) {
        buf[at..at + 2].copy_from_slice(&v.to_be_bytes());
    }

    /// An 8-electrode result block for 80.00 kg, 18.5 % fat, channels in 0.1 Ω.
    fn eight_block(orig: [u16; 10], adj: [u16; 10]) -> [Vec<u8>; 3] {
        let mut p1 = vec![0u8; 19];
        p1[..5].copy_from_slice(&[0x10, 0x14, 0x01, 0x02, 0x31]);
        put(&mut p1, 5, 8000);
        for (i, at) in [7, 9, 11, 13, 15, 17].into_iter().enumerate() {
            put(&mut p1, at, orig[i]);
        }
        let mut p2 = vec![0u8; 19];
        p2[..2].copy_from_slice(&[0x10, 0x14]);
        p2[4] = 0x32;
        for (i, at) in [2, 5, 7, 9].into_iter().enumerate() {
            put(&mut p2, at, orig[6 + i]);
        }
        for (i, at) in [11, 13, 15, 17].into_iter().enumerate() {
            put(&mut p2, at, adj[i]);
        }
        let mut p3 = vec![0u8; 19];
        p3[..2].copy_from_slice(&[0x10, 0x14]);
        p3[4] = 0x33;
        for (i, at) in [2, 5, 7, 9, 11, 13].into_iter().enumerate() {
            put(&mut p3, at, adj[4 + i]);
        }
        put(&mut p3, 15, 185);
        p3[17] = 64;
        [f(&p1), f(&p2), f(&p3)]
    }

    fn comp_frames(op_c: u8, op_d: u8, len_d: usize) -> (Vec<u8>, Vec<u8>) {
        let mut c = vec![0u8; 15];
        c[..3].copy_from_slice(&[op_c, 0x10, 0xff]);
        put(&mut c, 3, 247); // BMI 24.7
        put(&mut c, 5, 580); // water 58.0 %
        put(&mut c, 7, 770); // muscle 77.0 % of weight
        c[9] = 7;
        c[10] = 33;
        put(&mut c, 11, 1780);
        put(&mut c, 13, 182);
        let mut d = vec![0u8; len_d - 1];
        d[..3].copy_from_slice(&[op_d, 0x10, 0xff]);
        put(&mut d, 4, 43); // bone 4.3 %
        put(&mut d, 6, 815); // lean 81.5 %
        put(&mut d, 8, 162);
        put(&mut d, 10, 520);
        put(&mut d, 12, 900);
        (f(&c), f(&d))
    }

    const ORIG: [u16; 10] = [3300, 2480, 3200, 2400, 2460, 2170, 2560, 2290, 360, 590];
    const ADJ: [u16; 10] = [3300, 2480, 3200, 2400, 2460, 2170, 2560, 2290, 370, 330];

    #[test]
    fn handshake_follows_the_scale() {
        let mut s = QnSession::new(cfg());
        let st = s.on_notification(&f(&[0x12, 0x11, 0xff, 1, 2, 3, 4, 5, 6, 0, 0x01, 0, 0, 0, 0, 0]), 0);
        assert_eq!(st.writes, vec![f(&[0x13, 0x09, 0xff, 0x01, 0x10, 0, 0, 0])]);
        // 2026-01-01 00:00:00 UTC.
        let now = 1_767_225_600;
        let st = s.on_notification(&f(&[0x14, 0x05, 0x01, 0x01]), now);
        let secs = ((now - EPOCH_2000) as u32).to_le_bytes();
        assert_eq!(st.writes[0], f(&[0x20, 0x08, 0xff, secs[0], secs[1], secs[2], secs[3]]));
        assert_eq!(st.writes[1], f(&[0xa2, 0x06, 0x01, 0x32, 34]));
        let st = s.on_notification(&f(&[0x21, 0x05, 0xff, 0x00]), now);
        // Slot 1, key 8, male, 34, 1800 mm, algorithm 4; then start for slot 1 (mask 0b11).
        assert_eq!(st.writes, vec![f(&[0xa0, 0x0d, 0x02, 0x01, 0x00, 0x08, 0x00, 34, 0x07, 0x08, 0x04, 0x02]), f(&[0x22, 0x06, 0xff, 0x00, 0x03])]);
        // Asked once only; and a refusal is explained.
        assert!(s.on_notification(&f(&[0x21, 0x05, 0xff, 0x00]), now).writes.is_empty());
        assert!(s.on_notification(&f(&[0xa1, 0x06, 0x02, 0x01, 0x00]), now).notes[0].contains("user_key"));
    }

    #[test]
    fn idle_sends_the_profile_when_never_asked() {
        let mut s = QnSession::new(cfg());
        assert!(s.on_idle().writes.is_empty(), "not before the scale is ready");
        s.on_notification(&f(&[0x14, 0x05, 0x01, 0x01]), 0);
        assert_eq!(s.on_idle().writes.len(), 2);
        assert!(s.on_idle().writes.is_empty());
    }

    #[test]
    fn eight_electrode_weigh_in() {
        let mut s = QnSession::new(cfg());
        s.on_notification(&f(&[0x14, 0x05, 0x01, 0x01]), 0);
        // Live weight while stepping on.
        let mut live = vec![0u8; 19];
        live[..5].copy_from_slice(&[0x10, 0x14, 0x01, 0x00, 0x00]);
        put(&mut live, 5, 7935);
        let st = s.on_notification(&f(&live), 0);
        assert_eq!((st.live_weight_kg, st.stable), (Some(79.35), false));
        for p in eight_block(ORIG, ADJ) {
            assert!(s.on_notification(&p, 0).readings.is_empty());
        }
        let (c, d) = comp_frames(0x15, 0x16, 16);
        assert!(s.on_notification(&c, 0).readings.is_empty());
        let st = s.on_notification(&d, 0);
        assert_eq!(st.writes, vec![f(&[0x1f, 0x05, 0xff, 0x10])], "result acknowledged");
        let r = &st.readings[0];
        assert_eq!((r.weight_kg, r.fat_pct, r.heart_rate), (80.0, Some(18.5), Some(64)));
        assert_eq!(r.channels.as_ref().unwrap()[8..], [36.0, 59.0]);
        assert_eq!(r.adjusted.as_ref().unwrap()[9], 33.0);
        let v = r.values();
        for (k, want) in [
            ("weight_kg", 80.0),
            ("pbf", 18.5),
            ("body_fat_mass_kg", 14.8),
            ("fat_free_mass_kg", 65.2),
            ("muscle_mass_kg", 61.6),
            ("bone_mass_kg", 3.44),
            ("smm_kg", 41.6),
            ("bmi", 24.7),
            ("body_water_pct", 58.0),
            ("visceral_fat_level", 7.0),
            ("metabolic_age", 33.0),
            ("bmr_kcal", 1780.0),
            ("protein_pct", 18.2),
            ("subcutaneous_fat_pct", 16.2),
            ("skeletal_muscle_pct", 52.0),
            ("heart_rate_bpm", 64.0),
            ("imp_left_arm_20k_ohm", 330.0),
            ("imp_right_leg_100k_ohm", 229.0),
            ("imp_trunk_100k_ohm", 59.0),
        ] {
            assert_eq!(v.get(k).copied(), Some(want), "{k}");
        }
        // Weight frames after the result don't restart it.
        assert_eq!(s.on_notification(&f(&live), 0).live_weight_kg, None);
    }

    #[test]
    fn scrambled_channels_are_recognised() {
        let scrambled: [u16; 10] = ORIG.map(unscramble);
        assert_ne!(scrambled, ORIG);
        let mut s = QnSession::new(cfg());
        let [p1, p2, p3] = eight_block(scrambled, ADJ.map(unscramble));
        for p in [p1, p2, p3] {
            s.on_notification(&p, 0);
        }
        let r = &s.on_idle().readings[0];
        assert_eq!(r.channels.as_ref().unwrap()[0], 330.0);
        assert_eq!(r.composition, None, "a block without the scale's results still counts");
    }

    #[test]
    fn stored_weigh_ins() {
        let mut s = QnSession::new(cfg());
        let secs: u32 = 830_000_000; // 2026-04-19 UTC
        let mut s1 = vec![0u8; 19];
        s1[..5].copy_from_slice(&[0x23, 0x01, 0x01, 0x01, 0x31]);
        s1[5..9].copy_from_slice(&secs.to_le_bytes());
        put(&mut s1, 9, 7850);
        for (i, at) in [11, 13, 15, 17].into_iter().enumerate() {
            put(&mut s1, at, ORIG[i]);
        }
        let mut s2 = vec![0u8; 19];
        s2[0] = 0x23;
        s2[3] = 0x01;
        s2[4] = 0x32;
        for (i, at) in [1, 5, 7, 9, 11, 13].into_iter().enumerate() {
            put(&mut s2, at, ORIG[4 + i]);
        }
        for (i, at) in [15, 17].into_iter().enumerate() {
            put(&mut s2, at, ADJ[i]);
        }
        let mut s3 = vec![0u8; 19];
        s3[0] = 0x23;
        s3[3] = 0x01;
        s3[4] = 0x33;
        for (i, at) in [1, 5, 7, 9, 11, 13, 15, 17].into_iter().enumerate() {
            put(&mut s3, at, ADJ[2 + i]);
        }
        let (mut c, d) = comp_frames(0x24, 0x25, 16);
        // 0x24 is 19 bytes: body fat at [15..17], heart rate [17].
        c.pop();
        c.resize(18, 0);
        c[1] = 0x13;
        put(&mut c, 15, 201);
        let c = f(&c);
        for fr in [f(&s1), f(&s2), f(&s3), c] {
            assert!(s.on_notification(&fr, 0).stored.is_empty());
        }
        let st = s.on_notification(&d, 0);
        let r = &st.stored[0];
        assert_eq!((r.recorded_unix, r.weight_kg, r.fat_pct), (Some(EPOCH_2000 + secs as i64), 78.5, Some(20.1)));
        assert_eq!(r.channels.as_deref(), Some(&ORIG.map(|x| x as f64 / 10.0)[..]));
        assert_eq!(r.values()["protein_pct"], 18.2);
    }

    #[test]
    fn classic_four_electrode() {
        let mut s = QnSession::new(cfg());
        s.on_notification(&f(&[0x12, 0x11, 0x02, 1, 2, 3, 4, 5, 6, 0, 0x01, 0, 0, 0, 0, 0]), 0);
        let st = s.on_notification(&f(&[0x10, 0x0b, 0x02, 0x1f, 0x40, 0x00, 0, 0, 0, 0]), 0);
        assert_eq!(st.live_weight_kg, Some(80.0));
        // Stable but no impedance yet: wait.
        assert!(s.on_notification(&f(&[0x10, 0x0b, 0x02, 0x1f, 0x40, 0x01, 0, 0, 0, 0]), 0).readings.is_empty());
        let st = s.on_notification(&f(&[0x10, 0x0b, 0x02, 0x1f, 0x40, 0x01, 0x01, 0xf6, 0x01, 0xf4]), 0);
        assert_eq!(st.readings[0].resistance, vec![502.0, 500.0]);
        assert_eq!(st.readings[0].values()["impedance_ohm"], 502.0);
        assert_eq!(st.writes, vec![f(&[0x1f, 0x05, 0x02, 0x10])]);
    }

    #[test]
    fn extended_record() {
        let mut rec = vec![0u8; 114];
        rec[0] = 1;
        rec[1..3].copy_from_slice(&8123u16.to_le_bytes());
        for (i, v) in ORIG.iter().enumerate() {
            rec[3 + 2 * i..5 + 2 * i].copy_from_slice(&v.to_le_bytes());
        }
        rec[43..45].copy_from_slice(&222u16.to_le_bytes());
        rec[51..53].copy_from_slice(&760u16.to_le_bytes());
        rec[66..68].copy_from_slice(&505u16.to_le_bytes());
        // Split in two parts.
        let mut s = QnSession::new(cfg());
        let part = |i: u8, body: &[u8]| {
            let mut fr = vec![0xb1, (body.len() + 5) as u8, 2, i];
            fr.extend(body);
            with_checksum(fr)
        };
        assert!(s.on_notification(&part(1, &rec[..60]), 0).readings.is_empty());
        let st = s.on_notification(&part(2, &rec[60..]), 0);
        let r = &st.readings[0];
        assert_eq!((r.weight_kg, r.fat_pct), (81.23, Some(22.2)));
        assert_eq!(r.values()["skeletal_muscle_pct"], 50.5);
        assert_eq!(r.values()["imp_left_arm_20k_ohm"], 330.0);
    }

    #[test]
    fn bad_checksums_and_hex() {
        let mut s = QnSession::new(cfg());
        let mut fr = f(&[0x21, 0x05, 0xff, 0x00]);
        *fr.last_mut().unwrap() ^= 1;
        assert!(s.on_notification(&fr, 0).writes.is_empty());
        assert_eq!(parse_hex("10 14 0a"), Some(vec![0x10, 0x14, 0x0a]));
        assert_eq!(parse_hex("10140A"), Some(vec![0x10, 0x14, 0x0a]));
        assert_eq!(parse_hex("1"), None);
        assert_eq!(unscramble(unscramble(0x1234)), 0x1234);
        assert_eq!(unscramble(0x10cf), 0x01f6);
    }
}
