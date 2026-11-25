import { api, type Schedule, type Suggestion, type Template, type WeighInRow, type WeightUnit, type WorkoutCard } from "./api";
import { isoDate } from "./charts/RangePicker";
import { parseLocal, toUnit } from "./format";
import { goalStatus, type GoalInfo } from "./goal";
import { IS_ANDROID } from "./platform";

/** What the Android home-screen widget shows, as ready-made text. Kotlin only picks the entry
 *  for today, so the widget rolls over at midnight without the app (HomeWidget.kt). */
export interface WidgetSnapshot {
  weight: string;
  rate: string;
  /** Colour of `rate`: true on track, false off, null plain. */
  rateOk: boolean | null;
  streak: string;
  /** This week's line, and the line once `weekEnd` (exclusive, YYYY-MM-DD) has passed. */
  week: string;
  nextWeek: string;
  weekEnd: string;
  /** The Start button for each of the next 7 days; templateId -1 opens the Workouts tab. */
  days: { date: string; text: string; templateId: number }[];
}

export interface WidgetInput {
  today: Date;
  unit: WeightUnit;
  rows: WeighInRow[];
  goal: GoalInfo | null;
  streakWeeks: number;
  schedule: Schedule | null;
  recent: WorkoutCard[];
  active: boolean;
  templates: Template[];
  /** api.suggestion for each of the 7 days from today. */
  suggestions: (Suggestion | null)[];
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const signed = (v: number, digits = 1) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(digits)}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

export function buildSnapshot(x: WidgetInput): WidgetSnapshot {
  const u = (kg: number) => toUnit(kg, x.unit);
  const scale = x.rows.filter((r) => r.source !== "inbody");
  const last = scale[scale.length - 1];
  const s = goalStatus(x.goal, x.rows, []);
  const target =
    s && (s.targetKg[0] === s.targetKg[1] ? signed(u(s.targetKg[0]), 2) : `${signed(u(s.targetKg[0]))}…${signed(u(s.targetKg[1]))}`);
  const rate = !s ? "" : s.actualKg != null ? `${signed(u(s.actualKg), 2)}/wk · goal ${target}` : `goal ${target} ${x.unit}/wk`;

  // Weeks start on Monday.
  const monday = addDays(x.today, -((x.today.getDay() + 6) % 7));
  const weekEnd = isoDate(addDays(monday, 7));
  const done = x.recent.filter((w) => {
    const d = w.started_at_local.slice(0, 10);
    return d >= isoDate(monday) && d < weekEnd;
  });
  const sch = x.schedule;
  const perWeek = !sch
    ? 0
    : Math.round((sch.days.filter((d) => d != null).length * 7) / (sch.kind === "weekly" ? 7 : sch.cycle_length || 7));
  const of = perWeek ? ` of ${perWeek}` : "";
  const sets = done.reduce((n, w) => n + w.sets, 0);
  const week = `This week: ${done.length}${of} workout${done.length === 1 && !perWeek ? "" : "s"}${sets ? ` · ${sets} sets` : ""}`;

  const name = (id: number) => x.templates.find((t) => t.id === id)?.name;
  const days = x.suggestions.map((sg, i) => {
    const date = isoDate(addDays(x.today, i));
    if (x.active) return { date, text: "▶ Resume workout", templateId: -1 };
    const main = sg?.items.find((it) => name(it.template_id)) ?? (sg?.next && name(sg.next.template_id) ? sg.next : null);
    if (!main) return { date, text: "▶ Start a workout", templateId: -1 };
    const when =
      main.reason === "today"
        ? "today"
        : main.reason === "missed"
          ? `missed ${DAYS[parseLocal(main.planned_date).getDay()]}`
          : DAYS[parseLocal(main.planned_date).getDay()];
    return { date, text: `▶ ${name(main.template_id)} · ${when}`, templateId: main.template_id };
  });

  return {
    weight: last ? `${u(last.weight_kg).toFixed(1)} ${x.unit}` : "No weigh-ins",
    rate,
    rateOk: s?.onTrack ?? null,
    streak: x.streakWeeks > 0 ? `${x.streakWeeks}-wk streak` : "",
    week,
    nextWeek: `This week: 0${of} workouts`,
    weekEnd,
    days,
  };
}

let timer: ReturnType<typeof setTimeout> | undefined;

/** Sends fresh numbers to the home-screen widget (Android only), at most once every 2 seconds;
 *  `now` skips the wait (leaving the app, when timers stop). */
export function refreshWidget(now = false) {
  if (!IS_ANDROID) return;
  clearTimeout(timer);
  timer = setTimeout(
    async () => {
      try {
        const unit = ((await api.getSetting("weight_unit")) as WeightUnit | null) ?? "lb";
        const day = new Date();
        const dates = Array.from({ length: 7 }, (_, i) => isoDate(addDays(day, i)));
        const [rows, goal, streak, schedule, recent, active, templates, suggestions] = await Promise.all([
          api.weighIns(false),
          api.currentGoal(),
          api.streak(dates[0]),
          api.activeSchedule(),
          api.historyPage(30),
          api.activeWorkout(),
          api.listTemplates(),
          Promise.all(dates.map((d) => api.suggestion(d))),
        ]);
        const snap = buildSnapshot({
          today: day,
          unit,
          rows,
          goal,
          streakWeeks: streak.current_weeks,
          schedule,
          recent,
          active: !!active,
          templates,
          suggestions,
        });
        await api.widget(JSON.stringify(snap));
      } catch {
        // The widget keeps its last numbers.
      }
    },
    now ? 0 : 2000,
  );
}

/** What a widget button asked for when it opened the app, once. */
export const WIDGET_WEIGH_IN = "fitcodex-widget-weigh-in";
let pendingWeighIn = false;
/** TodayCard calls this when it mounts: true once after the widget's ⚖ Weigh in. */
export const takePendingWeighIn = () => {
  const p = pendingWeighIn;
  pendingWeighIn = false;
  return p;
};

/** Acts on a widget tap: start (or resume) the workout, or open the weigh-in. */
export async function handleWidgetAction(navigate: (path: string) => void) {
  if (!IS_ANDROID) return;
  const a = await api.takeWidgetAction().catch(() => null);
  if (!a) return;
  if (a.action === "weigh_in") {
    pendingWeighIn = true;
    // Not "/history": opening the app with a workout in progress jumps from there to the workout.
    navigate("/today");
    window.dispatchEvent(new Event(WIDGET_WEIGH_IN));
  } else if (a.action === "start") {
    if (await api.activeWorkout()) return navigate("/workout");
    if (a.templateId < 0) return navigate("/history");
    await api.startWorkout({ kind: "template", template_id: a.templateId });
    navigate("/workout");
  }
}
