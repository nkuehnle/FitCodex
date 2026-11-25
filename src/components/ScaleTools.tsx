import { useEffect, useRef, useState } from "react";
import { api, type BiaEstimate, type InBodyField, type InBodyScan, type PendingWeighIn, type ScaleDevice, type ScaleProfile } from "../api";
import { usePrefs } from "../App";
import { formatDate, formatTime, toUnit } from "../format";
import { IS_ANDROID, saveOrShareText } from "../platform";
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

// ---- Quick weigh-in ---------------------------------------------------------------------------------

/** Setting: the scale profile the quick weigh-in button uses (empty: type the weight in). */
export const QUICK_WEIGH_IN_KEY = "quick_weigh_in";
/** Settings per scale profile: the scale this phone weighs in on, and your user number on it. */
const addressKey = (profile: string) => `scale_address.${profile}`;
const slotKey = (profile: string) => `scale_slot.${profile}`;

/** The profile id the weigh-in button uses ("" to type it in). Never chosen: a Bluetooth scale
 *  you've weighed in on. */
async function quickScaleId(ps: ScaleProfile[]): Promise<string> {
  const v = await api.getSetting(QUICK_WEIGH_IN_KEY);
  if (v != null) return v;
  const used = new Set((await api.inbodyScans()).map((s) => s.source));
  return ps.find((p) => p.bluetooth && used.has(p.id))?.id ?? "";
}

/** The Bluetooth scale chosen for quick weigh-ins (Android): undefined while loading, null for
 *  "type it in". */
export function useQuickScale(): ScaleProfile | null | undefined {
  const [p, setP] = useState<ScaleProfile | null | undefined>(IS_ANDROID ? undefined : null);
  useEffect(() => {
    if (!IS_ANDROID) return;
    api
      .scaleProfiles()
      .then(async (ps) => {
        const id = await quickScaleId(ps);
        setP(ps.find((x) => x.id === id && x.bluetooth) ?? null);
      })
      .catch(() => setP(null));
  }, []);
  return p;
}

/** One-tap Bluetooth weigh-in on the scale chosen in Settings; nothing when weigh-ins are typed in. */
export function QuickScaleButton({
  onSaved,
  label = "⚖ Weigh in",
  autoOpen = false,
  onAutoOpened,
}: {
  onSaved: (msg: string) => void;
  label?: string;
  /** Starts the weigh-in right away (the home-screen widget's ⚖ Weigh in), then calls onAutoOpened. */
  autoOpen?: boolean;
  onAutoOpened?: () => void;
}) {
  const profile = useQuickScale();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!autoOpen || !profile) return;
    setOpen(true);
    onAutoOpened?.();
  }, [autoOpen, profile]);
  if (!profile) return null;
  return (
    <>
      <button className="button" title={`Weigh in on the ${profile.name} scale`} onClick={() => setOpen(true)}>
        {label}
      </button>
      {open && <BluetoothWeighIn profile={profile} onClose={() => setOpen(false)} onSaved={onSaved} />}
    </>
  );
}

// ---- Scale settings -----------------------------------------------------------------------------

/** Settings › Scale: what the weigh-in button does, which scale this phone uses, your user number
 *  on it, and the scale profiles. */
export function ScaleSettings() {
  const { unit } = usePrefs();
  const [profiles, setProfiles] = useState<ScaleProfile[]>([]);
  const [fields, setFields] = useState<InBodyField[]>([]);
  const [quick, setQuick] = useState<string | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [slot, setSlot] = useState(1);
  const [setup, setSetup] = useState(false);
  const [showProfiles, setShowProfiles] = useState(false);
  const loadProfiles = () => api.scaleProfiles().then(setProfiles);
  useEffect(() => {
    api.scaleProfiles().then(async (ps) => {
      setProfiles(ps);
      setQuick(await quickScaleId(ps));
    });
    api.inbodyFields().then(setFields);
  }, []);
  const scale = profiles.find((p) => p.id === quick && p.bluetooth);
  useEffect(() => {
    if (!scale) return;
    api.getSetting(addressKey(scale.id)).then(setAddress);
    api.getSetting(slotKey(scale.id)).then((v) => setSlot(Number(v) || scale.bluetooth?.slot || 1));
  }, [scale?.id]);
  const bluetooth = profiles.filter((p) => p.bluetooth);

  return (
    <section className="card">
      <h2 className="section-title">Scale</h2>
      {IS_ANDROID && quick !== null && bluetooth.length > 0 && (
        <label className="row small">
          Weigh-in button
          <select
            className="select inline"
            value={quick}
            onChange={(e) => {
              setQuick(e.target.value);
              api.setSetting(QUICK_WEIGH_IN_KEY, e.target.value);
            }}
          >
            <option value="">Type it in</option>
            {bluetooth.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} scale (Bluetooth)
              </option>
            ))}
          </select>
        </label>
      )}
      {IS_ANDROID && scale && (
        <>
          <p className="row small">
            {address ? `This phone uses the ${scale.name} scale ${address}.` : "No scale set up yet: the first one found when you weigh in is kept."}
            <button className="button small" onClick={() => setSetup(true)}>
              {address ? "Change" : "Set up scale"}
            </button>
            {address && (
              <button
                className="button small"
                onClick={() => {
                  api.setSetting(addressKey(scale.id), "");
                  setAddress(null);
                }}
              >
                Forget
              </button>
            )}
          </p>
          <label className="row small">
            You are user
            <select
              className="select inline"
              value={slot}
              onChange={(e) => {
                setSlot(Number(e.target.value));
                api.setSetting(slotKey(scale.id), e.target.value);
              }}
            >
              {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            on it
          </label>
          <p className="muted small">
            Sharing the scale? Everyone picks a different number on their own phone. User 1 is the first user in the {scale.name} app; on
            many models only user 1 gets the scale's own body composition.
          </p>
        </>
      )}
      <p className="row small muted">
        Scale profiles say what each scale or app reports and how to talk to it.
        <button className="button small" onClick={() => setShowProfiles(true)}>
          Scale profiles
        </button>
      </p>
      {setup && scale && (
        <ScaleSetup
          profile={scale}
          onClose={() => setSetup(false)}
          onDone={(a) => {
            setAddress(a);
            setSetup(false);
          }}
        />
      )}
      {showProfiles && (
        <ScaleProfilesModal profiles={profiles} fields={fields} unit={unit} onChanged={loadProfiles} onClose={() => setShowProfiles(false)} />
      )}
    </section>
  );
}

/** Nearby scales (and, folded, other Bluetooth devices) to pick from. */
function DeviceList({ devices, others, onPick }: { devices: ScaleDevice[]; others: ScaleDevice[]; onPick: (d: ScaleDevice) => void }) {
  const row = (d: ScaleDevice) => (
    <div key={d.address} className="start-row" onClick={() => onPick(d)}>
      <span>
        {d.name || "Unnamed"} <span className="muted small">{d.address}</span>
      </span>
      <span className="muted">Use ›</span>
    </div>
  );
  return (
    <>
      {devices.map(row)}
      {others.length > 0 && (
        <details className="small">
          <summary>Other Bluetooth devices nearby ({others.length})</summary>
          <p className="muted">If your scale is one of these (it shows only while awake), pick it here.</p>
          {others.map(row)}
        </details>
      )}
    </>
  );
}

/** Finds the scale and connects once, without weighing in, to keep it for this phone. */
function ScaleSetup({ profile, onClose, onDone }: { profile: ScaleProfile; onClose: () => void; onDone: (address: string) => void }) {
  const [found, setFound] = useState<{ devices: ScaleDevice[]; others: ScaleDevice[] } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const scan = () => {
    setFound(null);
    setError(null);
    api
      .scaleBleScan(profile.id)
      .then((r) => setFound({ devices: r.devices, others: r.others ?? [] }))
      .catch((e) => {
        setError(String(e));
        setFound({ devices: [], others: [] });
      });
  };
  useEffect(() => {
    scan();
    return () => {
      alive.current = false;
      api.scaleBleDisconnect().catch(() => {});
    };
  }, []);
  const pick = async (d: ScaleDevice) => {
    setError(null);
    setStatus(`Connecting to ${d.name || d.address}…`);
    try {
      await api.scaleBleConnect(profile.id, d.address, "kg");
      for (let i = 0; i < 75 && alive.current; i++) {
        const p = await api.scaleBlePump();
        if (p.state === "ready") {
          await api.setSetting(addressKey(profile.id), d.address);
          await api.scaleBleDisconnect();
          return onDone(d.address);
        }
        if (p.state === "closed") throw new Error(p.error ?? "the scale disconnected");
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error("no answer from the scale");
    } catch (e) {
      api.scaleBleDisconnect().catch(() => {});
      setStatus(null);
      setError(`Couldn't connect (${e instanceof Error ? e.message : e}). Wake the scale and try again.`);
    }
  };
  return (
    <Modal title={`Set up your ${profile.name} scale`} onClose={onClose}>
      <p className="small">Wake the scale (tap it or step on it), and close the {profile.name} app. Nothing is weighed or saved.</p>
      {status ? (
        <p className="small">{status}</p>
      ) : found ? (
        <>
          {!found.devices.length && <p className="small">No scale found yet.</p>}
          <DeviceList devices={found.devices} others={found.others} onPick={pick} />
          <button className="button" onClick={scan}>
            Search again
          </button>
        </>
      ) : (
        <p className="small">Looking for the scale…</p>
      )}
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}

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

/** Weigh in on a Bluetooth scale (Android): finds the scale this phone uses (the first one found
 *  becomes it), connects, and saves the weigh-in when it's done; one that may be someone else's waits
 *  for "That's me". It listens only while this is open. Weigh-ins the scale kept from while no phone
 *  was connected are held for checking (see `PendingWeighIns`). */
export function BluetoothWeighIn({ profile, onClose, onSaved }: { profile: ScaleProfile; onClose: () => void; onSaved: (msg: string) => void }) {
  const { unit } = usePrefs();
  const [fields, setFields] = useState<InBodyField[]>([]);
  const [phase, setPhase] = useState<"search" | "pick" | "connecting" | "ready" | "done" | "closed">("search");
  const [found, setFound] = useState<{ devices: ScaleDevice[]; others: ScaleDevice[] }>({ devices: [], others: [] });
  const [live, setLive] = useState<{ kg: number; stable: boolean } | null>(null);
  const [reading, setReading] = useState<InBodyScan | null>(null);
  const [saved, setSaved] = useState(false);
  const [doubt, setDoubt] = useState<string | null>(null);
  const [held, setHeld] = useState(0);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const alive = useRef(true);
  const heldRef = useRef(0);

  const search = async (tries = 0): Promise<void> => {
    if (!alive.current) return;
    setPhase("search");
    setError(null);
    const remembered = (await api.getSetting(addressKey(profile.id)).catch(() => null)) || null;
    try {
      const r = await api.scaleBleScan(profile.id, remembered);
      if (!alive.current) return;
      const all = [...r.devices, ...(r.others ?? [])];
      const mine = remembered ? all.find((d) => d.address.toLowerCase() === remembered.toLowerCase()) : r.devices.length === 1 ? r.devices[0] : undefined;
      if (mine) return connect(mine);
      setFound({ devices: r.devices, others: r.others ?? [] });
      // Keep looking a while: the scale shows up once it's woken.
      if ((remembered || !r.devices.length) && tries < 2) return search(tries + 1);
      setPhase("pick");
    } catch (e) {
      setError(String(e));
      setPhase("pick");
    }
  };
  useEffect(() => {
    api.inbodyFields().then(setFields);
    search();
    return () => {
      alive.current = false;
      if (timer.current) window.clearInterval(timer.current);
      api.scaleBleDisconnect().catch(() => {});
    };
  }, []);

  async function save(r: InBodyScan) {
    try {
      await api.mergeBodyCompScans([r]);
      setSaved(true);
      const n = heldRef.current;
      onSaved(`Saved your weigh-in from the ${profile.name} scale.` + (n ? ` ${n} earlier weigh-in${n > 1 ? "s are" : " is"} waiting for you to check.` : ""));
    } catch (e) {
      setError(String(e));
    }
  }

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
    let kept = false;
    timer.current = window.setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const p = await api.scaleBlePump();
        if (p.error) setError(p.error);
        if (p.notes.length) setNotes((n) => [...n, ...p.notes]);
        if (p.live_weight_kg != null) setLive({ kg: p.live_weight_kg, stable: p.stable });
        if (p.held) {
          heldRef.current += p.held;
          setHeld(heldRef.current);
        }
        if (p.state === "ready" && !kept) {
          // This phone's scale from now on.
          kept = true;
          api.setSetting(addressKey(profile.id), d.address).catch(() => {});
        }
        if (p.readings.length) {
          const r = p.readings[p.readings.length - 1];
          setReading(r);
          setPhase("done");
          const why = await api.weighInDoubt(r.measured_at_local, r.values.weight_kg).catch(() => null);
          setDoubt(why);
          if (!why) save(r);
        } else if (p.state === "ready") setPhase((x) => (x === "connecting" ? "ready" : x));
        else if (p.state === "closed") setPhase((x) => (x === "done" ? x : "closed"));
      } catch (e) {
        setError(String(e));
      } finally {
        busy = false;
      }
    }, 200);
  };

  const stop = () => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
    api.scaleBleDisconnect().catch(() => {});
    onClose();
  };

  const shareLog = async () => {
    try {
      const log = await api.scaleBleLog();
      if (!log) return setError("Nothing captured yet.");
      await saveOrShareText(`fitcodex-${profile.id}-capture.txt`, "text/plain", log);
    } catch (e) {
      setError(String(e));
    }
  };
  const kg = (v: number) => `${toUnit(v, unit).toFixed(1)} ${unit}`;
  const shown = reading?.values.weight_kg ?? live?.kg;

  return (
    <Modal title="Weigh in" onClose={stop}>
      {phase === "search" && <p className="small">Looking for your {profile.name} scale… step on it to wake it.</p>}
      {phase === "pick" && (
        <>
          <p className="small">
            {found.devices.length ? "Which one is your scale? It's kept for next time." : "No scale found. Step on it to wake it, close the " + profile.name + " app, then search again."}
          </p>
          <DeviceList devices={found.devices} others={found.others} onPick={connect} />
          <button className="button" onClick={() => search()}>
            Search again
          </button>
        </>
      )}
      {phase !== "search" && phase !== "pick" && (
        <div className="stat">
          <div className="stat-value">{shown != null ? kg(shown) : "—"}</div>
          <div className="stat-label">
            {phase === "connecting"
              ? "Connecting…"
              : phase === "done"
                ? saved
                  ? "Saved ✓"
                  : doubt
                    ? "Was this you?"
                    : "Saving…"
                : phase === "closed"
                  ? "The scale disconnected before a result came through."
                  : live?.stable
                    ? "Hold still: measuring body composition…"
                    : "Step on barefoot."}
          </div>
        </div>
      )}
      {reading && (
        <>
          <p className="small muted">
            {[
              reading.values.pbf != null && `${reading.values.pbf}% fat`,
              reading.values.smm_kg != null && `skeletal muscle ${kg(reading.values.smm_kg)}`,
              reading.values.body_water_pct != null && `water ${reading.values.body_water_pct}%`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {doubt && !saved && (
            <>
              <p className="warn small">{doubt.replace(/(-?\d+\.\d) kg/g, (_, v) => kg(Number(v)))}.</p>
              <div className="row">
                <button className="button primary" onClick={() => save(reading)}>
                  That's me
                </button>
                <button className="button" onClick={stop}>
                  Not me
                </button>
              </div>
            </>
          )}
          <details className="small">
            <summary>All values</summary>
            <ValuesTable scan={reading} fields={fields} unit={unit} />
          </details>
        </>
      )}
      {held > 0 && (
        <p className="small">
          The scale also sent {held} weigh-in{held > 1 ? "s" : ""} from while no phone was connected; check them under Measure.
        </p>
      )}
      {notes.map((n, i) => (
        <p key={i} className="warn small">
          {n}
        </p>
      ))}
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className={`button${saved ? " primary" : ""}`} onClick={stop}>
          {saved ? "Done" : "Cancel"}
        </button>
      </div>
      <details className="small">
        <summary>Help</summary>
        <ol>
          <li>
            Set the scale up once in the {profile.name} app, with you as its first user and the same birth date, height and sex as in
            FitCodex.
          </li>
          <li>
            Close the {profile.name} app; if the scale isn't found, force stop it (long-press its icon › App info › Force stop). No
            pairing in Android's Bluetooth settings is needed.
          </li>
          <li>Stay on, barefoot, until body composition finishes (about 15 s after the weight settles).</li>
          <li>Your user number and the scale this phone uses are under Settings › Scale.</li>
        </ol>
        <p className="row">
          Still not working? Share the capture log (every byte exchanged with the scale).
          <button className="button small" onClick={shareLog}>
            Share capture log
          </button>
        </p>
      </details>
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
        replaces the built-in one. Format: data/scales/README.md in the FitCodex repository.
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

