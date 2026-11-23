import { useState } from "react";
import type { Phase } from "../api";

export interface Range {
  key: string;
  from: string | null; // YYYY-MM-DD inclusive
  to: string | null;
  label: string;
}

export function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function today(): string {
  return isoDate(new Date());
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDate(d);
}

export function weekStart(d = new Date()): string {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return isoDate(x);
}

export const PRESETS: Range[] = [
  { key: "week", from: weekStart(), to: null, label: "This week" },
  { key: "4w", from: daysAgo(27), to: null, label: "4 weeks" },
  { key: "3m", from: daysAgo(91), to: null, label: "3 months" },
  { key: "6m", from: daysAgo(182), to: null, label: "6 months" },
  { key: "1y", from: daysAgo(365), to: null, label: "1 year" },
  { key: "all", from: null, to: null, label: "All time" },
];

export function presetRange(key: string): Range {
  return PRESETS.find((p) => p.key === key) ?? PRESETS[PRESETS.length - 1];
}

/** A chart's range, remembered on this device per `key` (presets re-resolve so "4 weeks" stays
 *  relative to today). Falls back to all time. */
export function useSavedRange(key: string): [Range, (r: Range) => void] {
  const storageKey = `range:${key}`;
  const [range, setRange] = useState<Range>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Range | null;
      if (saved?.key) return PRESETS.some((p) => p.key === saved.key) ? presetRange(saved.key) : saved;
    } catch {
      /* storage unavailable */
    }
    return presetRange("all");
  });
  const set = (r: Range) => {
    setRange(r);
    try {
      localStorage.setItem(storageKey, JSON.stringify(r));
    } catch {
      /* storage unavailable */
    }
  };
  return [range, set];
}

export function phaseRange(p: Phase): Range {
  return { key: `phase-${p.id}`, from: p.start_date, to: p.end_date, label: p.name };
}

export function inRange(dateStr: string, r: Range): boolean {
  const d = dateStr.slice(0, 10);
  return (!r.from || d >= r.from) && (!r.to || d <= r.to);
}

const dayLabel = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** A phase with its dates, e.g. "Maintain · Mar 3, 2026 – May 1, 2026". */
export function phaseLabel(p: Phase): string {
  return `${p.name} · ${dayLabel(p.start_date)} – ${p.end_date ? dayLabel(p.end_date) : "now"}`;
}

type Kind = "time" | "program" | "nutrition" | "custom";

/** Which range a chart shows, as two dropdowns shared by every chart page: what to go by (time, a
 *  workout routine, a cut / maintain / gain goal, or custom dates), then which one. */
export function RangePicker({
  value,
  onChange,
  phases = [],
  presets = ["4w", "3m", "6m", "1y", "all"],
}: {
  value: Range;
  onChange: (r: Range) => void;
  phases?: Phase[];
  presets?: string[];
}) {
  const byLane = (lane: Phase["lane"]) =>
    phases.filter((p) => p.lane === lane && p.id != null).sort((a, b) => b.start_date.localeCompare(a.start_date));
  const lists: Record<"program" | "nutrition", Phase[]> = { program: byLane("program"), nutrition: byLane("nutrition") };
  const current = value.key.startsWith("phase-") ? phases.find((p) => `phase-${p.id}` === value.key) : undefined;
  const kind: Kind = value.key === "custom" ? "custom" : current ? current.lane : "time";
  const choose = (k: Kind) => {
    if (k === "time") onChange(presetRange(presets.includes("all") ? "all" : presets[presets.length - 1]));
    else if (k === "custom") onChange({ key: "custom", from: value.from ?? daysAgo(90), to: value.to, label: "Custom" });
    else if (lists[k][0]) onChange(phaseRange(lists[k][0]));
  };
  return (
    <div className="range-picker row small">
      <select className="select inline" aria-label="Show by" value={kind} onChange={(e) => choose(e.target.value as Kind)}>
        <option value="time">By time</option>
        {lists.program.length > 0 && <option value="program">By routine</option>}
        {lists.nutrition.length > 0 && <option value="nutrition">By goal (cut / maintain / gain)</option>}
        <option value="custom">Custom dates</option>
      </select>
      {kind === "time" && (
        <select className="select inline" aria-label="Time span" value={value.key} onChange={(e) => onChange(presetRange(e.target.value))}>
          {presets.map((k) => (
            <option key={k} value={k}>
              {presetRange(k).label}
            </option>
          ))}
        </select>
      )}
      {(kind === "program" || kind === "nutrition") && (
        <select
          className="select inline"
          aria-label={kind === "program" ? "Routine" : "Goal"}
          value={value.key}
          onChange={(e) => {
            const p = phases.find((x) => `phase-${x.id}` === e.target.value);
            if (p) onChange(phaseRange(p));
          }}
        >
          {lists[kind].map((p) => (
            <option key={p.id} value={`phase-${p.id}`}>
              {phaseLabel(p)}
            </option>
          ))}
        </select>
      )}
      {kind === "custom" && (
        <>
          <label>
            From <input type="date" value={value.from ?? ""} onChange={(e) => onChange({ ...value, from: e.target.value || null })} />
          </label>
          <label>
            To <input type="date" value={value.to ?? ""} onChange={(e) => onChange({ ...value, to: e.target.value || null })} />
          </label>
        </>
      )}
    </div>
  );
}
