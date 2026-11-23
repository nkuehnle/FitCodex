import { describe, expect, it } from "vitest";
import { pickPhases, winAnsi, type GoalPhase } from "./select";

const g = (id: number, goal: GoalPhase["goal"], start: string, end: string | null): GoalPhase => ({
  phase_id: id,
  goal,
  start_date: start,
  end_date: end,
  weekly_rate_kg: null,
});
const goals = [
  g(1, "gain", "2025-01-01", "2025-03-31"),
  g(2, "cut", "2025-04-01", "2025-05-31"),
  g(3, "gain", "2025-06-01", "2025-09-30"),
  g(4, "maintain", "2025-10-01", "2025-10-31"),
  g(5, "cut", "2025-11-01", "2026-01-31"),
  g(6, "gain", "2026-02-01", null),
];

describe("pickPhases", () => {
  it("compares a goal phase with the three before it, then earlier ones of the same goal", () => {
    const p = pickPhases(goals, 6, "2026-02-01", "2026-06-01");
    expect(p.map((x) => [x.phase.phase_id, x.role])).toEqual([
      [6, "this"],
      [5, "before"],
      [4, "before"],
      [3, "before"],
      [1, "earlier"],
    ]);
  });
  it("uses the goal phases overlapping a time range", () => {
    const p = pickPhases(goals, null, "2025-09-15", "2025-12-01");
    expect(p.map((x) => x.phase.phase_id)).toEqual([5, 4, 3]);
  });
  it("first phase has nothing before it", () => {
    expect(pickPhases(goals, 1, "2025-01-01", "2025-03-31").map((x) => x.phase.phase_id)).toEqual([1]);
  });
});

describe("winAnsi", () => {
  it("keeps Latin-1, swaps math signs and drops emoji", () => {
    expect(winAnsi("−2.5 kg → 80 · café 🏋 ≈ 3 – ok")).toBe("-2.5 kg -> 80 · café ~ 3 – ok");
  });
});
