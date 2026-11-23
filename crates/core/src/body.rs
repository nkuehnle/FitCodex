//! Bodyweight log, body-composition scans (InBody and home BIA scales; manual, CSV, sheet/screenshot
//! OCR, Health Connect and Bluetooth), diet log and energy balance.

use std::collections::{BTreeMap, HashMap};

use chrono::{Duration, NaiveDate, NaiveDateTime};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::units::WeightUnit;
use crate::{Error, Result};

const TIME_FMT: &str = "%Y-%m-%d %H:%M:%S";
/// Energy in one kg of body-mass change (≈ 3,500 kcal per lb).
pub const KCAL_PER_KG: f64 = 7700.0;

// ---- Bodyweight -------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct WeighInRow {
    pub id: i64,
    pub at: String,
    pub weight_kg: f64,
    /// "manual", "strong", "inbody", or the device or app a scale weigh-in came from
    /// ("arboleaf", "garmin", ...).
    pub source: String,
}

impl Db {
    pub fn add_weigh_in(&mut self, at: NaiveDateTime, weight_kg: f64) -> Result<i64> {
        if !(weight_kg > 0.0) {
            return Err(Error::Format("weight must be positive".into()));
        }
        self.conn().execute(
            "INSERT INTO bodyweight (measured_at_local, weight_kg, source) VALUES (?1, ?2, 'manual')
             ON CONFLICT (source, measured_at_local) DO UPDATE SET weight_kg = excluded.weight_kg",
            params![at.format(TIME_FMT).to_string(), weight_kg],
        )?;
        Ok(self.conn().last_insert_rowid())
    }

    /// Corrects a weigh-in's weight and/or time (manual or imported entries).
    pub fn update_weigh_in(&mut self, id: i64, at: NaiveDateTime, weight_kg: f64) -> Result<()> {
        if !(weight_kg > 0.0) {
            return Err(Error::Format("weight must be positive".into()));
        }
        let at = at.format(TIME_FMT).to_string();
        let clash: Option<i64> = self
            .conn()
            .query_row(
                "SELECT b.id FROM bodyweight b JOIN bodyweight me ON me.id = ?1
                 WHERE b.source = me.source AND b.measured_at_local = ?2 AND b.id != ?1",
                params![id, at],
                |r| r.get(0),
            )
            .optional()?;
        if clash.is_some() {
            return Err(Error::Format("there's already a weigh-in at that exact time".into()));
        }
        let n = self.conn().execute("UPDATE bodyweight SET measured_at_local = ?2, weight_kg = ?3 WHERE id = ?1", params![id, at, weight_kg])?;
        if n == 0 {
            return Err(Error::Format("weigh-in not found".into()));
        }
        Ok(())
    }

    pub fn delete_weigh_in(&mut self, id: i64) -> Result<()> {
        self.conn().execute("DELETE FROM bodyweight WHERE id = ?1", [id])?;
        Ok(())
    }

    /// All weigh-ins oldest first; InBody scan weights included (source "inbody") when asked.
    /// Home-scale scans add their own weigh-in to `bodyweight` when saved, so they're always here.
    pub fn weigh_ins(&self, include_inbody: bool) -> Result<Vec<WeighInRow>> {
        let mut stmt = self.conn().prepare(
            "SELECT id, measured_at_local, weight_kg, source FROM bodyweight
             UNION ALL
             SELECT -id, measured_at_local, weight_kg, 'inbody' FROM inbody_scan
             WHERE ?1 AND weight_kg IS NOT NULL AND coalesce(source, 'inbody') = 'inbody'
             ORDER BY 2",
        )?;
        let rows = stmt.query_map([include_inbody], |r| Ok(WeighInRow { id: r.get(0)?, at: r.get(1)?, weight_kg: r.get(2)?, source: r.get(3)? }))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

// ---- Body-part measurements ---------------------------------------------------------------------

/// (id, label, unit) of every measurable body part. Lengths are stored in cm; "pct" in percent.
pub const BODY_PARTS: &[(&str, &str, &str)] = &[
    ("body_fat_pct", "Body fat", "pct"),
    ("neck", "Neck", "cm"),
    ("shoulders", "Shoulders", "cm"),
    ("chest", "Chest", "cm"),
    ("left_bicep", "Left bicep", "cm"),
    ("right_bicep", "Right bicep", "cm"),
    ("left_forearm", "Left forearm", "cm"),
    ("right_forearm", "Right forearm", "cm"),
    ("upper_abs", "Upper abs", "cm"),
    ("waist", "Waist", "cm"),
    ("lower_abs", "Lower abs", "cm"),
    ("hips", "Hips", "cm"),
    ("left_thigh", "Left thigh", "cm"),
    ("right_thigh", "Right thigh", "cm"),
    ("left_calf", "Left calf", "cm"),
    ("right_calf", "Right calf", "cm"),
];

#[derive(Debug, Clone, Serialize)]
pub struct MeasurementRow {
    pub id: i64,
    pub at: String,
    pub part: String,
    pub value: f64,
}

impl Db {
    pub fn add_measurement(&mut self, at: NaiveDateTime, part: &str, value: f64) -> Result<i64> {
        if !BODY_PARTS.iter().any(|p| p.0 == part) {
            return Err(Error::Format(format!("unknown body part {part:?}")));
        }
        if !(value > 0.0) {
            return Err(Error::Format("measurement must be positive".into()));
        }
        self.conn().execute(
            "INSERT INTO body_measurement (measured_at_local, part, value) VALUES (?1, ?2, ?3)",
            params![at.format(TIME_FMT).to_string(), part, value],
        )?;
        Ok(self.conn().last_insert_rowid())
    }

    pub fn update_measurement(&mut self, id: i64, at: NaiveDateTime, value: f64) -> Result<()> {
        if !(value > 0.0) {
            return Err(Error::Format("measurement must be positive".into()));
        }
        self.conn().execute(
            "UPDATE body_measurement SET measured_at_local = ?2, value = ?3 WHERE id = ?1",
            params![id, at.format(TIME_FMT).to_string(), value],
        )?;
        Ok(())
    }

    pub fn delete_measurement(&mut self, id: i64) -> Result<()> {
        self.conn().execute("DELETE FROM body_measurement WHERE id = ?1", [id])?;
        Ok(())
    }

    /// All measurements oldest first, optionally for one part.
    pub fn measurements(&self, part: Option<&str>) -> Result<Vec<MeasurementRow>> {
        let mut stmt = self.conn().prepare(
            "SELECT id, measured_at_local, part, value FROM body_measurement
             WHERE ?1 IS NULL OR part = ?1 ORDER BY measured_at_local, id",
        )?;
        let rows = stmt.query_map([part], |r| Ok(MeasurementRow { id: r.get(0)?, at: r.get(1)?, part: r.get(2)?, value: r.get(3)? }))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

// ---- InBody -----------------------------------------------------------------------------------

/// (column, label, unit) for every numeric InBody field. Units: kg, l, pct, kcal, ratio, level, score.
pub const INBODY_FIELDS: &[(&str, &str, &str)] = &[
    ("weight_kg", "Weight", "kg"),
    ("smm_kg", "Skeletal muscle mass", "kg"),
    ("body_fat_mass_kg", "Body fat mass", "kg"),
    ("pbf", "Percent body fat", "pct"),
    ("lean_body_mass_kg", "Lean body mass", "kg"),
    ("fat_free_mass_kg", "Fat-free mass", "kg"),
    ("total_body_water_l", "Total body water", "l"),
    ("icw_l", "Intracellular water", "l"),
    ("ecw_l", "Extracellular water", "l"),
    ("ecw_tbw", "ECW/TBW ratio", "ratio"),
    ("protein_kg", "Protein", "kg"),
    ("minerals_kg", "Minerals", "kg"),
    ("bmi", "BMI", "ratio"),
    ("bmr_kcal", "BMR", "kcal"),
    ("visceral_fat_level", "Visceral fat level", "level"),
    ("inbody_score", "InBody score", "score"),
    ("lean_right_arm_kg", "Lean mass: right arm", "kg"),
    ("lean_left_arm_kg", "Lean mass: left arm", "kg"),
    ("lean_trunk_kg", "Lean mass: trunk", "kg"),
    ("lean_right_leg_kg", "Lean mass: right leg", "kg"),
    ("lean_left_leg_kg", "Lean mass: left leg", "kg"),
    ("lean_right_arm_pct", "Lean mass: right arm (% of ideal)", "pct"),
    ("lean_left_arm_pct", "Lean mass: left arm (% of ideal)", "pct"),
    ("lean_trunk_pct", "Lean mass: trunk (% of ideal)", "pct"),
    ("lean_right_leg_pct", "Lean mass: right leg (% of ideal)", "pct"),
    ("lean_left_leg_pct", "Lean mass: left leg (% of ideal)", "pct"),
    ("fat_right_arm_kg", "Fat mass: right arm", "kg"),
    ("fat_left_arm_kg", "Fat mass: left arm", "kg"),
    ("fat_trunk_kg", "Fat mass: trunk", "kg"),
    ("fat_right_leg_kg", "Fat mass: right leg", "kg"),
    ("fat_left_leg_kg", "Fat mass: left leg", "kg"),
    ("fat_right_arm_pct", "Fat mass: right arm (% of ideal)", "pct"),
    ("fat_left_arm_pct", "Fat mass: left arm (% of ideal)", "pct"),
    ("fat_trunk_pct", "Fat mass: trunk (% of ideal)", "pct"),
    ("fat_right_leg_pct", "Fat mass: right leg (% of ideal)", "pct"),
    ("fat_left_leg_pct", "Fat mass: left leg (% of ideal)", "pct"),
    // Home BIA scales (Arboleaf and similar). "Muscle mass" there is soft lean mass (fat-free mass
    // less bone), not InBody's skeletal muscle mass.
    ("muscle_mass_kg", "Muscle mass (scale)", "kg"),
    ("bone_mass_kg", "Bone mass", "kg"),
    ("body_water_pct", "Body water", "pct"),
    ("protein_pct", "Protein", "pct"),
    ("skeletal_muscle_pct", "Skeletal muscle", "pct"),
    ("subcutaneous_fat_pct", "Subcutaneous fat", "pct"),
    ("metabolic_age", "Metabolic age", "years"),
    ("heart_rate_bpm", "Heart rate", "bpm"),
    // Raw bioimpedance.
    ("impedance_ohm", "Impedance (whole body)", "ohm"),
    ("imp_right_arm_20k_ohm", "Impedance: right arm, 20 kHz", "ohm"),
    ("imp_left_arm_20k_ohm", "Impedance: left arm, 20 kHz", "ohm"),
    ("imp_trunk_20k_ohm", "Impedance: trunk, 20 kHz", "ohm"),
    ("imp_right_leg_20k_ohm", "Impedance: right leg, 20 kHz", "ohm"),
    ("imp_left_leg_20k_ohm", "Impedance: left leg, 20 kHz", "ohm"),
    ("imp_right_arm_100k_ohm", "Impedance: right arm, 100 kHz", "ohm"),
    ("imp_left_arm_100k_ohm", "Impedance: left arm, 100 kHz", "ohm"),
    ("imp_trunk_100k_ohm", "Impedance: trunk, 100 kHz", "ohm"),
    ("imp_right_leg_100k_ohm", "Impedance: right leg, 100 kHz", "ohm"),
    ("imp_left_leg_100k_ohm", "Impedance: left leg, 100 kHz", "ohm"),
];

/// Source of scans with no source given (the manual form, InBody CSVs and sheet images).
pub const DEFAULT_SCAN_SOURCE: &str = "inbody";

/// Scans from the same source this close together are the same weigh-in reaching the app twice
/// (e.g. over Bluetooth and again from Health Connect): the second fills in the first's gaps.
pub const SAME_WEIGH_IN_MINUTES: i64 = 3;

/// What `merge_body_comp_scan` did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MergeOutcome {
    Inserted,
    /// Filled in fields an existing scan of the same weigh-in didn't have.
    Merged,
    /// Nothing new.
    Unchanged,
}

/// Valid source ids: lowercase letters, digits, `_`, `-` and `.` (Health Connect package names).
pub fn valid_source(s: &str) -> bool {
    !s.is_empty() && s.len() <= 80 && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "_-.".contains(c))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InBodyScan {
    pub id: Option<i64>,
    pub measured_at_local: String,
    /// Field column -> value (kg for masses).
    pub values: BTreeMap<String, f64>,
    /// Model, as shown to the user ("InBody 580", "Arboleaf CS10P").
    pub device: Option<String>,
    pub notes: Option<String>,
    /// Device family (a scale profile id such as "inbody" or "arboleaf"); `DEFAULT_SCAN_SOURCE`
    /// when missing.
    #[serde(default)]
    pub source: Option<String>,
}

impl InBodyScan {
    pub fn source(&self) -> &str {
        self.source.as_deref().unwrap_or(DEFAULT_SCAN_SOURCE)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CsvMapping {
    pub date_column: String,
    /// CSV header -> InBody field column.
    pub columns: BTreeMap<String, String>,
    /// Unit of mass columns in the file.
    pub mass_unit: WeightUnit,
    /// Device family the file's scans come from (a scale profile id); InBody when missing.
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InBodyCsvPreview {
    pub headers: Vec<String>,
    /// Remembered mapping for this header layout, else a best guess.
    pub mapping: CsvMapping,
    pub remembered: bool,
    pub scans: Vec<InBodyScan>,
    pub errors: Vec<String>,
}

fn is_field(c: &str) -> bool {
    INBODY_FIELDS.iter().any(|f| f.0 == c)
}

fn norm(s: &str) -> String {
    s.to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric() || *c == '%').collect()
}

/// Best-effort mapping from typical InBody/LookinBody column names.
pub fn guess_inbody_column(header: &str) -> Option<&'static str> {
    let h = norm(header);
    let pct = h.contains('%') || h.contains("percent") || h.contains("ideal");
    let seg = |side: &str| -> Option<&'static str> {
        let fat = h.contains("fat");
        let lean = h.contains("lean") || h.contains("ffm") || h.contains("muscle") || h.contains("mass") && !fat;
        if !(fat || lean) {
            return None;
        }
        let kind = if fat { "fat" } else { "lean" };
        let unit = if pct { "pct" } else { "kg" };
        INBODY_FIELDS.iter().map(|f| f.0).find(|c| *c == format!("{kind}_{side}_{unit}"))
    };
    for (key, side) in [("rightarm", "right_arm"), ("leftarm", "left_arm"), ("rightleg", "right_leg"), ("leftleg", "left_leg"), ("trunk", "trunk")] {
        if h.contains(key) {
            return seg(side);
        }
    }
    if h.contains("impedance") || h.contains("resistance") {
        return Some("impedance_ohm");
    }
    if pct {
        let pct_table: &[(&[&str], &str)] = &[
            (&["subcutaneous"], "subcutaneous_fat_pct"),
            (&["skeletalmuscle"], "skeletal_muscle_pct"),
            (&["water"], "body_water_pct"),
            (&["protein"], "protein_pct"),
        ];
        if let Some((_, c)) = pct_table.iter().find(|(keys, _)| keys.iter().any(|k| h.contains(k))) {
            return Some(c);
        }
    }
    let table: &[(&[&str], &str)] = &[
        (&["subcutaneous"], "subcutaneous_fat_pct"),
        (&["metabolicage", "bodyage"], "metabolic_age"),
        (&["heartrate", "pulse"], "heart_rate_bpm"),
        (&["bonemass", "bone"], "bone_mass_kg"),
        (&["ecwtbw", "ecwratio"], "ecw_tbw"),
        (&["skeletalmusclemass", "smm"], "smm_kg"),
        (&["bodyfatmass", "bfm"], "body_fat_mass_kg"),
        (&["percentbodyfat", "pbf", "bodyfat%", "bodyfatpercentage", "bodyfatrate"], "pbf"),
        (&["fatmass"], "body_fat_mass_kg"),
        (&["leanbodymass", "lbm", "softleanmass"], "lean_body_mass_kg"),
        (&["fatfreemass", "ffm", "fatfreebodyweight"], "fat_free_mass_kg"),
        (&["totalbodywater", "tbw"], "total_body_water_l"),
        (&["intracellularwater", "icw"], "icw_l"),
        (&["extracellularwater", "ecw"], "ecw_l"),
        (&["visceralfat", "vfl"], "visceral_fat_level"),
        (&["basalmetabolicrate", "bmr"], "bmr_kcal"),
        (&["inbodyscore", "score"], "inbody_score"),
        (&["protein"], "protein_kg"),
        (&["mineral"], "minerals_kg"),
        (&["bmi", "bodymassindex"], "bmi"),
        (&["musclemass", "muscle"], "muscle_mass_kg"),
        (&["bodyfat"], "pbf"),
        (&["weight"], "weight_kg"),
    ];
    table.iter().find(|(keys, _)| keys.iter().any(|k| h.contains(k))).map(|(_, c)| *c)
}

fn parse_scan_date(s: &str) -> Option<NaiveDateTime> {
    let s = s.trim();
    for f in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S", "%m/%d/%Y %H:%M:%S", "%m/%d/%Y %H:%M", "%Y.%m.%d %H:%M:%S", "%Y%m%d%H%M%S"] {
        if let Ok(t) = NaiveDateTime::parse_from_str(s, f) {
            return Some(t);
        }
    }
    for f in ["%Y-%m-%d", "%m/%d/%Y", "%Y.%m.%d", "%d.%m.%Y", "%Y%m%d"] {
        if let Ok(d) = NaiveDate::parse_from_str(s, f) {
            return d.and_hms_opt(0, 0, 0);
        }
    }
    None
}

fn header_signature(headers: &[String]) -> String {
    let mut h: Vec<String> = headers.iter().map(|h| norm(h)).collect();
    h.sort();
    h.join("|")
}

impl Db {
    pub fn inbody_scans(&self) -> Result<Vec<InBodyScan>> {
        let cols: Vec<&str> = INBODY_FIELDS.iter().map(|f| f.0).collect();
        let sql = format!("SELECT id, measured_at_local, device, notes, source, {} FROM inbody_scan ORDER BY measured_at_local", cols.join(", "));
        let mut stmt = self.conn().prepare(&sql)?;
        let rows = stmt.query_map([], |r| {
            let mut values = BTreeMap::new();
            for (i, c) in cols.iter().enumerate() {
                if let Some(v) = r.get::<_, Option<f64>>(5 + i)? {
                    values.insert(c.to_string(), v);
                }
            }
            Ok(InBodyScan { id: r.get(0)?, measured_at_local: r.get(1)?, device: r.get(2)?, notes: r.get(3)?, source: r.get(4)?, values })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The scans analyses use (body fat trends, muscle growth, left/right balance, reports): one
    /// source only, since different BIA devices don't agree with each other. That's the source chosen
    /// on the Body comp page, else the one with the most scans (InBody on a tie).
    pub fn analysis_scans(&self) -> Result<Vec<InBodyScan>> {
        let scans = self.inbody_scans()?;
        let source = self.analysis_source_of(&scans)?;
        Ok(scans.into_iter().filter(|s| Some(s.source()) == source.as_deref()).collect())
    }

    /// See `analysis_scans`; `None` without any scans.
    pub fn analysis_source(&self) -> Result<Option<String>> {
        let scans = self.inbody_scans()?;
        self.analysis_source_of(&scans)
    }

    fn analysis_source_of(&self, scans: &[InBodyScan]) -> Result<Option<String>> {
        let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
        for s in scans {
            *counts.entry(s.source()).or_default() += 1;
        }
        if let Some(chosen) = self.setting("body_comp_analysis_source")? {
            if counts.contains_key(chosen.as_str()) {
                return Ok(Some(chosen));
            }
        }
        Ok(counts
            .iter()
            .max_by_key(|(src, n)| (**n, **src == DEFAULT_SCAN_SOURCE))
            .map(|(src, _)| src.to_string()))
    }

    /// Picks the source analyses use; `None` goes back to automatic.
    pub fn set_analysis_source(&mut self, source: Option<&str>) -> Result<()> {
        match source {
            Some(s) if valid_source(s) => self.set_setting("body_comp_analysis_source", s),
            Some(s) => Err(Error::Format(format!("bad source {s:?}"))),
            None => {
                self.conn().execute("DELETE FROM setting WHERE key = 'body_comp_analysis_source'", [])?;
                Ok(())
            }
        }
    }

    /// Inserts or replaces a scan (matched by id, else by date/time).
    pub fn save_inbody_scan(&mut self, s: &InBodyScan) -> Result<i64> {
        crate::strong::parse_datetime(&s.measured_at_local).ok_or_else(|| Error::Format(format!("bad date {:?}", s.measured_at_local)))?;
        if let Some(bad) = s.values.keys().find(|k| !is_field(k)) {
            return Err(Error::Format(format!("unknown InBody field {bad:?}")));
        }
        let source = s.source();
        if !valid_source(source) {
            return Err(Error::Format(format!("bad source {source:?}")));
        }
        let cols: Vec<&str> = INBODY_FIELDS.iter().map(|f| f.0).collect();
        let vals: Vec<Option<f64>> = cols.iter().map(|c| s.values.get(*c).copied()).collect();
        if let Some(id) = s.id {
            self.conn().execute("DELETE FROM inbody_scan WHERE id = ?1", [id])?;
        }
        let placeholders: Vec<String> = (0..cols.len()).map(|i| format!("?{}", i + 5)).collect();
        let sql = format!(
            "INSERT OR REPLACE INTO inbody_scan (measured_at_local, device, notes, source, {}) VALUES (?1, ?2, ?3, ?4, {})",
            cols.join(", "),
            placeholders.join(", ")
        );
        let mut p: Vec<&dyn rusqlite::ToSql> = vec![&s.measured_at_local, &s.device, &s.notes, &source];
        for v in &vals {
            p.push(v);
        }
        self.conn().execute(&sql, p.as_slice())?;
        let id = self.conn().last_insert_rowid();
        // A home scale is also the everyday bathroom scale: its weight is a weigh-in, unless the same
        // weigh-in already arrived another way (e.g. Health Connect's weight record).
        if let (true, Some(w)) = (source != DEFAULT_SCAN_SOURCE, s.values.get("weight_kg")) {
            if *w > 0.0 {
                self.conn().execute(
                    "INSERT OR IGNORE INTO bodyweight (measured_at_local, weight_kg, source)
                     SELECT ?1, ?2, ?3 WHERE NOT EXISTS (
                       SELECT 1 FROM bodyweight WHERE abs(julianday(measured_at_local) - julianday(?1)) * 1440 <= 2 AND abs(weight_kg - ?2) < 0.05)",
                    params![s.measured_at_local, w, source],
                )?;
            }
        }
        Ok(id)
    }

    /// Saves a scan from an importer (Bluetooth, Health Connect, screenshots): when a scan from the
    /// same source is within `SAME_WEIGH_IN_MINUTES`, it's the same weigh-in, so only the fields that
    /// scan lacks are filled in; nothing already there is overwritten.
    pub fn merge_body_comp_scan(&mut self, s: &InBodyScan) -> Result<(MergeOutcome, i64)> {
        let at = crate::strong::parse_datetime(&s.measured_at_local).ok_or_else(|| Error::Format(format!("bad date {:?}", s.measured_at_local)))?;
        let source = s.source().to_string();
        let near = self.inbody_scans()?.into_iter().filter(|x| x.source() == source).find(|x| {
            crate::strong::parse_datetime(&x.measured_at_local).is_some_and(|t| (t - at).num_minutes().abs() <= SAME_WEIGH_IN_MINUTES)
        });
        let Some(mut existing) = near else {
            let mut new = s.clone();
            new.id = None;
            new.measured_at_local = at.format(TIME_FMT).to_string();
            new.source = Some(source);
            return Ok((MergeOutcome::Inserted, self.save_inbody_scan(&new)?));
        };
        let mut changed = false;
        for (k, v) in &s.values {
            if !existing.values.contains_key(k) {
                existing.values.insert(k.clone(), *v);
                changed = true;
            }
        }
        if existing.device.is_none() && s.device.is_some() {
            existing.device = s.device.clone();
            changed = true;
        }
        let id = existing.id.expect("stored scans have ids");
        if !changed {
            return Ok((MergeOutcome::Unchanged, id));
        }
        Ok((MergeOutcome::Merged, self.save_inbody_scan(&existing)?))
    }

    pub fn delete_inbody_scan(&mut self, id: i64) -> Result<()> {
        self.conn().execute("DELETE FROM inbody_scan WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Parses an InBody CSV with `mapping`, or with the remembered/guessed one when `None`.
    pub fn preview_inbody_csv(&self, text: &str, mapping: Option<CsvMapping>) -> Result<InBodyCsvPreview> {
        let delim = if text.lines().next().unwrap_or("").matches(';').count() > text.lines().next().unwrap_or("").matches(',').count() { b';' } else { b',' };
        let mut rdr = csv::ReaderBuilder::new().delimiter(delim).flexible(true).from_reader(text.as_bytes());
        let headers: Vec<String> = rdr.headers()?.iter().map(|h| h.trim().trim_start_matches('\u{feff}').to_string()).collect();
        let sig = header_signature(&headers);
        let remembered: Option<CsvMapping> = self
            .conn()
            .query_row("SELECT mapping FROM csv_mapping WHERE kind = 'inbody' AND signature = ?1", [&sig], |r| r.get::<_, String>(0))
            .optional()?
            .and_then(|m| serde_json::from_str(&m).ok());
        let was_remembered = mapping.is_none() && remembered.is_some();
        let mapping = mapping.or(remembered).unwrap_or_else(|| {
            let date_column = headers.iter().find(|h| norm(h).contains("date") || norm(h).contains("time")).cloned().unwrap_or_default();
            let mut columns = BTreeMap::new();
            let mut used = std::collections::HashSet::new();
            for h in &headers {
                if *h == date_column {
                    continue;
                }
                if let Some(f) = guess_inbody_column(h) {
                    if used.insert(f) {
                        columns.insert(h.clone(), f.to_string());
                    }
                }
            }
            CsvMapping { date_column, columns, mass_unit: WeightUnit::Kg, source: None }
        });
        let idx: HashMap<&str, usize> = headers.iter().enumerate().map(|(i, h)| (h.as_str(), i)).collect();
        let mut scans = Vec::new();
        let mut errors = Vec::new();
        for (n, rec) in rdr.records().enumerate() {
            let rec = rec?;
            let line = n + 2;
            let Some(date) = idx.get(mapping.date_column.as_str()).and_then(|&i| rec.get(i)).and_then(parse_scan_date) else {
                errors.push(format!("row {line}: no readable date"));
                continue;
            };
            let mut values = BTreeMap::new();
            for (h, field) in &mapping.columns {
                let Some(raw) = idx.get(h.as_str()).and_then(|&i| rec.get(i)) else { continue };
                let raw = raw.trim().trim_end_matches('%').replace(',', ".");
                if raw.is_empty() {
                    continue;
                }
                match raw.parse::<f64>() {
                    Ok(v) => {
                        let unit = INBODY_FIELDS.iter().find(|f| f.0 == field).map(|f| f.2).unwrap_or("");
                        values.insert(field.clone(), if unit == "kg" { mapping.mass_unit.to_kg(v) } else { v });
                    }
                    Err(_) => errors.push(format!("row {line}: {h} = {raw:?} isn't a number")),
                }
            }
            scans.push(InBodyScan { id: None, measured_at_local: date.format(TIME_FMT).to_string(), values, device: None, notes: None, source: mapping.source.clone() });
        }
        Ok(InBodyCsvPreview { headers, mapping, remembered: was_remembered, scans, errors })
    }

    /// Imports the scans and remembers the mapping for files with the same columns.
    pub fn import_inbody_csv(&mut self, text: &str, mapping: CsvMapping) -> Result<usize> {
        let preview = self.preview_inbody_csv(text, Some(mapping.clone()))?;
        let sig = header_signature(&preview.headers);
        self.conn().execute(
            "INSERT INTO csv_mapping (kind, signature, mapping) VALUES ('inbody', ?1, ?2)
             ON CONFLICT (kind, signature) DO UPDATE SET mapping = excluded.mapping",
            params![sig, serde_json::to_string(&mapping).expect("mapping serializes")],
        )?;
        let mut n = 0;
        for s in &preview.scans {
            let exists: Option<i64> =
                self.conn().query_row("SELECT id FROM inbody_scan WHERE measured_at_local = ?1", [&s.measured_at_local], |r| r.get(0)).optional()?;
            if exists.is_none() {
                self.save_inbody_scan(s)?;
                n += 1;
            }
        }
        Ok(n)
    }
}

// ---- Diet and energy balance --------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DietDay {
    pub date: String,
    pub calories: Option<f64>,
    pub protein_g: Option<f64>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct EnergyPoint {
    pub date: String,
    /// Smoothed bodyweight.
    pub trend_kg: f64,
    /// Energy surplus (+) or deficit (−) implied by the trend over the window, kcal/day.
    pub balance_kcal: Option<f64>,
    /// Average logged intake over the window, when enough days were logged.
    pub avg_intake_kcal: Option<f64>,
    /// Estimated expenditure = intake − balance.
    pub tdee_kcal: Option<f64>,
}

/// Energy balance from weigh-ins and (optional) intake.
///
/// - Trend weight: exponentially weighted average of weigh-ins, time-aware across gaps
///   (`alpha` per day; 0.1 ≈ a 10-day smoothing).
/// - Balance on day d: (trend(d) − trend(d − window)) × 7700 kcal/kg ÷ window.
/// - TDEE on day d: mean intake over the window's logged days − balance, when at least half
///   the window's days have intake logged. Days don't have to line up with weigh-ins.
pub fn energy_balance(weights: &[(NaiveDate, f64)], intake: &[(NaiveDate, f64)], window_days: i64, alpha: f64) -> Vec<EnergyPoint> {
    let mut daily: BTreeMap<NaiveDate, (f64, usize)> = BTreeMap::new();
    for &(d, w) in weights {
        let e = daily.entry(d).or_default();
        e.0 += w;
        e.1 += 1;
    }
    let (Some(&first), Some(&last)) = (daily.keys().next(), daily.keys().next_back()) else { return Vec::new() };
    let intake: HashMap<NaiveDate, f64> = intake.iter().copied().collect();

    // Trend for every calendar day from first to last weigh-in.
    let mut trend: Vec<(NaiveDate, f64)> = Vec::new();
    let mut t = daily[&first].0 / daily[&first].1 as f64;
    let mut d = first;
    while d <= last {
        if let Some(&(sum, n)) = daily.get(&d) {
            t += alpha * (sum / n as f64 - t);
        }
        trend.push((d, t));
        d += Duration::days(1);
    }
    let w = window_days.max(1) as usize;
    trend
        .iter()
        .enumerate()
        .map(|(i, &(d, t))| {
            let balance = (i >= w).then(|| (t - trend[i - w].1) * KCAL_PER_KG / w as f64);
            let logged: Vec<f64> = (0..w as i64).filter_map(|k| intake.get(&(d - Duration::days(k))).copied()).collect();
            let avg = (logged.len() * 2 >= w).then(|| logged.iter().sum::<f64>() / logged.len() as f64);
            EnergyPoint {
                date: d.to_string(),
                trend_kg: t,
                balance_kcal: balance,
                avg_intake_kcal: avg,
                tdee_kcal: avg.zip(balance).map(|(a, b)| a - b),
            }
        })
        .collect()
}

impl Db {
    pub fn diet_days(&self) -> Result<Vec<DietDay>> {
        let mut stmt = self.conn().prepare("SELECT date, calories, protein_g, notes FROM diet_day ORDER BY date")?;
        let rows = stmt.query_map([], |r| Ok(DietDay { date: r.get(0)?, calories: r.get(1)?, protein_g: r.get(2)?, notes: r.get(3)? }))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Saves a day; a day with nothing filled in is removed.
    pub fn save_diet_day(&mut self, d: &DietDay) -> Result<()> {
        NaiveDate::parse_from_str(&d.date, "%Y-%m-%d").map_err(|_| Error::Format(format!("bad date {:?}", d.date)))?;
        if d.calories.is_none() && d.protein_g.is_none() && d.notes.as_deref().unwrap_or("").trim().is_empty() {
            self.conn().execute("DELETE FROM diet_day WHERE date = ?1", [&d.date])?;
            return Ok(());
        }
        self.conn().execute(
            "INSERT INTO diet_day (date, calories, protein_g, notes) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (date) DO UPDATE SET calories = excluded.calories, protein_g = excluded.protein_g, notes = excluded.notes",
            params![d.date, d.calories, d.protein_g, d.notes],
        )?;
        Ok(())
    }

    pub fn energy_balance(&self, window_days: i64) -> Result<Vec<EnergyPoint>> {
        let parse = |s: &str| NaiveDate::parse_from_str(&s[..10], "%Y-%m-%d").ok();
        let weights: Vec<(NaiveDate, f64)> =
            self.weigh_ins(true)?.into_iter().filter_map(|w| parse(&w.at).map(|d| (d, w.weight_kg))).collect();
        let intake: Vec<(NaiveDate, f64)> =
            self.diet_days()?.into_iter().filter_map(|d| Some((parse(&d.date)?, d.calories?))).collect();
        Ok(energy_balance(&weights, &intake, window_days, 0.1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn energy_balance_recovers_known_surplus_and_tdee() {
        // Gaining exactly 0.5 kg/week on 2,800 kcal/day: surplus 550 kcal/day, TDEE 2,250.
        let start = NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
        let weights: Vec<_> = (0..120).step_by(2).map(|i| (start + Duration::days(i), 80.0 + 0.5 / 7.0 * i as f64)).collect();
        // Intake logged only on 5 of every 7 days, never matching weigh-in days exactly.
        let intake: Vec<_> = (0..120).filter(|i| i % 7 < 5).map(|i| (start + Duration::days(i), 2800.0)).collect();
        let pts = energy_balance(&weights, &intake, 14, 0.1);
        let late = pts.iter().rev().find(|p| p.tdee_kcal.is_some()).unwrap();
        assert!((late.balance_kcal.unwrap() - 550.0).abs() < 5.0, "{late:?}");
        assert!((late.tdee_kcal.unwrap() - 2250.0).abs() < 5.0, "{late:?}");
        assert!(pts[..14].iter().all(|p| p.balance_kcal.is_none()), "needs a full window");
    }

    #[test]
    fn energy_balance_without_intake() {
        let start = NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
        let weights: Vec<_> = (0..60).map(|i| (start + Duration::days(i), 90.0 - 0.1 * i as f64)).collect();
        let pts = energy_balance(&weights, &[], 14, 0.1);
        let last = pts.last().unwrap();
        assert!((last.balance_kcal.unwrap() + 770.0).abs() < 15.0, "{last:?}");
        assert_eq!(last.tdee_kcal, None);
    }

    #[test]
    fn edit_weigh_ins() {
        let mut db = Db::open_in_memory().unwrap();
        let t = |s: &str| NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap();
        db.add_weigh_in(t("2026-11-01 07:00:00"), 81.0).unwrap();
        db.add_weigh_in(t("2026-11-02 07:00:00"), 18.0).unwrap(); // typo
        let rows = db.weigh_ins(false).unwrap();
        db.update_weigh_in(rows[1].id, t("2026-11-02 07:30:00"), 81.2).unwrap();
        let rows = db.weigh_ins(false).unwrap();
        assert_eq!((rows[1].at.as_str(), rows[1].weight_kg), ("2026-11-02 07:30:00", 81.2));
        // Moving it onto another entry's exact time is refused rather than overwriting.
        assert!(db.update_weigh_in(rows[1].id, t("2026-11-01 07:00:00"), 81.2).is_err());
        assert!(db.update_weigh_in(rows[1].id, t("2026-11-02 07:30:00"), 0.0).is_err());
        assert_eq!(db.weigh_ins(false).unwrap().len(), 2);

        let m = db.add_measurement(t("2026-11-01 07:00:00"), "waist", 8.4).unwrap();
        db.update_measurement(m, t("2026-11-01 07:00:00"), 84.0).unwrap();
        assert_eq!(db.measurements(Some("waist")).unwrap()[0].value, 84.0);
    }

    #[test]
    fn body_measurements() {
        let mut db = Db::open_in_memory().unwrap();
        let t = |s: &str| NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap();
        db.add_measurement(t("2026-10-01 08:00:00"), "waist", 84.0).unwrap();
        db.add_measurement(t("2026-11-01 08:00:00"), "waist", 82.5).unwrap();
        db.add_measurement(t("2026-11-01 08:00:00"), "left_bicep", 38.0).unwrap();
        assert!(db.add_measurement(t("2026-11-01 08:00:00"), "elbow", 30.0).is_err());
        assert!(db.add_measurement(t("2026-11-01 08:00:00"), "neck", 0.0).is_err());
        let waist = db.measurements(Some("waist")).unwrap();
        assert_eq!(waist.iter().map(|m| m.value).collect::<Vec<_>>(), [84.0, 82.5]);
        assert_eq!(db.measurements(None).unwrap().len(), 3);
        let csv = db.export_measurements_csv(crate::units::WeightUnit::Kg).unwrap();
        assert!(csv.contains("2026-11-01 08:00:00,Waist,82.5,cm") && csv.contains("Left bicep,38,cm"), "{csv}");
        let inches = db.export_measurements_csv(crate::units::WeightUnit::Lb).unwrap();
        assert!(inches.contains("Waist,32.48,in"), "{inches}");
        db.delete_measurement(waist[0].id).unwrap();
        assert_eq!(db.measurements(Some("waist")).unwrap().len(), 1);
    }

    fn scan(at: &str, source: &str, values: &[(&str, f64)]) -> InBodyScan {
        InBodyScan {
            id: None,
            measured_at_local: at.into(),
            values: values.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
            device: None,
            notes: None,
            source: Some(source.into()),
        }
    }

    #[test]
    fn home_scale_scans_merge_and_stay_apart_from_inbody() {
        let mut db = Db::open_in_memory().unwrap();
        db.save_inbody_scan(&scan("2026-10-01 09:00:00", "inbody", &[("weight_kg", 80.0), ("pbf", 15.0)])).unwrap();
        // Over Bluetooth, then the same weigh-in from Health Connect a minute later.
        let (o, _) = db.merge_body_comp_scan(&scan("2026-11-01 07:00:10", "arboleaf", &[("weight_kg", 79.5), ("pbf", 19.0)])).unwrap();
        assert_eq!(o, MergeOutcome::Inserted);
        let (o, _) = db.merge_body_comp_scan(&scan("2026-11-01 07:01:00", "arboleaf", &[("pbf", 19.4), ("bone_mass_kg", 3.2)])).unwrap();
        assert_eq!(o, MergeOutcome::Merged);
        let (o, _) = db.merge_body_comp_scan(&scan("2026-11-01 07:01:00", "arboleaf", &[("pbf", 19.4)])).unwrap();
        assert_eq!(o, MergeOutcome::Unchanged);
        let scans = db.inbody_scans().unwrap();
        assert_eq!(scans.len(), 2);
        let a = &scans[1];
        assert_eq!((a.source(), a.values["pbf"], a.values["bone_mass_kg"]), ("arboleaf", 19.0, 3.2), "nothing overwritten");
        // The home scale's weight is a weigh-in; InBody's only shows when asked.
        let w = db.weigh_ins(false).unwrap();
        assert_eq!((w.len(), w[0].source.as_str(), w[0].weight_kg), (1, "arboleaf", 79.5));
        assert_eq!(db.weigh_ins(true).unwrap().len(), 2);
        // Analyses use one source: the most scans, InBody on a tie, or the chosen one.
        assert_eq!(db.analysis_source().unwrap().as_deref(), Some("inbody"));
        db.merge_body_comp_scan(&scan("2026-11-02 07:00:00", "arboleaf", &[("weight_kg", 79.4)])).unwrap();
        assert_eq!(db.analysis_source().unwrap().as_deref(), Some("arboleaf"));
        db.set_analysis_source(Some("inbody")).unwrap();
        assert!(db.analysis_scans().unwrap().iter().all(|s| s.source() == "inbody"));
        assert!(db.set_analysis_source(Some("Not Valid")).is_err());
        db.set_analysis_source(None).unwrap();
        assert_eq!(db.analysis_source().unwrap().as_deref(), Some("arboleaf"));
    }

    #[test]
    fn health_connect_body_composition() {
        use crate::wearables::{BodyCompSample, WearableImport, WeightSample};
        let mut db = Db::open_in_memory().unwrap();
        db.save_scale_profile(r#"{"id":"arboleaf","name":"Arboleaf","health_connect_packages":["com.example.Scale"]}"#).unwrap();
        let vals = |p: &[(&str, f64)]| p.iter().map(|(k, v)| (k.to_string(), *v)).collect();
        let data = WearableImport {
            weights: vec![WeightSample { at: "2026-11-03 07:00:00".into(), weight_kg: 79.0, source: "com.example.Scale".into() }],
            body_comp: vec![
                BodyCompSample { at: "2026-11-03 07:00:00".into(), source: "com.example.Scale".into(), values: vals(&[("weight_kg", 79.0), ("pbf", 18.0), ("bone_mass_kg", 3.1)]) },
                // A weight alone isn't a scan; unknown fields are dropped.
                BodyCompSample { at: "2026-11-04 07:00:00".into(), source: "com.example.Scale".into(), values: vals(&[("weight_kg", 78.8), ("mystery", 1.0)]) },
            ],
            ..Default::default()
        };
        let s = db.import_wearable(&data).unwrap();
        assert_eq!((s.weights, s.scans), (1, 1));
        let scans = db.inbody_scans().unwrap();
        assert_eq!((scans.len(), scans[0].source()), (1, "arboleaf"));
        // One weigh-in, filed under the profile, not two.
        let w = db.weigh_ins(false).unwrap();
        assert_eq!((w.len(), w[0].source.as_str()), (1, "arboleaf"));
        // Again: nothing new.
        assert_eq!(db.import_wearable(&data).unwrap().scans, 0);
        // An app no profile claims: its package (lowercase) is the scan's source, and its weight
        // isn't counted twice.
        let other = WearableImport {
            weights: vec![WeightSample { at: "2026-11-05 07:00:00".into(), weight_kg: 78.0, source: "com.Other.App".into() }],
            body_comp: vec![BodyCompSample { at: "2026-11-05 07:00:30".into(), source: "com.Other.App".into(), values: vals(&[("weight_kg", 78.0), ("pbf", 17.0)]) }],
            ..Default::default()
        };
        db.import_wearable(&other).unwrap();
        assert_eq!(db.inbody_scans().unwrap()[1].source(), "com.other.app");
        assert_eq!(db.weigh_ins(false).unwrap().len(), 2);
    }

    #[test]
    fn inbody_column_guesses() {
        for (h, f) in [
            ("Weight(kg)", "weight_kg"),
            ("Skeletal Muscle Mass", "smm_kg"),
            ("SMM", "smm_kg"),
            ("Body Fat Mass", "body_fat_mass_kg"),
            ("Percent Body Fat", "pbf"),
            ("PBF(%)", "pbf"),
            ("ECW/TBW", "ecw_tbw"),
            ("Visceral Fat Level", "visceral_fat_level"),
            ("Basal Metabolic Rate", "bmr_kcal"),
            ("Right Arm Lean Mass", "lean_right_arm_kg"),
            ("Lean Mass of Left Leg(%)", "lean_left_leg_pct"),
            ("Trunk Fat Mass", "fat_trunk_kg"),
            ("InBody Score", "inbody_score"),
            // Home-scale exports.
            ("Body Fat(%)", "pbf"),
            ("Body Fat", "pbf"),
            ("Fat Mass(lb)", "body_fat_mass_kg"),
            ("Body Water(%)", "body_water_pct"),
            ("Protein(%)", "protein_pct"),
            ("Skeletal Muscle(%)", "skeletal_muscle_pct"),
            ("Muscle Mass(kg)", "muscle_mass_kg"),
            ("Bone Mass", "bone_mass_kg"),
            ("Subcutaneous Fat(%)", "subcutaneous_fat_pct"),
            ("Metabolic Age", "metabolic_age"),
            ("Fat-free Body Weight", "fat_free_mass_kg"),
            ("Heart Rate", "heart_rate_bpm"),
            ("Impedance", "impedance_ohm"),
        ] {
            assert_eq!(guess_inbody_column(h), Some(f), "{h}");
        }
        assert_eq!(guess_inbody_column("Comments"), None);
    }
}
