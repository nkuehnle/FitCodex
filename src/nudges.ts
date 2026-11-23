import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, sendNotification } from "@tauri-apps/plugin-notification";
import { api, type ExerciseView, type SetView, type WorkoutDetail } from "./api";
import { IS_ANDROID } from "./platform";

/** A reminder at `atMs` (0 = none). */
export interface Nudge {
  atMs: number;
  title: string;
  text: string;
}

const NONE: Nudge = { atMs: 0, title: "", text: "" };
const MIN = 60_000;

/** Rough time to do one set, in seconds: setup plus about 4 s a rep; timed sets take their time. */
export function setSeconds(e: ExerciseView, s: SetView): number {
  if (e.kind === "distance_duration") return s.duration_s ?? 600;
  if (e.kind === "duration") return s.duration_s ?? 60;
  return 20 + 4 * (s.reps ?? e.rep_max ?? 10);
}

/** The set you'd do next: the first exercise with sets left, or in a superset the member that's
 *  furthest behind in the round. */
export function nextOpenSet(w: WorkoutDetail): { e: ExerciseView; s: SetView; n: number } | null {
  const ex = w.exercises;
  const done = (e: ExerciseView) => e.sets.filter((s) => s.completed).length;
  for (let i = 0; i < ex.length; i++) {
    const group = ex[i].superset === null ? [ex[i]] : ex.filter((e) => e.superset === ex[i].superset);
    const open = group.filter((e) => e.sets.some((s) => !s.completed));
    if (!open.length) continue;
    const e = open.reduce((a, b) => (done(b) < done(a) ? b : a));
    const s = e.sets.find((x) => !x.completed)!;
    return { e, s, n: e.sets.indexOf(s) + 1 };
  }
  return null;
}

/**
 * Reminders for a live workout. `readyAt` is when the next set could start: when the rest ends,
 * or when the last set was ticked without a rest. The next-set reminder comes after twice the
 * set's expected time plus 1.5 min (generous, not nagging); with every set ticked, a reminder
 * to finish 3 min later. The finish reminder comes a while after the workout's usual length
 * (`typicalS`), whatever is ticked.
 */
export function planNudges(w: WorkoutDetail, readyAt: number, startMs: number, typicalS: number | null): { set: Nudge; finish: Nudge } {
  const all = w.exercises.flatMap((e) => e.sets);
  const open = all.filter((s) => !s.completed).length;
  const next = nextOpenSet(w);
  let set = NONE;
  if (next) {
    set = {
      atMs: readyAt + (2 * setSeconds(next.e, next.s) + 90) * 1000,
      title: "Mark off your next set",
      text: `${next.e.name} · set ${next.n}. Done it? Tick it off in FitCodex.`,
    };
  } else if (all.length) {
    set = { atMs: readyAt + 3 * MIN, title: "All sets done", text: `Tap Finish to save ${w.name}.` };
  }
  let finish = NONE;
  if (typicalS && all.length) {
    const usual = Math.round(typicalS / 60);
    finish = {
      atMs: startMs + (typicalS + Math.max(600, typicalS * 0.2)) * 1000,
      title: "Finish your workout",
      text:
        `${w.name} usually takes about ${usual} min. ` +
        (open ? `${open} set${open > 1 ? "s" : ""} not ticked yet. Tick any you did, then tap Finish.` : "Tap Finish to save it."),
    };
  }
  return { set, finish };
}

// Desktop: plain timers and a system notification while the app is open.
const timers: number[] = [];
function desktopSchedule(nudges: Nudge[]) {
  timers.splice(0).forEach(clearTimeout);
  for (const n of nudges) {
    const wait = n.atMs - Date.now();
    if (n.atMs && wait > 0 && wait < 2 ** 31) {
      timers.push(
        window.setTimeout(async () => {
          try {
            if (await isPermissionGranted()) sendNotification({ title: n.title, body: n.text });
          } catch {
            /* notifications unavailable */
          }
        }, wait),
      );
    }
  }
}

function schedule(set: Nudge, finish: Nudge) {
  if (IS_ANDROID) invoke("rest_android_nudges", { set, finish }).catch(() => {});
  else desktopSchedule([set, finish]);
}

/** Workout finished or cancelled. */
export function clearNudges() {
  schedule(NONE, NONE);
}

/**
 * Keeps the reminders for a live workout up to date. Call the returned `ticked()` when a set is
 * ticked or unticked. A reminder already due isn't shown again until something changes.
 */
export function useWorkoutNudges(w: WorkoutDetail | null, restEndsAt: number | null, startMs: number) {
  // When the next set could start: the end of the running rest, else the last tick (or opening
  // the workout). Kept after a rest ends so a late timer callback doesn't move it.
  const readyAt = useRef(Date.now());
  const typical = useRef<{ id: number; s: number | null } | null>(null);

  useEffect(() => {
    if (!w) return;
    if (restEndsAt) readyAt.current = restEndsAt;
    else readyAt.current = Math.min(readyAt.current, Date.now());
    let stale = false;
    const go = (typicalS: number | null) => {
      if (stale) return;
      const { set, finish } = planNudges(w, readyAt.current, startMs, typicalS);
      schedule(set, finish);
    };
    if (typical.current?.id === w.id) go(typical.current.s);
    else
      api
        .typicalDuration(w.id)
        .catch(() => null)
        .then((s) => {
          typical.current = { id: w.id, s };
          go(s);
        });
    return () => {
      stale = true;
    };
  }, [w, restEndsAt, startMs]);

  return {
    ticked: () => {
      readyAt.current = Date.now();
    },
  };
}
