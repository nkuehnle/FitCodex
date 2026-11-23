//! Weigh-ins held for the user to check before they're saved: a scale or health app can be shared by
//! a household, so a weigh-in that may be someone else's (far from your recent weight, or taken on
//! the scale while no phone was connected) waits for "That's me" or "Not me". A weigh-in marked
//! "Not me" is remembered so the next sync doesn't offer it again.

use rusqlite::params;
use serde::Serialize;

use crate::body::{InBodyScan, SAME_WEIGH_IN_MINUTES};
use crate::db::Db;
use crate::strong::parse_datetime;
use crate::{Error, Result};

const TIME_FMT: &str = "%Y-%m-%d %H:%M:%S";

/// A weigh-in waiting to be checked. `scan.values` holds at least `weight_kg`; a scan with nothing
/// else is saved as a plain weigh-in.
#[derive(Debug, Clone, Serialize)]
pub struct PendingWeighIn {
    pub id: i64,
    pub scan: InBodyScan,
    /// Why it's held, in a sentence.
    pub reason: String,
}

impl Db {
    /// Why a weigh-in might be someone else's: more than max(3 kg, 4 %) from the median of your
    /// weigh-ins in the 30 days before it. None when it looks like you, or there's nothing to go on.
    pub fn weigh_in_doubt(&self, at: &str, weight_kg: f64) -> Result<Option<String>> {
        let t = parse_datetime(at).ok_or_else(|| Error::Format(format!("bad date {at:?}")))?;
        let mut stmt = self.conn().prepare_cached(
            "SELECT weight_kg FROM bodyweight WHERE measured_at_local < ?1 AND measured_at_local >= ?2 ORDER BY weight_kg",
        )?;
        let from = (t - chrono::Duration::days(30)).format(TIME_FMT).to_string();
        let w: Vec<f64> = stmt.query_map(params![t.format(TIME_FMT).to_string(), from], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        if w.is_empty() {
            return Ok(None);
        }
        let usual = w[w.len() / 2];
        let off = weight_kg - usual;
        Ok((off.abs() > (usual * 0.04).max(3.0)).then(|| format!("{:+.1} kg from your usual {usual:.1} kg", off)))
    }

    /// The held or rejected entry for this weigh-in (same source, within `SAME_WEIGH_IN_MINUTES`).
    fn pending_near(&self, source: &str, at: &str) -> Result<Option<(i64, bool)>> {
        let t = parse_datetime(at).ok_or_else(|| Error::Format(format!("bad date {at:?}")))?;
        let mut stmt = self.conn().prepare_cached("SELECT id, measured_at_local, rejected FROM pending_weigh_in WHERE source = ?1")?;
        let rows: Vec<(i64, String, bool)> = stmt.query_map([source], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?;
        Ok(rows
            .into_iter()
            .find(|(_, m, _)| parse_datetime(m).is_some_and(|x| (x - t).num_minutes().abs() <= SAME_WEIGH_IN_MINUTES))
            .map(|(id, _, rejected)| (id, rejected)))
    }

    /// Whether this weigh-in is already held or was marked "Not me". A held one takes the scan's
    /// extra fields (the same weigh-in can arrive as a weight and as a scan).
    pub fn absorb_if_held(&mut self, scan: &InBodyScan) -> Result<bool> {
        let Some((id, rejected)) = self.pending_near(scan.source(), &scan.measured_at_local)? else { return Ok(false) };
        if !rejected {
            let json: String = self.conn().query_row("SELECT scan FROM pending_weigh_in WHERE id = ?1", [id], |r| r.get(0))?;
            let mut held: InBodyScan = serde_json::from_str(&json).map_err(|e| Error::Format(e.to_string()))?;
            for (k, v) in &scan.values {
                held.values.entry(k.clone()).or_insert(*v);
            }
            held.device = held.device.or_else(|| scan.device.clone());
            self.conn().execute(
                "UPDATE pending_weigh_in SET scan = ?2 WHERE id = ?1",
                params![id, serde_json::to_string(&held).map_err(|e| Error::Format(e.to_string()))?],
            )?;
        }
        Ok(true)
    }

    /// Holds a weigh-in for checking (merged into one already held for the same weigh-in). One
    /// already saved (a scale can send its stored weigh-ins again) is left alone.
    pub fn hold_weigh_in(&mut self, scan: &InBodyScan, reason: &str) -> Result<()> {
        let Some(&w) = scan.values.get("weight_kg").filter(|w| **w > 0.0) else {
            return Err(Error::Format("a held weigh-in needs a weight".into()));
        };
        if self.absorb_if_held(scan)? {
            return Ok(());
        }
        let saved: bool = self.conn().query_row(
            "SELECT count(*) > 0 FROM bodyweight
             WHERE abs(julianday(measured_at_local) - julianday(?1)) * 1440 <= ?3 AND abs(weight_kg - ?2) < 0.05",
            params![scan.measured_at_local, w, SAME_WEIGH_IN_MINUTES],
            |r| r.get(0),
        )?;
        if saved {
            return Ok(());
        }
        let at = parse_datetime(&scan.measured_at_local).ok_or_else(|| Error::Format(format!("bad date {:?}", scan.measured_at_local)))?;
        let mut s = scan.clone();
        s.id = None;
        s.measured_at_local = at.format(TIME_FMT).to_string();
        s.source = Some(scan.source().to_string());
        self.conn().execute(
            "INSERT OR IGNORE INTO pending_weigh_in (measured_at_local, source, scan, reason) VALUES (?1, ?2, ?3, ?4)",
            params![s.measured_at_local, s.source, serde_json::to_string(&s).map_err(|e| Error::Format(e.to_string()))?, reason],
        )?;
        Ok(())
    }

    /// Saves a weigh-in from a scale or health app unless it may be someone else's, in which case
    /// it's held. Returns true when saved now.
    pub fn save_or_hold_weigh_in(&mut self, scan: &InBodyScan) -> Result<bool> {
        if self.absorb_if_held(scan)? {
            return Ok(false);
        }
        if let Some(w) = scan.values.get("weight_kg") {
            if let Some(why) = self.weigh_in_doubt(&scan.measured_at_local, *w)? {
                self.hold_weigh_in(scan, &format!("{why}: is this you?"))?;
                return Ok(false);
            }
        }
        self.save_checked(scan)?;
        Ok(true)
    }

    /// A weight alone is a weigh-in; anything more is a body-composition scan (which also adds
    /// its weigh-in).
    fn save_checked(&mut self, scan: &InBodyScan) -> Result<()> {
        if scan.values.keys().all(|k| k == "weight_kg") {
            self.conn().execute(
                "INSERT OR IGNORE INTO bodyweight (measured_at_local, weight_kg, source) VALUES (?1, ?2, ?3)",
                params![scan.measured_at_local, scan.values["weight_kg"], scan.source()],
            )?;
        } else {
            self.merge_body_comp_scan(scan)?;
        }
        Ok(())
    }

    /// Weigh-ins waiting to be checked, oldest first.
    pub fn pending_weigh_ins(&self) -> Result<Vec<PendingWeighIn>> {
        let mut stmt = self.conn().prepare("SELECT id, scan, reason FROM pending_weigh_in WHERE rejected = 0 ORDER BY measured_at_local")?;
        let rows: Vec<(i64, String, String)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?;
        rows.into_iter()
            .map(|(id, json, reason)| Ok(PendingWeighIn { id, scan: serde_json::from_str(&json).map_err(|e| Error::Format(e.to_string()))?, reason }))
            .collect()
    }

    /// "That's me": saves it. "Not me": drops it and remembers not to offer it again.
    pub fn resolve_pending_weigh_in(&mut self, id: i64, mine: bool) -> Result<()> {
        if !mine {
            self.conn().execute("UPDATE pending_weigh_in SET rejected = 1 WHERE id = ?1", [id])?;
            return Ok(());
        }
        let json: String = self.conn().query_row("SELECT scan FROM pending_weigh_in WHERE id = ?1 AND rejected = 0", [id], |r| r.get(0))?;
        let scan: InBodyScan = serde_json::from_str(&json).map_err(|e| Error::Format(e.to_string()))?;
        self.save_checked(&scan)?;
        self.conn().execute("DELETE FROM pending_weigh_in WHERE id = ?1", [id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan(at: &str, values: &[(&str, f64)]) -> InBodyScan {
        InBodyScan {
            id: None,
            measured_at_local: at.into(),
            values: values.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
            device: None,
            notes: None,
            source: Some("arboleaf".into()),
        }
    }

    #[test]
    fn someone_elses_weigh_in_waits_for_you() {
        let mut db = Db::open_in_memory().unwrap();
        // Nothing to compare with: saved.
        assert!(db.save_or_hold_weigh_in(&scan("2026-11-01 07:00:00", &[("weight_kg", 80.0)])).unwrap());
        for d in 2..=9 {
            db.save_or_hold_weigh_in(&scan(&format!("2026-11-0{d} 07:00:00"), &[("weight_kg", 80.0 + d as f64 / 10.0)])).unwrap();
        }
        // Close to usual: saved, with its scan.
        assert!(db.save_or_hold_weigh_in(&scan("2026-11-10 07:00:00", &[("weight_kg", 81.5), ("pbf", 18.0)])).unwrap());
        assert_eq!(db.inbody_scans().unwrap().len(), 1);
        // Someone lighter: held; the same weigh-in's scan (from another import) joins it.
        assert!(!db.save_or_hold_weigh_in(&scan("2026-11-10 07:30:00", &[("weight_kg", 61.0)])).unwrap());
        assert!(!db.save_or_hold_weigh_in(&scan("2026-11-10 07:31:00", &[("pbf", 27.0)])).unwrap());
        let p = db.pending_weigh_ins().unwrap();
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].scan.values["pbf"], 27.0);
        assert!(p[0].reason.contains("from your usual"), "{}", p[0].reason);
        assert_eq!(db.weigh_ins(false).unwrap().len(), 10);

        // Not me: gone, and not offered again.
        db.resolve_pending_weigh_in(p[0].id, false).unwrap();
        assert!(db.pending_weigh_ins().unwrap().is_empty());
        assert!(!db.save_or_hold_weigh_in(&scan("2026-11-10 07:30:00", &[("weight_kg", 61.0)])).unwrap());
        assert!(db.pending_weigh_ins().unwrap().is_empty());

        // That's me (a real change, or a weigh-in the scale kept): saved with its scan.
        db.hold_weigh_in(&scan("2026-11-11 07:00:00", &[("weight_kg", 75.0), ("pbf", 16.0)]), "kept on the scale").unwrap();
        let id = db.pending_weigh_ins().unwrap()[0].id;
        db.resolve_pending_weigh_in(id, true).unwrap();
        assert!(db.pending_weigh_ins().unwrap().is_empty());
        // The scale sending it again doesn't bring it back.
        db.hold_weigh_in(&scan("2026-11-11 07:00:00", &[("weight_kg", 75.0), ("pbf", 16.0)]), "kept on the scale").unwrap();
        assert!(db.pending_weigh_ins().unwrap().is_empty());
        assert_eq!(db.inbody_scans().unwrap().len(), 2);
        assert_eq!(db.weigh_ins(false).unwrap().last().unwrap().weight_kg, 75.0);
    }
}
