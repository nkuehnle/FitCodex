import * as d3 from "d3";
import { useMemo, useState, type ReactNode } from "react";
import { LOAD_RAMP, useChartTheme, type ChartTheme } from "./theme";

// Front/back figures, 200 × 430 each: an athletic 8-heads-tall build drawn on one body outline.
// Muscle regions are polygons keyed by muscle id, smoothed into curves; "mirror" shapes are drawn
// on the figure's left half and mirrored. A muscle can have several regions (each quad head, each
// ab segment), and each one is shaded as a rounded form.
type Pt = [number, number];
interface Region {
  muscle: string;
  pts: Pt[];
  mirror?: boolean;
}
const R = (muscle: string, pts: Pt[], mirror = true): Region => ({ muscle, pts, mirror });

const SIDE_DELT: Pt[] = [[57, 75.5], [49, 79], [43, 88], [41, 100], [43, 110], [49, 112], [48, 98], [50, 86]];

const FRONT: Region[] = [
  R("neck", [[91, 54], [109, 54], [110, 64], [105, 71], [100, 73], [95, 71], [90, 64]], false),
  R("traps", [[89, 59], [89, 66], [81, 71], [69, 73.5], [61, 73.5], [72, 68.5], [82, 63.5]]),
  R("side_delts", SIDE_DELT),
  R("front_delts", [[67, 75.5], [59, 77], [53, 84], [50.5, 96], [52, 108], [57, 113], [60.5, 104], [64, 93], [68, 83]]),
  R("upper_chest", [[98, 76.5], [84, 76], [70.5, 78], [68, 85], [65.5, 93], [76, 92.5], [88, 91], [98, 90.5]]),
  R("lower_chest", [[98, 93], [88, 93.5], [76, 95], [65.5, 96], [62.5, 104], [66, 113], [73, 119.5], [83, 122], [93, 120.5], [98, 116]]),
  R("lats", [[64.5, 110], [63.5, 120], [65.5, 134], [69, 146], [71, 135], [70, 121]]),
  R("biceps", [[58.5, 114], [52, 114], [47.5, 123], [46.5, 138], [48.5, 150], [53, 154.5], [56.5, 148], [59, 134], [60, 121]]),
  R("triceps", [[45.5, 113.5], [41.5, 122], [40.5, 138], [41, 149], [44.5, 148], [45, 131], [46.5, 118]]),
  R("forearm_flexors", [[53, 160.5], [47, 161], [44.5, 173], [43.5, 191], [41.5, 211], [42, 215], [46.5, 203], [51.5, 185], [53, 170]]),
  R("forearm_extensors", [[44.5, 158.5], [38, 160.5], [33, 172], [31.5, 188], [32.5, 210], [39, 213.5], [41, 192], [42, 174]]),
  R("abs", [[99, 125], [91, 125.5], [88.5, 131], [89, 138.5], [99, 139]]),
  R("abs", [[99, 141.5], [89, 141.5], [88, 148], [88.5, 155.5], [99, 156]]),
  R("abs", [[99, 158.5], [88.5, 158.5], [88, 165.5], [88.5, 172.5], [99, 173]]),
  R("abs", [[99, 175.5], [88.5, 175.5], [88, 187], [90, 199], [95, 208.5], [99, 212]]),
  R("obliques", [[85.5, 128], [78, 129], [71.5, 140], [72.5, 154], [74, 166], [73, 180], [72, 192], [78, 198.5], [86, 205], [86, 186], [85.5, 160], [85.5, 140]]),
  R("abductors", [[71, 196.5], [67.5, 204], [66.5, 218], [68.5, 232], [72, 226], [75, 213], [76, 203]]),
  R("quads", [[80.5, 214], [75.5, 226], [74.5, 250], [76.5, 276], [80.5, 299], [85, 301], [88, 280], [89, 254], [87.5, 232], [84.5, 218]]),
  R("quads", [[72, 228], [67.5, 238], [66.5, 258], [68.5, 281], [72.5, 301], [76.5, 305], [78, 299], [74.5, 277], [72.5, 251], [73, 234]]),
  R("quads", [[90.5, 263], [89.5, 281], [87.5, 298], [89.5, 308.5], [93, 304.5], [95, 290], [94.5, 273], [92.5, 263]]),
  R("adductors", [[88.5, 222], [98, 233], [98, 247], [96, 262], [93, 258.5], [91, 250], [90, 236]]),
  R("calves", [[75, 329], [70.5, 341], [70.5, 359], [73.5, 378], [77.5, 392], [80, 376], [80.5, 354], [79, 337]]),
  R("calves", [[88, 329], [92, 339], [93, 356], [91.5, 372], [88.5, 387], [86.5, 370], [86, 350], [86, 336]]),
];

const BACK: Region[] = [
  R("neck", [[91.5, 47], [108.5, 47], [109.5, 56], [100, 59], [90.5, 56]], false),
  R("traps", [[99.5, 52], [92.5, 56.5], [87, 64], [74, 70], [61, 73.5], [69, 78], [81, 81.5], [89, 94], [94.5, 114], [99.5, 134]]),
  R("side_delts", SIDE_DELT),
  R("rear_delts", [[66.5, 77.5], [59, 77.5], [52.5, 84], [50.5, 96], [52, 108], [56.5, 111.5], [60.5, 102], [65, 92], [69, 83]]),
  R("upper_back", [[71.5, 83], [81.5, 85.5], [87.5, 97], [91, 110], [86, 116.5], [76, 114.5], [67.5, 108.5], [64.5, 100], [67.5, 91]]),
  R("lats", [[64.5, 110.5], [75, 118], [86.5, 120], [91, 117], [93.5, 127], [96, 139], [96.5, 158], [93.5, 172], [88, 178], [80, 172], [74, 160], [70, 146], [66, 128]]),
  R("lower_back", [[99.5, 139], [97, 143], [96, 161], [94.5, 178], [92.5, 192], [95, 200.5], [99.5, 202]]),
  R("obliques", [[73.5, 162], [72.5, 175], [70.5, 188], [75, 194], [85, 189], [90.5, 181], [81, 175], [76, 167]]),
  R("triceps", [[50, 110.5], [44.5, 113.5], [41, 124], [40.5, 138], [42.5, 148.5], [47, 150.5], [48.5, 140], [49, 124]]),
  R("triceps", [[57.5, 113], [51.5, 113.5], [51, 126], [50.5, 142], [51.5, 152.5], [55, 153], [57.5, 141], [59.5, 125]]),
  R("forearm_extensors", [[46.5, 160], [39, 160.5], [33, 172], [31.5, 188], [32.5, 210], [39.5, 214], [42, 200], [45, 180], [46, 167]]),
  R("forearm_flexors", [[53, 161.5], [48.5, 163], [47.5, 180], [44.5, 202], [42, 214.5], [46.5, 204], [51.5, 185], [53, 171]]),
  R("abductors", [[75, 194.5], [69.5, 200], [67, 210], [68, 218], [74, 212.5], [82, 207], [90, 203.5], [84, 197.5]]),
  R("glutes", [[91, 206], [82, 210], [73.5, 216.5], [68, 226], [68, 240], [74, 250], [86, 252.5], [96, 248.5], [99, 239], [99, 217], [96, 208]]),
  R("hamstrings", [[70.5, 255], [67.5, 267], [69, 288], [72.5, 306], [77, 312], [80, 300], [80.5, 277], [79.5, 259]]),
  R("hamstrings", [[82.5, 258], [83, 277], [82.5, 300], [85, 312], [90, 308], [93, 292], [94.5, 271], [93, 257.5], [88, 256]]),
  R("adductors", [[96, 252], [99, 248.5], [98.5, 263], [97, 277], [95.5, 267]]),
  R("calves", [[72.5, 327], [69.5, 340], [70.5, 356], [75, 368], [80.5, 366], [81, 346], [80, 331], [76, 323]]),
  R("calves", [[83, 323], [82.5, 346], [83, 368], [88, 371], [92.5, 358], [93.5, 340], [91.5, 327], [87, 321]]),
];

// Left half of the body outline: from the neck over the shoulder, down the arm and around the
// hand, up to the armpit, down the torso and leg, around the foot and up the inner leg to the
// crotch; mirrored for the right half.
const OUTLINE_LEFT: Pt[] = [
  [90.5, 46], [90, 59], [85, 65.5], [72, 70.5], [60, 73.5], [48, 79.5], [41.5, 91], [39.5, 108], [40, 124], [38.5, 142],
  [35.5, 158], [31.5, 172], [30, 187], [31, 204], [32, 216], [29, 227], [28.5, 240], [31, 250], [35.5, 253.5], [39.5, 249],
  [41, 240], [44.5, 238], [46, 230], [43.5, 221], [42.5, 216], [47, 201], [52, 183], [53.5, 168], [54, 158], [56.5, 141], [59, 125], [61.5, 113],
  [64.5, 108.5], [64.5, 119], [66.5, 134], [70.5, 150], [73, 163], [72, 177], [69, 191], [66.5, 205], [65.5, 221], [65.5, 241],
  [67, 263], [69.5, 285], [72, 301], [72.5, 313], [71, 325], [69, 341], [69.5, 359], [73, 379], [76.5, 396], [77, 406],
  [74, 414], [70.5, 420], [72, 424.5], [81, 425.5], [90, 424.5], [92, 418], [89.5, 408], [90, 394], [92.5, 374], [94, 354],
  [93, 336], [91.5, 322], [92.5, 308], [94.5, 290], [97, 266], [99, 244], [100, 229],
];
const OUTLINE: Pt[] = [...OUTLINE_LEFT, ...[...OUTLINE_LEFT].reverse().map(([x, y]) => [200 - x, y] as Pt)];
const HEAD_LEFT: Pt[] = [[100, 6], [91, 8], [84.5, 15], [81.5, 26], [82.5, 38], [86, 49], [93, 57], [100, 59.5]];
const HEAD: Pt[] = [...HEAD_LEFT, ...[...HEAD_LEFT].reverse().slice(1, -1).map(([x, y]) => [200 - x, y] as Pt)];
const EAR: Pt[] = [[81.5, 28], [79, 30], [79.5, 37], [82.5, 40]];

/** The head and ears, drawn over the neck muscles. */
const HEAD_PARTS: Pt[][] = [EAR, EAR.map(([x, y]) => [200 - x, y] as Pt), HEAD];

/** Hair, drawn over the head: a short cut from the front, the whole back of the head from behind. */
const HAIR_FRONT =
  "M81.6,30 C80,17 86,5 100,4.5 C114,5 120,17 118.4,30 C117.5,24 115,19.5 111,17.5 C104,20 94,19.5 88,16.5 C85,19.5 82.5,24 81.6,30 Z";
const HAIR_BACK = "M81.6,30 C80,17 86,5 100,4.5 C114,5 120,17 118.4,30 C118.5,37 116,43 112,46 Q100,49 88,46 C84,43 81.5,37 81.6,30 Z";

/** Definition lines, drawn in the surface color. */
const DETAIL_FRONT = [
  // collarbones and the line between the pecs
  "M97,75 Q82,72.5 64,74.5 M103,75 Q118,72.5 136,74.5",
  "M100,78 L100,121",
  // serratus
  "M70,124 l6,3 M70.5,131 l6,3 M71.5,138 l5.5,3 M130,124 l-6,3 M129.5,131 l-6,3 M128.5,138 l-5.5,3",
  // hip lines
  "M73,195 Q84,205 93,221 M127,195 Q116,205 107,221",
  // kneecaps and shins
  "M76,312 Q82,305 88,312 Q88,321 82,324 Q76,321 76,312 M124,312 Q118,305 112,312 Q112,321 118,324 Q124,321 124,312",
  "M83.3,330 Q83.6,362 84,398 M116.7,330 Q116.4,362 116,398",
  // fingers
  "M32.5,240 L33.5,251 M36,240 L36.5,252 M167.5,240 L166.5,251 M164,240 L163.5,252",
];
const DETAIL_BACK = [
  "M100,60 L100,203",
  // shoulder blades
  "M72,84 Q84,92 90,112 M128,84 Q116,92 110,112",
  "M100,207 L100,247",
  // under the glutes, backs of the knees, Achilles tendons
  "M70,252 Q84,258 97,251 M130,252 Q116,258 103,251",
  "M75,318 Q82,321 89,318 M125,318 Q118,321 111,318",
  "M76,372 Q80,390 80.5,406 M88,374 Q85,390 84.5,406 M124,372 Q120,390 119.5,406 M112,374 Q115,390 115.5,406",
  "M32.5,240 L33.5,251 M36,240 L36.5,252 M167.5,240 L166.5,251 M164,240 L163.5,252",
];

const mirror = (pts: Pt[]): Pt[] => pts.map(([x, y]) => [200 - x, y]);
// Closed Catmull-Rom curves through the polygon corners: rounded, organic outlines.
const smooth = d3.line().curve(d3.curveCatmullRomClosed.alpha(0.5));
const toPath = (pts: Pt[]) => smooth(pts) ?? "";

function regionsOf(view: Region[]) {
  return view.flatMap((r) =>
    r.mirror
      ? [
          { ...r, d: toPath(r.pts) },
          { ...r, d: toPath(mirror(r.pts)) },
        ]
      : [{ ...r, d: toPath(r.pts) }],
  );
}

const FRONT_PATHS = regionsOf(FRONT);
const BACK_PATHS = regionsOf(BACK);

export interface BodyMapProps {
  /** muscle id -> value (sets or volume) */
  values: Record<string, number>;
  /** Scale maximum; defaults to the largest value (pass a shared max when comparing maps). */
  max?: number;
  selected?: string | null;
  onSelect?: (muscle: string) => void;
  theme?: ChartTheme;
  /** Figure height in px. */
  height?: number;
  showLegend?: boolean;
  legendLabel?: string;
  muscleNames?: Record<string, string>;
  hideNumbers?: boolean;
  /** Weekly set targets (min, max) per muscle; values must then be sets per week. Colors become
   *  under / in / over target, and muscles over target get a dashed outline. */
  targets?: Record<string, [number, number]>;
  /** Precomputed fill per muscle (overrides values/targets coloring), with its own legend. */
  fills?: Record<string, string>;
  legend?: ReactNode;
}

const loadInterp = d3
  .scaleLinear<string>()
  .domain(LOAD_RAMP.map((r) => r[0]))
  .range(LOAD_RAMP.map((r) => r[1]))
  .interpolate(d3.interpolateLab)
  .clamp(true);

/** Where a weekly set count sits against its target: 0–0.5 under the minimum, 0.5–0.8 inside the
 *  range, 0.8–1 above the maximum (1 = half again over it). */
export function loadPosition(v: number, [lo, hi]: [number, number]): number {
  if (v <= 0) return 0;
  if (v < lo) return 0.5 * (v / lo);
  if (v <= hi) return 0.5 + 0.3 * (hi > lo ? (v - lo) / (hi - lo) : 1);
  return 0.8 + 0.2 * Math.min(1, (v - hi) / (0.5 * hi || 1));
}
export const loadColor = (t: number) => loadInterp(t);

/** Plain magnitude (no targets): white → deep red, stopping short of the "too much" black. */
export function useHeatScale(_theme: ChartTheme, max: number) {
  return useMemo(() => (v: number) => (v <= 0 ? null : loadInterp(0.03 + 0.77 * Math.min(1, v / (max || 1)))), [max]);
}

/** Color ramp legend for body maps (also used alone under side-by-side maps). */
export function HeatLegend({
  max,
  theme: forced,
  label,
  hideNumbers,
}: {
  max: number;
  theme?: ChartTheme;
  label?: string;
  hideNumbers?: boolean;
}) {
  const auto = useChartTheme();
  const theme = forced ?? auto;
  const color = useHeatScale(theme, max);
  return (
    <div className="heat-legend small muted">
      <span>0</span>
      <span
        className="heat-ramp"
        style={{ background: `linear-gradient(to right, ${[0.02, 0.25, 0.5, 0.75, 1].map((f) => color(f * (max || 1))).join(",")})` }}
      />
      <span>{hideNumbers ? "most" : `${Math.round(max * 10) / 10}`}</span>
      {label && <span>{label}</span>}
    </div>
  );
}

/** Legend for the target-relative scale (segments match loadPosition: 50% / 30% / 20%). */
export function LoadLegend() {
  const stops = [0.02, 0.25, 0.5, 0.65, 0.8, 0.9, 1].map((t) => `${loadColor(t)} ${t * 100}%`).join(",");
  return (
    <div className="load-legend small muted">
      <span className="load-ramp" style={{ background: `linear-gradient(to right, ${stops})` }} />
      <div className="load-labels">
        <span>under target</span>
        <span>in target</span>
        <span>over</span>
      </div>
    </div>
  );
}

export function BodyMap(props: BodyMapProps) {
  const auto = useChartTheme();
  const theme = props.theme ?? auto;
  const max = props.max ?? Math.max(0, ...Object.values(props.values));
  const color = useHeatScale(theme, max);
  const [hover, setHover] = useState<string | null>(null);
  const height = props.height ?? 320;
  const dark = theme.mode === "dark";
  const base = dark ? "#2a2f37" : "#e3e6eb";
  const hair = dark ? "#4a5261" : "#aab1bd";
  const active = hover ?? props.selected ?? null;

  const figure = (paths: typeof FRONT_PATHS, label: string, dx: number) => (
    <g transform={`translate(${dx},0)`}>
      <path d={toPath(OUTLINE)} fill={base} stroke={base} strokeWidth={2} strokeLinejoin="round" />
      <path d={toPath(OUTLINE)} fill="url(#bm-body)" pointerEvents="none" />
      {paths.map((r, i) => {
        const v = props.values[r.muscle] ?? 0;
        const t = props.targets?.[r.muscle];
        const fill = props.fills ? (props.fills[r.muscle] ?? null) : t ? (v > 0 ? loadColor(loadPosition(v, t)) : null) : color(v);
        const over = !!t && v > t[1];
        return (
          <path
            key={i}
            d={r.d}
            fill={fill ?? base}
            stroke={active === r.muscle || over ? theme.text : theme.surface}
            strokeWidth={active === r.muscle ? 1.6 : 0.9}
            strokeDasharray={over && active !== r.muscle ? "3 2" : undefined}
            strokeLinejoin="round"
            style={{ cursor: props.onSelect ? "pointer" : undefined }}
            onPointerEnter={() => setHover(r.muscle)}
            onPointerLeave={() => setHover(null)}
            onClick={() => props.onSelect?.(r.muscle)}
          >
            <title>{(props.muscleNames?.[r.muscle] ?? r.muscle) + (props.hideNumbers ? "" : `: ${Math.round(v * 10) / 10}`)}</title>
          </path>
        );
      })}
      {/* Light from the upper left on every muscle, so each reads as a rounded form. */}
      <g fill="url(#bm-form)" pointerEvents="none">
        {paths.map((r, i) => (
          <path key={i} d={r.d} />
        ))}
      </g>
      <g pointerEvents="none">
        {HEAD_PARTS.map((p, i) => (
          <path key={i} d={toPath(p)} fill={base} stroke={theme.surface} strokeWidth={0.9} />
        ))}
        <path d={toPath(HEAD)} fill="url(#bm-form)" />
        <path d={label === "Front" ? HAIR_FRONT : HAIR_BACK} fill={hair} />
      </g>
      <g fill="none" stroke={theme.surface} strokeWidth={0.9} strokeLinecap="round" pointerEvents="none" opacity={0.9}>
        {(label === "Front" ? DETAIL_FRONT : DETAIL_BACK).map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
      <text x={100} y={438} textAnchor="middle" fontSize={11} fill={theme.muted}>
        {label}
      </text>
    </g>
  );

  return (
    <div className="body-map">
      <svg
        viewBox="0 0 410 444"
        height={height}
        style={{ maxWidth: "100%", height: "auto", display: "block", margin: "0 auto" }}
        fontFamily="system-ui, sans-serif"
      >
        <defs>
          <radialGradient id="bm-form" cx="0.38" cy="0.32" r="0.8">
            <stop offset="0" stopColor="#fff" stopOpacity={dark ? 0.16 : 0.34} />
            <stop offset="0.55" stopColor="#fff" stopOpacity={0} />
            <stop offset="1" stopColor="#000" stopOpacity={dark ? 0.3 : 0.2} />
          </radialGradient>
          <linearGradient id="bm-body" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="#000" stopOpacity={0.12} />
            <stop offset="0.3" stopColor="#000" stopOpacity={0} />
            <stop offset="0.7" stopColor="#000" stopOpacity={0} />
            <stop offset="1" stopColor="#000" stopOpacity={0.12} />
          </linearGradient>
        </defs>
        {figure(FRONT_PATHS, "Front", 0)}
        {figure(BACK_PATHS, "Back", 210)}
      </svg>
      {props.showLegend !== false &&
        (props.legend ??
          (props.targets ? (
            <LoadLegend />
          ) : (
            <HeatLegend max={max} theme={theme} label={props.legendLabel} hideNumbers={props.hideNumbers} />
          )))}
      {hover && props.muscleNames && (
        <div className="small" style={{ textAlign: "center", minHeight: "1.4em" }}>
          {props.muscleNames[hover]}
          {!props.hideNumbers && `: ${Math.round((props.values[hover] ?? 0) * 10) / 10}`}
          {!props.hideNumbers && props.targets?.[hover] && ` / week (target ${props.targets[hover][0]}–${props.targets[hover][1]})`}
        </div>
      )}
    </div>
  );
}
