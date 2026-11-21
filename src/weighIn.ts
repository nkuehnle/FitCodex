import { api } from "./api";

/** Reminder time ("HH:MM") per weekday, 0 = Sunday … 6 = Saturday; null = not a weigh-in day.
 *  Kept in the settings table. */
export interface WeighInPlan {
  times: (string | null)[];
}

export const isWeighDay = (plan: WeighInPlan | null, day: number) => plan?.times[day] != null;

export async function loadWeighInPlan(): Promise<WeighInPlan> {
  const [times, days, time] = await Promise.all(["weigh_in_times", "weigh_in_days", "weigh_in_time"].map(api.getSetting));
  if (times != null) return { times: times.split(",").map((t) => t || null) };
  // Before per-day times: one time for all the chosen days.
  const chosen = (days ?? "")
    .split(",")
    .filter((d) => d.trim() !== "")
    .map(Number);
  return { times: Array.from({ length: 7 }, (_, d) => (chosen.includes(d) ? time || "09:00" : null)) };
}

/** "HH:MM" → minutes past midnight; null → -1 (no reminder). */
export const minutesOf = (t: string | null) => {
  if (!t) return -1;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

/** Pushes the plan to the Android alarm (also after a restore or reinstall). */
export function syncWeighInReminder(plan: WeighInPlan) {
  // A week from a Sunday, so day i of the cycle is weekday i.
  return api
    .dayReminder(
      "weigh_in",
      "2023-01-01",
      plan.times.map(minutesOf),
      plan.times.map(() => "Weigh-in day"),
      plan.times.map(() => "Step on the scale and log it in FitLedger"),
    )
    .catch(() => {});
}

export async function saveWeighInPlan(plan: WeighInPlan) {
  await api.setSetting("weigh_in_times", plan.times.map((t) => t ?? "").join(","));
  await syncWeighInReminder(plan);
}
