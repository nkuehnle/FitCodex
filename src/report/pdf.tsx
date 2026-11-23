import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { api, type InBodyScan, type MeasurementRow, type Phase, type WeighInRow } from "../api";
import { calorieTargets, goalCorridors } from "../charts/corridor";
import { inRange, isoDate, today, type Range } from "../charts/RangePicker";
import { TimeSeriesSvg, type Band } from "../charts/TimeSeriesChart";
import { LIGHT } from "../charts/theme";
import { parseLocal, toUnit } from "../format";
import { GOAL_TEXT } from "../goal";
import { phaseSplit } from "../phaseSplit";
import { pickPhases, winAnsi, type GoalPhase } from "./select";

export type ReportSection = "weight" | "body" | "strength" | "recovery";
export const SECTION_TEXT: Record<ReportSection, string> = {
  weight: "Weight, calories and goal phases",
  body: "Body composition and measurements",
  strength: "Strength and training",
  recovery: "Recovery (sleep, heart rate)",
};

type Unit = "kg" | "lb";
const DAY = 86_400_000;
const M = 40;
const INK = rgb(0.11, 0.12, 0.14);
const MUTED = rgb(0.42, 0.44, 0.48);
const RULE = rgb(0.85, 0.86, 0.88);
const ZEBRA = rgb(0.96, 0.965, 0.97);

/** Scan values worth a row, with labels; `mass` values are kg. */
const SCAN_ROWS: [string, string, boolean][] = [
  ["pbf", "Body fat %", false],
  ["body_fat_mass_kg", "Body fat mass", true],
  ["smm_kg", "Skeletal muscle", true],
  ["lean_body_mass_kg", "Lean body mass", true],
];

const short = (d: string) => parseLocal(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });
const long = (d: string) => parseLocal(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const sign = (v: number, digits: number) => `${v > 0 ? "+" : v < 0 ? "-" : ""}${Math.abs(v).toFixed(digits)}`;

/** US and Canada print on Letter, everyone else on A4. */
function pageSize(): [number, number] {
  return /-(US|CA)$/i.test(navigator.language) ? [612, 792] : [595.28, 841.89];
}

/** Draws on pages top to bottom, starting a new page when a block won't fit. */
class Writer {
  pages: PDFPage[] = [];
  page!: PDFPage;
  y = 0;
  readonly w: number;
  constructor(
    private doc: PDFDocument,
    private size: [number, number],
    private font: PDFFont,
    private bold: PDFFont,
  ) {
    this.w = size[0] - 2 * M;
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage(this.size);
    this.pages.push(this.page);
    this.y = this.size[1] - M;
  }
  ensure(h: number) {
    if (this.y - h < M + 16) this.newPage();
  }
  width(s: string, size: number, bold = false) {
    return (bold ? this.bold : this.font).widthOfTextAtSize(winAnsi(s), size);
  }
  /** One line at the current y (baseline below it), without moving down. */
  at(s: string, x: number, size: number, o: { bold?: boolean; color?: RGB; right?: boolean } = {}) {
    const text = winAnsi(s);
    const f = o.bold ? this.bold : this.font;
    const dx = o.right ? -f.widthOfTextAtSize(text, size) : 0;
    this.page.drawText(text, { x: x + dx, y: this.y - size, size, font: f, color: o.color ?? INK });
  }
  /** Wrapped text, moving down. */
  para(s: string, size = 9, color = MUTED) {
    const words = winAnsi(s).split(" ");
    let line = "";
    const lines: string[] = [];
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (this.font.widthOfTextAtSize(next, size) > this.w && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
    this.ensure(lines.length * size * 1.35);
    for (const l of lines) {
      this.at(l, M, size, { color });
      this.y -= size * 1.35;
    }
    this.y -= 4;
  }
  heading(s: string, need: number) {
    this.ensure(28 + need);
    this.y -= 10;
    this.at(s, M, 13, { bold: true });
    this.y -= 18;
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: M + this.w, y: this.y }, thickness: 0.7, color: RULE });
    this.y -= 8;
  }
  stats(items: [string, string][]) {
    if (!items.length) return;
    this.ensure(36);
    const col = this.w / Math.max(items.length, 4);
    items.forEach(([, value], i) => {
      this.at(value, M + i * col, 14, { bold: true });
    });
    this.y -= 19;
    items.forEach(([label], i) => this.at(label, M + i * col, 8, { color: MUTED }));
    this.y -= 17;
  }
  /** Columns: label, width (pt), right-aligned. The first column is left-aligned text. */
  table(cols: [string, number, boolean][], rows: string[][], size = 8.5) {
    if (!rows.length) return;
    const rowH = size + 5.5;
    const xs: number[] = [];
    let x = M;
    for (const [, w] of cols) {
      xs.push(x);
      x += w;
    }
    const cell = (s: string, i: number, o: { bold?: boolean; color?: RGB } = {}) => {
      const [, w, right] = cols[i];
      let t = s;
      while (t.length > 1 && this.width(t, size, o.bold) > w - 4) t = t.slice(0, -2) + "…";
      this.at(t, right ? xs[i] + w - 2 : xs[i], size, { ...o, right });
    };
    this.ensure(rowH * Math.min(rows.length + 1, 4));
    cols.forEach(([label], i) => cell(label, i, { bold: true, color: MUTED }));
    this.y -= rowH;
    rows.forEach((r, n) => {
      this.ensure(rowH);
      if (n % 2 === 0) this.page.drawRectangle({ x: M - 3, y: this.y - rowH + 2.5, width: this.w + 6, height: rowH, color: ZEBRA });
      r.forEach((s, i) => cell(s, i, { bold: i === 0 && s.endsWith("(this)") }));
      this.y -= rowH;
    });
    this.y -= 6;
  }
  /** Colored swatches with labels, on one line. */
  legend(items: [string, string][]) {
    this.ensure(16);
    let x = M;
    for (const [label, hex] of items) {
      const n = parseInt(hex.slice(1), 16);
      this.page.drawRectangle({
        x,
        y: this.y - 8,
        width: 12,
        height: 3,
        color: rgb((n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255),
      });
      this.at(label, x + 16, 8.5, { color: MUTED });
      x += 16 + this.width(label, 8.5) + 16;
    }
    this.y -= 14;
  }
  async image(png: Uint8Array, pxW: number, pxH: number) {
    const img = await this.doc.embedPng(png);
    const h = (this.w / pxW) * pxH;
    this.ensure(h);
    this.page.drawImage(img, { x: M, y: this.y - h, width: this.w, height: h });
    this.y -= h + 6;
  }
  footer(made: string) {
    this.pages.forEach((p, i) => {
      const text = winAnsi(`${made} · page ${i + 1} of ${this.pages.length}`);
      p.drawText(text, { x: M, y: M / 2, size: 7.5, font: this.font, color: MUTED });
    });
  }
}

/** Renders a chart off-screen (light theme) and rasterizes it at 2x for print. */
async function chartPng(node: ReactNode): Promise<{ png: Uint8Array; w: number; h: number } | null> {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-20000px;top:0";
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(node));
    await new Promise((r) => setTimeout(r, 80));
    const svg = host.querySelector("svg");
    if (!svg) return null;
    const w = Number(svg.getAttribute("width"));
    const h = Number(svg.getAttribute("height"));
    const src = new XMLSerializer().serializeToString(svg);
    const img = new Image();
    await new Promise((ok, fail) => {
      img.onload = ok;
      img.onerror = fail;
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(src);
    });
    const c = document.createElement("canvas");
    c.width = w * 2;
    c.height = h * 2;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
    return blob ? { png: new Uint8Array(await blob.arrayBuffer()), w, h } : null;
  } finally {
    root.unmount();
    host.remove();
  }
}

/** Chart pixels are twice the PDF width, with fonts to match. */
const CHART_PX = 1030;

/** The first and last value in a time-ordered list, and the change. */
function ends<T>(list: T[]): [T, T] | null {
  return list.length >= 1 ? [list[0], list[list.length - 1]] : null;
}

/**
 * A light-themed PDF report for `range`: a summary, then each chosen section (empty ones left
 * out). Built entirely on the device; returns the file's bytes.
 */
export async function buildReport(range: Range, sections: ReportSection[], unit: Unit): Promise<{ bytes: Uint8Array; pages: number }> {
  const on = (s: ReportSection) => sections.includes(s);
  const [rows, goals, phases, energy, scans, measurements, parts, workouts, sex, height] = await Promise.all([
    api.weighIns(true) as Promise<WeighInRow[]>,
    api.goalHistory(),
    api.listPhases() as Promise<Phase[]>,
    api.energyBalance(14),
    api.analysisScans() as Promise<InBodyScan[]>,
    api.measurements() as Promise<MeasurementRow[]>,
    api.bodyParts(),
    api.workoutSeries(),
    api.getSetting("sex"),
    api.getSetting("height_cm"),
  ]);
  // "All time" starts at the first thing logged.
  const firsts = [rows[0]?.at, workouts[0]?.at, scans[0]?.measured_at_local, measurements[0]?.at].filter(Boolean) as string[];
  const from = range.from ?? (firsts.length ? firsts.map((d) => d.slice(0, 10)).sort()[0] : today());
  const to = range.to && range.to < today() ? range.to : today();
  const r: Range = { ...range, from, to };
  const span = (parseLocal(to).getTime() - parseLocal(from).getTime()) / DAY + 1;
  const before = {
    from: isoDate(new Date(parseLocal(from).getTime() - span * DAY)),
    to: isoDate(new Date(parseLocal(from).getTime() - DAY)),
  };
  const [nums, prev] = await Promise.all([api.reportNumbers(from, to), api.reportNumbers(before.from, before.to)]);

  const [W, H] = pageSize();
  const doc = await PDFDocument.create();
  doc.setTitle(`FitCodex progress report, ${from} to ${to}`);
  doc.setProducer("FitCodex");
  doc.setCreator("FitCodex");
  const out = new Writer(doc, [W, H], await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold));
  const kg = (v: number, d = 1) => `${toUnit(v, unit).toFixed(d)} ${unit}`;
  const kgSigned = (v: number, d = 1) => `${sign(toUnit(v, unit), d)} ${unit}`;

  // ---- Title and summary
  out.at("Progress report", M, 22, { bold: true });
  out.y -= 28;
  const selected = range.key.startsWith("phase-") ? phases.find((p) => `phase-${p.id}` === range.key) : undefined;
  out.at(`${selected ? selected.name : range.label} · ${long(from)} – ${long(to)}`, M, 11, { color: MUTED });
  out.y -= 22;

  const weighIns = rows.filter((w) => inRange(w.at, r));
  const w = ends(weighIns);
  const weeks = span / 7;
  const summary: [string, string][] = [];
  if (on("weight") && w) {
    summary.push(["Latest weight", kg(w[1].weight_kg)]);
    if (w[0] !== w[1]) {
      const change = w[1].weight_kg - w[0].weight_kg;
      const wks = Math.max(1, (parseLocal(w[1].at).getTime() - parseLocal(w[0].at).getTime()) / (7 * DAY));
      summary.push(["Change", kgSigned(change)], ["Per week", kgSigned(change / wks, 2)]);
    }
  }
  if (on("strength") && nums.workouts) summary.push(["Workouts a week", (nums.workouts / weeks).toFixed(1)]);
  if (on("weight") && nums.intake_kcal != null) summary.push(["Average intake", `${Math.round(nums.intake_kcal)} kcal`]);
  out.stats(summary.slice(0, 5));

  // ---- Weight, calories, goal phases
  if (on("weight") && weighIns.length > 0) {
    const bands: Band[] = phases.map((p) => ({
      start: parseLocal(p.start_date),
      end: p.end_date ? parseLocal(p.end_date) : null,
      label: p.name,
      lane: p.lane,
    }));
    const inView = goals.filter((g) => g.start_date <= to && (!g.end_date || g.end_date >= from));
    const now = new Date(parseLocal(to).getTime() + DAY);
    out.heading("Weight", 200);
    const weight = await chartPng(
      <TimeSeriesSvg
        series={[{ id: "bw", label: "Weigh-ins", points: weighIns.map((x) => ({ t: parseLocal(x.at), v: toUnit(x.weight_kg, unit) })) }]}
        unit={unit}
        bands={bands}
        corridors={goalCorridors(inView, rows, (v) => toUnit(v, unit), now)}
        theme={LIGHT}
        width={CHART_PX}
        height={360}
        yFormat={(v) => v.toFixed(0)}
        smooth={{ on: true, span: 0.15 }}
        fontScale={2}
      />,
    );
    if (weight) await out.image(weight.png, weight.w, weight.h);
    const balance = energy.filter((p) => p.balance_kcal != null && inRange(p.date, r));
    if (balance.length > 1) {
      const chart = await chartPng(
        <TimeSeriesSvg
          series={[
            {
              id: "bal",
              label: "Surplus / deficit",
              points: balance.map((p) => ({ t: parseLocal(p.date), v: Math.round(p.balance_kcal!) })),
            },
          ]}
          unit="kcal"
          bands={bands}
          corridors={calorieTargets(inView, rows, now)}
          corridorLabel="Target surplus / deficit"
          diverging={{ aboveLabel: "Surplus", belowLabel: "Deficit" }}
          yStep={250}
          yFormat={(v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(Math.round(v)).toLocaleString()}
          theme={LIGHT}
          width={CHART_PX}
          height={260}
          smooth={{ on: false, span: 0.15 }}
          fontScale={2}
        />,
      );
      if (chart) {
        out.ensure(130);
        out.at("Calories: surplus (+) / deficit (-) from the weight trend, 14-day average", M, 9, { bold: true });
        out.y -= 13;
        await out.image(chart.png, chart.w, chart.h);
      }
    }
    const tdee = [...energy].reverse().find((p) => p.tdee_kcal != null && inRange(p.date, r))?.tdee_kcal;
    const food = [
      nums.intake_kcal != null && `Average intake ${Math.round(nums.intake_kcal)} kcal/day (${nums.intake_days} days logged)`,
      nums.protein_g != null && `protein ${Math.round(nums.protein_g)} g/day`,
      tdee != null && `estimated expenditure ${Math.round(tdee)} kcal/day`,
    ].filter(Boolean);
    if (food.length) out.para(`${food.join(", ")}.`);
    if (inView.length)
      out.para(
        "Shaded bands are each goal's target pace: where weight would be at the goal's rate, and the matching daily surplus or deficit (7,700 kcal per kg).",
        8,
      );

    // Goal phases side by side.
    const picked = pickPhases(goals as GoalPhase[], selected?.lane === "nutrition" ? selected.id : null, from, to);
    if (picked.length) {
      const profile = { sex: sex === "male" || sex === "female" ? (sex as "male" | "female") : null, height: Number(height) || null };
      const tableRows: string[][] = [];
      for (const { phase: g, role } of picked) {
        const end = g.end_date && g.end_date < today() ? g.end_date : today();
        const n = await api.reportNumbers(g.start_date, end);
        const ws = rows.filter((x) => x.at.slice(0, 10) >= g.start_date && x.at.slice(0, 10) <= end);
        const days = (parseLocal(end).getTime() - parseLocal(g.start_date).getTime()) / DAY + 1;
        const e = ends(ws);
        const change = e && e[0] !== e[1] ? e[1].weight_kg - e[0].weight_kg : null;
        const actual =
          change != null ? (change / Math.max(1, (parseLocal(e![1].at).getTime() - parseLocal(e![0].at).getTime()) / DAY)) * 7 : null;
        const split = phaseSplit(g.start_date, g.end_date, new Date(), measurements, scans, rows, profile.sex, profile.height);
        tableRows.push([
          `${GOAL_TEXT[g.goal]}${role === "this" && picked.length > 1 && selected ? " (this)" : role === "earlier" ? " (earlier)" : ""}`,
          `${short(g.start_date)} – ${g.end_date ? short(g.end_date) : "now"}`,
          (days / 7).toFixed(0),
          change != null ? sign(toUnit(change, unit), 1) : "–",
          actual != null
            ? `${sign(toUnit(actual, unit), 2)}${g.weekly_rate_kg != null ? ` (${sign(toUnit(g.weekly_rate_kg, unit), 2)})` : ""}`
            : "–",
          split ? `${sign(toUnit(split.leanKg, unit), 1)} / ${sign(toUnit(split.fatKg, unit), 1)}` : "–",
          n.intake_kcal != null ? String(Math.round(n.intake_kcal)) : "–",
          n.workouts ? (n.workouts / n.weeks).toFixed(1) : "–",
          n.median_change != null ? `${sign(n.median_change * 100, 1)}%` : "–",
        ]);
      }
      out.heading(selected?.lane === "nutrition" ? "This phase and the ones before it" : "Goal phases in this period", 60);
      out.table(
        [
          ["Phase", 70, false],
          ["Dates", 92, false],
          ["Weeks", 32, true],
          [`Change (${unit})`, 56, true],
          ["Per week (target)", 76, true],
          ["Lean / fat", 64, true],
          ["kcal/day", 40, true],
          ["Workouts/wk", 58, true],
          ["Strength", 27 + (out.w - 515), true],
        ],
        tableRows,
      );
      out.para(
        "Per week is the actual rate, with the goal's own target in brackets. Lean / fat splits the change using body-fat readings near the start and end (scans, tape or logged). Strength is the typical change in estimated 1RM, first half to second half, across the most-trained lifts.",
        8,
      );
    }
  }

  // ---- Body composition and measurements
  if (on("body")) {
    const inScans = scans.filter((s) => inRange(s.measured_at_local, r));
    const table: string[][] = [];
    const s = ends(inScans);
    for (const [col, label, mass] of SCAN_ROWS) {
      const withIt = inScans.filter((x) => x.values[col] != null);
      const e = ends(withIt);
      if (!e) continue;
      const [a, b] = [e[0].values[col], e[1].values[col]];
      const show = (v: number) => (mass ? kg(v) : `${v.toFixed(1)}%`);
      table.push([
        label,
        e[0] === e[1] ? "" : `${show(a)}  ${short(e[0].measured_at_local)}`,
        `${show(b)}  ${short(e[1].measured_at_local)}`,
        e[0] === e[1] ? "–" : mass ? kgSigned(b - a) : `${sign(b - a, 1)} pts`,
      ]);
    }
    const imperial = unit === "lb";
    for (const p of parts) {
      const e = ends(measurements.filter((m) => m.part === p.id && inRange(m.at, r)));
      if (!e) continue;
      const show = (v: number) => (p.unit === "pct" ? `${v.toFixed(1)}%` : imperial ? `${(v / 2.54).toFixed(1)} in` : `${v.toFixed(1)} cm`);
      const d = e[1].value - e[0].value;
      table.push([
        p.label,
        e[0] === e[1] ? "" : `${show(e[0].value)}  ${short(e[0].at)}`,
        `${show(e[1].value)}  ${short(e[1].at)}`,
        e[0] === e[1] ? "–" : p.unit === "pct" ? `${sign(d, 1)} pts` : imperial ? `${sign(d / 2.54, 1)} in` : `${sign(d, 1)} cm`,
      ]);
    }
    if (table.length) {
      out.heading("Body composition and measurements", 120);
      if (s && inScans.length > 1) {
        const pts = (c: string) =>
          inScans.filter((x) => x.values[c] != null).map((x) => ({ t: parseLocal(x.measured_at_local), v: toUnit(x.values[c], unit) }));
        const chart = await chartPng(
          <TimeSeriesSvg
            series={[
              { id: "smm", label: "Skeletal muscle", points: pts("smm_kg") },
              { id: "bfm", label: "Body fat mass", points: pts("body_fat_mass_kg") },
            ]}
            unit={unit}
            theme={LIGHT}
            width={CHART_PX}
            height={260}
            smooth={{ on: false, span: 0.3 }}
            fontScale={2}
          />,
        );
        if (chart) {
          out.legend([
            ["Skeletal muscle", LIGHT.line],
            ["Body fat mass", LIGHT.categorical[0]],
          ]);
          await out.image(chart.png, chart.w, chart.h);
        }
      }
      out.table(
        [
          ["", 150, false],
          ["First in period", 130, true],
          ["Latest", 130, true],
          ["Change", out.w - 410, true],
        ],
        table,
      );
    }
  }

  // ---- Strength and training
  if (on("strength") && nums.workouts > 0) {
    out.heading("Strength and training", 80);
    out.stats([
      ["Workouts", String(nums.workouts)],
      ["Per week", (nums.workouts / weeks).toFixed(1)],
      ["Sets per week", (nums.sets / weeks).toFixed(0)],
      ...(nums.avg_duration_min != null ? ([["Average length", `${Math.round(nums.avg_duration_min)} min`]] as [string, string][]) : []),
      ...(prev.workouts ? ([["Previous period", `${(prev.workouts / weeks).toFixed(1)}/wk`]] as [string, string][]) : []),
    ]);
    const e = (v: number | null) => (v == null ? "–" : toUnit(v, unit).toFixed(1));
    out.table(
      [
        ["Most-trained lifts", 170, false],
        ["Sets", 40, true],
        [`e1RM 1st half`, 70, true],
        [`2nd half (${unit})`, 70, true],
        ["Change", 55, true],
        ["Best set", 75, true],
        ["PRs", out.w - 480, true],
      ],
      nums.lifts.map((l) => [
        l.per_hand ? `${l.name} (per hand)` : l.name,
        String(l.sets),
        e(l.first_kg),
        e(l.second_kg),
        l.first_kg && l.second_kg ? `${sign(((l.second_kg - l.first_kg) / l.first_kg) * 100, 1)}%` : "–",
        `${toUnit(l.best_kg, unit).toFixed(1)} × ${l.best_reps}`,
        String(l.prs),
      ]),
    );
  }

  // ---- Recovery
  if (on("recovery") && (nums.sleep_h != null || nums.resting_hr != null || nums.hrv_ms != null)) {
    out.heading("Recovery", 40);
    const was = (v: number | null, f: (v: number) => string) => (v != null ? ` (before: ${f(v)})` : "");
    const items: [string, string][] = [];
    if (nums.sleep_h != null) items.push([`Sleep a night${was(prev.sleep_h, (v) => `${v.toFixed(1)} h`)}`, `${nums.sleep_h.toFixed(1)} h`]);
    if (nums.resting_hr != null)
      items.push([`Resting HR${was(prev.resting_hr, (v) => `${Math.round(v)}`)}`, `${Math.round(nums.resting_hr)} bpm`]);
    if (nums.hrv_ms != null) items.push([`HRV${was(prev.hrv_ms, (v) => `${Math.round(v)}`)}`, `${Math.round(nums.hrv_ms)} ms`]);
    out.stats(items);
    out.para(`Averages over the period; "before" is the same length of time just before it.`, 8);
  }

  out.footer(`Made ${long(today())}`);
  return { bytes: await doc.save(), pages: out.pages.length };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
