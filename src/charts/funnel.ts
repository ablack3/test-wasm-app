/**
 * Funnel plot of every effect estimate for a comparison.
 *
 * Hazard ratio on the x axis (log scale), standard error of the log hazard
 * ratio on the y axis, inverted so precise estimates sit at the top. Negative
 * controls, whose true HR is 1, should form a symmetric funnel around 1; the
 * shaded region is the 95% envelope implied by the fitted null distribution.
 * Estimates falling outside it are unlikely to be explained by the residual
 * systematic error this analysis carries.
 */
import * as d3 from "d3";
import type { EstimateRow } from "../data/model";
import type { Null } from "../data/calibration";
import { normalCdf } from "../data/calibration";
import {
  frame,
  xAxis,
  yAxis,
  legend,
  showTooltip,
  moveTooltip,
  hideTooltip,
  fmt,
  fmtP,
  fmtInt,
  fmtCi,
  token,
  onResize,
  type Margin,
} from "./common";

const MARGIN: Margin = { top: 14, right: 20, bottom: 46, left: 62 };
const HR_TICKS = [0.1, 0.25, 0.5, 1, 2, 4, 10];

export interface FunnelOptions {
  /** Null distribution fitted on the negative controls; draws the envelope. */
  nul: Null | null;
  /** Called when the user clicks an estimate. */
  onSelect?: (row: EstimateRow) => void;
  height?: number;
}

export function renderFunnel(
  container: HTMLElement,
  rows: EstimateRow[],
  options: FunnelOptions,
): void {
  const draw = () => drawFunnel(container, rows, options);
  draw();
  onResize(container, draw);
}

function drawFunnel(
  container: HTMLElement,
  rows: EstimateRow[],
  { nul, onSelect, height = 460 }: FunnelOptions,
): void {
  const data = rows.filter(
    (r) =>
      r.log_rr != null &&
      r.se_log_rr != null &&
      r.se_log_rr > 0 &&
      Number.isFinite(r.log_rr) &&
      Number.isFinite(r.se_log_rr),
  );

  const f = frame(container, height, MARGIN);
  if (data.length === 0) {
    f.plot
      .append("text")
      .attr("class", "tick-label")
      .attr("x", f.width / 2)
      .attr("y", f.height / 2)
      .attr("text-anchor", "middle")
      .text("No estimable results for this comparison.");
    return;
  }

  const maxSe = Math.max(
    0.25,
    Math.min(2, d3.max(data, (d) => d.se_log_rr as number) as number),
  );
  const logExtent = Math.max(
    Math.log(2),
    Math.min(
      Math.log(10),
      d3.max(data, (d) => Math.abs(d.log_rr as number)) as number,
    ),
  );

  const x = d3.scaleLinear().domain([-logExtent, logExtent]).range([0, f.width]);
  // Inverted: the most precise estimates (SE ~ 0) sit at the top of the funnel.
  const y = d3.scaleLinear().domain([0, maxSe]).range([0, f.height]).clamp(true);

  // 95% envelope implied by the fitted null: mu +/- 1.96 * sqrt(sigma^2 + se^2).
  if (nul) {
    const steps = d3.range(0, maxSe + 1e-9, maxSe / 80);
    const band = d3
      .area<number>()
      .x0((se) => x(nul.mean - 1.96 * Math.sqrt(nul.sd ** 2 + se ** 2)))
      .x1((se) => x(nul.mean + 1.96 * Math.sqrt(nul.sd ** 2 + se ** 2)))
      .y((se) => y(se))
      .curve(d3.curveLinear);

    f.plot
      .append("path")
      .attr("d", band(steps) ?? "")
      .attr("fill", token("--series-1"))
      .attr("fill-opacity", 0.09)
      .attr("stroke", token("--series-1"))
      .attr("stroke-opacity", 0.3)
      .attr("stroke-width", 1)
      .attr("stroke-dasharray", "4 3")
      .attr("pointer-events", "none");
  }

  yAxis(f, y, "Standard error of log HR (precision ↑)", undefined, (v) =>
    v.toFixed(2),
  );
  xAxis(
    f,
    x,
    "Hazard ratio (log scale)",
    HR_TICKS.filter((t) => Math.abs(Math.log(t)) <= logExtent + 1e-9).map(Math.log),
    (v) => {
      const hr = Math.exp(v);
      return hr < 1 ? String(+hr.toFixed(2)) : String(+hr.toFixed(1));
    },
  );

  // No-effect reference line at HR = 1.
  f.plot
    .append("line")
    .attr("class", "ref-line")
    .attr("x1", x(0))
    .attr("x2", x(0))
    .attr("y1", 0)
    .attr("y2", f.height);
  f.plot
    .append("text")
    .attr("class", "tick-label")
    .attr("x", x(0) + 5)
    .attr("y", 11)
    .text("no effect");

  const controlColor = token("--text-muted");
  const outcomeColor = token("--series-1");
  const alertColor = token("--status-critical");

  // Negative controls first so outcomes of interest draw over them.
  const ordered = [...data].sort(
    (a, b) => Number(b.is_negative_control) - Number(a.is_negative_control),
  );

  f.plot
    .append("g")
    .selectAll("circle")
    .data(ordered)
    .join("circle")
    .attr("cx", (d) => x(d.log_rr as number))
    .attr("cy", (d) => y(d.se_log_rr as number))
    .attr("r", (d) => (d.is_negative_control ? 4 : 6))
    .attr("fill", (d) =>
      d.is_negative_control ? "none" : outsideEnvelope(d, nul) ? alertColor : outcomeColor,
    )
    .attr("fill-opacity", 0.85)
    .attr("stroke", (d) =>
      d.is_negative_control
        ? controlColor
        : token("--surface-1"),
    )
    // A 2px surface ring keeps overlapping marks readable.
    .attr("stroke-width", 2)
    .attr("cursor", onSelect ? "pointer" : "default")
    .on("mouseenter", function (event: MouseEvent, d) {
      d3.select(this).attr("stroke", token("--text-primary"));
      showTooltip(event, tooltipFor(d, nul));
    })
    .on("mousemove", moveTooltip)
    .on("mouseleave", function (_event, d) {
      d3.select(this).attr(
        "stroke",
        d.is_negative_control ? controlColor : token("--surface-1"),
      );
      hideTooltip();
    })
    .on("click", (_event, d) => onSelect?.(d));

  legend(container, [
    { label: "Outcome of interest", color: outcomeColor },
    { label: "Outcome of interest, outside null envelope", color: alertColor },
    { label: "Negative control (true HR = 1)", color: controlColor, hollow: true },
    ...(nul
      ? [{ label: "95% envelope of the fitted null", color: outcomeColor }]
      : []),
  ]);
}

function outsideEnvelope(row: EstimateRow, nul: Null | null): boolean {
  if (!nul || row.log_rr == null || row.se_log_rr == null) return false;
  const sd = Math.sqrt(nul.sd ** 2 + row.se_log_rr ** 2);
  return Math.abs(row.log_rr - nul.mean) > 1.96 * sd;
}

function tooltipFor(row: EstimateRow, nul: Null | null) {
  const rows: [string, string][] = [
    ["HR (95% CI)", fmtCi(row.rr, row.ci_95_lb, row.ci_95_ub)],
    ["Calibrated HR", fmtCi(row.cal_rr, row.cal_lb, row.cal_ub)],
    ["p", fmtP(row.p)],
    ["Calibrated p", fmtP(row.cal_p)],
    ["SE (log HR)", fmt(row.se_log_rr, 3)],
    ["Events (T / C)", `${fmtInt(row.target_outcomes)} / ${fmtInt(row.comparator_outcomes)}`],
  ];
  const footer = row.is_negative_control
    ? "Negative control — the true hazard ratio is 1, so any departure is systematic error."
    : nul
      ? outsideEnvelope(row, nul)
        ? "Outside the null envelope: not explained by this analysis' systematic error. Click for detail."
        : "Inside the null envelope: consistent with no effect once systematic error is allowed for. Click for detail."
      : "Click for detail.";
  return { title: row.outcome_name, rows, footer };
}

/** Two-sided p-value under the fitted null; used by the estimates table. */
export function nullP(nul: Null, logRr: number, seLogRr: number): number {
  const sd = Math.sqrt(nul.sd ** 2 + seLogRr ** 2);
  const z = (logRr - nul.mean) / sd;
  return 2 * Math.min(normalCdf(z), 1 - normalCdf(z));
}
