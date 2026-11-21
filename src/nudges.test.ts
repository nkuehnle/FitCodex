import { describe, expect, it } from "vitest";
import type { ExerciseView, SetView, WorkoutDetail } from "./api";
import { nextOpenSet, planNudges } from "./nudges";

const set = (completed: boolean, reps: number | null = 10): SetView => ({
  id: Math.random(),
  set_type: "normal",
  weight_kg: 50,
  reps,
  rpe: null,
  distance_m: null,
  duration_s: null,
  rest_s: null,
  completed,
  avg_hr: null,
  kcal: null,
});

let nextId = 1;
const ex = (name: string, sets: SetView[], superset: number | null = null): ExerciseView =>
  ({ id: nextId++, name, kind: "weight_reps", rep_max: null, superset, sets }) as unknown as ExerciseView;

const workout = (exercises: ExerciseView[]): WorkoutDetail => ({ id: 1, name: "Torso B", exercises }) as unknown as WorkoutDetail;

describe("nextOpenSet", () => {
  it("is the first unticked set in order", () => {
    const w = workout([ex("Bench", [set(true), set(true)]), ex("Row", [set(true), set(false), set(false)])]);
    const n = nextOpenSet(w)!;
    expect([n.e.name, n.n]).toEqual(["Row", 2]);
  });

  it("in a superset is the member furthest behind in the round", () => {
    const w = workout([ex("Curl", [set(true), set(false)], 0), ex("Pushdown", [set(false), set(false)], 0)]);
    const n = nextOpenSet(w)!;
    expect([n.e.name, n.n]).toEqual(["Pushdown", 1]);
  });
});

describe("planNudges", () => {
  const t0 = 1_000_000_000_000;

  it("reminds about the next set after twice its expected time plus 90 s", () => {
    const w = workout([ex("Row", [set(true), set(false, 8)])]);
    const { set: s } = planNudges(w, t0, t0, null);
    // 8 reps: 20 + 32 = 52 s a set.
    expect(s.atMs - t0).toBe((2 * 52 + 90) * 1000);
    expect(s.text).toContain("Row · set 2");
  });

  it("asks to finish 3 min after the last set when everything is ticked", () => {
    const w = workout([ex("Row", [set(true), set(true)])]);
    const { set: s } = planNudges(w, t0, t0, null);
    expect(s.atMs - t0).toBe(3 * 60_000);
    expect(s.title).toBe("All sets done");
  });

  it("asks to finish a while after the usual length, mentioning unticked sets", () => {
    const w = workout([ex("Row", [set(true), set(false)])]);
    const { finish } = planNudges(w, t0, t0, 3600);
    expect(finish.atMs - t0).toBe((3600 + 720) * 1000);
    expect(finish.text).toBe("Torso B usually takes about 60 min. 1 set not ticked yet. Tick any you did, then tap Finish.");
    // Short sessions still get at least 10 min.
    expect(planNudges(w, t0, t0, 1200).finish.atMs - t0).toBe((1200 + 600) * 1000);
    // No history: no finish reminder.
    expect(planNudges(w, t0, t0, null).finish.atMs).toBe(0);
  });
});
