//! Open estimates from raw bioimpedance, so a scan with impedance values can be checked against a
//! published equation rather than only the device's own (undisclosed) one.
//!
//! - Whole-body resistance is the right side, hand to foot: right arm + trunk + right leg, the path
//!   a standard tetrapolar hand-to-foot measurement takes.
//! - The equations are for 50 kHz. Scales with 20 and 100 kHz get a 50 kHz value by interpolating
//!   log-resistance against log-frequency between them (an approximation of the Cole curve).
//! - Sun et al. 2003 (Am J Clin Nutr 77:331–340), NHANES III adults, H in cm, W in kg, R in Ω:
//!   men   TBW = 1.20 + 0.45 H²/R + 0.18 W;  FFM = −10.68 + 0.65 H²/R + 0.26 W + 0.02 R
//!   women TBW = 3.75 + 0.45 H²/R + 0.11 W;  FFM = −9.53 + 0.69 H²/R + 0.17 W + 0.02 R

use std::collections::BTreeMap;

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BiaEstimate {
    /// Whole-body (right side) resistance at each frequency there is, Ω.
    pub r20: Option<f64>,
    pub r100: Option<f64>,
    /// At 50 kHz: measured (4-electrode scales) or interpolated.
    pub r50: f64,
    pub r50_interpolated: bool,
    /// 100 kHz over 20 kHz resistance: lower means relatively more intracellular water.
    pub ratio_100_20: Option<f64>,
    /// Height² / R50, cm²/Ω.
    pub impedance_index: f64,
    pub ffm_kg: f64,
    pub fat_pct: f64,
    pub tbw_l: f64,
    pub method: &'static str,
}

/// Interpolates resistance at `f` (kHz) between (f1, r1) and (f2, r2) on log–log axes.
pub fn interpolate(f: f64, (f1, r1): (f64, f64), (f2, r2): (f64, f64)) -> f64 {
    let t = (f / f1).ln() / (f2 / f1).ln();
    (r1.ln() + t * (r2.ln() - r1.ln())).exp()
}

/// From a scan's values (`INBODY_FIELDS` columns, Ω); `None` without impedance, weight or height.
pub fn estimate(values: &BTreeMap<String, f64>, height_cm: f64, female: bool) -> Option<BiaEstimate> {
    let w = *values.get("weight_kg")?;
    if !(height_cm > 0.0 && w > 0.0) {
        return None;
    }
    let side = |f: &str| -> Option<f64> {
        let get = |seg: &str| values.get(&format!("imp_{seg}_{f}_ohm")).copied().filter(|v| *v > 0.0);
        Some(get("right_arm")? + get("trunk")? + get("right_leg")?)
    };
    let (r20, r100) = (side("20k"), side("100k"));
    let (r50, interpolated) = match (r20, r100, values.get("impedance_ohm").copied().filter(|v| *v > 0.0)) {
        (Some(a), Some(b), _) => (interpolate(50.0, (20.0, a), (100.0, b)), true),
        (_, _, Some(r)) => (r, false),
        (Some(a), None, None) | (None, Some(a), None) => (a, true),
        (None, None, None) => return None,
    };
    let idx = height_cm * height_cm / r50;
    let (tbw, ffm) = if female {
        (3.75 + 0.45 * idx + 0.11 * w, -9.53 + 0.69 * idx + 0.17 * w + 0.02 * r50)
    } else {
        (1.20 + 0.45 * idx + 0.18 * w, -10.68 + 0.65 * idx + 0.26 * w + 0.02 * r50)
    };
    let r = |v: f64| (v * 10.0).round() / 10.0;
    Some(BiaEstimate {
        r20: r20.map(r),
        r100: r100.map(r),
        r50: r(r50),
        r50_interpolated: interpolated,
        ratio_100_20: r20.zip(r100).map(|(a, b)| (b / a * 1000.0).round() / 1000.0),
        impedance_index: r(idx),
        ffm_kg: r(ffm),
        fat_pct: r((1.0 - ffm / w) * 100.0),
        tbw_l: r(tbw),
        method: "Sun et al. 2003 (NHANES III)",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vals(pairs: &[(&str, f64)]) -> BTreeMap<String, f64> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    #[test]
    fn sun_equation_from_whole_body_resistance() {
        // Man, 180 cm, 80 kg, R50 500 Ω: H²/R = 64.8.
        let e = estimate(&vals(&[("weight_kg", 80.0), ("impedance_ohm", 500.0)]), 180.0, false).unwrap();
        assert_eq!(e.impedance_index, 64.8);
        assert_eq!(e.ffm_kg, 62.2); // −10.68 + 42.12 + 20.8 + 10
        assert_eq!(e.tbw_l, 44.8); // 1.2 + 29.16 + 14.4
        assert_eq!(e.fat_pct, 22.2);
        assert!(!e.r50_interpolated);
        let f = estimate(&vals(&[("weight_kg", 60.0), ("impedance_ohm", 600.0)]), 165.0, true).unwrap();
        assert_eq!(f.ffm_kg, 44.0); // −9.53 + 31.31 + 10.2 + 12
    }

    #[test]
    fn segments_interpolated_to_50_khz() {
        let v = vals(&[
            ("weight_kg", 80.0),
            ("imp_right_arm_20k_ohm", 320.0),
            ("imp_trunk_20k_ohm", 36.0),
            ("imp_right_leg_20k_ohm", 255.0),
            ("imp_right_arm_100k_ohm", 240.0),
            ("imp_trunk_100k_ohm", 30.0),
            ("imp_right_leg_100k_ohm", 228.0),
        ]);
        let e = estimate(&v, 180.0, false).unwrap();
        assert_eq!((e.r20, e.r100), (Some(611.0), Some(498.0)));
        assert!(e.r50 < 611.0 && e.r50 > 498.0 && e.r50_interpolated);
        assert!((interpolate(50.0, (20.0, 611.0), (100.0, 498.0)) - 611.0 * (498.0f64 / 611.0).powf((2.5f64).ln() / 5f64.ln())).abs() < 1e-9);
        assert_eq!(e.ratio_100_20, Some(0.815));
        assert!(estimate(&vals(&[("weight_kg", 80.0)]), 180.0, false).is_none());
    }
}
