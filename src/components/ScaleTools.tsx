import { useEffect, useRef, useState } from "react";
import { api, type BiaEstimate, type InBodyField, type InBodyScan, type PendingWeighIn, type ScaleDevice, type ScaleProfile } from "../api";
import { usePrefs } from "../App";
import { formatDate, formatTime, toUnit } from "../format";
import { saveOrShareText } from "../platform";
import { Modal, ask } from "./Modal";

/** Source label for a scan: its profile's name, else its source id. */
export function sourceName(profiles: ScaleProfile[], source: string | null | undefined): string {
  const id = source ?? "inbody";
  return profiles.find((p) => p.id === id)?.name ?? id;
}

/** "kg" fields shown in the display unit; others as stored. */
export function showValue(f: InBodyField | undefined, v: number, unit: "kg" | "lb"): string {
  if (!f) return String(v);
  if (f.unit === "kg") return `${toUnit(v, unit).toFixed(1)} ${unit}`;
  const suffix: Record<string, string> = { pct: "%", l: " L", kcal: " kcal", ohm: " Ω", bpm: " bpm", years: " y" };
  return `${Math.round(v * 100) / 100}${suffix[f.unit] ?? ""}`;
}

function ValuesTable({ scan, fields, unit }: { scan: InBodyScan; fields: InBodyField[]; unit: "kg" | "lb" }) {
  return (
    <table className="sets small">
      <tbody>
        {fields
          .filter((f) => scan.values[f.column] != null)
          .map((f) => (
            <tr key={f.column}>
              <td>{f.label}</td>
              <td>{showValue(f, scan.values[f.column], unit)}</td>
            </tr>
          ))}
      </tbody>
    </table>
  );
}

// ---- Bluetooth weigh-in ----------------------------------------------------------------------------

// ---- Weigh-ins to check -------------------------------------------------------------------------

/** Weigh-ins that may be someone else's (a shared scale or app), each waiting for "That's me" or
 *  "Not me". Shows nothing when there are none. */
export function PendingWeighIns({ onChanged }: { onChanged: () => void }) {
  const { unit } = usePrefs();
  const [items, setItems] = useState<PendingWeighIn[]>([]);
  const load = () => api.pendingWeighIns().then(setItems).catch(() => {});
  useEffect(() => {
    load();
  }, []);
  if (!items.length) return null;
  const resolve = async (id: number, mine: boolean) => {
    await api.resolvePendingWeighIn(id, mine);
    await load();
    onChanged();
  };
  return (
    <section className="card">
      <h2 className="section-title">
        {items.length} weigh-in{items.length > 1 ? "s" : ""} to check
      </h2>
      <p className="muted small">Someone else may have used the scale. Nothing here is saved until you say it's you.</p>
      {items.map((p) => (
        <div key={p.id} className="start-row">
          <span>
            <strong>
              {formatDate(p.scan.measured_at_local)} {formatTime(p.scan.measured_at_local)} ·{" "}
              {toUnit(p.scan.values.weight_kg, unit).toFixed(1)} {unit}
            </strong>
            {p.scan.values.pbf != null && <span className="muted"> · {p.scan.values.pbf}% fat</span>}
            <br />
            <span className="muted small">{p.reason.replace(/(-?\d+\.\d) kg/g, (_, kg) => `${toUnit(Number(kg), unit).toFixed(1)} ${unit}`)}</span>
          </span>
          <span className="row">
            <button className="button small primary" onClick={() => resolve(p.id, true)}>
              That's me
            </button>
            <button className="button small" onClick={() => resolve(p.id, false)}>
              Not me
            </button>
          </span>
        </div>
      ))}
    </section>
  );
}

/** Weigh in on a Bluetooth scale (Android): find it, connect, step on, save. It listens only while
 *  this is open. Weigh-ins the scale kept from while no phone was connected go to the
 *  weigh-ins-to-check list, since anyone in the household may have taken them. */
export function BluetoothWeighIn({
  profile,
  fields,
  unit,
  onClose,
  onSaved,
}: {
  profile: ScaleProfile;
  fields: InBodyField[];
  unit: "kg" | "lb";
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [devices, setDevices] = useState<ScaleDevice[] | null>(null);
  const [phase, setPhase] = useState<"scan" | "pick" | "connecting" | "ready" | "done" | "closed">("scan");
  const [live, setLive] = useState<{ kg: number; stable: boolean } | null>(null);
  const [reading, setReading] = useState<InBodyScan | null>(null);
  const [doubt, setDoubt] = useState<string | null>(null);
  const [held, setHeld] = useState(0);
  const slotKey = `scale_slot.${profile.id}`;
  const [slot, setSlot] = useState<number | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const scan = () => {
    setPhase("scan");
    setError(null);
    api
      .scaleBleScan(profile.id)
      .then((r) => {
        setDevices(r.devices);
        setPhase("pick");
      })
      .catch((e) => {
        setError(String(e));
        setPhase("pick");
      });
  };
  useEffect(() => {
    api.getSetting(slotKey).then((v) => setSlot(Number(v) || profile.bluetooth?.slot || 1));
    scan();
    return () => {
      if (timer.current) window.clearInterval(timer.current);
      api.scaleBleDisconnect().catch(() => {});
    };
  }, []);

  const connect = async (d: ScaleDevice) => {
    setError(null);
    setPhase("connecting");
    try {
      await api.scaleBleConnect(profile.id, d.address, unit);
    } catch (e) {
      setError(String(e));
      setPhase("pick");
      return;
    }
    let busy = false;
    timer.current = window.setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const p = await api.scaleBlePump();
        if (p.error) setError(p.error);
        if (p.notes.length) setNotes((n) => [...n, ...p.notes]);
        if (p.live_weight_kg != null) setLive({ kg: p.live_weight_kg, stable: p.stable });
        if (p.held) setHeld((n) => n + p.held);
        if (p.readings.length) {
          const r = p.readings[p.readings.length - 1];
          setReading(r);
          setPhase("done");
          api.weighInDoubt(r.measured_at_local, r.values.weight_kg).then(setDoubt).catch(() => {});
        } else if (p.state === "ready") setPhase((x) => (x === "connecting" ? "ready" : x));
        else if (p.state === "closed") setPhase((x) => (x === "done" ? x : "closed"));
      } catch (e) {
        setError(String(e));
      } finally {
        busy = false;
      }
    }, 200);
  };

  async function save(scans: InBodyScan[]) {
    try {
      const r = await api.mergeBodyCompScans(scans);
      const added = r.inserted + r.merged;
      onSaved(
        (added ? `Saved your weigh-in from the ${profile.name} scale.` : "Already saved.") +
          (held ? ` ${held} earlier weigh-in${held > 1 ? "s are" : " is"} waiting for you to check.` : ""),
      );
    } catch (e) {
      setError(String(e));
    }
  }

  const stop = () => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
    api.scaleBleDisconnect().catch(() => {});
    onClose();
  };

  const chooseSlot = (n: number) => {
    setSlot(n);
    api.setSetting(slotKey, String(n));
  };

  const shareLog = async () => saveOrShareText(`fitledger-${profile.id}-capture.txt`, "text/plain", await api.scaleBleLog());

  return (
    <Modal title={`Weigh in: ${profile.name}`} onClose={onClose} wide>
      {(phase === "scan" || phase === "pick") && slot !== null && (
        <label className="row small">
          You are user
          <select className="select inline" value={slot} onChange={(e) => chooseSlot(Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          on this scale
        </label>
      )}
      {(phase === "scan" || phase === "pick") && (
        <p className="muted small">
          Sharing the scale? Everyone picks a different number in FitLedger on their own phone, so the scale keeps your weigh-ins
          apart. The scale works out body composition from your height, age and sex, so only weigh in while it's connected to your
          own phone.
        </p>
      )}
      {phase === "scan" && <p className="small">Looking for the scale… step on it briefly to wake it up.</p>}
      {phase === "pick" && (
        <>
          {devices?.length ? (
            devices.map((d) => (
              <div key={d.address} className="start-row" onClick={() => connect(d)}>
                <span>
                  {d.name || "Unnamed scale"} <span className="muted small">{d.address}</span>
                </span>
                <span className="muted">Connect ›</span>
              </div>
            ))
          ) : (
            <p className="small">No scale found. Wake it (step on), close the vendor app, then search again.</p>
          )}
          <button className="button" onClick={scan}>
            Search again
          </button>
        </>
      )}
      {(phase === "connecting" || phase === "ready") && (
        <div className="stat">
          <div className="stat-value">{live ? `${toUnit(live.kg, unit).toFixed(1)} ${unit}` : "—"}</div>
          <div className="stat-label">
            {phase === "connecting"
              ? "Connecting…"
              : live?.stable
                ? "Hold still: measuring body composition (barefoot, hands on the handle)…"
                : "Step on barefoot and hold the handle."}
          </div>
        </div>
      )}
      {phase === "closed" && !reading && <p className="warn small">The scale disconnected before a result came through.</p>}
      {reading && (
        <>
          <p className="success small">
            {formatDate(reading.measured_at_local)} {formatTime(reading.measured_at_local)}
          </p>
          {doubt && (
            <p className="warn small">
              {doubt.replace(/(-?\d+\.\d) kg/g, (_, kg) => `${toUnit(Number(kg), unit).toFixed(1)} ${unit}`)}. Was this you?
            </p>
          )}
          <ValuesTable scan={reading} fields={fields} unit={unit} />
          <div className="row">
            <button className="button primary" onClick={() => save([reading])}>
              Save: that's me
            </button>
            <button className="button" onClick={stop}>
              Not me
            </button>
          </div>
        </>
      )}
      {held > 0 && (
        <p className="small">
          The scale also sent {held} weigh-in{held > 1 ? "s" : ""} it kept while no phone was connected. They wait under Measure for
          you to say which are yours.
        </p>
      )}
      {notes.map((n, i) => (
        <p key={i} className="warn small">
          {n}
        </p>
      ))}
      {error && <p className="error">{error}</p>}
      {phase !== "scan" && phase !== "pick" && (
        <p className="row small muted">
          FitLedger listens to the scale only while this window is open.
          <button className="button small" onClick={stop}>
            Stop listening
          </button>
        </p>
      )}
      <p className="muted small">
        Not working? Share the capture log: it records every byte exchanged with the scale, so the profile's Bluetooth settings can be
        tuned (and replayed under Scale profiles).{" "}
        <button className="button small" onClick={shareLog}>
          Share capture log
        </button>
      </p>
    </Modal>
  );
}

// ---- Scale profiles ----------------------------------------------------------------------------------

export function ScaleProfilesModal({
  profiles,
  fields,
  unit,
  onChanged,
  onClose,
}: {
  profiles: ScaleProfile[];
  fields: InBodyField[];
  unit: "kg" | "lb";
  onChanged: () => void;
  onClose: () => void;
}) {
  const [json, setJson] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replay, setReplay] = useState<{ profile: string; scans: InBodyScan[]; notes: string[] } | null>(null);

  const save = (text: string) =>
    api
      .saveScaleProfile(text)
      .then((p) => {
        setJson("");
        setError(null);
        setMsg(`Saved the ${p.name} profile.`);
        onChanged();
      })
      .catch((e) => setError(String(e)));
  const editable = (p: ScaleProfile) => {
    const { builtin: _, ...rest } = p;
    return JSON.stringify(rest, null, 2);
  };
  const runReplay = async (profile: string, file?: File) => {
    if (!file) return;
    try {
      const r = await api.scaleBleReplay(profile, await file.text(), unit);
      setReplay({ profile, scans: [...r.readings, ...r.stored], notes: r.notes });
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <Modal title="Scale profiles" onClose={onClose} wide>
      <p className="muted small">
        A profile says what a body-composition device reports: the labels its app prints (for reading screenshots), the Health Connect
        app that writes its data, and how to talk to it over Bluetooth. Edit a copy to tune one; a custom profile with the same id
        replaces the built-in one. Format: data/scales/README.md in the FitLedger repository.
      </p>
      {profiles.map((p) => (
        <details key={p.id} className="card">
          <summary>
            {p.name} <span className="chip">{p.builtin ? "built in" : "custom"}</span>
            {p.bluetooth && <span className="chip">Bluetooth</span>}
          </summary>
          {p.notes && <p className="small">{p.notes}</p>}
          {p.models.length > 0 && <p className="muted small">Models: {p.models.join(", ")}</p>}
          {Object.entries(p.field_notes).map(([k, v]) => (
            <p key={k} className="muted small">
              {fields.find((f) => f.column === k)?.label ?? k}: {v}
            </p>
          ))}
          <div className="row">
            <button className="button small" onClick={() => setJson(editable(p))}>
              Edit a copy
            </button>
            {p.bluetooth && (
              <label className="button small">
                Replay a capture log
                <input type="file" accept=".txt,text/plain" hidden onChange={(e) => runReplay(p.id, e.target.files?.[0])} />
              </label>
            )}
            {!p.builtin && (
              <button
                className="button small danger"
                onClick={() =>
                  ask(`Delete the ${p.name} profile? Its scans stay.`).then((ok) => {
                    if (ok) api.deleteScaleProfile(p.id).then(onChanged);
                  })
                }
              >
                Delete
              </button>
            )}
          </div>
        </details>
      ))}
      {replay && (
        <section className="card">
          <div className="section-label">Replay: {replay.scans.length} weigh-ins decoded</div>
          {replay.notes.map((n, i) => (
            <p key={i} className="warn small">
              {n}
            </p>
          ))}
          {replay.scans.map((s, i) => (
            <ValuesTable key={i} scan={s} fields={fields} unit={unit} />
          ))}
          {replay.scans.length > 0 && (
            <button
              className="button"
              onClick={() =>
                api.mergeBodyCompScans(replay.scans).then((r) => {
                  setMsg(`Saved ${r.inserted + r.merged}, ${r.unchanged} already there.`);
                  setReplay(null);
                  onChanged();
                })
              }
            >
              Save them
            </button>
          )}
        </section>
      )}
      <label>
        Profile JSON
        <textarea rows={10} value={json} placeholder='{"id": "myscale", "name": "My scale", "labels": {"pbf": ["Body Fat"]}}' onChange={(e) => setJson(e.target.value)} />
      </label>
      <div className="row">
        <button className="button primary" disabled={!json.trim()} onClick={() => save(json)}>
          Save profile
        </button>
        <label className="button">
          Load a profile file
          <input type="file" accept=".json,application/json" hidden onChange={async (e) => e.target.files?.[0] && save(await e.target.files[0].text())} />
        </label>
      </div>
      {msg && <p className="success small">{msg}</p>}
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}

// ---- Raw impedance --------------------------------------------------------------------------------

const SEGS: [string, string][] = [
  ["right_arm", "Right arm"],
  ["left_arm", "Left arm"],
  ["trunk", "Trunk"],
  ["right_leg", "Right leg"],
  ["left_leg", "Left leg"],
];

/** The latest scan with raw impedance: each segment at 20 and 100 kHz, and an open (published
 *  equation) estimate to set beside the device's own numbers. */
export function ImpedanceCard({ scans, profiles, unit }: { scans: InBodyScan[]; profiles: ScaleProfile[]; unit: "kg" | "lb" }) {
  const scan = [...scans].reverse().find((s) => Object.keys(s.values).some((k) => k.startsWith("imp") && k.endsWith("_ohm")));
  const [est, setEst] = useState<BiaEstimate | null>(null);
  useEffect(() => {
    setEst(null);
    if (scan) api.biaEstimate(scan.values).then(setEst);
  }, [scan?.id]);
  if (!scan) return null;
  const v = (seg: string, f: string) => scan.values[`imp_${seg}_${f}_ohm`];
  const segmental = SEGS.some(([s]) => v(s, "20k") != null);
  return (
    <section className="card">
      <div className="section-label">Raw impedance</div>
      <p className="muted small">
        {sourceName(profiles, scan.source)} · {formatDate(scan.measured_at_local)}
      </p>
      {segmental ? (
        <table className="sets small">
          <thead>
            <tr>
              <th></th>
              <th>20 kHz</th>
              <th>100 kHz</th>
            </tr>
          </thead>
          <tbody>
            {SEGS.map(([s, label]) => (
              <tr key={s}>
                <td>{label}</td>
                <td>{v(s, "20k") != null ? `${v(s, "20k")} Ω` : "—"}</td>
                <td>{v(s, "100k") != null ? `${v(s, "100k")} Ω` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="small">Whole body: {scan.values.impedance_ohm} Ω</p>
      )}
      {est ? (
        <>
          <p className="small">
            Open estimate ({est.method}, from {est.r50_interpolated ? "a 50 kHz value interpolated between 20 and 100 kHz" : "the measured resistance"}
            , right side hand to foot, R50 {est.r50} Ω): fat-free mass {toUnit(est.ffm_kg, unit).toFixed(1)} {unit}, body fat {est.fat_pct}%,
            total body water {est.tbw_l} L
            {scan.values.pbf != null && ` (the scale says ${scan.values.pbf}% fat)`}.
          </p>
          {est.ratio_100_20 != null && (
            <p className="muted small">
              100/20 kHz resistance ratio {est.ratio_100_20}: lower means relatively more water inside cells. Compare it with itself over
              time, same time of day and hydration.
            </p>
          )}
        </>
      ) : (
        <p className="muted small">Set your sex and height above for an open estimate from these numbers.</p>
      )}
    </section>
  );
}

