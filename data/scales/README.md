# Scale profiles

One JSON file per body-composition device family. FitCodex bundles these; users can add their own
(or override a bundled one with the same `id`) from Settings → Scale → Scale profiles, so a new scale
usually needs only a profile, not code.

```jsonc
{
  "id": "arboleaf",                 // lowercase; stored with every scan as its `source`
  "name": "Arboleaf",               // shown in the app
  "models": ["CS10P"],              // informational
  "notes": "…",                     // shown when choosing the profile
  "bluetooth": {                    // optional: weigh in over Bluetooth
    "protocol": "qn",               // only "qn" (Qingniu / QN-Scale family) so far
    "names": ["QN-Scale"],          // advertised names to look for
    "user_key": 1000,               // user key in the profile frame: the one the vendor app
                                    // registered users with (Arboleaf/Feelfit/GE apps: 1000)
    "algorithm": 4,                 // body-fat algorithm byte in the profile frame
    "slot": 1,                      // default user slot on the scale (1–8); each phone can pick
                                    // its own in the weigh-in window, so a household shares a scale
    "scrambled": null,              // impedance bytes scrambled? null = work it out
    "result_ack": true,             // acknowledge the result block (stops the scale resending it)
    "stored_records": true          // also fetch weigh-ins the scale kept while nothing was connected
  },
  "health_connect_packages": [],    // Health Connect data from these apps is filed under this profile
  "labels": {                       // field -> labels as printed in the vendor app (screenshots) or
    "pbf": ["Body Fat"]             // CSV headers; longest match wins, case and punctuation ignored
  },
  "field_notes": {}                 // field -> what this device means by it
}
```

Fields are the columns of `INBODY_FIELDS` in `crates/core/src/body.rs`. Masses are read in the unit
printed next to them (lb or kg), else in the app's display unit.
