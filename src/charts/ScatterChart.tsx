import * as d3 from "d3";
import { useEffect, useRef, useState } from "react";
import { useChartTheme, type ChartTheme } from "./theme";

export interface ScatterPoint {
  x: number;
  y: number;
  label: string;
}

/** Up to three series (fixed categorical slots validate all-pairs only for three). */
export function ScatterChart({
  series,
  xLabel,
  yLabel,
  yDomain,
  height = 240,
  width: fixedWidth,
  theme: forced,
  fontScale = 1,
  hideNumbers,
}: {
  series: { id: string; label: string; points: ScatterPoint[] }[];
  xLabel: string;
  yLabel: string;
  yDomain?: [number, number];
  height?: number;
  /** Fixed size (share images): the legend is drawn inside the SVG. */
  width?: number;
  theme?: ChartTheme;
  fontScale?: number;
  hideNumbers?: boolean;
}) {
  const auto = useChartTheme();
  const theme = forced ?? auto;
  const wrap = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(600);
  const width = fixedWidth ?? measured;
  const [hover, setHover] = useState<{ p: ScatterPoint; s: string; color: string } | null>(null);
  useEffect(() => {
    if (fixedWidth || !wrap.current) return;
    const ro = new ResizeObserver((e) => setMeasured(Math.max(240, Math.floor(e[0].contentRect.width))));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [fixedWidth]);
  const fs = fontScale;
  const svgLegend = fixedWidth != null && series.length > 1;
  const m = { top: (svgLegend ? 52 : 24) * fs, right: (hideNumbers ? 12 : 40) * fs, bottom: 34 * fs, left: 8 * fs };
  const all = series.flatMap((s) => s.points);
  const x = d3
    .scaleLinear()
    .domain(d3.extent(all, (p) => p.x) as [number, number])
    .nice()
    .range([m.left, width - m.right]);
  const y = d3
    .scaleLinear()
    .domain(yDomain ?? (d3.extent(all, (p) => p.y) as [number, number]))
    .nice()
    .range([height - m.bottom, m.top]);
  return (
    <div ref={wrap} className="chart-plot" style={{ position: "relative" }}>
      {series.length > 1 && !svgLegend && (
        <div className="chart-legend small">
          {series.map((s, i) => (
            <span key={s.id}>
              <i className="dot" style={{ background: theme.categorical[i] }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <svg
        width={width}
        height={height}
        style={{ display: "block", width: "100%", height: "auto" }}
        viewBox={`0 0 ${width} ${height}`}
        fontFamily="system-ui, sans-serif"
      >
        {svgLegend &&
          series.map((s, i) => (
            <g key={s.id} transform={`translate(${m.left + i * 220 * fs}, ${14 * fs})`}>
              <circle cx={6 * fs} cy={0} r={6 * fs} fill={theme.categorical[i]} />
              <text x={18 * fs} y={0} dy="0.32em" fontSize={12 * fs} fill={theme.text}>
                {s.label}
              </text>
            </g>
          ))}
        {y.ticks(5).map((v) => (
          <g key={v}>
            <line x1={m.left} x2={width - m.right} y1={y(v)} y2={y(v)} stroke={theme.grid} />
            {!hideNumbers && (
              <text x={width - m.right + 6 * fs} y={y(v)} dy="0.32em" fontSize={11 * fs} fill={theme.muted}>
                {v}
              </text>
            )}
          </g>
        ))}
        {!hideNumbers &&
          x.ticks(5).map((v) => (
            <text key={v} x={x(v)} y={height - 18 * fs} fontSize={11 * fs} fill={theme.muted} textAnchor="middle">
              {d3.format(",~r")(v)}
            </text>
          ))}
        <text x={(m.left + width - m.right) / 2} y={height - 3 * fs} fontSize={11 * fs} fill={theme.muted} textAnchor="middle">
          {xLabel}
        </text>
        <text x={width - 4 * fs} y={m.top - 12 * fs} fontSize={11 * fs} fill={theme.muted} textAnchor="end" dy="-0.2em">
          {yLabel}
        </text>
        {series.map((s, si) =>
          s.points.map((p, i) => (
            <circle
              key={`${si}-${i}`}
              cx={x(p.x)}
              cy={y(p.y) + (si - (series.length - 1) / 2) * 3 * fs}
              r={5 * fs}
              fill={theme.categorical[si]}
              stroke={theme.surface}
              strokeWidth={2 * fs}
              onPointerEnter={() => setHover({ p, s: s.label, color: theme.categorical[si] })}
              onPointerLeave={() => setHover(null)}
            />
          )),
        )}
      </svg>
      {hover && (
        <div
          className="chart-tooltip"
          style={{ left: `${(x(hover.p.x) / width) * 100}%`, top: y(hover.p.y) - 50, transform: "translateX(12px)" }}
        >
          <div className="muted">{hover.p.label}</div>
          <strong>
            {hover.s}: {hover.p.y}
          </strong>
        </div>
      )}
    </div>
  );
}
