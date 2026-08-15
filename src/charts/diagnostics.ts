/**
 * Diagnostic charts: preference-score overlap, covariate balance before vs
 * after adjustment, and Kaplan-Meier survival.
 */
import * as d3 from "d3";
import type {
  PreferenceScoreRow,
  BalanceRow,
  KaplanMeierRow,
} from "../data/model";
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

/**
 * Preference-score distributions for the two exposure groups. Overlap in the
 * middle of the range is what makes the comparison credible; two separated
 * humps mean the treatments go to different patients.
 */
export function renderPreferenceScore(
  container: HTMLElement,
  rows: PreferenceScoreRow[],
  labels: { target: string; comparator: string },
): void {
  const draw = () => {
    const margin: Margin = { top: 14, right: 18, bottom: 46, left: 56 };
    const f = frame(container, 300, margin);
    if (rows.length === 0) {
      empty(f, "No preference-score distribution for this comparison.");
      return;
    }

    const x = d3.scaleLinear().domain([0, 1]).range([0, f.width]);
    const maxDensity = d3.max(rows, (d) =>
      Math.max(d.target_density, d.comparator_density),
    ) as number;
    const y = d3.scaleLinear().domain([0, maxDensity * 1.05]).range([f.height, 0]);

    yAxis(f, y, "Density", undefined, (v) => v.toFixed(1));
    // Ticks are the equipoise bounds plus the ends; 0.25/0.75 would collide
    // with 0.3/0.7 at this width.
    xAxis(f, x, "Preference score", [0, 0.3, 0.5, 0.7, 1], (v) => v.toFixed(2));

    // The 0.3-0.7 equipoise band.
    f.plot
      .append("rect")
      .attr("x", x(0.3))
      .attr("width", x(0.7) - x(0.3))
      .attr("y", 0)
      .attr("height", f.height)
      .attr("fill", token("--text-muted"))
      .attr("fill-opacity", 0.09);
    f.plot
      .append("text")
      .attr("class", "tick-label")
      .attr("x", x(0.5))
      .attr("y", 11)
      .attr("text-anchor", "middle")
      .text("equipoise");

    const series: [string, string, (d: PreferenceScoreRow) => number][] = [
      [labels.target, token("--series-1"), (d) => d.target_density],
      [labels.comparator, token("--series-2"), (d) => d.comparator_density],
    ];

    for (const [, color, accessor] of series) {
      const area = d3
        .area<PreferenceScoreRow>()
        .x((d) => x(d.preference_score))
        .y0(f.height)
        .y1((d) => y(accessor(d)))
        .curve(d3.curveMonotoneX);
      f.plot
        .append("path")
        .attr("d", area(rows) ?? "")
        .attr("fill", color)
        .attr("fill-opacity", 0.22);

      const line = d3
        .line<PreferenceScoreRow>()
        .x((d) => x(d.preference_score))
        .y((d) => y(accessor(d)))
        .curve(d3.curveMonotoneX);
      f.plot
        .append("path")
        .attr("d", line(rows) ?? "")
        .attr("fill", "none")
        .attr("stroke", color)
        .attr("stroke-width", 2);
    }

    crosshair(f, rows, x, (d) => d.preference_score, (d) => ({
      title: `Preference score ${d.preference_score.toFixed(2)}`,
      rows: [
        [labels.target, fmt(d.target_density, 3)],
        [labels.comparator, fmt(d.comparator_density, 3)],
      ] as [string, string][],
    }));

    legend(container, [
      { label: labels.target, color: token("--series-1") },
      { label: labels.comparator, color: token("--series-2") },
    ]);
  };
  draw();
  onResize(container, draw);
}

/**
 * Covariate balance: standardised mean difference before adjustment (x) vs
 * after (y). Points should collapse toward the horizontal 0 line; the shaded
 * band is the conventional |SMD| <= 0.1 tolerance.
 */
export function renderBalanceScatter(
  container: HTMLElement,
  rows: BalanceRow[],
): void {
  const draw = () => {
    const margin: Margin = { top: 14, right: 18, bottom: 46, left: 62 };
    const f = frame(container, 340, margin);
    if (rows.length === 0) {
      empty(f, "No covariate balance data for this comparison.");
      return;
    }

    const limit = Math.max(
      0.2,
      d3.max(rows, (d) =>
        Math.max(Math.abs(d.std_diff_before ?? 0), Math.abs(d.std_diff_after ?? 0)),
      ) as number,
    );
    const x = d3.scaleLinear().domain([-limit, limit]).range([0, f.width]);
    const y = d3.scaleLinear().domain([-limit, limit]).range([f.height, 0]);

    yAxis(f, y, "SMD after PS adjustment", undefined, (v) => v.toFixed(2));
    xAxis(f, x, "SMD before PS adjustment", undefined, (v) => v.toFixed(2));

    // |SMD| <= 0.1 tolerance band on the "after" axis.
    f.plot
      .append("rect")
      .attr("x", 0)
      .attr("width", f.width)
      .attr("y", y(0.1))
      .attr("height", Math.abs(y(-0.1) - y(0.1)))
      .attr("fill", token("--status-good"))
      .attr("fill-opacity", 0.08);

    f.plot
      .append("line")
      .attr("class", "ref-line")
      .attr("x1", 0)
      .attr("x2", f.width)
      .attr("y1", y(0))
      .attr("y2", y(0));

    const overTolerance = token("--status-critical");
    const within = token("--series-1");

    f.plot
      .append("g")
      .selectAll("circle")
      .data(rows)
      .join("circle")
      .attr("cx", (d) => x(d.std_diff_before ?? 0))
      .attr("cy", (d) => y(d.std_diff_after ?? 0))
      .attr("r", 3)
      .attr("fill", (d) =>
        Math.abs(d.std_diff_after ?? 0) > 0.1 ? overTolerance : within,
      )
      .attr("fill-opacity", 0.55)
      .on("mouseenter", (event: MouseEvent, d) =>
        showTooltip(event, {
          title: d.covariate_name,
          rows: [
            ["SMD before", fmt(d.std_diff_before, 3)],
            ["SMD after", fmt(d.std_diff_after, 3)],
            ["Target mean after", fmt(d.target_mean_after, 3)],
            ["Comparator mean after", fmt(d.comparator_mean_after, 3)],
          ],
          footer:
            Math.abs(d.std_diff_after ?? 0) > 0.1
              ? "Above the 0.1 tolerance: residual imbalance on this covariate."
              : "Within the 0.1 tolerance.",
        }),
      )
      .on("mousemove", moveTooltip)
      .on("mouseleave", hideTooltip);

    legend(container, [
      { label: "|SMD| after ≤ 0.1 (balanced)", color: within },
      { label: "|SMD| after > 0.1 (residual imbalance)", color: overTolerance },
    ]);
  };
  draw();
  onResize(container, draw);
}

/** Kaplan-Meier survival curves for the two exposure groups. */
export function renderKaplanMeier(
  container: HTMLElement,
  rows: KaplanMeierRow[],
  labels: { target: string; comparator: string },
): void {
  const draw = () => {
    const margin: Margin = { top: 14, right: 18, bottom: 46, left: 62 };
    const f = frame(container, 300, margin);
    const data = rows.filter(
      (d) => d.target_survival != null && d.comparator_survival != null,
    );
    if (data.length === 0) {
      empty(f, "No Kaplan-Meier curve available for this outcome.");
      return;
    }

    const x = d3
      .scaleLinear()
      .domain([0, d3.max(data, (d) => d.time) as number])
      .range([0, f.width]);
    const minSurvival = d3.min(data, (d) =>
      Math.min(d.target_survival_lb ?? 1, d.comparator_survival_lb ?? 1),
    ) as number;
    const y = d3
      .scaleLinear()
      .domain([Math.max(0, minSurvival - 0.02), 1])
      .range([f.height, 0]);

    yAxis(f, y, "Survival free of outcome", undefined, (v) =>
      `${(100 * v).toFixed(0)}%`,
    );
    xAxis(f, x, "Days since exposure start", undefined, (v) => String(Math.round(v)));

    const series: [
      string,
      string,
      (d: KaplanMeierRow) => number | null,
      (d: KaplanMeierRow) => number | null,
      (d: KaplanMeierRow) => number | null,
    ][] = [
      [
        labels.target,
        token("--series-1"),
        (d) => d.target_survival,
        (d) => d.target_survival_lb,
        (d) => d.target_survival_ub,
      ],
      [
        labels.comparator,
        token("--series-2"),
        (d) => d.comparator_survival,
        (d) => d.comparator_survival_lb,
        (d) => d.comparator_survival_ub,
      ],
    ];

    for (const [, color, mid, lb, ub] of series) {
      const band = d3
        .area<KaplanMeierRow>()
        .x((d) => x(d.time))
        .y0((d) => y(lb(d) ?? (mid(d) as number)))
        .y1((d) => y(ub(d) ?? (mid(d) as number)))
        .curve(d3.curveStepAfter);
      f.plot
        .append("path")
        .attr("d", band(data) ?? "")
        .attr("fill", color)
        .attr("fill-opacity", 0.16);

      const line = d3
        .line<KaplanMeierRow>()
        .x((d) => x(d.time))
        .y((d) => y(mid(d) as number))
        .curve(d3.curveStepAfter);
      f.plot
        .append("path")
        .attr("d", line(data) ?? "")
        .attr("fill", "none")
        .attr("stroke", color)
        .attr("stroke-width", 2);
    }

    crosshair(f, data, x, (d) => d.time, (d) => ({
      title: `Day ${Math.round(d.time)}`,
      rows: [
        [labels.target, pct(d.target_survival)],
        [labels.comparator, pct(d.comparator_survival)],
      ] as [string, string][],
    }));

    legend(container, [
      { label: labels.target, color: token("--series-1") },
      { label: labels.comparator, color: token("--series-2") },
    ]);
  };
  draw();
  onResize(container, draw);
}

// ------------------------------------------------------------------ shared

function pct(v: number | null): string {
  return v == null ? "—" : `${(100 * v).toFixed(1)}%`;
}

function empty(
  f: ReturnType<typeof frame>,
  message: string,
): void {
  f.plot
    .append("text")
    .attr("class", "tick-label")
    .attr("x", f.width / 2)
    .attr("y", f.height / 2)
    .attr("text-anchor", "middle")
    .text(message);
}

/** Vertical crosshair that snaps to the nearest datum along x. */
function crosshair<T>(
  f: ReturnType<typeof frame>,
  data: T[],
  x: d3.ScaleContinuousNumeric<number, number>,
  xValue: (d: T) => number,
  content: (d: T) => { title: string; rows: [string, string][] },
): void {
  const rule = f.plot
    .append("line")
    .attr("class", "ref-line")
    .attr("y1", 0)
    .attr("y2", f.height)
    .attr("opacity", 0);

  const bisect = d3.bisector(xValue).center;

  f.plot
    .append("rect")
    .attr("width", f.width)
    .attr("height", f.height)
    .attr("fill", "transparent")
    .on("mousemove", (event: MouseEvent) => {
      const [mx] = d3.pointer(event);
      const value = x.invert(mx);
      const d = data[bisect(data, value)];
      if (!d) return;
      rule.attr("opacity", 1).attr("x1", x(xValue(d))).attr("x2", x(xValue(d)));
      showTooltip(event, content(d));
    })
    .on("mouseleave", () => {
      rule.attr("opacity", 0);
      hideTooltip();
    });
}
