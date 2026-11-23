import { useEffect, useState } from "react";
import { api, type DayHealth, type HealthConnectStatus } from "../api";
import { TimeSeriesChart } from "../charts/TimeSeriesChart";
import { isoDate, today } from "../charts/RangePicker";
import { formatDate, formatTime, parseLocal } from "../format";
import { IS_ANDROID } from "../platform";
import { latestRecoveryText } from "../recovery";
import { HEALTH_SYNCED, summaryText } from "./WearablesCard";

/** Day health from Health Connect, reloaded after each sync. */
function useDayHealth(): DayHealth[] | null {
  const [days, setDays] = useState<DayHealth[] | null>(null);
  useEffect(() => {
    const load = () =>
      api
        .dayHealth()
        .then(setDays)
        .catch(() => setDays([]));
    load();
    window.addEventListener(HEALTH_SYNCED, load);
    return () => window.removeEventListener(HEALTH_SYNCED, load);
  }, []);
  return days;
}

/** One small line for the top of Measure: today's sleep and recovery (else yesterday's), linking
 *  to the Recovery tab. Nothing without data. */
export function RecoveryLine() {
  const days = useDayHealth();
  if (!days) return null;
  const text = latestRecoveryText(days, today());
  if (!text) return null;
  return (
    <a className="small muted recovery-line" href="#/body/charts/recovery">
      {text} ›
    </a>
  );
}

type Metric = { key: keyof DayHealth; label: string; unit: string; of: (d: DayHealth) => number | null; show: (v: number) => string };

const hm = (h: number) => `${Math.floor(h)}h ${String(Math.round((h % 1) * 60)).padStart(2, "0")}m`;
const METRICS: Metric[] = [
  { key: "sleep_s", label: "Sleep", unit: "h", of: (d) => (d.sleep_s != null ? d.sleep_s / 3600 : null), show: hm },
  { key: "resting_hr", label: "Resting heart rate", unit: "bpm", of: (d) => d.resting_hr, show: (v) => `${Math.round(v)} bpm` },
  { key: "hrv_ms", label: "HRV", unit: "ms", of: (d) => d.hrv_ms, show: (v) => `${Math.round(v)} ms` },
  { key: "steps", label: "Steps", unit: "", of: (d) => d.steps, show: (v) => Math.round(v).toLocaleString() },
];

const avg = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

/** Sleep, resting heart rate, HRV and steps from your watch (Health Connect). */
export function RecoveryTab() {
  const days = useDayHealth();
  const [status, setStatus] = useState<HealthConnectStatus | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loadStatus = () => {
    if (IS_ANDROID)
      api
        .healthConnectStatus()
        .then(setStatus)
        .catch(() => {});
  };
  useEffect(() => {
    loadStatus();
    window.addEventListener(HEALTH_SYNCED, loadStatus);
    return () => window.removeEventListener(HEALTH_SYNCED, loadStatus);
  }, []);
  if (!days) return <p className="muted">Loading…</p>;

  async function syncNow() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.healthConnectSync();
      setMsg(summaryText(r));
      window.dispatchEvent(new Event(HEALTH_SYNCED));
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  }

  const t = today();
  const since = (n: number) => isoDate(new Date(parseLocal(t).getTime() - n * 86400000));
  const connected = status?.available === "yes" && status.granted > 0;
  const metrics = METRICS.filter((m) => days.some((d) => m.of(d) != null));
  const line = latestRecoveryText(days, t);

  return (
    <>
      <section className="card">
        <h2 className="section-title">Sleep & recovery</h2>
        {line ? <p>{line}</p> : <p className="muted small">Nothing for today or yesterday yet.</p>}
        {metrics.length > 0 && (
          <div className="stats-row">
            {metrics.map((m) => {
              // This week (last 7 days) against the 4 weeks before.
              const week = avg(
                days
                  .filter((d) => d.date > since(7))
                  .map(m.of)
                  .filter((v): v is number => v != null),
              );
              const usual = avg(
                days
                  .filter((d) => d.date <= since(7) && d.date > since(35))
                  .map(m.of)
                  .filter((v): v is number => v != null),
              );
              return (
                <div key={m.key} className="stat">
                  <div className="stat-value">{week != null ? m.show(week) : "—"}</div>
                  <div className="stat-label">
                    {m.label}, 7-day average{usual != null && ` (usual ${m.show(usual)})`}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {IS_ANDROID && (
          <p className="row small muted">
            {connected
              ? `Health Connect${status?.synced_at ? `, synced ${formatDate(status.synced_at)} ${formatTime(status.synced_at)}` : ""}.`
              : "Connect Health Connect under Settings › Watch & health apps to see your sleep and recovery here."}
            {connected && (
              <button className="button small" disabled={busy} onClick={syncNow}>
                {busy ? "Syncing…" : "Sync now"}
              </button>
            )}
          </p>
        )}
        {msg && <p className="small">{msg}</p>}
      </section>
      {metrics.map((m) => (
        <section key={m.key} className="card">
          <h2 className="section-title">{m.label}</h2>
          <TimeSeriesChart
            title={m.label}
            series={[
              {
                id: m.key,
                label: m.label,
                points: days.filter((d) => m.of(d) != null).map((d) => ({ t: parseLocal(d.date), v: m.of(d)! })),
              },
            ]}
            unit={m.key === "sleep_s" ? "" : m.unit}
            yFormat={m.key === "sleep_s" ? (v) => hm(v) : (v) => Math.round(v).toLocaleString()}
            zero={m.key === "steps"}
            height={200}
          />
        </section>
      ))}
      {!metrics.length && <p className="empty">No sleep or recovery data yet. It comes from your watch through Health Connect.</p>}
    </>
  );
}
