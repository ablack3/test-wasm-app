/**
 * Cross-study scatter: systematic error against negative-control coverage, one
 * mark per (study, database, comparison, analysis).
 *
 * A comparison belongs in the top-left: little systematic error, and intervals
 * that cover the truth about 95% of the time. Marks drifting right carry bias;
 * marks falling low have intervals too narrow for the error they carry.
 *
 * Colour marks only two ways — the study in focus versus everything else —
 * because 23 studies cannot be given 23 distinguishable hues. Identity comes
 * from the axes, the tooltip, and the highlight, never from a cycled palette.
 */
import * as d3 from "d3";
import type { ComparisonSummary } from "../data/crossStudy";
import {
  frame,
  xAxis,
  yAxis,
  legend,
  showTooltip,
  moveTooltip,
  hideTooltip,
  fmt,
  token,
  onResize,
  type Margin,
} from "./common";

const MARGIN: Margin = { top: 16, right: 20, bottom: 46, left: 62 };

export interface CrossStudyOptions {
  /** Comparisons from this study are drawn in the highlight colour. */
  focusStudyId?: string;
  onSelect?: (row: ComparisonSummary) => void;
  height?: number;
}

export function renderCrossStudyScatter(
  container: HTMLElement,
  rows: ComparisonSummary[],
  options: CrossStudyOptions = {},
): void {
  const draw = () => drawScatter(container, rows, options);
  draw();
  onResize(container, draw);
}

function drawScatter(
  container: HTMLElement,
  rows: ComparisonSummary[],
  { focusStudyId, onSelect, height = 440 }: CrossStudyOptions,
): void {
  const data = rows.filter((r) => r.ease != null && r.coverage != null);
  const f = frame(container, height, MARGIN);

  if (data.length === 0) {
    f.plot
      .append("text")
      .attr("class", "tick-label")
      .attr("x", f.width / 2)
      .attr("y", f.height / 2)
      .attr("text-anchor", "middle")
      .text("No comparison has enough negative controls to fit a null.");
    return;
  }

  const maxEase = Math.max(
    0.3,
    Math.min(1.5, d3.max(data, (d) => d.ease as number) as number),
  );
  const x = d3.scaleLinear().domain([0, maxEase]).range([0, f.width]).clamp(true);
  const y = d3.scaleLinear().domain([0, 1]).range([f.height, 0]);

  // The region a well-behaved analysis should land in: EASE <= 0.25 and
  // coverage >= 0.9.
  f.plot
    .append("rect")
    .attr("x", x(0))
    .attr("width", x(Math.min(0.25, maxEase)) - x(0))
    .attr("y", y(1))
    .attr("height", y(0.9) - y(1))
    .attr("fill", token("--status-good"))
    .attr("fill-opacity", 0.1);

  // 0.95 is deliberately not a tick: the dashed nominal line already labels it,
  // and its label collides with 100% at this height.
  yAxis(f, y, "Negative-control 95% CI coverage", [0, 0.25, 0.5, 0.75, 1], (v) =>
    `${(100 * v).toFixed(0)}%`,
  );
  xAxis(f, x, "Expected absolute systematic error (EASE)", undefined, (v) =>
    v.toFixed(2),
  );

  // Nominal coverage.
  f.plot
    .append("line")
    .attr("class", "ref-line")
    .attr("x1", 0)
    .attr("x2", f.width)
    .attr("y1", y(0.95))
    .attr("y2", y(0.95));
  f.plot
    .append("text")
    .attr("class", "tick-label")
    .attr("x", f.width - 4)
    .attr("y", y(0.95) - 5)
    .attr("text-anchor", "end")
    .text("nominal 95%");

  const other = token("--text-muted");
  const focus = token("--series-1");

  // Draw the focus study last so it sits on top.
  const ordered = [...data].sort(
    (a, b) =>
      Number(a.study_id === focusStudyId) - Number(b.study_id === focusStudyId),
  );

  f.plot
    .append("g")
    .selectAll("circle")
    .data(ordered)
    .join("circle")
    .attr("cx", (d) => x(d.ease as number))
    .attr("cy", (d) => y(d.coverage as number))
    .attr("r", (d) => (d.study_id === focusStudyId ? 5 : 3))
    .attr("fill", (d) => (d.study_id === focusStudyId ? focus : other))
    .attr("fill-opacity", (d) => (d.study_id === focusStudyId ? 0.9 : 0.4))
    .attr("stroke", token("--surface-1"))
    .attr("stroke-width", (d) => (d.study_id === focusStudyId ? 2 : 0))
    .attr("cursor", onSelect ? "pointer" : "default")
    .on("mouseenter", function (event: MouseEvent, d) {
      d3.select(this).attr("stroke", token("--text-primary")).attr("stroke-width", 2);
      showTooltip(event, {
        title: `${d.target_name} vs ${d.comparator_name}`,
        rows: [
          ["Study", d.study_name],
          ["Database", d.database_id],
          ["EASE", fmt(d.ease, 3)],
          [
            "Control coverage",
            d.coverage == null ? "—" : `${(100 * d.coverage).toFixed(1)}%`,
          ],
          ["Negative controls", String(d.n_controls)],
          ["Outcomes of interest", String(d.n_outcomes)],
        ],
        footer: "Click to open this comparison.",
      });
    })
    .on("mousemove", moveTooltip)
    .on("mouseleave", function (_event, d) {
      d3.select(this)
        .attr("stroke", token("--surface-1"))
        .attr("stroke-width", d.study_id === focusStudyId ? 2 : 0);
      hideTooltip();
    })
    .on("click", (_event, d) => onSelect?.(d));

  legend(container, [
    ...(focusStudyId
      ? [{ label: "Selected study", color: focus }]
      : []),
    { label: "All other comparisons", color: other },
    { label: "Target region (EASE ≤ 0.25, coverage ≥ 90%)", color: token("--status-good") },
  ]);
}
