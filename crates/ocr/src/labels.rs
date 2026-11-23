//! Reads "label: value" screens (a scale app's results page, a report) of any layout: finds each
//! known label, then the number that goes with it, in the same row after it or, for tiles, the
//! nearest number straight above or below. Which labels mean which field comes from the caller (the
//! scale profile), so a new app needs only its labels.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use ocrs::{DecodeMethod, ImageSource, OcrEngine, OcrEngineParams, TextItem};
use rten_tensor::prelude::*;
use rten_tensor::NdTensor;
use serde::{Deserialize, Serialize};

use crate::{models, Error};

/// A field and the labels it goes by. `kind` is its unit kind (kg, pct, kcal, …) for plausibility
/// checks and unit handling.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LabelSpec {
    pub field: String,
    pub kind: String,
    pub labels: Vec<String>,
}

/// One recognised word and its box (pixels).
#[derive(Debug, Clone, PartialEq)]
pub struct Word {
    pub text: String,
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct LabeledRead {
    /// Field -> value as printed (masses in `units[field]`, else the caller's unit).
    pub values: BTreeMap<String, f64>,
    /// Field -> "lb" or "kg", where a mass had its unit printed next to it.
    pub units: BTreeMap<String, String>,
    /// "YYYY-MM-DD HH:MM:SS" when a date (and time) was on screen.
    pub measured_at: Option<String>,
    /// All the text read, line by line (for checking and for writing a profile).
    pub text: Vec<String>,
}

fn norm(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(|c| c.to_lowercase()).collect()
}

/// The number in a word, if it is one ("27.3%", "160.0lb", "1,704", "(2.4"), and a unit stuck to it.
fn number(word: &str) -> Option<(f64, Option<&'static str>)> {
    let lower = word.to_ascii_lowercase();
    let digits: String = lower.chars().filter(|c| c.is_ascii_digit() || *c == '.' || *c == ',').collect();
    let digits = digits.trim_matches(|c| c == '.' || c == ',');
    if !digits.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    // Mostly a number: a few unit letters at most.
    let letters = lower.chars().filter(|c| c.is_alphabetic()).count();
    if letters > 4 {
        return None;
    }
    // "1,704" is thousands; "27,3" a decimal comma.
    let v = if digits.contains(',') && !digits.contains('.') {
        let after = digits.rsplit(',').next().unwrap_or("");
        if after.len() == 3 { digits.replace(',', "") } else { digits.replace(',', ".") }
    } else {
        digits.replace(',', "")
    };
    let v: f64 = v.parse().ok()?;
    Some((v, unit_of(&lower)))
}

fn unit_of(s: &str) -> Option<&'static str> {
    let s = s.trim_matches(|c: char| !c.is_alphanumeric() && c != '%');
    // OCR often drops or misreads the "l" of "lb" ("b", "1b", "ib").
    if s.ends_with("lbs") || s.ends_with("lb") || s.ends_with("ib") || (s.ends_with('b') && !s.ends_with("kb")) {
        Some("lb")
    } else if s.ends_with("kg") {
        Some("kg")
    } else if s.ends_with('%') {
        Some("%")
    } else if s.ends_with("kcal") {
        Some("kcal")
    } else {
        None
    }
}

fn plausible(kind: &str, v: f64, unit: Option<&str>) -> bool {
    match kind {
        "kg" => {
            let kg = if unit == Some("lb") { v * 0.453_592_37 } else { v };
            (0.1..=400.0).contains(&kg) && unit != Some("%")
        }
        "pct" => (0.1..=95.0).contains(&v) && !matches!(unit, Some("lb" | "kg" | "kcal")),
        "kcal" => (400.0..=6000.0).contains(&v),
        "l" => (5.0..=120.0).contains(&v),
        "level" => (1.0..=60.0).contains(&v),
        "years" => (10.0..=110.0).contains(&v),
        "bpm" => (25.0..=230.0).contains(&v),
        "ohm" => (1.0..=2000.0).contains(&v),
        "ratio" => (0.0..=100.0).contains(&v),
        _ => v > 0.0,
    }
}

/// Groups words into rows: same row when their vertical centres are within half a word height.
fn rows(words: &[Word]) -> Vec<Vec<usize>> {
    let mut idx: Vec<usize> = (0..words.len()).collect();
    idx.sort_by(|&a, &b| (words[a].y0 + words[a].y1).total_cmp(&(words[b].y0 + words[b].y1)));
    let mut out: Vec<Vec<usize>> = Vec::new();
    for i in idx {
        let w = &words[i];
        let (c, h) = ((w.y0 + w.y1) / 2.0, (w.y1 - w.y0).max(1.0));
        match out.last_mut() {
            Some(row) if row.iter().any(|&j| ((words[j].y0 + words[j].y1) / 2.0 - c).abs() < h * 0.5) => row.push(i),
            _ => out.push(vec![i]),
        }
    }
    for row in &mut out {
        row.sort_by(|&a, &b| words[a].x0.total_cmp(&words[b].x0));
    }
    out
}

struct Found {
    /// Fields going by this label, in spec order (an app may print a mass or a % under one name).
    fields: Vec<usize>,
    /// Word indices of the label, in order.
    words: Vec<usize>,
}

/// Matches labels and values among recognised words.
pub fn match_labels(words: &[Word], specs: &[LabelSpec]) -> LabeledRead {
    let rows = rows(words);
    let mut out = LabeledRead { text: rows.iter().map(|r| r.iter().map(|&i| words[i].text.as_str()).collect::<Vec<_>>().join(" ")).collect(), ..Default::default() };

    // Every label (normalised word sequence), longest first, so "Body Fat Mass" beats "Body Fat".
    let mut labels: Vec<(usize, Vec<String>)> = specs
        .iter()
        .enumerate()
        .flat_map(|(i, s)| s.labels.iter().map(move |l| (i, l.split_whitespace().map(norm).filter(|w| !w.is_empty()).collect::<Vec<_>>())))
        .filter(|(_, l)| !l.is_empty())
        .collect();
    labels.sort_by_key(|(_, l)| std::cmp::Reverse(l.iter().map(|w| w.len()).sum::<usize>()));

    let normed: Vec<String> = words.iter().map(|w| norm(&w.text)).collect();
    let mut used: HashSet<usize> = HashSet::new();
    let mut found: Vec<Found> = Vec::new();
    for row in &rows {
        for (_, label) in &labels {
            let n = label.len();
            let mut start = 0;
            while start + n <= row.len() {
                let span = &row[start..start + n];
                if span.iter().zip(label).all(|(&i, l)| normed[i] == *l) && span.iter().all(|i| !used.contains(i)) {
                    used.extend(span.iter().copied());
                    let fields = labels.iter().filter(|(_, l)| l == label).map(|(f, _)| *f).collect::<BTreeSet<_>>().into_iter().collect();
                    found.push(Found { fields, words: span.to_vec() });
                    start += n;
                } else {
                    start += 1;
                }
            }
        }
    }
    let label_words: HashSet<usize> = used.clone();
    let row_of: BTreeMap<usize, usize> = rows.iter().enumerate().flat_map(|(r, ws)| ws.iter().map(move |&w| (w, r))).collect();
    let mut taken: HashSet<usize> = HashSet::new();
    // Labels in reading order.
    found.sort_by(|a, b| (row_of[&a.words[0]], words[a.words[0]].x0).partial_cmp(&(row_of[&b.words[0]], words[b.words[0]].x0)).unwrap());

    let value_at = |i: usize| -> Option<(f64, Option<&'static str>)> {
        let (v, mut unit) = number(&words[i].text)?;
        // A unit printed as its own word right after the number.
        if unit.is_none() {
            let row = &rows[row_of[&i]];
            let pos = row.iter().position(|&j| j == i)?;
            if let Some(&next) = row.get(pos + 1) {
                if number(&words[next].text).is_none() {
                    unit = unit_of(&words[next].text.to_ascii_lowercase());
                }
            }
        }
        Some((v, unit))
    };

    let value_for = |f: &Found, spec: &LabelSpec, taken: &HashSet<usize>| -> Option<(usize, f64, Option<&'static str>)> {
        let row = &rows[row_of[&f.words[0]]];
        let last = *f.words.last().unwrap();
        let after = row.iter().position(|&j| j == last).unwrap() + 1;
        let ok = |i: usize| -> Option<(f64, Option<&'static str>)> {
            if taken.contains(&i) || label_words.contains(&i) {
                return None;
            }
            value_at(i).filter(|(v, u)| plausible(&spec.kind, *v, *u))
        };
        // Same row, after the label and before the next label.
        let mut pick = row[after..].iter().take_while(|j| !label_words.contains(j)).find_map(|&i| ok(i).map(|v| (i, v)));
        // Else the nearest number in the label's column, above or below.
        if pick.is_none() {
            let (lx0, lx1) = (words[f.words[0]].x0, words[last].x1);
            let (ly0, ly1) = (f.words.iter().map(|&i| words[i].y0).fold(f32::MAX, f32::min), f.words.iter().map(|&i| words[i].y1).fold(f32::MIN, f32::max));
            let h = (ly1 - ly0).max(1.0);
            pick = (0..words.len())
                .filter(|&i| row_of[&i] != row_of[&f.words[0]])
                .filter(|&i| {
                    let (cx, w) = ((words[i].x0 + words[i].x1) / 2.0, &words[i]);
                    (cx >= lx0 - h && cx <= lx1 + h) || (w.x0 <= lx1 && w.x1 >= lx0)
                })
                .filter_map(|i| {
                    let gap = if words[i].y1 <= ly0 { ly0 - words[i].y1 } else { words[i].y0 - ly1 };
                    (gap >= -h * 0.25 && gap <= h * 4.0).then_some((gap.max(0.0), words[i].y1 <= ly0, i))
                })
                .filter_map(|(gap, above, i)| ok(i).map(|v| (gap, above, i, v)))
                .min_by(|a, b| a.0.total_cmp(&b.0).then(b.1.cmp(&a.1)))
                .map(|(_, _, i, v)| (i, v));
        }
        pick.map(|(i, (v, u))| (i, v, u))
    };

    for f in &found {
        for &field in &f.fields {
            let spec = &specs[field];
            if out.values.contains_key(&spec.field) {
                continue;
            }
            if let Some((i, v, unit)) = value_for(f, spec, &taken) {
                taken.insert(i);
                out.values.insert(spec.field.clone(), v);
                if spec.kind == "kg" {
                    if let Some(u @ ("lb" | "kg")) = unit {
                        out.units.insert(spec.field.clone(), u.to_string());
                    }
                }
                break;
            }
        }
    }
    // The weight is often the headline with its label far above it (or none): the largest
    // plausible number on screen.
    if let Some(spec) = specs.iter().find(|s| s.field == "weight_kg" && !out.values.contains_key("weight_kg")) {
        let biggest = (0..words.len())
            .filter(|i| !taken.contains(i) && !label_words.contains(i))
            .filter_map(|i| value_at(i).filter(|(v, u)| *v >= 20.0 && plausible(&spec.kind, *v, *u)).map(|v| (i, v)))
            .max_by(|a, b| (words[a.0].y1 - words[a.0].y0).total_cmp(&(words[b.0].y1 - words[b.0].y0)));
        if let Some((i, (v, unit))) = biggest {
            // Only a clear headline: much taller than the labels.
            let label_h = label_words.iter().map(|&j| words[j].y1 - words[j].y0).fold(0.0, f32::max);
            if words[i].y1 - words[i].y0 > label_h * 1.5 {
                out.values.insert(spec.field.clone(), v);
                let unit = unit.or_else(|| unit_near(words, i));
                if let Some(u @ ("lb" | "kg")) = unit {
                    out.units.insert(spec.field.clone(), u.to_string());
                }
            }
        }
    }
    out.measured_at = find_datetime(&out.text.join(" "));
    out
}

/// A unit printed in its own word just right of or below word `i` ("182" then a small "lb").
fn unit_near(words: &[Word], i: usize) -> Option<&'static str> {
    let w = &words[i];
    let h = w.y1 - w.y0;
    words
        .iter()
        .filter(|o| o.x0 >= w.x1 - h * 0.2 && o.x0 <= w.x1 + h && o.y0 < w.y1 + h * 0.2 && o.y1 > w.y0)
        .find_map(|o| match unit_of(&o.text.to_ascii_lowercase()) {
            Some(u @ ("lb" | "kg")) if o.text.len() <= 3 => Some(u),
            _ => None,
        })
}

/// A date (and time) in the text: 2025-04-24, 2025/04/24, 04/24/2025 (US order unless the first part
/// is over 12), optionally followed by HH:MM.
pub fn find_datetime(text: &str) -> Option<String> {
    let re_ok = |y: u32, m: u32, d: u32| (2000..2100).contains(&y) && (1..=12).contains(&m) && (1..=31).contains(&d);
    let toks: Vec<&str> = text.split_whitespace().collect();
    for (i, t) in toks.iter().enumerate() {
        let parts: Vec<u32> = t.split(|c| c == '-' || c == '/' || c == '.').filter(|p| !p.is_empty()).map(|p| p.trim_matches(|c: char| !c.is_ascii_digit()).parse().ok()).collect::<Option<_>>().unwrap_or_default();
        if parts.len() != 3 {
            continue;
        }
        let (y, m, d) = if parts[0] > 999 {
            (parts[0], parts[1], parts[2])
        } else if parts[2] > 999 {
            if parts[0] > 12 { (parts[2], parts[1], parts[0]) } else { (parts[2], parts[0], parts[1]) }
        } else {
            continue;
        };
        if !re_ok(y, m, d) {
            continue;
        }
        let time = toks.get(i + 1).and_then(|t| {
            let hm: Vec<u32> = t.split(':').map(|p| p.trim_matches(|c: char| !c.is_ascii_digit()).parse().ok()).collect::<Option<_>>()?;
            let pm = toks.get(i + 2).is_some_and(|s| s.eq_ignore_ascii_case("pm"));
            match hm[..] {
                [h, m, ..] if h < 24 && m < 60 => Some((if pm && h < 12 { h + 12 } else { h }, m)),
                _ => None,
            }
        });
        let (h, mi) = time.unwrap_or((0, 0));
        return Some(format!("{y:04}-{m:02}-{d:02} {h:02}:{mi:02}:00"));
    }
    None
}

/// Recognises every word in an image (a phone screenshot or photo of a screen) with positions.
pub fn read_words(image_bytes: &[u8], model_dir: &std::path::Path) -> Result<Vec<Word>, Error> {
    let img = image::load_from_memory(image_bytes).map_err(|e| Error(format!("couldn't read the image: {e}")))?.into_rgb8();
    let (detection, recognition) = models(model_dir)?;
    let engine = OcrEngine::new(OcrEngineParams {
        detection_model: Some(detection),
        recognition_model: Some(recognition),
        decode_method: DecodeMethod::BeamSearch { width: 20 },
        ..Default::default()
    })
    .map_err(|e| Error(e.to_string()))?;
    let (w, h) = img.dimensions();
    let tensor = NdTensor::from_data([h as usize, w as usize, 3], img.into_vec());
    let source = ImageSource::from_tensor(tensor.view(), ocrs::DimOrder::Hwc).map_err(|e| Error(e.to_string()))?;
    let input = engine.prepare_input(source).map_err(|e| Error(e.to_string()))?;
    let found = engine.detect_words(&input).map_err(|e| Error(e.to_string()))?;
    let lines = engine.find_text_lines(&input, &found);
    let texts = engine.recognize_text(&input, &lines).map_err(|e| Error(e.to_string()))?;
    let mut out = Vec::new();
    for line in texts.into_iter().flatten() {
        for word in line.words() {
            let r = word.bounding_rect();
            out.push(Word { text: word.to_string(), x0: r.left() as f32, y0: r.top() as f32, x1: r.right() as f32, y1: r.bottom() as f32 });
        }
    }
    Ok(out)
}

/// Reads a screenshot with the labels in `specs`.
pub fn read_labeled(image_bytes: &[u8], model_dir: &std::path::Path, specs: &[LabelSpec]) -> Result<LabeledRead, Error> {
    Ok(match_labels(&read_words(image_bytes, model_dir)?, specs))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(field: &str, kind: &str, labels: &[&str]) -> LabelSpec {
        LabelSpec { field: field.into(), kind: kind.into(), labels: labels.iter().map(|s| s.to_string()).collect() }
    }

    fn specs() -> Vec<LabelSpec> {
        vec![
            spec("weight_kg", "kg", &["Weight"]),
            spec("pbf", "pct", &["Body Fat"]),
            spec("body_fat_mass_kg", "kg", &["Fat Mass", "Body Fat Mass"]),
            spec("body_water_pct", "pct", &["Body Water"]),
            spec("bone_mass_kg", "kg", &["Bone Mass"]),
            spec("bmr_kcal", "kcal", &["BMR"]),
            spec("bmi", "ratio", &["BMI"]),
            spec("visceral_fat_level", "level", &["Visceral Fat"]),
        ]
    }

    /// Words laid out left to right from `x`, 20 px tall at `y`, 10 px a character.
    fn line(x: f32, y: f32, text: &str) -> Vec<Word> {
        let mut x = x;
        text.split_whitespace()
            .map(|t| {
                let w = Word { text: t.into(), x0: x, y0: y, x1: x + 10.0 * t.len() as f32, y1: y + 20.0 };
                x = w.x1 + 10.0;
                w
            })
            .collect()
    }

    #[test]
    fn headline_weight_and_a_mass_named_like_a_percent() {
        let mut words = line(200.0, 10.0, "Weight");
        // The headline: big, far below its title, its "lb" small and to the right.
        words.push(Word { text: "182".into(), x0: 150.0, y0: 300.0, x1: 330.0, y1: 380.0 });
        words.push(Word { text: "lb".into(), x0: 340.0, y0: 350.0, x1: 370.0, y1: 372.0 });
        words.extend(line(20.0, 500.0, "Skeletal Muscle 83.8 lb"));
        let specs = [
            spec("weight_kg", "kg", &["Weight"]),
            spec("skeletal_muscle_pct", "pct", &["Skeletal Muscle"]),
            spec("smm_kg", "kg", &["Skeletal Muscle"]),
        ];
        let r = match_labels(&words, &specs);
        assert_eq!((r.values["weight_kg"], r.units["weight_kg"].as_str()), (182.0, "lb"));
        assert_eq!((r.values["smm_kg"], r.units["smm_kg"].as_str()), (83.8, "lb"));
        assert!(!r.values.contains_key("skeletal_muscle_pct"));
    }

    #[test]
    fn list_layout() {
        let words = [
            line(20.0, 10.0, "04/24/2025 10:09 AM"),
            line(20.0, 60.0, "Weight 160.0 lb"),
            line(20.0, 100.0, "Body Fat 27.3%"),
            line(20.0, 140.0, "Body Fat Mass 43.7lb"),
            line(20.0, 180.0, "Body Water 53.4 %"),
            line(20.0, 220.0, "BMR 1,704 kcal"),
            line(20.0, 260.0, "Steps 9000"),
        ]
        .concat();
        let r = match_labels(&words, &specs());
        assert_eq!(r.values["weight_kg"], 160.0);
        assert_eq!(r.units["weight_kg"], "lb");
        assert_eq!(r.values["pbf"], 27.3);
        assert_eq!(r.values["body_fat_mass_kg"], 43.7, "longest label wins");
        assert_eq!(r.units["body_fat_mass_kg"], "lb");
        assert_eq!(r.values["body_water_pct"], 53.4);
        assert_eq!(r.values["bmr_kcal"], 1704.0);
        assert_eq!(r.measured_at.as_deref(), Some("2025-04-24 10:09:00"));
    }

    #[test]
    fn tiles_and_two_per_row() {
        // Value above its label, two tiles per row, plus a row with two label/value pairs.
        let words = [
            line(20.0, 10.0, "27.3%"),
            line(220.0, 10.0, "24.3"),
            line(20.0, 40.0, "Body Fat"),
            line(220.0, 40.0, "BMI"),
            line(20.0, 120.0, "Bone Mass 5.4 lb Visceral Fat 9"),
        ]
        .concat();
        let r = match_labels(&words, &specs());
        assert_eq!((r.values["pbf"], r.values["bmi"]), (27.3, 24.3));
        assert_eq!((r.values["bone_mass_kg"], r.values["visceral_fat_level"]), (5.4, 9.0));
        assert_eq!(r.units["bone_mass_kg"], "lb");
        assert_eq!(r.measured_at, None);
    }

    #[test]
    fn implausible_numbers_are_skipped() {
        // A percent where a body fat can't be, and a body fat that's really a date.
        let words = [line(20.0, 10.0, "Body Fat 2025 27.3%"), line(20.0, 60.0, "Weight 72.5%")].concat();
        let r = match_labels(&words, &specs());
        assert_eq!(r.values["pbf"], 27.3);
        assert!(!r.values.contains_key("weight_kg"));
    }

    #[test]
    fn numbers_and_dates() {
        assert_eq!(number("27,3%"), Some((27.3, Some("%"))));
        assert_eq!(number("1,704"), Some((1704.0, None)));
        assert_eq!(number("(2.4"), Some((2.4, None)));
        assert_eq!(number("Weight"), None);
        assert_eq!(number("43.7b"), Some((43.7, Some("lb"))), "OCR lost the l");
        assert_eq!(find_datetime("Measured 2026-11-02 7:05"), Some("2026-11-02 07:05:00".into()));
        assert_eq!(find_datetime("24/04/2025"), Some("2025-04-24 00:00:00".into()));
        assert_eq!(find_datetime("4/5/2025 1:30 PM"), Some("2025-04-05 13:30:00".into()));
    }
}
