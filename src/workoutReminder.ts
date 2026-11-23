import { api } from "./api";
import { minutesOf } from "./weighIn";

/** Reminder times ("HH:MM", null = off) for scheduled workout days and for rest days that have
 *  an optional activity. Kept in the settings table. */
export interface WorkoutReminderPlan {
  planned: string | null;
  optional: string | null;
}

export async function loadWorkoutReminderPlan(): Promise<WorkoutReminderPlan> {
  const [planned, optional] = await Promise.all(["workout_reminder_planned", "workout_reminder_optional"].map(api.getSetting));
  return { planned: planned || null, optional: optional || null };
}

export async function saveWorkoutReminderPlan(plan: WorkoutReminderPlan) {
  await api.setSetting("workout_reminder_planned", plan.planned ?? "");
  await api.setSetting("workout_reminder_optional", plan.optional ?? "");
  await syncWorkoutReminder(plan);
}

/** Pushes the plan, laid over the active schedule, to the Android alarm. Call again when the
 *  schedule changes. */
export async function syncWorkoutReminder(plan?: WorkoutReminderPlan) {
  try {
    const p = plan ?? (await loadWorkoutReminderPlan());
    const [s, templates] = await Promise.all([api.activeSchedule(), api.listTemplates()]);
    const name = (id: number | null) => templates.find((t) => t.id === id)?.name ?? "Workout";
    const len = !s ? 1 : s.kind === "weekly" ? 7 : s.cycle_length;
    const days = Array.from({ length: len }, (_, i) => {
      const planned = s?.days[i] ?? null;
      const optional = s?.optional[i] ?? null;
      if (planned !== null && p.planned)
        return { at: p.planned, title: `${name(planned)} today`, text: "Your scheduled workout. Start it in FitCodex." };
      if (planned === null && optional !== null && p.optional)
        return { at: p.optional, title: `Rest day: ${name(optional)}?`, text: "It's optional. Start it in FitCodex if you feel like it." };
      return { at: null, title: "", text: "" };
    });
    // A weekly schedule's days are weekdays from Monday; a cycle counts from its start date.
    let from = s?.start_date ?? "2023-01-02";
    if (s?.kind === "weekly") {
      const d = new Date(`${from}T12:00:00`);
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
    await api.dayReminder(
      "workout",
      from,
      days.map((d) => minutesOf(d.at)),
      days.map((d) => d.title),
      days.map((d) => d.text),
    );
  } catch {
    /* not on Android, or no schedule yet */
  }
}
