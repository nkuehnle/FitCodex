import { describe, expect, it } from "vitest";
import type { Schedule, Suggestion, Template, WorkoutCard } from "./api";
import { buildSnapshot, type WidgetInput } from "./widget";

// Wednesday 2026-11-25.
const today = new Date(2026, 10, 25);
const tpl = (id: number, name: string) => ({ id, name }) as Template;
const card = (date: string, sets: number) => ({ started_at_local: `${date}T18:00:00`, sets }) as WorkoutCard;
const sug = (s: Partial<Suggestion>): Suggestion => ({
  is_rest_day: false,
  done_today: false,
  items: [],
  next: null,
  optional: null,
  ...s,
});
const weekly: Schedule = {
  id: 1,
  name: "PPL",
  kind: "weekly",
  start_date: "2026-01-05",
  cycle_length: 7,
  days: [1, null, 2, null, 3, null, null],
  optional: [],
};

const input = (x: Partial<WidgetInput> = {}): WidgetInput => ({
  today,
  unit: "kg",
  rows: [{ id: 1, at: "2026-11-24T07:00:00", weight_kg: 82.44, source: "manual" }],
  goal: null,
  streakWeeks: 5,
  schedule: weekly,
  recent: [card("2026-11-23", 18), card("2026-11-25", 13), card("2026-11-21", 20)],
  active: false,
  templates: [tpl(1, "Push"), tpl(2, "Pull"), tpl(3, "Legs")],
  suggestions: Array(7).fill(null),
  ...x,
});

describe("buildSnapshot", () => {
  it("counts this Monday-to-Sunday week against the schedule", () => {
    const s = buildSnapshot(input());
    expect(s.weight).toBe("82.4 kg");
    expect(s.week).toBe("This week: 2 of 3 workouts · 31 sets");
    expect(s.nextWeek).toBe("This week: 0 of 3 workouts");
    expect(s.weekEnd).toBe("2026-11-30");
    expect(s.streak).toBe("5-wk streak");
  });

  it("gives each of the next 7 days its own Start button", () => {
    const s = buildSnapshot(
      input({
        suggestions: [
          sug({ items: [{ template_id: 2, reason: "today", planned_date: "2026-11-25" }] }),
          sug({ is_rest_day: true, next: { template_id: 3, reason: "upcoming", planned_date: "2026-11-27" } }),
          sug({ items: [{ template_id: 1, reason: "missed", planned_date: "2026-11-23" }] }),
          ...Array(4).fill(null),
        ],
      }),
    );
    expect(s.days.map((d) => d.date)).toEqual([
      "2026-11-25",
      "2026-11-26",
      "2026-11-27",
      "2026-11-28",
      "2026-11-29",
      "2026-11-30",
      "2026-12-01",
    ]);
    expect(s.days[0]).toEqual({ date: "2026-11-25", text: "▶ Pull · today", templateId: 2 });
    expect(s.days[1].text).toBe("▶ Legs · Fri");
    expect(s.days[2].text).toBe("▶ Push · missed Mon");
    expect(s.days[3]).toEqual({ date: "2026-11-28", text: "▶ Start a workout", templateId: -1 });
  });

  it("resumes a workout in progress", () => {
    const s = buildSnapshot(
      input({
        active: true,
        suggestions: [sug({ items: [{ template_id: 2, reason: "today", planned_date: "2026-11-25" }] }), ...Array(6).fill(null)],
      }),
    );
    expect(s.days[0]).toEqual({ date: "2026-11-25", text: "▶ Resume workout", templateId: -1 });
    // Still open after midnight: still Resume.
    expect(s.days[1].text).toBe("▶ Resume workout");
  });

  it("works without a schedule, weigh-ins or streak, and in lb", () => {
    const s = buildSnapshot(input({ schedule: null, rows: [], streakWeeks: 0, recent: [card("2026-11-24", 12)] }));
    expect(s.weight).toBe("No weigh-ins");
    expect(s.rate).toBe("");
    expect(s.week).toBe("This week: 1 workout · 12 sets");
    expect(s.streak).toBe("");
    expect(buildSnapshot(input({ unit: "lb" })).weight).toBe("181.7 lb");
  });

  it("shows the weekly rate against the goal", () => {
    const rows = [
      { id: 1, at: "2026-11-01T07:00:00", weight_kg: 84, source: "manual" },
      { id: 2, at: "2026-11-24T07:00:00", weight_kg: 82.5, source: "manual" },
    ];
    // goalStatus measures from the real clock, so only the goal part is checked.
    const r = buildSnapshot(input({ rows, goal: { goal: "cut", rate_pct: [-1, -0.5], weekly_rate_kg: -0.5, start_date: "2026-10-01" } }));
    expect(r.rate).toMatch(/goal −0\.50/);
  });
});
