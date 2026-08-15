/** The five tab views. Each renders into a container from already-loaded data. */
import {
  loadPreferenceScores,
  loadBalance,
  loadDiagnostics,
  currentFit,
  shortName,
  type EstimateRow,
  type Selection,
  type Lookups,
  type Diagnostic,
  type Verdict,
} from "../data/model";
import { query } from "../data/db";
import { renderFunnel } from "../charts/funnel";
import { renderForest } from "../charts/forest";
import {
  renderPreferenceScore,
  renderBalanceScatter,
} from "../charts/diagnostics";
import { renderTable, type Column } from "./table";
import { openDrawer } from "./drawer";
import { fmt, fmtP, fmtInt, fmtCi, escapeHtml } from "../charts/common";

export interface ViewContext {
  selection: Selection;
  lookups: Lookups;
  estimates: EstimateRow[];
  targetName: string;
  comparatorName: string;
}

const select = (root: HTMLElement, id: string) =>
  root.querySelector(`#${id}`) as HTMLElement;

function panel(title: string, hint: string, id: string): string {
  return `<div class="panel"><h2>${escapeHtml(title)}</h2>
    <p class="hint">${hint}</p><div id="${id}"></div></div>`;
}

const drill = (ctx: ViewContext) => (row: EstimateRow) =>
  void openDrawer(row, ctx.selection, ctx.lookups);

// --------------------------------------------------------------- 1. Overview

export async function renderOverview(
  root: HTMLElement,
  ctx: ViewContext,
): Promise<void> {
  const ofInterest = ctx.estimates.filter((e) => !e.is_negative_control);
  const estimable = ofInterest.filter((e) => e.rr != null);
  const fit = currentFit();

  root.innerHTML = `
    <div class="panel">
      <h2>${escapeHtml(shortName(ctx.targetName))} vs ${escapeHtml(
        shortName(ctx.comparatorName),
      )}</h2>
      <p class="hint">New users with prior rheumatoid arthritis in
        ${escapeHtml(ctx.selection.databaseId)}, propensity-score stratified.
        Every calibrated figure on this page is computed in your browser from
        this comparison's ${fit.nControls} negative controls.</p>
      <div class="tiles" id="ov-tiles"></div>
    </div>
    ${panel(
      "Diagnostics",
      "Whether this comparison can support a causal claim at all. Click any row to see the underlying chart.",
      "ov-diag",
    )}
    ${panel(
      "Outcomes of interest",
      "Uncalibrated and calibrated hazard ratios. Click a row for the full drilldown.",
      "ov-forest",
    )}`;

  const significant = estimable.filter(
    (e) => e.cal_p != null && e.cal_p < 0.05,
  ).length;

  select(root, "ov-tiles").innerHTML = [
    ["Outcomes of interest", `${estimable.length} / ${ofInterest.length}`, "estimable"],
    ["Negative controls", String(fit.nControls), "used for calibration"],
    [
      "Systematic error (EASE)",
      fit.ease != null ? fit.ease.toFixed(3) : "—",
      "0 would be unbiased",
    ],
    [
      "Calibrated p < 0.05",
      String(significant),
      "outcomes after calibration",
    ],
  ]
    .map(
      ([label, value, sub]) =>
        `<div class="tile"><div class="label">${escapeHtml(label)}</div>
         <div class="value">${escapeHtml(value)}</div>
         <div class="sub">${escapeHtml(sub)}</div></div>`,
    )
    .join("");

  const diagnostics = await loadDiagnostics(ctx.selection);
  renderDiagnosticList(select(root, "ov-diag"), diagnostics);

  renderForest(
    select(root, "ov-forest"),
    ofInterest.map((r) => ({
      label: shortName(r.outcome_name),
      rr: r.rr,
      lb: r.ci_95_lb,
      ub: r.ci_95_ub,
      p: r.p,
      calRr: r.cal_rr,
      calLb: r.cal_lb,
      calUb: r.cal_ub,
      calP: r.cal_p,
      datum: r,
    })),
    {
      labelWidth: 320,
      onSelect: (item) => drill(ctx)(item.datum as EstimateRow),
    },
  );
}

const VERDICT_ICON: Record<Verdict, string> = {
  pass: "●",
  warn: "▲",
  fail: "■",
  unknown: "○",
};

const VERDICT_WORD: Record<Verdict, string> = {
  pass: "Pass",
  warn: "Caution",
  fail: "Fail",
  unknown: "Unknown",
};

/**
 * Diagnostics as a list of pass/caution/fail rows. Each carries an icon and a
 * word as well as its color, and explains in plain language what the number
 * means and why it matters.
 */
function renderDiagnosticList(
  container: HTMLElement,
  diagnostics: Diagnostic[],
  onSelect?: (d: Diagnostic) => void,
): void {
  container.innerHTML = diagnostics
    .map(
      (d) => `
      <div class="diagnostic verdict-${d.verdict}" data-id="${d.id}">
        <div class="icon" aria-hidden="true">${VERDICT_ICON[d.verdict]}</div>
        <div>
          <div class="name">${escapeHtml(d.label)}</div>
          <div class="explanation">${escapeHtml(d.explanation)}</div>
        </div>
        <div>
          <div class="num">${escapeHtml(d.value)}</div>
          <span class="verdict-word">${VERDICT_WORD[d.verdict]}</span>
        </div>
      </div>`,
    )
    .join("");

  if (onSelect) {
    container.querySelectorAll(".diagnostic").forEach((el) => {
      el.addEventListener("click", () => {
        const id = (el as HTMLElement).dataset.id;
        const hit = diagnostics.find((d) => d.id === id);
        if (hit) onSelect(hit);
      });
    });
  }
}

// ----------------------------------------------------------- 2. Funnel plot

export function renderFunnelView(root: HTMLElement, ctx: ViewContext): void {
  const fit = currentFit();
  root.innerHTML = `
    ${panel(
      "Funnel plot — every effect estimate in this comparison",
      "Hazard ratio on the x axis, standard error on the y axis with the most " +
        "precise estimates at the top. The hollow marks are negative controls: " +
        "outcomes this exposure is known not to cause, so their true hazard " +
        "ratio is 1 and any spread away from 1 is the analysis' own error. The " +
        "shaded funnel is the 95% envelope of the null distribution fitted to " +
        "them. Hover any mark for its numbers; click an outcome of interest to " +
        "drill in.",
      "fn-plot",
    )}
    ${panel(
      "What the fitted null says",
      "These four numbers are the calibration model behind every calibrated " +
        "estimate in the app.",
      "fn-fit",
    )}
    ${panel(
      "Negative controls, sorted by how far they miss",
      "A well-behaved analysis puts these near a hazard ratio of 1. The worst " +
        "offenders here are the ones driving the systematic error.",
      "fn-controls",
    )}`;

  renderFunnel(select(root, "fn-plot"), ctx.estimates, {
    nul: fit.null,
    onSelect: (row) => {
      if (!row.is_negative_control) drill(ctx)(row);
    },
    height: 500,
  });

  select(root, "fn-fit").innerHTML = fit.null
    ? [
        [
          "Null mean (log HR)",
          fit.null.mean.toFixed(3),
          "systematic bias; 0 is unbiased",
        ],
        [
          "Null SD (log HR)",
          fit.null.sd.toFixed(3),
          "spread of the error between outcomes",
        ],
        [
          "EASE",
          fit.ease?.toFixed(3) ?? "—",
          "expected absolute systematic error",
        ],
        [
          "Control CI coverage",
          fit.coverage != null ? `${(100 * fit.coverage).toFixed(1)}%` : "—",
          "should be near 95%",
        ],
      ]
        .map(
          ([label, value, sub]) =>
            `<div class="tile"><div class="label">${escapeHtml(label)}</div>
             <div class="value">${escapeHtml(value)}</div>
             <div class="sub">${escapeHtml(sub)}</div></div>`,
        )
        .join("")
    : `<p class="muted">Too few estimable negative controls to fit a null
         distribution, so nothing in this comparison can be calibrated.</p>`;
  select(root, "fn-fit").className = fit.null ? "tiles" : "";

  const controls = ctx.estimates
    .filter((e) => e.is_negative_control && e.rr != null)
    .sort((a, b) => Math.abs(b.log_rr ?? 0) - Math.abs(a.log_rr ?? 0));

  renderTable(select(root, "fn-controls"), controls, estimateColumns(), {
    sortKey: "rr",
    maxHeight: 400,
    onSelect: drill(ctx),
  });
}

// ------------------------------------------------------- 3. Effect estimates

export function renderEstimatesView(root: HTMLElement, ctx: ViewContext): void {
  root.innerHTML = `
    ${panel(
      "All effect estimates",
      "Outcomes of interest and negative controls together. Sort any column; " +
        "click a row to open the drilldown for that estimate.",
      "es-table",
    )}`;

  renderTable(select(root, "es-table"), ctx.estimates, estimateColumns(true), {
    sortKey: "outcome",
    maxHeight: 620,
    onSelect: drill(ctx),
  });
}

function estimateColumns(withType = false): Column<EstimateRow>[] {
  const columns: Column<EstimateRow>[] = [
    {
      key: "outcome",
      label: "Outcome",
      value: (r) => shortName(r.outcome_name),
    },
  ];
  if (withType) {
    columns.push({
      key: "type",
      label: "Type",
      value: (r) => (r.is_negative_control ? "Negative control" : "Of interest"),
      render: (r) =>
        r.is_negative_control
          ? '<span class="chip">control</span>'
          : '<span class="chip">of interest</span>',
    });
  }
  return columns.concat([
    {
      key: "rr",
      label: "HR (95% CI)",
      value: (r) => r.rr,
      render: (r) => escapeHtml(fmtCi(r.rr, r.ci_95_lb, r.ci_95_ub)),
      numeric: true,
    },
    {
      key: "p",
      label: "p",
      value: (r) => r.p,
      render: (r) => fmtP(r.p),
      numeric: true,
    },
    {
      key: "calRr",
      label: "Calibrated HR (95% CI)",
      value: (r) => r.cal_rr,
      render: (r) => escapeHtml(fmtCi(r.cal_rr, r.cal_lb, r.cal_ub)),
      numeric: true,
      title: "Computed in-browser from this comparison's negative controls",
    },
    {
      key: "calP",
      label: "Calibrated p",
      value: (r) => r.cal_p,
      render: (r) => fmtP(r.cal_p),
      numeric: true,
    },
    {
      key: "se",
      label: "SE (log HR)",
      value: (r) => r.se_log_rr,
      render: (r) => fmt(r.se_log_rr, 3),
      numeric: true,
    },
    {
      key: "tOut",
      label: "Events T",
      value: (r) => r.target_outcomes,
      render: (r) => fmtInt(r.target_outcomes),
      numeric: true,
    },
    {
      key: "cOut",
      label: "Events C",
      value: (r) => r.comparator_outcomes,
      render: (r) => fmtInt(r.comparator_outcomes),
      numeric: true,
    },
  ]);
}

// ----------------------------------------------------------- 4. Diagnostics

export async function renderDiagnosticsView(
  root: HTMLElement,
  ctx: ViewContext,
): Promise<void> {
  root.innerHTML = `
    ${panel(
      "Study diagnostics",
      "Each check is scored against the OHDSI convention shown in its " +
        "explanation. A failing check invalidates the estimates below it — " +
        "read this tab before the effect estimates, not after.",
      "dg-list",
    )}
    <div class="grid-2">
      ${panel(
        "Propensity score overlap",
        "Where the two exposure groups fall on the preference score. Substantial " +
          "mass inside the shaded 0.3-0.7 band means patients could plausibly " +
          "have received either drug.",
        "dg-ps",
      )}
      ${panel(
        "Covariate balance",
        "Each point is one baseline covariate: its standardised difference " +
          "before adjustment against after. Hover for the covariate's name and " +
          "group means.",
        "dg-balance",
      )}
    </div>
    ${panel(
      "Covariates with the largest residual imbalance",
      "The covariates propensity-score adjustment left least well balanced.",
      "dg-worst",
    )}`;

  const [diagnostics, ps, balance] = await Promise.all([
    loadDiagnostics(ctx.selection),
    loadPreferenceScores(ctx.selection),
    loadBalance(ctx.selection),
  ]);

  renderDiagnosticList(select(root, "dg-list"), diagnostics, (d) => {
    const target =
      d.id === "equipoise"
        ? "dg-ps"
        : d.id === "balance"
          ? "dg-balance"
          : null;
    if (target) {
      select(root, target).scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });

  renderPreferenceScore(select(root, "dg-ps"), ps, {
    target: shortName(ctx.targetName),
    comparator: shortName(ctx.comparatorName),
  });

  renderBalanceScatter(select(root, "dg-balance"), balance);

  const worst = [...balance]
    .sort(
      (a, b) => Math.abs(b.std_diff_after ?? 0) - Math.abs(a.std_diff_after ?? 0),
    )
    .slice(0, 50);

  renderTable(
    select(root, "dg-worst"),
    worst,
    [
      { key: "name", label: "Covariate", value: (r) => r.covariate_name },
      {
        key: "before",
        label: "SMD before",
        value: (r) => r.std_diff_before,
        render: (r) => fmt(r.std_diff_before, 3),
        numeric: true,
      },
      {
        key: "after",
        label: "SMD after",
        value: (r) => r.std_diff_after,
        render: (r) => fmt(r.std_diff_after, 3),
        numeric: true,
      },
      {
        key: "tMean",
        label: "Target mean",
        value: (r) => r.target_mean_after,
        render: (r) => fmt(r.target_mean_after, 3),
        numeric: true,
      },
      {
        key: "cMean",
        label: "Comparator mean",
        value: (r) => r.comparator_mean_after,
        render: (r) => fmt(r.comparator_mean_after, 3),
        numeric: true,
      },
    ],
    { sortKey: "after", sortDescending: true, maxHeight: 420 },
  );
}

// ------------------------------------------------------------ 5. Definitions

export async function renderAboutView(
  root: HTMLElement,
  ctx: ViewContext,
): Promise<void> {
  root.innerHTML = `
    ${panel(
      "Study",
      "Effect estimates from the OHDSI COVID-19 study of IL-6 and JAK " +
        "inhibitors in patients with rheumatoid arthritis, comparing new users " +
        "of each drug against comparator DMARDs across three US claims " +
        "databases. Results are read straight from Parquet by DuckDB-WASM in " +
        "your browser; there is no server.",
      "ab-study",
    )}
    ${panel("Exposure cohorts", "", "ab-exposures")}
    ${panel("Outcomes of interest", "", "ab-outcomes")}
    ${panel("Analysis settings", "", "ab-analyses")}
    ${panel(
      "Databases",
      "Observation period covered by each database for this comparison.",
      "ab-databases",
    )}`;

  select(root, "ab-study").innerHTML = `
    <p class="muted small">Currently showing:
      <strong>${escapeHtml(ctx.targetName)}</strong> vs
      <strong>${escapeHtml(ctx.comparatorName)}</strong> in
      ${escapeHtml(ctx.selection.databaseId)}.</p>`;

  renderTable(
    select(root, "ab-exposures"),
    ctx.lookups.exposures,
    [
      { key: "id", label: "ID", value: (r) => r.exposure_id, numeric: true },
      { key: "name", label: "Cohort", value: (r) => r.exposure_name },
    ],
    { sortKey: "id" },
  );

  renderTable(
    select(root, "ab-outcomes"),
    ctx.lookups.outcomes,
    [
      { key: "id", label: "ID", value: (r) => r.outcome_id, numeric: true },
      { key: "name", label: "Outcome", value: (r) => r.outcome_name },
    ],
    { sortKey: "id", maxHeight: 380 },
  );

  renderTable(
    select(root, "ab-analyses"),
    ctx.lookups.analyses,
    [
      { key: "id", label: "ID", value: (r) => r.analysis_id, numeric: true },
      { key: "desc", label: "Description", value: (r) => r.description },
    ],
    { sortKey: "id" },
  );

  const periods = await query<{
    database_id: string;
    min_date: string;
    max_date: string;
  }>(
    `SELECT database_id, MIN(min_date) AS min_date, MAX(max_date) AS max_date
       FROM comparison_summary GROUP BY database_id ORDER BY database_id`,
  );

  renderTable(
    select(root, "ab-databases"),
    periods,
    [
      { key: "db", label: "Database", value: (r) => r.database_id },
      { key: "min", label: "From", value: (r) => String(r.min_date) },
      { key: "max", label: "To", value: (r) => String(r.max_date) },
    ],
    { sortKey: "db" },
  );
}
