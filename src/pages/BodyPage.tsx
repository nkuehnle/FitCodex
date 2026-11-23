import { goalCorridors, phaseLines, type GoalStretch } from "../charts/corridor";
import { PhaseOverlay } from "../charts/PhaseOverlay";
import * as d3 from "d3";
import { ask } from "../components/Modal";
import { useEffect, useMemo, useState } from "react";
import {
  api,
  type CsvMapping,
  type DietDay,
  type EnergyPoint,
  type InBodyCsvPreview,
  type InBodyField,
  type InBodyScan,
  type BodyPart,
  type Goal,
  type MeasurementRow,
  type Phase,
  type ScaleProfile,
  type WeighInRow,
} from "../api";
import { usePrefs } from "../App";
import { RangePicker, inRange, today, useSavedRange } from "../charts/RangePicker";
import { TimeSeriesChart, type Band, type Point, type Series } from "../charts/TimeSeriesChart";
import { useChartTheme, type ChartTheme } from "../charts/theme";
import { BodyFatTab } from "../components/BodyFatTab";
import { Modal } from "../components/Modal";
import { ProfileHint, Standing, useNormProfile } from "../components/Standing";
import { ShareButton } from "../share/ShareDialog";
import { formatDate, formatTime, nowLocal, parseLocal, toUnit } from "../format";
import { GOAL_TEXT, goalStatus, type GoalInfo } from "../goal";
import { PhaseSplitCard } from "../components/PhaseSplitCard";
import { IS_ANDROID, fileToBase64 } from "../platform";
import { ImpedanceCard, PendingWeighIns, QuickScaleButton, showValue, sourceName } from "../components/ScaleTools";
import { RecoveryLine, RecoveryTab } from "../components/RecoveryTab";
import { isPumped, pumpRatio } from "../pump";

const KG_PER_LB = 0.45359237;
type Mode = "data" | "charts";
const DATA_TABS = { weighins: "Weigh-ins", body: "Body", scans: "Scans", calories: "Calories" } as const;
const CHART_TABS = { weight: "Weight & calories", body: "Body", recovery: "Recovery" } as const;
type DataTab = keyof typeof DATA_TABS;
type ChartTab = keyof typeof CHART_TABS;

/** Where a route goes: #/body/data/<tab>[/<part>] or #/body/charts/<tab>[/<part>]; older links
 *  (#/body/weight, /diet, /inbody, /parts/<id>, /recovery) land on their new place. */
function resolve(path: string[]): { mode: Mode; tab: string; part?: string } {
  const [a, b, c] = path;
  if (a === "data") return { mode: "data", tab: b && b in DATA_TABS ? b : "weighins", part: c };
  if (a === "charts") {
    // Earlier chart tabs: body comp and body parts are now Body, calories are under Weight.
    const merged: Record<string, string> = { comp: "body", parts: "body", calories: "weight" };
    const tab = b ? (merged[b] ?? b) : "weight";
    return { mode: "charts", tab: tab in CHART_TABS ? tab : "weight", part: c };
  }
  const legacy: Record<string, [Mode, string]> = {
    weight: ["data", "weighins"],
    diet: ["data", "calories"],
    inbody: ["data", "body"],
    fat: ["data", "body"],
    parts: ["data", "body"],
    recovery: ["charts", "recovery"],
  };
  const [mode, tab] = legacy[a] ?? ["charts", "weight"];
  return { mode, tab, part: a === "parts" ? b : undefined };
}

export default function BodyPage({ path }: { path: string[] }) {
  const { mode, tab, part } = resolve(path);
  // Bumped when a held weigh-in is saved, to reload the tab.
  const [rev, setRev] = useState(0);
  const tabs: Record<string, string> = mode === "data" ? DATA_TABS : CHART_TABS;
  return (
    <div className="page">
      <h1 className="page-title">Measure</h1>
      <div className="measure-quick">
        <RecoveryLine />
        <QuickScaleButton label="⚖ Weigh in" onSaved={() => setRev((r) => r + 1)} />
      </div>
      <PendingWeighIns key={`p${rev}`} onChanged={() => setRev((r) => r + 1)} />
      <div className="segmented">
        {(["charts", "data"] as Mode[]).map((m) => (
          <a key={m} href={`#/body/${m}`} className={mode === m ? "seg-link active" : "seg-link"}>
            {m === "data" ? "Data & metrics" : "Charts"}
          </a>
        ))}
      </div>
      <div className="segmented small tabs-scroll">
        {Object.entries(tabs).map(([t, label]) => (
          <a key={t} href={`#/body/${mode}/${t}`} className={tab === t ? "seg-link active" : "seg-link"}>
            {label}
          </a>
        ))}
      </div>
      {mode === "data" ? (
        <>
          {(tab as DataTab) === "weighins" && (
            <>
              <section className="card">
                <GoalPanel />
              </section>
              <BodyweightTab key={rev} mode="data" />
            </>
          )}
          {(tab as DataTab) === "body" && (
            <>
              <BodyFatTab key={`f${rev}`} mode="data" />
              <BodyPartsTab part={part} mode="data" />
            </>
          )}
          {(tab as DataTab) === "scans" && <InBodyTab key={`s${rev}`} mode="data" />}
          {(tab as DataTab) === "calories" && <DietTab mode="data" />}
        </>
      ) : (
        <>
          {(tab as ChartTab) === "weight" && (
            <>
              <BodyweightTab key={rev} mode="charts" />
              <DietTab mode="charts" />
            </>
          )}
          {(tab as ChartTab) === "body" &&
            (part ? (
              <BodyPartsTab part={part} mode="charts" />
            ) : (
              <>
                <BodyFatTab key={`f${rev}`} mode="charts" />
                <InBodyTab key={`s${rev}`} mode="charts" />
                <BodyPartsTab mode="charts" />
              </>
            ))}
          {(tab as ChartTab) === "recovery" && <RecoveryTab />}
        </>
      )}
    </div>
  );
}

// ---- Goal -------------------------------------------------------------------------------------------

type GoalEntry = Awaited<ReturnType<typeof api.goalHistory>>[number];
const signed = (v: number, digits = 1) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(digits)}`;

/** Weekly target input: blank means "use the default range for the goal". Stored as kg/week. */
function rateText(kg: number | null, unit: "kg" | "lb") {
  return kg == null ? "" : String(Math.round(toUnit(kg, unit) * 100) / 100);
}
function parseRate(text: string, goal: Goal, unit: "kg" | "lb"): number | null {
  const v = Number(text);
  if (!text.trim() || !isFinite(v)) return null;
  const kg = unit === "lb" ? v * KG_PER_LB : v;
  // Typing "1" on a cut means losing 1 a week.
  return goal === "cut" ? -Math.abs(kg) : goal === "gain" ? Math.abs(kg) : kg;
}

/** Cut / maintain / gain over time. Switching starts a new nutrition phase today (shaded on charts);
 *  earlier goals can be backdated, and each goal can have its own weekly target. */
function GoalPanel() {
  const { unit } = usePrefs();
  const [info, setInfo] = useState<GoalInfo | null>(null);
  const [history, setHistory] = useState<GoalEntry[]>([]);
  const [rate, setRate] = useState("");
  const [add, setAdd] = useState<{ goal: Goal; start: string; rate: string }>({ goal: "cut", start: today(), rate: "" });
  const [edit, setEdit] = useState<{ id: number; goal: Goal; start: string; end: string; rate: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    api.currentGoal().then((g) => {
      setInfo(g);
      setRate(rateText(g.weekly_rate_kg, unit));
    });
    api.goalHistory().then(setHistory);
  };
  useEffect(load, [unit]);
  const changed = () => {
    load();
    window.dispatchEvent(new Event("goal-changed"));
  };
  if (!info) return null;
  const goal = info.goal;
  return (
    <div className="goal-panel">
      <div className="goal-row">
        <span className="small muted">Goal</span>
        <div className="segmented small">
          {(["cut", "maintain", "gain"] as Goal[]).map((g) => (
            <button key={g} className={goal === g ? "active" : ""} onClick={() => goal !== g && api.setGoal(g).then(changed)}>
              {GOAL_TEXT[g]}
            </button>
          ))}
        </div>
        {/* Maintain always aims for no change (within a small band), so it has no target to set. */}
        {goal && goal !== "maintain" && (
          <label className="small goal-target">
            Target
            <input
              className="input small-input"
              inputMode="decimal"
              placeholder="default"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              onBlur={() => {
                const kg = parseRate(rate, goal, unit);
                if (kg !== info.weekly_rate_kg) api.setGoal(goal, info.start_date ?? undefined, kg).then(changed);
              }}
            />
            {unit}/week
          </label>
        )}
        {info.start_date && <span className="small muted">since {formatDate(info.start_date)}</span>}
      </div>
      <details className="goal-history">
        <summary className="small">Goal history</summary>
        <table className="table small">
          <tbody>
            {[...history].reverse().map((h) =>
              edit?.id === h.phase_id ? (
                <tr key={h.phase_id}>
                  <td>{GOAL_TEXT[h.goal]}</td>
                  <td colSpan={2}>
                    <div className="row small">
                      <input
                        className="input"
                        type="date"
                        value={edit.start}
                        onChange={(e) => setEdit({ ...edit, start: e.target.value })}
                      />
                      to
                      <input
                        className="input"
                        type="date"
                        value={edit.end}
                        aria-label="End (blank = ongoing)"
                        onChange={(e) => setEdit({ ...edit, end: e.target.value })}
                      />
                      {edit.goal !== "maintain" && (
                        <input
                          className="input small-input"
                          inputMode="decimal"
                          placeholder={`${unit}/wk`}
                          aria-label={`Weekly target, ${unit} (blank = default)`}
                          value={edit.rate}
                          onChange={(e) => setEdit({ ...edit, rate: e.target.value })}
                        />
                      )}
                      <button
                        className="button"
                        disabled={!edit.start}
                        onClick={() =>
                          api
                            .editGoal(
                              edit.id,
                              edit.start,
                              edit.end || null,
                              edit.goal === "maintain" ? null : parseRate(edit.rate, edit.goal, unit),
                            )
                            .then(() => (setEdit(null), setError(null), changed()))
                            .catch((e) => setError(String(e)))
                        }
                      >
                        Save
                      </button>
                      <button
                        className="link-btn danger"
                        onClick={async () => {
                          if (!(await ask(`Delete the ${GOAL_TEXT[edit.goal].toLowerCase()} goal from ${formatDate(edit.start)}?`))) return;
                          await api.deletePhase(edit.id);
                          setEdit(null);
                          setError(null);
                          changed();
                        }}
                      >
                        Delete
                      </button>
                      <button className="link-btn" onClick={() => (setEdit(null), setError(null))}>
                        Cancel
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={h.phase_id}>
                  <td>{GOAL_TEXT[h.goal]}</td>
                  <td>
                    <button
                      className="link-btn"
                      onClick={() => (
                        setEdit({
                          id: h.phase_id,
                          goal: h.goal,
                          start: h.start_date,
                          end: h.end_date ?? "",
                          rate: rateText(h.weekly_rate_kg, unit),
                        }),
                        setError(null)
                      )}
                    >
                      {formatDate(h.start_date)} – {h.end_date ? formatDate(h.end_date) : "now"}
                    </button>
                  </td>
                  <td className="muted">
                    {h.goal === "maintain" ? "±0" : h.weekly_rate_kg != null ? `${signed(toUnit(h.weekly_rate_kg, unit), 2)} ${unit}/wk` : "default"}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
        <div className="row small">
          <select className="input" value={add.goal} onChange={(e) => setAdd({ ...add, goal: e.target.value as Goal })}>
            {(["cut", "maintain", "gain"] as Goal[]).map((g) => (
              <option key={g} value={g}>
                {GOAL_TEXT[g]}
              </option>
            ))}
          </select>
          from
          <input className="input" type="date" value={add.start} onChange={(e) => setAdd({ ...add, start: e.target.value })} />
          {add.goal !== "maintain" && (
            <input
              className="input small-input"
              inputMode="decimal"
              placeholder={`${unit}/wk`}
              value={add.rate}
              onChange={(e) => setAdd({ ...add, rate: e.target.value })}
            />
          )}
          <button
            className="button"
            disabled={!add.start}
            onClick={() => api.setGoal(add.goal, add.start, add.goal === "maintain" ? null : parseRate(add.rate, add.goal, unit)).then(changed)}
          >
            Add
          </button>
        </div>
        {error && <p className="error small">{error}</p>}
        <p className="small muted">
          Adding a goal with an earlier start date ends the goal before it on that date. Tap a goal's dates to change them, its weekly
          target, or delete it (leave the end blank while it's ongoing); goals they now overlap are shortened to fit.
        </p>
      </details>
    </div>
  );
}

/** Target vs actual weekly rate of weight change for the current goal. */
function GoalRate({ rows, unit }: { rows: WeighInRow[]; unit: "kg" | "lb" }) {
  const [info, setInfo] = useState<GoalInfo | null>(null);
  useEffect(() => {
    const load = () => api.currentGoal().then(setInfo);
    load();
    window.addEventListener("goal-changed", load);
    return () => window.removeEventListener("goal-changed", load);
  }, []);
  const s = goalStatus(info, rows, []);
  if (!s) return null;
  const u = (kg: number) => toUnit(kg, unit);
  const [lo, hi] = s.targetKg;
  const aim =
    lo === hi
      ? `${signed(u(lo), 2)} ${unit} a week`
      : s.goal === "maintain"
        ? `within ±${u(hi).toFixed(1)} ${unit} a week`
        : `${signed(u(lo))} to ${signed(u(hi))} ${unit} a week`;
  return (
    <p className="small goal-rate">
      <strong>{GOAL_TEXT[s.goal]}:</strong> aim for {aim}.{" "}
      {s.actualKg == null ? (
        <span className="muted">Weigh in over a few weeks to see your rate.</span>
      ) : (
        <span>
          Last 3 weeks: {signed(u(s.actualKg), 2)} {unit} a week{s.onTrack ? " (on target)." : "."}
        </span>
      )}
    </p>
  );
}

// ---- Body parts --------------------------------------------------------------------------------------

/** Tape measurements: logging them (data) or their charts and how they compare (charts). */
function BodyPartsTab({ part, mode }: { part?: string; mode: Mode }) {
  const { unit } = usePrefs();
  const inches = unit === "lb";
  const [parts, setParts] = useState<BodyPart[]>([]);
  const [rows, setRows] = useState<MeasurementRow[]>([]);
  const [entry, setEntry] = useState("");
  const [editing, setEditing] = useState<MeasurementRow | null>(null);
  const [workouts, setWorkouts] = useState<[string, number | null, string[]][]>([]);
  const load = () => api.measurements().then(setRows);
  useEffect(() => {
    api.bodyParts().then(setParts);
    api.workoutTimes().then(setWorkouts);
    load();
  }, []);
  const show = (p: BodyPart, v: number) =>
    p.unit === "pct" ? `${v.toFixed(1)}%` : inches ? `${(v / 2.54).toFixed(1)} in` : `${v.toFixed(1)} cm`;
  const sel = parts.find((p) => p.id === part);
  const { who, loaded } = useNormProfile();
  const theme = useChartTheme();
  const base = mode === "data" ? "#/body/data/body" : "#/body/charts/body";

  if (!sel)
    return (
      <section className="card">
        <h2 className="section-title">{mode === "data" ? "Body measurements" : "Body parts"}</h2>
        {parts.map((p) => {
          const mine = rows.filter((r) => r.part === p.id);
          const last = mine[mine.length - 1];
          return (
            <a key={p.id} className="start-row" href={`${base}/${p.id}`}>
              <span>{p.label}</span>
              <span className="muted">{last ? `${show(p, last.value)} · ${formatDate(last.at)}` : "—"} ›</span>
            </a>
          );
        })}
      </section>
    );

  const mine = rows.filter((r) => r.part === sel.id);
  const toDisplay = (v: number) => (sel.unit === "cm" && inches ? v / 2.54 : v);
  const unitLabel = sel.unit === "pct" ? "%" : inches ? "in" : "cm";
  // Tape measurements taken during or just after a workout for those muscles are "pumped"; charted separately.
  const pumped = (r: MeasurementRow) => isPumped(r.at, sel.id, workouts);
  const point = (r: MeasurementRow) => ({ t: parseLocal(r.at), v: toDisplay(r.value) });
  const rested = mine.filter((r) => !pumped(r));
  const pumpedRows = mine.filter(pumped);
  // With enough pairs, your own pump ratio fills in each line's missing days as estimates (diamonds).
  const pump = pumpRatio(rested.map(point), pumpedRows.map(point));
  const [restColor, pumpColor] = [theme.line, theme.categorical[0]];
  const partSeries: Series[] = pumpedRows.length
    ? [
        { id: "rested", label: "Not pumped", points: rested.map(point), color: restColor },
        { id: "pumped", label: "Pumped (within 6 h of training it)", points: pumpedRows.map(point), color: pumpColor },
        ...(pump
          ? [
              {
                id: "rested-est",
                label: "Not pumped (estimate)",
                points: pumpedRows.map(point).map((p) => ({ t: p.t, v: p.v / pump.ratio })),
                color: restColor,
                style: "points" as const,
              },
              {
                id: "pumped-est",
                label: "Pumped (estimate)",
                points: rested.map(point).map((p) => ({ t: p.t, v: p.v * pump.ratio })),
                color: pumpColor,
                style: "points" as const,
              },
            ]
          : []),
      ].filter((x) => x.points.length)
    : [{ id: sel.id, label: sel.label, points: mine.map(point) }];
  // Parts with reference data (CDC): waist, and the upper arm (measured relaxed there).
  const norm = sel.id === "waist" ? "waist_cm" : sel.id === "left_bicep" || sel.id === "right_bicep" ? "arm_cm" : null;
  const normRows = rested.length ? rested : mine;
  const normValues = normRows.length > 1 ? [normRows[0].value, normRows[normRows.length - 1].value] : normRows.map((r) => r.value);
  async function add() {
    const v = Number(entry);
    if (!v) return;
    await api.addMeasurement(nowLocal(), sel!.id, sel!.unit === "cm" && inches ? v * 2.54 : v);
    setEntry("");
    load();
  }
  const back = (
    <a className="back-link" href={base}>
      ‹ {mode === "data" ? "Body measurements" : "Body parts"}
    </a>
  );
  if (mode === "data")
    return (
      <>
        {back}
        <section className="card">
          <h2 className="section-title">{sel.label}</h2>
          <div className="row" style={{ marginTop: 0 }}>
          <input
            className="num big-input"
            inputMode="decimal"
            placeholder={`New (${unitLabel})`}
            value={entry}
            onChange={(e) => setEntry(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <button className="button primary" onClick={add} disabled={!Number(entry)}>
            + Add
          </button>
          </div>
          {mine.length > 1 && (
            <a className="small" href={`#/body/charts/body/${sel.id}`}>
              Chart ›
            </a>
          )}
        </section>
        <section className="card">
          {mine.length === 0 && <p className="muted small">No measurements yet.</p>}
          {[...mine].reverse().map((r) => (
            <button key={r.id} className="start-row" onClick={() => setEditing(r)}>
              <span>
                {formatDate(r.at)} <span className="muted small">{formatTime(r.at)}</span>
                {pumped(r) && <span className="chip small-chip">pumped</span>}
              </span>
              <strong>{show(sel, r.value)}</strong>
            </button>
          ))}
        </section>
        {editing && (
          <EntryEditor
            title={`Edit ${sel.label.toLowerCase()}`}
            unitLabel={unitLabel}
            value={toDisplay(editing.value)}
            at={editing.at}
            onClose={() => setEditing(null)}
            onSave={(v, at) => api.updateMeasurement(editing.id, at, sel.unit === "cm" && inches ? v * 2.54 : v).then(load)}
            onDelete={() => api.deleteMeasurement(editing.id).then(load)}
          />
        )}
      </>
    );
  return (
    <>
      {back}
      <section className="card">
        <h2 className="section-title">{sel.label}</h2>
        {mine.length < 2 && <p className="muted small">Log two or more under Data & metrics › Body to see a chart.</p>}
        {mine.length > 1 && (
          <TimeSeriesChart series={partSeries} unit={unitLabel} height={200} title={sel.label} />
        )}
        {pumpedRows.length > 0 && (
          <p className="muted small">
            {pump
              ? `Your pump: ${pump.ratio >= 1 ? "+" : "−"}${Math.abs((pump.ratio - 1) * 100).toFixed(1)} % on average (${pump.pairs} pumped readings with a rested one within a week). Diamonds are estimates from that.`
              : "Pumped means measured within 6 hours after the start of a workout that trained this muscle. With 3 or more pumped readings that have a rested one within a week, the chart estimates each from the other."}
          </p>
        )}
      </section>
      {norm && normValues.length > 0 && loaded && (
        <section className="card">
          <h2 className="section-title">How you compare</h2>
          {who ? (
            <Standing
              metric={norm}
              label={sel.label}
              values={normValues}
              who={who}
              show={(cm) => (inches ? `${(cm / 2.54).toFixed(1)} in` : `${cm.toFixed(1)} cm`)}
              note={
                norm === "waist_cm"
                  ? "The survey measures the waist at the top of the hip bone."
                  : "The survey measures the relaxed upper arm, midway between shoulder and elbow; a flexed measurement reads higher."
              }
            />
          ) : (
            <ProfileHint />
          )}
          <p className="muted small">Against US adults of your sex and age group (CDC, 2015–2018).</p>
        </section>
      )}
    </>
  );
}

function bandsOf(phases: Phase[]): Band[] {
  return phases.map((p) => ({
    start: parseLocal(p.start_date),
    end: p.end_date ? parseLocal(p.end_date) : null,
    label: p.name,
    lane: p.lane,
  }));
}

// ---- Bodyweight ---------------------------------------------------------------------------------------

function BodyweightTab({ mode }: { mode: Mode }) {
  const { unit } = usePrefs();
  const [rows, setRows] = useState<WeighInRow[]>([]);
  const [phases, setPhases] = useState<Phase[]>([]);
  const [range, setRange] = useSavedRange("bodyweight");
  const [entry, setEntry] = useState("");
  const [hide, setHide] = useState(false);
  // Remembered on this device.
  const [showTarget, setShowTargetState] = useState(() => {
    try {
      return localStorage.getItem("weightGoalPace") !== "off";
    } catch {
      return true;
    }
  });
  const setShowTarget = (on: boolean) => {
    setShowTargetState(on);
    try {
      localStorage.setItem("weightGoalPace", on ? "on" : "off");
    } catch {
      /* storage unavailable */
    }
  };
  const [goals, setGoals] = useState<GoalStretch[]>([]);
  const [view, setView] = useState({ smooth: { on: false, span: 0.15 }, showBands: true });
  const load = () => api.weighIns(true).then(setRows);
  useEffect(() => {
    load();
    api.listPhases().then(setPhases);
    const loadGoals = () => api.goalHistory().then(setGoals);
    loadGoals();
    window.addEventListener("goal-changed", loadGoals);
    return () => window.removeEventListener("goal-changed", loadGoals);
  }, []);

  // Every weigh-in, whatever it came from (typed, a scale, Health Connect or a scan).
  const regular = rows.filter((r) => inRange(r.at, range));
  const pts = (rs: WeighInRow[]): Point[] => rs.map((r) => ({ t: parseLocal(r.at), v: toUnit(r.weight_kg, unit) }));
  const series = [{ id: "bw", label: "Weigh-ins", points: pts(regular) }];
  // Each goal's target pace, for the goals that overlap the range.
  const corridors = goalCorridors(
    goals.filter((g) => (!range.to || g.start_date <= range.to) && (!range.from || !g.end_date || g.end_date >= range.from)),
    rows,
    (kg) => toUnit(kg, unit),
    new Date(),
  );

  // Weekly average (last 7 days) and change over the range.
  const last7 = regular.filter((r) => parseLocal(r.at).getTime() > Date.now() - 7 * 86400000);
  const avg7 = last7.length ? last7.reduce((s, r) => s + r.weight_kg, 0) / last7.length : null;
  const first = regular[0];
  const last = regular[regular.length - 1];
  const change = first && last ? last.weight_kg - first.weight_kg : null;
  const weeks = first && last ? Math.max(1, (parseLocal(last.at).getTime() - parseLocal(first.at).getTime()) / (7 * 86400000)) : 1;
  const { who, heightCm, loaded } = useNormProfile();
  // First weigh-in in the range and the latest (7-day average when there is one).
  const compareKg = first && last ? (first === last ? [last.weight_kg] : [first.weight_kg, avg7 ?? last.weight_kg]) : [];

  async function add() {
    const v = Number(entry);
    if (!v) return;
    await api.addWeighIn(nowLocal(), unit === "lb" ? v * KG_PER_LB : v);
    setEntry("");
    load();
  }

  if (mode === "data")
    return (
      <>
        <section className="card">
          <div className="row" style={{ marginTop: 0 }}>
            <input
              className="num big-input"
              inputMode="decimal"
              placeholder={`Today's weight (${unit})`}
              value={entry}
              onChange={(e) => setEntry(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
            />
            <button className="button primary" onClick={add} disabled={!Number(entry)}>
              Log
            </button>
          </div>
        </section>
        <WeighInList rows={rows} unit={unit} onChanged={load} />
      </>
    );

  return (
    <>
      <section className="card">
        <div className="title-row">
          <h2 className="section-title">Bodyweight</h2>
          <ShareButton
            kind="bodyweight"
            range={range}
            chart={{
              series,
              unit,
              bands: view.showBands ? bandsOf(phases) : undefined,
              corridors: showTarget ? corridors : undefined,
              hideNumbers: hide,
              yFormat: (v) => v.toFixed(0),
              smooth: view.smooth,
            }}
          />
        </div>
        <div className="stats-row">
          {last && <Stat label="Latest" value={`${toUnit(last.weight_kg, unit).toFixed(1)} ${unit}`} />}
          {avg7 != null && <Stat label="7-day average" value={`${toUnit(avg7, unit).toFixed(1)} ${unit}`} />}
          {change != null && (
            <Stat
              label={`Change (${range.label.toLowerCase()})`}
              value={`${change >= 0 ? "+" : "−"}${Math.abs(toUnit(change, unit)).toFixed(1)} ${unit}`}
            />
          )}
          {change != null && (
            <Stat label="Per week" value={`${change >= 0 ? "+" : "−"}${Math.abs(toUnit(change / weeks, unit)).toFixed(2)} ${unit}`} />
          )}
        </div>
        <GoalRate rows={rows} unit={unit} />
        <RangePicker value={range} onChange={setRange} phases={phases} />
        <div className="row small" style={{ marginTop: 0 }}>
          <label className="check">
            <input type="checkbox" checked={hide} onChange={(e) => setHide(e.target.checked)} /> Hide numbers
          </label>
          {corridors.length > 0 && (
            <label className="check">
              <input type="checkbox" checked={showTarget} onChange={(e) => setShowTarget(e.target.checked)} /> Goal pace
            </label>
          )}
        </div>
        <TimeSeriesChart
          series={series}
          unit={unit}
          bands={bandsOf(phases)}
          corridors={showTarget ? corridors : undefined}
          height={280}
          hideNumbers={hide}
          yFormat={(v) => v.toFixed(0)}
          share={false}
          onView={setView}
        />
        {showTarget && corridors.length > 0 && (
          <p className="muted small" style={{ marginBottom: 0 }}>
            The shaded band (Goal pace) is where your weight would be at each goal's target rate, from where that goal began (for maintenance, within
            1% of it). Inside it, you're on pace.
          </p>
        )}
      </section>
      <PhaseCompare goals={goals} rows={rows} unit={unit} />
      {compareKg.length > 0 && loaded && (
        <section className="card">
          <h2 className="section-title">How you compare</h2>
          {who ? (
            <>
              <Standing
                metric="weight_kg"
                label="Weight"
                values={compareKg}
                who={who}
                show={(kg) => `${toUnit(kg, unit).toFixed(0)} ${unit}`}
              />
              {heightCm && (
                <Standing
                  metric="bmi"
                  label="BMI"
                  values={compareKg.map((kg) => kg / (heightCm / 100) ** 2)}
                  who={who}
                  show={(v) => v.toFixed(1)}
                  note="BMI can't tell muscle from fat; the body comp comparisons can."
                />
              )}
              <p className="muted small">Against US adults of your sex and age group (CDC, 2015–2018).</p>
            </>
          ) : (
            <ProfileHint />
          )}
        </section>
      )}
      <PhaseSplitCard rows={rows} />
    </>
  );
}

/** Earlier stretches of the same goal laid over the current one, from each one's first day. */
function PhaseCompare({ goals, rows, unit }: { goals: GoalStretch[]; rows: WeighInRow[]; unit: "kg" | "lb" }) {
  const kinds = (["gain", "cut", "maintain"] as const).filter((k) => goals.some((g) => g.goal === k));
  const current = goals[goals.length - 1]?.goal;
  const [picked, setPicked] = useState<Goal | null>(null);
  const goal = picked ?? current;
  if (!goal) return null;
  const lines = phaseLines(goals, rows, goal, new Date());
  if (goals.filter((g) => g.goal === goal).length < 2 && kinds.length < 2) return null;
  return (
    <section className="card">
      <h2 className="section-title">Compare phases</h2>
      <div className="chips-row" style={{ marginBottom: 6 }}>
        {kinds.map((k) => (
          <button key={k} className={goal === k ? "chip-btn active" : "chip-btn"} onClick={() => setPicked(k)}>
            {GOAL_TEXT[k]}
          </button>
        ))}
      </div>
      {lines.length === 0 ? (
        <p className="muted small">No {GOAL_TEXT[goal].toLowerCase()} phase has two weeks of weigh-ins yet.</p>
      ) : (
        <>
          <p className="muted small">
            Each {GOAL_TEXT[goal].toLowerCase()} phase from its own first day: weekly average weight against where it started.
          </p>
          <PhaseOverlay lines={lines} unit={unit} toUnit={(kg) => Math.round(toUnit(kg, unit) * 10) / 10} />
        </>
      )}
    </section>
  );
}

/** The scan taken with a weigh-in (same device moment, within a few minutes), if any. */
function scanOf(r: WeighInRow, scans: InBodyScan[]): InBodyScan | undefined {
  const t = parseLocal(r.at).getTime();
  return scans.find((s) => Math.abs(parseLocal(s.measured_at_local).getTime() - t) <= 3 * 60000);
}

/** Every weigh-in, newest first. Tap one to fix it, or, when a scale or InBody scan came with it, to
 *  see the full report. */
function WeighInList({ rows, unit, onChanged }: { rows: WeighInRow[]; unit: "kg" | "lb"; onChanged: () => void }) {
  const [shown, setShown] = useState(30);
  const [editing, setEditing] = useState<WeighInRow | null>(null);
  const [report, setReport] = useState<{ row: WeighInRow; scan: InBodyScan } | null>(null);
  const [scanEdit, setScanEdit] = useState<InBodyScan | null>(null);
  const [scans, setScans] = useState<InBodyScan[]>([]);
  const [fields, setFields] = useState<InBodyField[]>([]);
  const [profiles, setProfiles] = useState<ScaleProfile[]>([]);
  const loadScans = () => api.inbodyScans().then(setScans);
  useEffect(() => {
    loadScans();
    api.inbodyFields().then(setFields);
    api.scaleProfiles().then(setProfiles);
  }, [rows]);
  const list = [...rows].reverse();
  return (
    <section className="card">
      <div className="section-label">Weigh-ins ({rows.length}) · tap one for details or to edit</div>
      {list.slice(0, shown).map((r) => {
        const scan = scanOf(r, scans);
        return (
          <button
            key={`${r.source}${r.id}`}
            className="start-row"
            onClick={() => (scan ? setReport({ row: r, scan }) : r.source !== "inbody" && setEditing(r))}
          >
            <span>
              {formatDate(r.at)} <span className="muted small">{formatTime(r.at)}</span>
              {scan && <span className="chip">{sourceName(profiles, scan.source)}</span>}
            </span>
            <span>
              <strong>
                {toUnit(r.weight_kg, unit).toFixed(1)} {unit}
              </strong>
              {scan?.values.pbf != null && <span className="muted small"> · {scan.values.pbf}%</span>}
              {scan && <span className="muted"> ›</span>}
            </span>
          </button>
        );
      })}
      {list.length > shown && (
        <button className="button wide-btn" onClick={() => setShown(shown + 60)}>
          Show more
        </button>
      )}
      {report && (
        <ScanReport
          scan={report.scan}
          scans={scans}
          fields={fields}
          profiles={profiles}
          onClose={() => setReport(null)}
          onEdit={() => {
            setScanEdit(report.scan);
            setReport(null);
          }}
          onEditWeight={
            report.row.source !== "inbody"
              ? () => {
                  setEditing(report.row);
                  setReport(null);
                }
              : undefined
          }
        />
      )}
      {scanEdit && (
        <ScanForm
          scan={scanEdit}
          fields={fields}
          unit={unit}
          known={Object.keys(profiles.find((p) => p.id === scanEdit.source && p.id !== "inbody")?.labels ?? {})}
          onClose={() => setScanEdit(null)}
          onSaved={() => {
            setScanEdit(null);
            loadScans();
            onChanged();
          }}
        />
      )}
      {editing && (
        <EntryEditor
          title="Edit weigh-in"
          unitLabel={unit}
          value={toUnit(editing.weight_kg, unit)}
          at={editing.at}
          onClose={() => setEditing(null)}
          onSave={(v, at) => api.updateWeighIn(editing.id, at, unit === "lb" ? v * KG_PER_LB : v).then(onChanged)}
          onDelete={() => api.deleteWeighIn(editing.id).then(onChanged)}
        />
      )}
    </section>
  );
}

/** Fields a home scale reports beyond the InBody sheet's. */
const HOME_FIELDS = ["muscle_mass_kg", "bone_mass_kg", "body_water_pct", "protein_pct", "skeletal_muscle_pct", "subcutaneous_fat_pct", "metabolic_age", "heart_rate_bpm"];
const FIELD_GROUPS: [string, (f: InBodyField) => boolean][] = [
  ["Body composition", (f) => !f.column.startsWith("lean_") && !f.column.startsWith("fat_") && !HOME_FIELDS.includes(f.column) && f.unit !== "ohm"],
  ["More from the scale", (f) => HOME_FIELDS.includes(f.column)],
  ["Segmental lean", (f) => f.column.startsWith("lean_")],
  ["Segmental fat", (f) => f.column.startsWith("fat_")],
  ["Raw impedance", (f) => f.unit === "ohm"],
];

/** A weigh-in's scan in full: every value it has, grouped, each against that device's previous scan,
 *  and a chart of any of them over that device's scans ("scale data"). */
function ScanReport({
  scan,
  scans,
  fields,
  profiles,
  onClose,
  onEdit,
  onEditWeight,
}: {
  scan: InBodyScan;
  scans: InBodyScan[];
  fields: InBodyField[];
  profiles: ScaleProfile[];
  onClose: () => void;
  onEdit: () => void;
  onEditWeight?: () => void;
}) {
  const { unit } = usePrefs();
  const src = scan.source ?? "inbody";
  const device = sourceName(profiles, src);
  const same = scans.filter((s) => (s.source ?? "inbody") === src);
  const prev = [...same].reverse().find((s) => s.measured_at_local < scan.measured_at_local);
  const has = fields.filter((f) => scan.values[f.column] != null);
  const charted = has.filter((f) => same.filter((s) => s.values[f.column] != null).length > 1);
  const [metric, setMetric] = useState(charted.find((f) => f.column === "pbf")?.column ?? charted[0]?.column ?? "");
  const field = fields.find((f) => f.column === metric);
  const display = (f: InBodyField, v: number) => (f.unit === "kg" ? toUnit(v, unit) : v);
  const change = (f: InBodyField) => {
    const a = prev?.values[f.column];
    const b = scan.values[f.column];
    if (a == null || Math.abs(b - a) < 1e-9) return "";
    const d = display(f, b) - display(f, a);
    return `${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(f.unit === "kcal" || f.unit === "ohm" ? 0 : 1)}`;
  };
  return (
    <Modal title={`${device}: ${formatDate(scan.measured_at_local)} ${formatTime(scan.measured_at_local)}`} onClose={onClose} wide>
      {FIELD_GROUPS.map(([title, pred]) => {
        const fs = has.filter(pred);
        if (!fs.length) return null;
        return (
          <details key={title} open={title !== "Raw impedance"}>
            <summary className="section-label">{title}</summary>
            <table className="table small">
              <tbody>
                {fs.map((f) => (
                  <tr key={f.column}>
                    <td>{f.label}</td>
                    <td>
                      <strong>{showValue(f, scan.values[f.column], unit)}</strong>
                    </td>
                    <td className="muted">{change(f)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        );
      })}
      {prev && <p className="muted small">Changes are since your previous {device} reading ({formatDate(prev.measured_at_local)}).</p>}
      {scan.notes && <p className="muted small">{scan.notes}</p>}
      {charted.length > 0 && field && (
        <>
          <div className="section-label">Scale data: {device}</div>
          <select className="select" value={metric} onChange={(e) => setMetric(e.target.value)}>
            {charted.map((f) => (
              <option key={f.column} value={f.column}>
                {f.label}
              </option>
            ))}
          </select>
          <TimeSeriesChart
            title={`${field.label} (${device})`}
            series={[
              {
                id: metric,
                label: field.label,
                points: same.filter((s) => s.values[metric] != null).map((s) => ({ t: parseLocal(s.measured_at_local), v: display(field, s.values[metric]) })),
              },
            ]}
            unit={field.unit === "kg" ? unit : field.unit === "pct" ? "%" : field.unit === "ohm" ? "Ω" : field.unit === "kcal" ? "kcal" : ""}
            height={200}
          />
        </>
      )}
      <div className="row">
        <button className="button" onClick={onEdit}>
          Edit scan
        </button>
        {onEditWeight && (
          <button className="button" onClick={onEditWeight}>
            Edit weight
          </button>
        )}
        <button className="button primary" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

/** Fix the value and date/time of a logged entry, or delete it. */
function EntryEditor({
  title,
  unitLabel,
  value,
  at,
  onClose,
  onSave,
  onDelete,
}: {
  title: string;
  unitLabel: string;
  value: number;
  at: string;
  onClose: () => void;
  onSave: (value: number, at: string) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
}) {
  const [v, setV] = useState(String(Math.round(value * 10) / 10));
  const [when, setWhen] = useState(at.slice(0, 16).replace(" ", "T"));
  const [error, setError] = useState<string | null>(null);
  async function save() {
    const n = Number(v.replace(",", "."));
    if (!(n > 0)) return setError("Enter a number above 0.");
    try {
      await onSave(n, when.replace("T", " ") + ":00");
      onClose();
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <Modal title={title} onClose={onClose}>
      <div className="form">
        <label>
          Value ({unitLabel})
          <input
            className="big-input"
            inputMode="decimal"
            value={v}
            autoFocus
            onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
          />
        </label>
        <label>
          Date & time
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </label>
        {error && <p className="error small">{error}</p>}
        <div className="row">
          <button className="button primary" onClick={save}>
            Save
          </button>
          <button
            className="button danger"
            onClick={() =>
              ask("Delete this entry?").then((ok) => {
                if (ok) onDelete().then(onClose);
              })
            }
          >
            Delete
          </button>
          <button className="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

// ---- InBody -------------------------------------------------------------------------------------------

/** Body-composition scans from every device: adding and importing them, and the list (data), or
 *  their charts (charts). */
function InBodyTab({ mode }: { mode: Mode }) {
  const { unit } = usePrefs();
  const [fields, setFields] = useState<InBodyField[]>([]);
  const [scans, setScans] = useState<InBodyScan[]>([]);
  const [phases, setPhases] = useState<Phase[]>([]);
  const [editing, setEditing] = useState<InBodyScan | null>(null);
  const [report, setReport] = useState<InBodyScan | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [flagged, setFlagged] = useState<string[]>([]);
  const [review, setReview] = useState<{ scan: InBodyScan; doubtful: string[] }[]>([]);
  const [reading, setReading] = useState<string | null>(null);
  const [csv, setCsv] = useState<{ text: string; preview: InBodyCsvPreview } | null>(null);
  const [metric, setMetric] = useState("smm_kg");
  const [msg, setMsg] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<ScaleProfile[]>([]);
  /** The device the import buttons are for. */
  const [profileId, setProfileId] = useState<string | null>(() => {
    try {
      return localStorage.getItem("bodyCompDevice");
    } catch {
      return null;
    }
  });
  const load = () => {
    api.inbodyScans().then((x) => {
      setScans(x);
      setLoaded(true);
    });
  };
  const loadProfiles = () => api.scaleProfiles().then(setProfiles);
  useEffect(() => {
    load();
    loadProfiles();
    api.inbodyFields().then(setFields);
    api.listPhases().then(setPhases);
  }, []);
  // The chosen device, else a Bluetooth scale (what you weigh in on at home), else the first.
  const profile = profiles.find((p) => p.id === profileId) ?? profiles.find((p) => p.bluetooth) ?? profiles[0];
  const chooseProfile = (id: string) => {
    setProfileId(id);
    try {
      localStorage.setItem("bodyCompDevice", id);
    } catch {
      /* storage unavailable */
    }
  };
  const sources = [...new Set(scans.map((s) => s.source ?? "inbody"))];

  const conv = (f: InBodyField | undefined, v: number) => (f?.unit === "kg" ? toUnit(v, unit) : v);
  const fieldOf = (c: string) => fields.find((f) => f.column === c);
  const unitLabel = (f?: InBodyField) =>
    !f ? "" : f.unit === "kg" ? unit : f.unit === "pct" ? "%" : f.unit === "l" ? "L" : f.unit === "kcal" ? "kcal" : "";
  const unitLabel2 = (f?: InBodyField) => (f?.unit === "ohm" ? "Ω" : f?.unit === "bpm" ? "bpm" : f?.unit === "years" ? "years" : unitLabel(f));
  // One line across every device's scans.
  const series = (c: string): Series[] => [
    {
      id: c,
      label: fieldOf(c)?.label ?? c,
      points: scans.filter((s) => s.values[c] != null).map((s) => ({ t: parseLocal(s.measured_at_local), v: conv(fieldOf(c), s.values[c]) })) as Point[],
    },
  ];
  const available = fields.filter(
    (f) => scans.some((s) => s.values[f.column] != null) && !f.column.startsWith("lean_") && !f.column.startsWith("fat_"),
  );

  async function onFile(file?: File) {
    if (!file) return;
    const text = await file.text();
    const preview = await api.previewInbodyCsv(text);
    // A file with columns seen before keeps its device; a new one is for the chosen device.
    if (!preview.remembered && profile && profile.id !== "inbody") preview.mapping.source = profile.id;
    setCsv({ text, preview });
  }

  /** A scale-app screenshot read with each home-scale profile's labels: the profile that finds the
   *  most values, or null when none finds any. */
  async function readAsScaleScreenshot(file: File) {
    const data = await fileToBase64(file);
    let best: { scan: InBodyScan; doubtful: string[] } | null = null;
    for (const p of profiles.filter((p) => p.id !== "inbody" && Object.keys(p.labels).length > 0)) {
      const r = await api.readBodyCompScreenshot(data, p.id, unit).catch(() => null);
      if (!r || Object.keys(r.values).length <= Object.keys(best?.scan.values ?? {}).length) continue;
      best = {
        scan: { id: null, measured_at_local: r.measured_at ?? nowLocal(), values: r.values, device: p.name, notes: null, source: p.id },
        doubtful: r.measured_at ? r.doubtful : [...r.doubtful, "date"],
      };
    }
    return best;
  }

  /** InBody result sheets (clean reads are saved, anything doubtful opens for a check) and
   *  scale-app screenshots (always checked). */
  async function onImages(files: FileList | null) {
    if (!files?.length) return;
    setMsg(null);
    const existing = new Set(scans.map((s) => s.measured_at_local.slice(0, 16)));
    let saved = 0;
    let skipped = 0;
    const toCheck: { scan: InBodyScan; doubtful: string[] }[] = [];
    const failed: string[] = [];
    for (const [i, file] of [...files].entries()) {
      setReading(`Reading sheet ${i + 1} of ${files.length}…`);
      try {
        const r = await api.readInbodyImage(await fileToBase64(file), unit);
        if (r.measured_at && existing.has(r.measured_at.slice(0, 16))) {
          skipped++;
          continue;
        }
        const scan: InBodyScan = {
          id: null,
          measured_at_local: r.measured_at ?? nowLocal(),
          values: r.values,
          device: "InBody 580",
          notes: null,
        };
        if (r.doubtful.length === 0 && r.measured_at) {
          await api.saveInbodyScan(scan);
          existing.add(r.measured_at.slice(0, 16));
          saved++;
        } else {
          toCheck.push({ scan, doubtful: r.measured_at ? r.doubtful : [...r.doubtful, "date"] });
        }
      } catch (e) {
        // Not an InBody sheet: maybe a home scale's app screenshot.
        const shot = await readAsScaleScreenshot(file);
        if (shot) toCheck.push(shot);
        else failed.push(`${file.name}: ${e}`);
      }
    }
    setReading(null);
    load();
    setMsg(
      [
        saved && `Saved ${saved} scan${saved > 1 ? "s" : ""}.`,
        skipped && `${skipped} already in your scans.`,
        toCheck.length && `${toCheck.length} need${toCheck.length > 1 ? "" : "s"} a quick check.`,
        failed.length && `Couldn't read: ${failed.join("; ")}`,
      ]
        .filter(Boolean)
        .join(" "),
    );
    if (toCheck.length) {
      setEditing(toCheck[0].scan);
      setFlagged(toCheck[0].doubtful);
      setReview(toCheck.slice(1));
    }
  }
  const nextReview = () => {
    const [next, ...rest] = review;
    setEditing(next?.scan ?? null);
    setFlagged(next?.doubtful ?? []);
    setReview(rest);
  };

  if (mode === "charts")
    return !loaded ? null : scans.length === 0 ? (
      <p className="empty">No scans yet. Add them under Data & metrics › Scans.</p>
    ) : (
      <>
        <section className="card">
          <div className="title-row">
            <h2 className="section-title">Body composition: any metric</h2>
            <ShareButton kind="inbody" />
          </div>
          <select className="select" value={metric} onChange={(e) => setMetric(e.target.value)}>
            {available.map((f) => (
              <option key={f.column} value={f.column}>
                {f.label}
              </option>
            ))}
          </select>
          <TimeSeriesChart
            title={fieldOf(metric)?.label ?? metric}
            series={series(metric)}
            unit={unitLabel2(fieldOf(metric))}
            bands={bandsOf(phases)}
            height={220}
          />
        </section>
        <Segmental scans={scans} unit={unit} />
        <ImpedanceCard scans={scans} profiles={profiles} unit={unit} />
      </>
    );

  return (
    <>
      <section className="card">
        <div className="form-row" style={{ marginTop: 0 }}>
          <label>
            Device
            <select className="select" value={profile?.id ?? profileId} onChange={(e) => chooseProfile(e.target.value)}>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="row">
          <button
            className="button primary"
            onClick={() => {
              setFlagged([]);
              setEditing({
                id: null,
                measured_at_local: nowLocal(),
                values: {},
                device: profile && profile.id !== "inbody" ? profile.name : null,
                notes: null,
                source: profile?.id ?? null,
              });
            }}
          >
            + Add scan
          </button>
          <label className="button">
            Read images
            <input type="file" accept="image/*" multiple hidden disabled={!!reading} onChange={(e) => onImages(e.target.files)} />
          </label>
          <label className="button">
            Import CSV
            <input type="file" accept=".csv,text/csv" hidden onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
        </div>
        <p className="muted small">
          Read images takes InBody result sheets and scale-app screenshots, read on this device.
          {IS_ANDROID && " Weigh in on your Bluetooth scale with the Weigh in button at the top; set it up under Settings › Scale."}
        </p>
        {reading && <p className="small">{reading}</p>}
        {msg && <p className="success small">{msg}</p>}
      </section>
      {!loaded ? null : scans.length === 0 ? (
        <p className="empty">No scans yet. Weigh in on your scale, read a screenshot or result sheet, or import a CSV.</p>
      ) : (
        <>
          <section className="card">
            <div className="section-label">Scans</div>
            {[...scans].reverse().map((s) => (
              <div key={s.id} className="start-row" onClick={() => setReport(s)}>
                <span>
                  {formatDate(s.measured_at_local)}
                  {sources.length > 1 && <span className="chip">{sourceName(profiles, s.source)}</span>}
                  <span className="muted small">
                    {" "}
                    · {s.values.weight_kg != null && `${toUnit(s.values.weight_kg, unit).toFixed(1)} ${unit}`}
                    {s.values.pbf != null && ` · ${s.values.pbf}% fat`}
                    {s.values.smm_kg != null && ` · SMM ${toUnit(s.values.smm_kg, unit).toFixed(1)}`}
                  </span>
                </span>
                <span className="muted">Details ›</span>
              </div>
            ))}
          </section>
        </>
      )}
      {report && (
        <ScanReport
          scan={report}
          scans={scans}
          fields={fields}
          profiles={profiles}
          onClose={() => setReport(null)}
          onEdit={() => {
            setFlagged([]);
            setEditing(report);
            setReport(null);
          }}
        />
      )}
      {editing && (
        <ScanForm
          key={editing.measured_at_local}
          scan={editing}
          fields={fields}
          unit={unit}
          flagged={flagged}
          known={Object.keys(profiles.find((p) => p.id === editing.source && p.id !== "inbody")?.labels ?? {})}
          onClose={nextReview}
          onSaved={() => {
            load();
            nextReview();
          }}
        />
      )}
      {csv && (
        <CsvMapper
          profiles={profiles}
          text={csv.text}
          initial={csv.preview}
          fields={fields}
          onClose={() => setCsv(null)}
          onImported={(n) => {
            setCsv(null);
            setMsg(`Imported ${n} scans. The column mapping is remembered for files like this.`);
            load();
          }}
        />
      )}
    </>
  );
}

const SEGMENTS: [string, string][] = [
  ["right_arm", "Right arm"],
  ["left_arm", "Left arm"],
  ["trunk", "Trunk"],
  ["right_leg", "Right leg"],
  ["left_leg", "Left leg"],
];

/** Segmental lean or fat mass of the latest scan: one bar per segment on a shared scale, with the
 *  normal range when the sheet gives "% of normal", and each segment's change since the first scan. */
function Segmental({ scans, unit }: { scans: InBodyScan[]; unit: "kg" | "lb" }) {
  const screen = useChartTheme();
  const [kind, setKind] = useState<"lean" | "fat">("lean");
  const kgOf = (x: InBodyScan, seg: string) => x.values[`${kind}_${seg}_kg`];
  const withData = scans.filter((x) => SEGMENTS.some(([seg]) => kgOf(x, seg) != null));
  if (!withData.length) return null;
  const scan = withData[withData.length - 1];
  const first = withData[0];
  const pct = (seg: string) => scan.values[`${kind}_${seg}_pct`];
  // Lean mass on the InBody sheet comes with "% of normal"; otherwise bars show kg.
  const usePct = SEGMENTS.every(([seg]) => pct(seg) != null);
  const rows = SEGMENTS.map(([seg, name]) => {
    const kg = kgOf(scan, seg);
    const was = first !== scan ? kgOf(first, seg) : undefined;
    return { seg, name, kg, pct: pct(seg), delta: kg != null && was != null ? kg - was : null };
  });
  const values = rows.map((r) => (usePct ? r.pct : r.kg)).filter((v): v is number => v != null);
  const domain: [number, number] = usePct
    ? [Math.min(60, d3.min(values)! - 10), Math.max(160, d3.max(values)! + 10)]
    : [0, d3.max(values)! * 1.1];
  const W = 340;
  const labelW = 74;
  const valueW = 112;
  const rowH = 30;
  const top = 20;
  const x = d3.scaleLinear(domain, [labelW, W - valueW]);
  const H = top + rows.length * rowH + 4;
  const ticks = usePct ? [80, 100, 120, 140].filter((t) => t > domain[0] && t < domain[1]) : x.ticks(4);
  const delta = (d: number | null) => (d == null || Math.abs(d) < 0.005 ? "" : ` (${d > 0 ? "+" : "−"}${Math.abs(toUnit(d, unit)).toFixed(1)})`);
  const draw = (theme: ChartTheme, hide = false) => {
    const fill = kind === "lean" ? theme.categorical[0] : theme.categorical[1];
    return (
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", maxWidth: 560 }} fontFamily="system-ui, sans-serif">
            {usePct && (
              <>
                {/* InBody's normal range for segmental lean mass is about 90–110 % of ideal. */}
                <rect x={x(90)} y={top - 4} width={x(110) - x(90)} height={H - top} fill={theme.grid} />
                <text x={(x(90) + x(110)) / 2} y={top - 8} fontSize={9} fill={theme.muted} textAnchor="middle">
                  normal
                </text>
              </>
            )}
            {ticks.map((t) => (
              <g key={t}>
                <line x1={x(t)} x2={x(t)} y1={top - 4} y2={H} stroke={t === 100 && usePct ? theme.muted : theme.gridStrong} strokeDasharray={t === 100 && usePct ? undefined : "2 3"} />
                {!(usePct && t === 100) && (
                  <text x={x(t)} y={top - 8} fontSize={9} fill={theme.muted} textAnchor="middle">
                    {usePct ? `${t}%` : hide ? "" : toUnit(t, unit).toFixed(0)}
                  </text>
                )}
              </g>
            ))}
            {rows.map((r, i) => {
              const y = top + i * rowH;
              const v = usePct ? r.pct : r.kg;
              return (
                <g key={r.seg}>
                  <text x={0} y={y + rowH / 2 + 4} fontSize={11.5} fill={theme.text}>
                    {r.name}
                  </text>
                  {v != null && (
                    <rect x={x(domain[0])} y={y + 7} width={Math.max(2, x(v) - x(domain[0]))} height={rowH - 14} rx={3} fill={fill} />
                  )}
                  <text x={W} y={y + rowH / 2 + 4} fontSize={11} fill={theme.text} textAnchor="end">
                    {hide ? "" : r.kg != null ? `${toUnit(r.kg, unit).toFixed(1)} ${unit}` : "—"}
                    {!hide && usePct && r.pct != null ? ` · ${r.pct}%` : ""}
                    {!hide && <tspan fill={theme.muted}>{delta(r.delta)}</tspan>}
                  </text>
                </g>
              );
            })}
      </svg>
    );
  };
  return (
    <section className="card">
      <div className="title-row">
        <h2 className="section-title">Segmental {kind} mass</h2>
        <ShareButton
          icon
          kind="visual"
          title={`Segmental ${kind} mass`}
          subtitle={formatDate(scan.measured_at_local)}
          render={(theme, _w, _h, hide) => draw(theme, hide)}
        />
        <div className="segmented small">
          <button className={kind === "lean" ? "active" : ""} onClick={() => setKind("lean")}>
            Lean
          </button>
          <button className={kind === "fat" ? "active" : ""} onClick={() => setKind("fat")}>
            Fat
          </button>
        </div>
      </div>
      {draw(screen)}
      <p className="muted small">
        {formatDate(scan.measured_at_local)}
        {first !== scan ? ` · changes in brackets since ${formatDate(first.measured_at_local)}` : ""}
        {usePct ? " · bars are % of the ideal for your height (InBody), shaded band is normal" : ""}
      </p>
    </section>
  );
}

function ScanForm({
  scan,
  fields,
  unit,
  flagged = [],
  known = [],
  onClose,
  onSaved,
}: {
  scan: InBodyScan;
  fields: InBodyField[];
  unit: "kg" | "lb";
  /** Fields read from an image that need checking (highlighted). */
  flagged?: string[];
  /** Fields the scale's app shows (its profile's labels): only these are open; the rest come from
   *  Bluetooth or other devices. */
  known?: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toDisplay = (f: InBodyField, v: number) => (f.unit === "kg" ? Math.round(toUnit(v, unit) * 100) / 100 : v);
  const [vals, setVals] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(scan.values).map(([k, v]) => [
        k,
        String(
          toDisplay(
            fields.find((f) => f.column === k)!,
            v,
          ),
        ),
      ]),
    ),
  );
  const [when, setWhen] = useState(scan.measured_at_local.slice(0, 16).replace(" ", "T"));
  const [device, setDevice] = useState(scan.device ?? "");
  const [notes, setNotes] = useState(scan.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const label = (f: InBodyField) =>
    `${f.label}${
      f.unit === "kg"
        ? ` (${unit})`
        : f.unit === "pct"
          ? " (%)"
          : f.unit === "l"
            ? " (L)"
            : f.unit === "kcal"
              ? " (kcal)"
              : f.unit === "ohm"
                ? " (Ω)"
                : f.unit === "bpm"
                  ? " (bpm)"
                  : f.unit === "years"
                    ? " (years)"
                    : ""
    }`;
  const HOME = ["muscle_mass_kg", "bone_mass_kg", "body_water_pct", "protein_pct", "skeletal_muscle_pct", "subcutaneous_fat_pct", "metabolic_age", "heart_rate_bpm"];
  const isImp = (f: InBodyField) => f.unit === "ohm";
  const groups: [string, (f: InBodyField) => boolean][] = [
    ["Body composition", (f) => !f.column.startsWith("lean_") && !f.column.startsWith("fat_") && !HOME.includes(f.column) && !isImp(f)],
    ["Home scale", (f) => HOME.includes(f.column)],
    ["Segmental lean", (f) => f.column.startsWith("lean_")],
    ["Segmental fat", (f) => f.column.startsWith("fat_")],
    ["Raw impedance", isImp],
  ];
  const homeScale = (scan.source ?? "inbody") !== "inbody";
  // A home scale's app shows a few fields: those first, the rest folded away.
  const appShows = (f: InBodyField) => known.includes(f.column) || scan.values[f.column] != null;
  const shown: [string, (f: InBodyField) => boolean][] =
    homeScale && known.length
      ? [
          [`Shown in the ${scan.device ?? "scale"} app`, appShows],
          ...groups.map(([t, pred]): [string, (f: InBodyField) => boolean] => [`More: ${t.toLowerCase()} (Bluetooth or other devices)`, (f) => pred(f) && !appShows(f)]),
        ]
      : groups;

  async function save() {
    const values: Record<string, number> = {};
    for (const [k, v] of Object.entries(vals)) {
      if (v.trim() === "") continue;
      const n = Number(v.replace(",", "."));
      if (Number.isNaN(n)) return setError(`${k}: not a number`);
      const f = fields.find((x) => x.column === k)!;
      values[k] = f.unit === "kg" && unit === "lb" ? n * KG_PER_LB : n;
    }
    try {
      await api.saveInbodyScan({
        id: scan.id,
        measured_at_local: when.replace("T", " ") + ":00",
        values,
        device: device || null,
        notes: notes || null,
        source: scan.source ?? null,
      });
      onSaved();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <Modal title={scan.id ? "Edit scan" : scan.device ? `New scan: ${scan.device}` : "New scan"} onClose={onClose} wide>
      <div className="form">
        <div className="form-row">
          <label>
            Date & time
            <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </label>
          <label>
            Device
            <input value={device} placeholder={homeScale ? "Model" : "InBody 570"} onChange={(e) => setDevice(e.target.value)} />
          </label>
        </div>
        {flagged.length > 0 ? (
          <p className="warn small">
            Read from {homeScale ? "a screenshot" : "the sheet image"}. Check the highlighted {flagged.includes("date") ? "date and " : ""}fields against the sheet before
            saving.
          </p>
        ) : (
          <p className="muted small">
            Every field is optional; fill in what's on your {homeScale ? "scale's app" : "result sheet"}.
          </p>
        )}
        {shown.filter(([, pred]) => fields.some(pred)).map(([title, pred], i) => (
          <details
            key={title}
            open={
              (shown === groups ? title === "Body composition" : i === 0) ||
              (shown === groups && title === "Home scale" && homeScale) ||
              fields.some((f) => pred(f) && (flagged.includes(f.column) || vals[f.column]))
            }
          >
            <summary className="section-label">{title}</summary>
            <div className="field-grid">
              {fields.filter(pred).map((f) => (
                <label key={f.column} className={flagged.includes(f.column) ? "flagged" : undefined}>
                  {label(f)}
                  <input
                    inputMode="decimal"
                    value={vals[f.column] ?? ""}
                    onChange={(e) => setVals({ ...vals, [f.column]: e.target.value })}
                  />
                </label>
              ))}
            </div>
          </details>
        ))}
        <label>
          Notes
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button className="button primary" onClick={save}>
            Save
          </button>
          {scan.id && (
            <button
              className="button danger"
              onClick={() =>
                ask("Delete this scan?").then((ok) => {
                  if (ok) api.deleteInbodyScan(scan.id!).then(onSaved);
                })
              }
            >
              Delete
            </button>
          )}
          <button className="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

function CsvMapper({
  profiles,
  text,
  initial,
  fields,
  onClose,
  onImported,
}: {
  profiles: ScaleProfile[];
  text: string;
  initial: InBodyCsvPreview;
  fields: InBodyField[];
  onClose: () => void;
  onImported: (n: number) => void;
}) {
  const [mapping, setMapping] = useState<CsvMapping>(initial.mapping);
  const [preview, setPreview] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .previewInbodyCsv(text, mapping)
      .then(setPreview)
      .catch((e) => setError(String(e)));
  }, [mapping, text]);
  const fieldFor = (h: string) => mapping.columns[h] ?? "";
  const setField = (h: string, f: string) => {
    const columns = { ...mapping.columns };
    if (f) columns[h] = f;
    else delete columns[h];
    setMapping({ ...mapping, columns });
  };
  return (
    <Modal title="Map body-composition CSV columns" onClose={onClose} wide>
      {initial.remembered && <p className="success small">Using the mapping you saved for files with these columns.</p>}
      <div className="form-row">
        <label>
          Date column
          <select className="select" value={mapping.date_column} onChange={(e) => setMapping({ ...mapping, date_column: e.target.value })}>
            {preview.headers.map((h) => (
              <option key={h}>{h}</option>
            ))}
          </select>
        </label>
        <label>
          Device
          <select
            className="select"
            value={mapping.source ?? "inbody"}
            onChange={(e) => setMapping({ ...mapping, source: e.target.value === "inbody" ? null : e.target.value })}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Masses in the file are in
          <select
            className="select"
            value={mapping.mass_unit}
            onChange={(e) => setMapping({ ...mapping, mass_unit: e.target.value as "kg" | "lb" })}
          >
            <option value="kg">kg</option>
            <option value="lb">lb</option>
          </select>
        </label>
      </div>
      <table className="sets small">
        <tbody>
          {preview.headers
            .filter((h) => h !== mapping.date_column)
            .map((h) => (
              <tr key={h}>
                <td>{h}</td>
                <td>
                  <select className="select inline" value={fieldFor(h)} onChange={(e) => setField(h, e.target.value)}>
                    <option value="">— ignore —</option>
                    {fields.map((f) => (
                      <option key={f.column} value={f.column}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
        </tbody>
      </table>
      <p className="small">
        {preview.scans.length} scans ready{preview.errors.length > 0 && <span className="warn"> · {preview.errors.length} problems</span>}
      </p>
      {preview.errors.length > 0 && (
        <details className="warnings">
          <summary className="small">Problems</summary>
          <ul>
            {preview.errors.slice(0, 50).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </details>
      )}
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button
          className="button primary"
          disabled={!preview.scans.length}
          onClick={() =>
            api
              .importInbodyCsv(text, mapping)
              .then(onImported)
              .catch((e) => setError(String(e)))
          }
        >
          Import {preview.scans.length} scans
        </button>
        <button className="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

// ---- Diet ----------------------------------------------------------------------------------------------

/** Calories and protein: logging them (data), or energy balance from the weight trend (charts). */
function DietTab({ mode }: { mode: Mode }) {
  const { unit } = usePrefs();
  const [days, setDays] = useState<DietDay[]>([]);
  const [energy, setEnergy] = useState<EnergyPoint[]>([]);
  const [window_, setWindow] = useState(14);
  const [range, setRange] = useSavedRange("diet");
  const [phases, setPhases] = useState<Phase[]>([]);
  const [date, setDate] = useState(today());
  const load = () => {
    api.dietDays().then(setDays);
    api.energyBalance(window_).then(setEnergy);
  };
  useEffect(() => {
    load();
    api.listPhases().then(setPhases);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [window_]);
  const day = days.find((d) => d.date === date);
  const [cal, setCal] = useState("");
  const [protein, setProtein] = useState("");
  useEffect(() => {
    setCal(day?.calories != null ? String(day.calories) : "");
    setProtein(day?.protein_g != null ? String(day.protein_g) : "");
  }, [date, day?.calories, day?.protein_g]);

  async function save() {
    await api.saveDietDay({
      date,
      calories: cal ? Number(cal) : null,
      protein_g: protein ? Number(protein) : null,
      notes: day?.notes ?? null,
    });
    load();
  }

  const e = energy.filter((p) => inRange(p.date, range));
  const latest = [...energy].reverse().find((p) => p.balance_kcal != null);
  const latestTdee = [...energy].reverse().find((p) => p.tdee_kcal != null);
  const d = (s: string) => parseLocal(s);
  const balance = e.filter((p) => p.balance_kcal != null).map((p) => ({ t: d(p.date), v: Math.round(p.balance_kcal!) }));
  const tdee = e.filter((p) => p.tdee_kcal != null).map((p) => ({ t: d(p.date), v: Math.round(p.tdee_kcal!) }));
  const intake = days.filter((x) => x.calories != null && inRange(x.date, range)).map((x) => ({ t: d(x.date), v: x.calories! }));
  const proteinPts = days.filter((x) => x.protein_g != null && inRange(x.date, range)).map((x) => ({ t: d(x.date), v: x.protein_g! }));
  const bands = useMemo(() => bandsOf(phases), [phases]);

  const logged = days.filter((x) => x.calories != null || x.protein_g != null).reverse();
  if (mode === "data")
    return (
      <>
      <section className="card">
        <p className="muted small">Optional. Log whatever you track; days don't need to match weigh-ins.</p>
        <div className="form-row">
          <label>
            Date
            <input type="date" value={date} onChange={(x) => setDate(x.target.value)} />
          </label>
          <label>
            Calories
            <input inputMode="numeric" value={cal} onChange={(x) => setCal(x.target.value)} placeholder="kcal" />
          </label>
          <label>
            Protein
            <input inputMode="numeric" value={protein} onChange={(x) => setProtein(x.target.value)} placeholder="g" />
          </label>
          <button className="button primary" style={{ alignSelf: "end" }} onClick={save}>
            Save
          </button>
        </div>
      </section>
      {logged.length > 0 && (
        <section className="card">
          <div className="section-label">Logged days · tap one to change it</div>
          {logged.slice(0, 30).map((x) => (
            <button key={x.date} className="start-row" onClick={() => setDate(x.date)}>
              <span>{formatDate(x.date)}</span>
              <span>
                {x.calories != null && <strong>{x.calories.toLocaleString()} kcal</strong>}
                {x.protein_g != null && <span className="muted"> · {x.protein_g} g protein</span>}
              </span>
            </button>
          ))}
        </section>
      )}
      </>
    );

  return (
    <>
      <section className="card">
        <h2 className="section-title">Energy balance</h2>
        <div className="stats-row">
          {latest?.balance_kcal != null && (
            <Stat
              label={latest.balance_kcal >= 0 ? "Estimated surplus" : "Estimated deficit"}
              value={`${Math.abs(Math.round(latest.balance_kcal))} kcal/day`}
            />
          )}
          {latestTdee?.tdee_kcal != null && <Stat label="Estimated TDEE" value={`${Math.round(latestTdee.tdee_kcal)} kcal`} />}
          {latest && <Stat label="Trend weight" value={`${toUnit(latest.trend_kg, unit).toFixed(1)} ${unit}`} />}
        </div>
        <p className="muted small">
          From your weight trend: each {unit === "lb" ? "lb" : "kg"} gained or lost ≈ {unit === "lb" ? "3,500" : "7,700"} kcal. TDEE needs
          calories logged on at least half the days in the window.
        </p>
        <div className="row small" style={{ marginTop: 0 }}>
          Window
          <div className="segmented small">
            {[7, 14, 28].map((w) => (
              <button key={w} className={window_ === w ? "active" : ""} onClick={() => setWindow(w)}>
                {w} days
              </button>
            ))}
          </div>
        </div>
        <RangePicker value={range} onChange={setRange} phases={phases} />
        <div className="section-label">Surplus (+) / deficit (−) from weight trend</div>
        <TimeSeriesChart
          title="Surplus / deficit from weight trend"
          series={[{ id: "bal", label: "Balance", points: balance }]}
          unit="kcal"
          bands={bands}
          height={220}
          diverging={{ aboveLabel: "Surplus", belowLabel: "Deficit" }}
          yStep={250}
          yFormat={(v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(Math.round(v)).toLocaleString()}
        />
        {tdee.length > 0 && (
          <>
            <div className="section-label">Estimated TDEE and logged intake</div>
            <TimeSeriesChart
              title="Estimated TDEE and logged intake"
              series={[
                { id: "tdee", label: "TDEE", points: tdee },
                { id: "in", label: "Intake", points: intake, style: "points" },
              ]}
              unit="kcal"
              height={200}
            />
          </>
        )}
        {proteinPts.length > 0 && (
          <>
            <div className="section-label">Protein</div>
            <TimeSeriesChart series={[{ id: "p", label: "Protein", points: proteinPts }]} unit="g" height={160} />
          </>
        )}
      </section>
    </>
  );
}
