/**
 * Forest plot: one row per outcome (or per database in the drilldown), showing
 * the hazard ratio and its 95% confidence interval on a log scale.
 */
import * as d3 from "d3";
import {
  frame,
  xAxis,
  legend,
  showTooltip,
  moveTooltip,
  hideTooltip,
  fmtCi,
  fmtP,
  token,
  onResize,
  type Margin,
} from "./common";

export interface ForestItem {
  label: string;
  rr: number | null;
  lb: number | null;
  ub: number | null;
  p: number | null;
  calRr: number | null;
  calLb: number | null;
  calUb: number | null;
  calP: number | null;
  datum?: unknown;
}

export interface ForestOptions {
  /** Show the calibrated estimate as a second mark on each row. */
  showCalibrated?: boolean;
  onSelect?: (item: ForestItem) => void;
  labelWidth?: number;
}

export function renderForest(
  container: HTMLElement,
  items: ForestItem[],
  options: ForestOptions = {},
): void {
  const draw = () => drawForest(container, items, options);
  draw();
  onResize(container, draw);
}

function drawForest(
  container: HTMLElement,
  items: ForestItem[],
  { showCalibrated = true, onSelect, labelWidth = 300 }: ForestOptions,
): void {
  const usable = items.filter((i) => i.rr != null && Number.isFinite(i.rr));
  const rowHeight = 26;
  const margin: Margin = {
    top: 12,
    right: 24,
    bottom: 46,
    left: labelWidth,
  };
  const height = Math.max(120, usable.length * rowHeight + 58);
  const f = frame(container, height, margin);

  if (usable.length === 0) {
    f.plot
      .append("text")
      .attr("class", "tick-label")
      .attr("y", 20)
      .text("No estimable results.");
    return;
  }

  const bounds = usable.flatMap((i) =>
    [i.lb, i.ub, i.rr, showCalibrated ? i.calLb : null, showCalibrated ? i.calUb : null].filter(
      (v): v is number => v != null && Number.isFinite(v) && v > 0,
    ),
  );
  const lo = Math.max(0.05, (d3.min(bounds) as number) * 0.85);
  const hi = Math.min(20, (d3.max(bounds) as number) * 1.15);

  const x = d3.scaleLog().domain([lo, hi]).range([0, f.width]).clamp(true);
  const y = d3
    .scaleBand<string>()
    .domain(usable.map((_, i) => String(i)))
    .range([0, usable.length * rowHeight])
    .padding(0.25);

  const plotBottom = usable.length * rowHeight;
  const ticks = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 4, 8].filter(
    (t) => t >= lo && t <= hi,
  );

  for (const t of ticks) {
    f.plot
      .append("line")
      .attr("class", t === 1 ? "ref-line" : "grid-line")
      .attr("x1", x(t))
      .attr("x2", x(t))
      .attr("y1", 0)
      .attr("y2", plotBottom);
  }

  const axisFrame = { ...f, height: plotBottom };
  xAxis(axisFrame, x, "Hazard ratio (log scale)", ticks, (v) => String(+v.toFixed(2)));

  const uncal = token("--series-1");
  const cal = token("--series-2");

  const rows = f.plot
    .append("g")
    .selectAll("g")
    .data(usable)
    .join("g")
    .attr(
      "transform",
      (_d, i) => `translate(0,${(y(String(i)) ?? 0) + y.bandwidth() / 2})`,
    )
    .attr("cursor", onSelect ? "pointer" : "default");

  // Full-row hit target, larger than the marks themselves.
  rows
    .append("rect")
    .attr("x", -margin.left)
    .attr("y", -rowHeight / 2)
    .attr("width", f.width + margin.left)
    .attr("height", rowHeight)
    .attr("fill", "transparent")
    .on("mouseenter", (event: MouseEvent, d) => showTooltip(event, tip(d)))
    .on("mousemove", moveTooltip)
    .on("mouseleave", hideTooltip)
    .on("click", (_e, d) => onSelect?.(d));

  rows
    .append("text")
    .attr("class", "tick-label")
    .attr("x", -10)
    .attr("dy", "0.32em")
    .attr("text-anchor", "end")
    .attr("fill", token("--text-primary"))
    .text((d) => truncate(d.label, Math.floor(labelWidth / 6.4)));

  const offset = showCalibrated ? 4 : 0;

  // Uncalibrated interval.
  rows
    .filter((d) => d.lb != null && d.ub != null)
    .append("line")
    .attr("x1", (d) => x(clamp(d.lb as number, lo, hi)))
    .attr("x2", (d) => x(clamp(d.ub as number, lo, hi)))
    .attr("y1", -offset)
    .attr("y2", -offset)
    .attr("stroke", uncal)
    .attr("stroke-width", 2)
    .attr("stroke-linecap", "round");

  rows
    .append("circle")
    .attr("cx", (d) => x(clamp(d.rr as number, lo, hi)))
    .attr("cy", -offset)
    .attr("r", 4.5)
    .attr("fill", uncal)
    .attr("stroke", token("--surface-1"))
    .attr("stroke-width", 2);

  if (showCalibrated) {
    const withCal = rows.filter((d) => d.calRr != null);
    withCal
      .filter((d) => d.calLb != null && d.calUb != null)
      .append("line")
      .attr("x1", (d) => x(clamp(d.calLb as number, lo, hi)))
      .attr("x2", (d) => x(clamp(d.calUb as number, lo, hi)))
      .attr("y1", offset)
      .attr("y2", offset)
      .attr("stroke", cal)
      .attr("stroke-width", 2)
      .attr("stroke-linecap", "round");

    withCal
      .append("circle")
      .attr("cx", (d) => x(clamp(d.calRr as number, lo, hi)))
      .attr("cy", offset)
      .attr("r", 4.5)
      .attr("fill", cal)
      .attr("stroke", token("--surface-1"))
      .attr("stroke-width", 2);
  }

  legend(
    container,
    showCalibrated
      ? [
          { label: "Uncalibrated", color: uncal },
          { label: "Calibrated on negative controls", color: cal },
        ]
      : [{ label: "Hazard ratio (95% CI)", color: uncal }],
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function tip(d: ForestItem) {
  return {
    title: d.label,
    rows: [
      ["HR (95% CI)", fmtCi(d.rr, d.lb, d.ub)],
      ["p", fmtP(d.p)],
      ["Calibrated HR", fmtCi(d.calRr, d.calLb, d.calUb)],
      ["Calibrated p", fmtP(d.calP)],
    ] as [string, string][],
    footer: "Click for the full estimate and its diagnostics.",
  };
}
