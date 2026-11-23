import type { Goal } from "../api";

/** Helvetica in a PDF only has the WinAnsi characters: swap the common others, drop the rest. */
const SWAPS: Record<string, string> = { "−": "-", "→": "->", "≈": "~", "≥": ">=", "≤": "<=", " ": " ", " ": " " };
const WIN_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
export function winAnsi(text: string): string {
  let out = "";
  for (const ch of text) {
    const s = SWAPS[ch] ?? ch;
    for (const c of s) {
      const code = c.codePointAt(0)!;
      if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_EXTRA.has(c)) out += c;
    }
  }
  return out.replace(/ {2,}/g, " ");
}

export interface GoalPhase {
  phase_id: number;
  goal: Goal;
  start_date: string;
  end_date: string | null;
  weekly_rate_kg: number | null;
}

/** A row of the phase comparison, and why it's there. */
export interface PickedPhase {
  phase: GoalPhase;
  role: "this" | "before" | "earlier";
}

/**
 * Which goal phases a report compares. For a goal phase: that phase, the 3 just before it
 * (whatever their goal), then up to 2 earlier phases of the same goal. For any other range: the
 * goal phases overlapping it, latest 4.
 */
export function pickPhases(goals: GoalPhase[], selectedId: number | null, from: string, to: string): PickedPhase[] {
  const sorted = [...goals].sort((a, b) => a.start_date.localeCompare(b.start_date));
  const i = selectedId == null ? -1 : sorted.findIndex((g) => g.phase_id === selectedId);
  if (i >= 0) {
    const sel = sorted[i];
    const before = sorted.slice(Math.max(0, i - 3), i).reverse();
    const earlier = sorted
      .slice(0, Math.max(0, i - 3))
      .filter((g) => g.goal === sel.goal)
      .reverse()
      .slice(0, 2);
    return [
      { phase: sel, role: "this" },
      ...before.map((phase) => ({ phase, role: "before" as const })),
      ...earlier.map((phase) => ({ phase, role: "earlier" as const })),
    ];
  }
  return sorted
    .filter((g) => g.start_date <= to && (!g.end_date || g.end_date >= from))
    .reverse()
    .slice(0, 4)
    .map((phase) => ({ phase, role: "this" as const }));
}
