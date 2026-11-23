import { useEffect, useState } from "react";
import { api } from "../api";
import { usePrefs } from "../App";
import { IS_ANDROID } from "../platform";

/** Settings key: "hidden" once dismissed, "shown" when reopened from Settings. */
export const GETTING_STARTED_KEY = "getting_started";
/** With this many workouts or more, someone isn't new: the guide only shows if reopened. */
const NEW_USER_WORKOUTS = 3;

interface Step {
  title: string;
  detail: string;
  done: boolean;
  href?: string;
  action?: string;
}

interface State {
  unitSet: boolean;
  workouts: number;
  routine: boolean;
  profile: boolean;
  weighIn: boolean;
  goal: boolean;
  health: boolean;
  setting: string | null;
}

async function load(): Promise<State> {
  const [unit, workouts, schedule, templates, sex, height, birth, weighIns, goal, setting, health] = await Promise.all([
    api.getSetting("weight_unit"),
    api.workoutSeries(),
    api.activeSchedule(),
    api.listTemplates(),
    api.getSetting("sex"),
    api.getSetting("height_cm"),
    api.getSetting("birth_year"),
    api.weighIns(true),
    api.currentGoal(),
    api.getSetting(GETTING_STARTED_KEY),
    IS_ANDROID ? api.healthConnectStatus().catch(() => null) : Promise.resolve(null),
  ]);
  return {
    unitSet: !!unit,
    workouts: workouts.length,
    routine: !!schedule || templates.length > 0,
    profile: !!sex && !!height && !!birth,
    weighIn: weighIns.length > 0,
    goal: !!goal.goal,
    health: !!health && (health.available !== "yes" || health.granted > 0),
    setting,
  };
}

/**
 * Top of Workouts for someone new: a short checklist that ticks itself off from what's been done,
 * each step linking to where it's done. Hidden once dismissed or finished; Settings can reopen it.
 */
export function GettingStarted() {
  const { unit, setUnit } = usePrefs();
  const [s, setS] = useState<State | null>(null);
  useEffect(() => {
    load().then(setS);
  }, []);
  if (!s || s.setting === "hidden") return null;
  if (s.setting !== "shown" && s.workouts >= NEW_USER_WORKOUTS) return null;

  const steps: Step[] = [
    {
      title: "Pick kg or lb",
      detail: "Every weight in the app uses it. You can change it later in Settings.",
      done: s.unitSet,
    },
    {
      title: "Choose a routine",
      detail: "Install a starter program, or build your own templates and weekly schedule.",
      done: s.routine,
      href: "#/plan/schedule",
      action: "Plans",
    },
    {
      title: "Bring in your history (optional)",
      detail: "Import a Strong export or a FitCodex backup so charts and suggestions start from your real numbers.",
      done: s.workouts > 0,
      href: "#/data",
      action: "Import",
    },
    {
      title: "Add your profile",
      detail: "Sex, height and birth year, for body-fat estimates and comparisons with people like you.",
      done: s.profile,
      href: "#/body/data/body",
      action: "Profile",
    },
    {
      title: "Log a weigh-in and set a goal",
      detail: "Cut, maintain or gain, with a weekly target. A Bluetooth scale can be set up in Settings for one-tap weigh-ins.",
      done: s.weighIn && s.goal,
      href: "#/body/data/weighins",
      action: "Weight",
    },
    ...(IS_ANDROID
      ? [
          {
            title: "Connect Health Connect (optional)",
            detail: "Brings in sleep, heart rate, steps and weigh-ins from your watch or scale app.",
            done: s.health,
            href: "#/settings",
            action: "Settings",
          },
        ]
      : []),
    {
      title: "Start your first workout",
      detail: "Tap Start below. Sets are pre-filled from your plan and last session; tick each one off as you go.",
      done: s.workouts > 0,
    },
  ];
  const done = steps.filter((x) => x.done).length;
  const hide = () => {
    api.setSetting(GETTING_STARTED_KEY, "hidden");
    setS({ ...s, setting: "hidden" });
  };
  if (done === steps.length && s.setting !== "shown") return null;

  return (
    <section className="card getting-started">
      <div className="title-row">
        <h2 className="section-title">Getting started</h2>
        <button className="button small" onClick={hide}>
          Hide
        </button>
      </div>
      <p className="muted small">
        {done} of {steps.length} done. This list ticks itself off as you go.
      </p>
      <ol className="gs-steps">
        {steps.map((x) => (
          <li key={x.title} className={x.done ? "done" : ""}>
            <span className="gs-mark" aria-hidden>
              {x.done ? "✓" : ""}
            </span>
            <div className="gs-body">
              <strong>{x.title}</strong>
              {!x.done && <div className="muted small">{x.detail}</div>}
              {!x.done && x.title === "Pick kg or lb" && (
                <div className="segmented small">
                  {(["kg", "lb"] as const).map((u) => (
                    <button
                      key={u}
                      className={unit === u ? "active" : ""}
                      onClick={() => {
                        setUnit(u);
                        setS({ ...s, unitSet: true });
                      }}
                    >
                      {u}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {!x.done && x.href && (
              <a className="button small" href={x.href}>
                {x.action}
              </a>
            )}
          </li>
        ))}
      </ol>
      <details className="small">
        <summary>Where things are</summary>
        <ul className="gs-tour">
          <li>
            <strong>Workouts</strong>: today's suggestion, starting a workout, and everything you've logged.
          </li>
          <li>
            <strong>Progress</strong>: each lift's estimated 1RM, muscles trained, weekly volume and cardio.
          </li>
          <li>
            <strong>Measure</strong>: charts of weight, calories, body composition and recovery; Data &amp; metrics is where you log them.
          </li>
          <li>
            <strong>Settings</strong>: plans and schedule, scales, reminders, reports, import, export and backups.
          </li>
        </ul>
      </details>
    </section>
  );
}
