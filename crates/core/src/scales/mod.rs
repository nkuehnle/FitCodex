//! Body-composition devices: scale profiles (what a device reports and how to reach it) and the
//! Bluetooth protocols FitLedger speaks.
//!
//! A profile is plain JSON (`data/scales/*.json` are bundled; users can add or override their own),
//! so supporting another app's screenshots, CSV headers or Health Connect package is configuration,
//! not code. See `data/scales/README.md` for the format.

pub mod bia;
pub mod qn;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::body::{INBODY_FIELDS, valid_source};
use crate::db::Db;
use crate::{Error, Result};

const BUNDLED: &[&str] = &[include_str!("../../../../data/scales/inbody.json"), include_str!("../../../../data/scales/arboleaf.json")];
const CUSTOM_KEY: &str = "scale_profiles";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScaleProfile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub bluetooth: Option<BluetoothConfig>,
    /// Health Connect data written by these apps is filed under this profile.
    #[serde(default)]
    pub health_connect_packages: Vec<String>,
    /// Field column -> labels as the vendor app prints them (screenshots) or CSV headers.
    #[serde(default)]
    pub labels: BTreeMap<String, Vec<String>>,
    /// Field column -> what this device means by it.
    #[serde(default)]
    pub field_notes: BTreeMap<String, String>,
    /// Set when listing: bundled with the app (a custom profile with the same id replaces it).
    #[serde(default, skip_deserializing)]
    pub builtin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BluetoothConfig {
    /// "qn" (Qingniu / QN-Scale family) is the only one so far.
    pub protocol: String,
    /// Advertised names to look for.
    #[serde(default)]
    pub names: Vec<String>,
    #[serde(default = "default_user_key")]
    pub user_key: u16,
    #[serde(default = "default_algorithm")]
    pub algorithm: u8,
    #[serde(default = "default_slot")]
    pub slot: u8,
    /// Impedance bytes scrambled; `None` works it out from the values.
    #[serde(default)]
    pub scrambled: Option<bool>,
    #[serde(default = "yes")]
    pub result_ack: bool,
    #[serde(default = "yes")]
    pub stored_records: bool,
}

fn default_user_key() -> u16 {
    8
}
fn default_algorithm() -> u8 {
    4
}
fn default_slot() -> u8 {
    1
}
fn yes() -> bool {
    true
}

impl ScaleProfile {
    pub fn validate(&self) -> Result<()> {
        if !valid_source(&self.id) {
            return Err(Error::Format(format!("profile id {:?}: use lowercase letters, digits, _ and -", self.id)));
        }
        if self.name.trim().is_empty() {
            return Err(Error::Format("profile needs a name".into()));
        }
        if let Some(bad) = self.labels.keys().chain(self.field_notes.keys()).find(|k| !INBODY_FIELDS.iter().any(|f| f.0 == k.as_str())) {
            return Err(Error::Format(format!("unknown field {bad:?}")));
        }
        if let Some(bt) = &self.bluetooth {
            if bt.protocol != "qn" {
                return Err(Error::Format(format!("unknown Bluetooth protocol {:?} (only \"qn\")", bt.protocol)));
            }
            if !(1..=8).contains(&bt.slot) {
                return Err(Error::Format("Bluetooth user slot must be 1–8".into()));
            }
        }
        Ok(())
    }
}

pub fn bundled_profiles() -> Vec<ScaleProfile> {
    BUNDLED
        .iter()
        .map(|j| {
            let mut p: ScaleProfile = serde_json::from_str(j).expect("bundled scale profile parses");
            p.builtin = true;
            p
        })
        .collect()
}

impl Db {
    fn custom_profiles(&self) -> Result<Vec<ScaleProfile>> {
        Ok(self.setting(CUSTOM_KEY)?.and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default())
    }

    /// Bundled profiles, with custom ones added or replacing a bundled one of the same id.
    pub fn scale_profiles(&self) -> Result<Vec<ScaleProfile>> {
        let mut out = bundled_profiles();
        for c in self.custom_profiles()? {
            match out.iter_mut().find(|p| p.id == c.id) {
                Some(p) => *p = c,
                None => out.push(c),
            }
        }
        Ok(out)
    }

    pub fn scale_profile(&self, id: &str) -> Result<ScaleProfile> {
        self.scale_profiles()?.into_iter().find(|p| p.id == id).ok_or_else(|| Error::Format(format!("no scale profile {id:?}")))
    }

    /// Adds or replaces a custom profile (JSON as in `data/scales/`).
    pub fn save_scale_profile(&mut self, json: &str) -> Result<ScaleProfile> {
        let p: ScaleProfile = serde_json::from_str(json).map_err(|e| Error::Format(format!("not a scale profile: {e}")))?;
        p.validate()?;
        let mut custom = self.custom_profiles()?;
        custom.retain(|c| c.id != p.id);
        custom.push(p.clone());
        self.set_setting(CUSTOM_KEY, &serde_json::to_string(&custom).expect("profiles serialize"))?;
        Ok(p)
    }

    /// Removes a custom profile (a bundled one it replaced comes back). Scans keep their source.
    pub fn delete_scale_profile(&mut self, id: &str) -> Result<()> {
        let mut custom = self.custom_profiles()?;
        custom.retain(|c| c.id != id);
        self.set_setting(CUSTOM_KEY, &serde_json::to_string(&custom).expect("profiles serialize"))
    }

    /// The profile that claims a Health Connect app's data (`health_connect_packages`).
    pub fn profile_for_package(&self, package: &str) -> Result<Option<String>> {
        Ok(self.scale_profiles()?.into_iter().find(|p| p.health_connect_packages.iter().any(|k| k == package)).map(|p| p.id))
    }

    /// The scan source for a Health Connect app: its profile, else the package name.
    pub fn source_for_package(&self, package: &str) -> Result<String> {
        Ok(self.profile_for_package(package)?.unwrap_or_else(|| package.to_ascii_lowercase()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_profiles_are_valid() {
        let all = bundled_profiles();
        assert!(all.iter().any(|p| p.id == "arboleaf" && p.bluetooth.is_some()));
        for p in &all {
            p.validate().unwrap_or_else(|e| panic!("{}: {e}", p.id));
        }
    }

    #[test]
    fn custom_profiles_add_and_override() {
        let mut db = Db::open_in_memory().unwrap();
        db.save_scale_profile(r#"{"id":"renpho","name":"Renpho","labels":{"pbf":["Body Fat"]},"health_connect_packages":["com.renpho.app"]}"#).unwrap();
        db.save_scale_profile(r#"{"id":"arboleaf","name":"Arboleaf (mine)","bluetooth":{"protocol":"qn","user_key":1000}}"#).unwrap();
        let all = db.scale_profiles().unwrap();
        let a = all.iter().find(|p| p.id == "arboleaf").unwrap();
        assert_eq!((a.name.as_str(), a.builtin, a.bluetooth.as_ref().unwrap().user_key), ("Arboleaf (mine)", false, 1000));
        assert_eq!(a.bluetooth.as_ref().unwrap().slot, 1, "defaults fill in");
        assert_eq!(db.source_for_package("com.renpho.app").unwrap(), "renpho");
        assert_eq!(db.source_for_package("com.example.Other").unwrap(), "com.example.other");
        db.delete_scale_profile("arboleaf").unwrap();
        assert!(db.scale_profile("arboleaf").unwrap().builtin);
        assert!(db.save_scale_profile(r#"{"id":"Bad Id","name":"x"}"#).is_err());
        assert!(db.save_scale_profile(r#"{"id":"x","name":"x","labels":{"nope":["a"]}}"#).is_err());
        assert!(db.save_scale_profile(r#"{"id":"x","name":"x","bluetooth":{"protocol":"yunmai"}}"#).is_err());
    }
}
