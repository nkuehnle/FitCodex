import type { Goal, WeighInRow } from "../api";
import { parseLocal } from "../format";

/** A goal's target range of bodyweight over time, fanning out from where the goal began. */
export interface Corridor {
  from: Date;
  to: Date;
  /** Bodyweight where the goal began (display units). */
  v0: number;
  /** Target change per day (display units): low and high edge. */
  lo: number;
  hi: number;
  /** Half-height at the start (display units): 0 for a wedge, the tolerance for a level band. */
  half: number;
  label: string;
}

export interface GoalStretch {
  goal: Goal;
  start_date: string;
  end_date: string | null;
  weekly_rate_kg: number | null;
}

const DAY = 86_400_000;
/** Default targets, % of bodyweight a week (see `Goal::weekly_rate_pct` in crates/core/src/planning.rs). */
const RATE_PCT: Record<"cut" | "gain", [number, number]> = { cut: [-1, -0.5], gain: [0.25, 0.5] };
/** Maintenance is drawn as a level band this fraction of bodyweight either side (a choice made here). */
const MAINTAIN_BAND = 0.01;
/** A custom weekly target counts as hit within this many kg either side (as on the Today card). */
const CUSTOM_TOLERANCE_KG = 0.1;
const GOAL_LABEL: Record<Goal, string> = { cut: "Cut target", maintain: "Maintain target", gain: "Gain target" };

/** Bodyweight around a moment: the mean of weigh-ins within 3 days, else the nearest within 10. */
export function weightNear(scale: { t: number; kg: number }[], at: number): number | null {
  const near = scale.filter((r) => Math.abs(r.t - at) <= 3 * DAY);
  if (near.length) return near.reduce((s, r) => s + r.kg, 0) / near.length;
  const nearest = scale.reduce<{ t: number; kg: number } | null>(
    (best, r) => (!best || Math.abs(r.t - at) < Math.abs(best.t - at) ? r : best),
    null,
  );
  return nearest && Math.abs(nearest.t - at) <= 10 * DAY ? nearest.kg : null;
}

export interface PhaseLine {
  id: string;
  label: string;
  /** The stretch still running. */
  current: boolean;
  /** x: weeks since the stretch began; y: change in bodyweight since then (kg), one point a week. */
  points: { x: number; y: number }[];
}

/** Each stretch of one goal as a line of weekly average bodyweight change from its own start. */
export function phaseLines(goals: GoalStretch[], rows: WeighInRow[], goal: Goal, until: Date): PhaseLine[] {
  const scale = rows.filter((r) => r.source !== "inbody").map((r) => ({ t: parseLocal(r.at).getTime(), kg: r.weight_kg }));
  const out: PhaseLine[] = [];
  for (const g of goals.filter((x) => x.goal === goal)) {
    const from = parseLocal(g.start_date).getTime();
    const to = g.end_date ? parseLocal(g.end_date).getTime() + DAY : until.getTime();
    const startKg = weightNear(scale, from);
    if (startKg == null) continue;
    const weeks = new Map<number, { kg: number; days: number; n: number }>();
    for (const r of scale) {
      if (r.t < from || r.t >= to) continue;
      const k = Math.floor((r.t - from) / (7 * DAY));
      const w = weeks.get(k) ?? { kg: 0, days: 0, n: 0 };
      weeks.set(k, { kg: w.kg + r.kg, days: w.days + (r.t - from) / DAY, n: w.n + 1 });
    }
    const points = [...weeks.entries()].sort((a, b) => a[0] - b[0]).map(([, w]) => ({ x: w.days / w.n / 7, y: w.kg / w.n - startKg }));
    if (points.length < 2) continue;
    out.push({
      id: g.start_date,
      label: parseLocal(g.start_date).toLocaleDateString(undefined, { month: "short", year: "numeric" }),
      current: g.end_date == null || parseLocal(g.end_date).getTime() + DAY >= until.getTime(),
      points: [{ x: 0, y: 0 }, ...points],
    });
  }
  return out;
}

/**
 * One corridor per goal stretch that has a weigh-in near its start: from the average of the
 * weigh-ins within 3 days of the start (else the nearest within 10), widening at the goal's
 * weekly rate (a level band for maintenance). `toUnit` converts kg for display; `until` ends a stretch that is still running.
 */
export function goalCorridors(goals: GoalStretch[], rows: WeighInRow[], toUnit: (kg: number) => number, until: Date): Corridor[] {
  const scale = rows.filter((r) => r.source !== "inbody").map((r) => ({ t: parseLocal(r.at).getTime(), kg: r.weight_kg }));
  const out: Corridor[] = [];
  for (const g of goals) {
    const from = parseLocal(g.start_date);
    const to = g.end_date ? new Date(parseLocal(g.end_date).getTime() + DAY) : until;
    if (to <= from) continue;
    const startKg = weightNear(scale, from.getTime());
    if (startKg == null) continue;
    if (g.goal === "maintain") {
      // Holding steady is a level band, not a rate: within MAINTAIN_BAND of where it began.
      const half = toUnit(startKg * MAINTAIN_BAND);
      out.push({ from, to, v0: toUnit(startKg), lo: 0, hi: 0, half, label: GOAL_LABEL[g.goal] });
      continue;
    }
    const [loKg, hiKg] =
      g.weekly_rate_kg != null
        ? [g.weekly_rate_kg - CUSTOM_TOLERANCE_KG, g.weekly_rate_kg + CUSTOM_TOLERANCE_KG]
        : [(startKg * RATE_PCT[g.goal][0]) / 100, (startKg * RATE_PCT[g.goal][1]) / 100];
    out.push({ from, to, v0: toUnit(startKg), lo: toUnit(loKg) / 7, hi: toUnit(hiKg) / 7, half: 0, label: GOAL_LABEL[g.goal] });
  }
  return out;
}

/** kcal a day per kg a week of bodyweight change (≈7,700 kcal per kg). */
const KCAL_PER_KG_WEEK = 7700 / 7;

/**
 * Each goal's target surplus (+) or deficit (−) in kcal a day, as a level band for the surplus /
 * deficit chart: its weekly rate (or default range, from the weight where it began) converted at
 * 7,700 kcal per kg. Maintenance is a line at 0.
 */
export function calorieTargets(goals: GoalStretch[], rows: WeighInRow[], until: Date): Corridor[] {
  const scale = rows.filter((r) => r.source !== "inbody").map((r) => ({ t: parseLocal(r.at).getTime(), kg: r.weight_kg }));
  const out: Corridor[] = [];
  for (const g of goals) {
    const from = parseLocal(g.start_date);
    const to = g.end_date ? new Date(parseLocal(g.end_date).getTime() + DAY) : until;
    if (to <= from) continue;
    if (g.goal === "maintain") {
      out.push({ from, to, v0: 0, lo: 0, hi: 0, half: 0, label: "Maintain target: 0 kcal/day" });
      continue;
    }
    let kg: [number, number];
    if (g.weekly_rate_kg != null) kg = [g.weekly_rate_kg - CUSTOM_TOLERANCE_KG, g.weekly_rate_kg + CUSTOM_TOLERANCE_KG];
    else {
      const startKg = weightNear(scale, from.getTime());
      if (startKg == null) continue;
      kg = [(startKg * RATE_PCT[g.goal][0]) / 100, (startKg * RATE_PCT[g.goal][1]) / 100];
    }
    const [lo, hi] = kg.map((k) => k * KCAL_PER_KG_WEEK);
    const kcal = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(Math.round(v))}`;
    out.push({ from, to, v0: (lo + hi) / 2, lo: 0, hi: 0, half: (hi - lo) / 2, label: `${GOAL_LABEL[g.goal]}: ${kcal(lo)} to ${kcal(hi)} kcal/day` });
  }
  return out;
}
