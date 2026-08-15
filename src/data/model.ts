/**
 * Study data model: typed shapes plus the SQL that produces them.
 *
 * Everything the UI needs is expressed as a function from a `Selection` (the
 * current filter state) to rows. Charts never issue SQL themselves.
 */
import { query, queryOne, lit } from "./db";
import {
  fitNull,
  fitSystematicError,
  calibrateP,
  calibrateCi,
  coverage,
  expectedAbsoluteSystematicError,
  type Null,
  type SystematicErrorModel,
} from "./calibration";

export interface Selection {
  studyId: string;
  databaseId: string;
  targetId: number;
  comparatorId: number;
  analysisId: number;
}

export interface Study {
  study_id: string;
  study_name: string;
  n_estimates: number;
  n_databases: number;
  n_comparisons: number;
  n_analyses: number;
}

export interface EstimateRow {
  target_id: number;
  comparator_id: number;
  outcome_id: number;
  analysis_id: number;
  database_id: string;
  outcome_name: string;
  is_negative_control: boolean;
  rr: number | null;
  ci_95_lb: number | null;
  ci_95_ub: number | null;
  p: number | null;
  log_rr: number | null;
  se_log_rr: number | null;
  target_subjects: number | null;
  comparator_subjects: number | null;
  target_outcomes: number | null;
  comparator_outcomes: number | null;
  target_days: number | null;
  comparator_days: number | null;
  /** Filled in by `calibrate` below; null when calibration is not possible. */
  cal_rr: number | null;
  cal_lb: number | null;
  cal_ub: number | null;
  cal_p: number | null;
}

export interface Lookups {
  studies: Study[];
  databases: { database_id: string; database_name: string }[];
  exposures: { exposure_id: number; exposure_name: string }[];
  outcomes: { outcome_id: number; outcome_name: string }[];
  analyses: { analysis_id: number; description: string }[];
  comparisons: { target_id: number; comparator_id: number }[];
}

/** Short display label: strips the "[OHDSI Cov19] New users of " boilerplate. */
export function shortName(name: string): string {
  return name
    .replace(/^\[[^\]]*\]\s*/, "")
    .replace(/^New users of\s*/i, "")
    .replace(/\s*with prior rheumatoid arthritis$/i, "")
    .trim();
}

/** The study catalogue, loaded once at startup. */
export async function loadStudies(): Promise<Study[]> {
  return query<Study>(`SELECT * FROM study ORDER BY study_name`);
}

/**
 * Filter options for one study. Databases, comparisons, and analyses all differ
 * per study, so this is re-read whenever the study changes.
 */
export async function loadLookups(studyId: string): Promise<Lookups> {
  const scope = `study_id = ${lit(studyId)}`;
  const [studies, databases, exposures, outcomes, analyses, comparisons] =
    await Promise.all([
      loadStudies(),
      query<Lookups["databases"][number]>(
        `SELECT DISTINCT database_id,
                COALESCE(MAX(database_name), database_id) AS database_name
           FROM database WHERE ${scope}
          GROUP BY database_id ORDER BY database_id`,
      ),
      query<Lookups["exposures"][number]>(
        `SELECT exposure_id, MAX(exposure_name) AS exposure_name
           FROM exposure_of_interest WHERE ${scope}
          GROUP BY exposure_id ORDER BY 2`,
      ),
      query<Lookups["outcomes"][number]>(
        `SELECT outcome_id, MAX(outcome_name) AS outcome_name
           FROM outcome_of_interest WHERE ${scope}
          GROUP BY outcome_id ORDER BY 2`,
      ),
      query<Lookups["analyses"][number]>(
        `SELECT analysis_id, MAX(description) AS description
           FROM cohort_method_analysis WHERE ${scope}
          GROUP BY analysis_id ORDER BY analysis_id`,
      ),
      query<Lookups["comparisons"][number]>(
        `SELECT DISTINCT target_id, comparator_id FROM cohort_method_result
          WHERE ${scope} ORDER BY target_id, comparator_id`,
      ),
    ]);
  return { studies, databases, exposures, outcomes, analyses, comparisons };
}

/**
 * Scope for the per-study diagnostic tables, which carry no study_id column.
 * Pass an alias when the query joins another table, or the shared column names
 * are ambiguous.
 */
function where(s: Selection, alias = ""): string {
  const q = alias ? `${alias}.` : "";
  return `${q}database_id = ${lit(s.databaseId)}
      AND ${q}target_id = ${s.targetId}
      AND ${q}comparator_id = ${s.comparatorId}
      AND ${q}analysis_id = ${s.analysisId}`;
}

/** Scope for the stacked index tables, which do carry study_id. */
function whereIndexed(s: Selection, alias = ""): string {
  const q = alias ? `${alias}.` : "";
  return `${q}study_id = ${lit(s.studyId)} AND ${where(s, alias)}`;
}

/**
 * All estimates for one comparison, outcomes of interest and negative controls
 * alike, with calibrated values attached.
 */
export async function loadEstimates(s: Selection): Promise<EstimateRow[]> {
  const rows = await query<EstimateRow>(
    `SELECT r.*,
            COALESCE(o.outcome_name, n.outcome_name, 'Outcome ' || r.outcome_id)
              AS outcome_name,
            n.outcome_id IS NOT NULL AS is_negative_control
       FROM cohort_method_result r
       LEFT JOIN outcome_of_interest o
              ON o.outcome_id = r.outcome_id AND o.study_id = r.study_id
       LEFT JOIN negative_control_outcome n
              ON n.outcome_id = r.outcome_id AND n.study_id = r.study_id
      WHERE ${whereIndexed(s, "r")}`,
  );
  return calibrate(rows);
}

/** Estimates for one outcome across every database, for the drilldown. */
export async function loadOutcomeAcrossDatabases(
  s: Selection,
  outcomeId: number,
): Promise<EstimateRow[]> {
  const out: EstimateRow[] = [];
  const databases = await query<{ database_id: string }>(
    `SELECT DISTINCT database_id FROM cohort_method_result
      WHERE study_id = ${lit(s.studyId)} ORDER BY database_id`,
  );
  // Each loadEstimates call re-fits the calibration for the database it reads,
  // overwriting the fit the visible tab is describing. Restore it afterwards so
  // opening a drilldown cannot change the numbers behind the funnel plot.
  const saved = lastFit;
  try {
    for (const { database_id } of databases) {
      const rows = await loadEstimates({ ...s, databaseId: database_id });
      const hit = rows.find((r) => r.outcome_id === outcomeId);
      if (hit) out.push(hit);
    }
  } finally {
    lastFit = saved;
  }
  return out;
}

export interface CalibrationFit {
  null: Null | null;
  systematicError: SystematicErrorModel | null;
  /** 95% CI coverage of the negative controls; 0.95 is the target. */
  coverage: number | null;
  /** Expected absolute systematic error (EASE) on the log scale. */
  ease: number | null;
  nControls: number;
}

let lastFit: CalibrationFit = {
  null: null,
  systematicError: null,
  coverage: null,
  ease: null,
  nControls: 0,
};

/** The calibration fit produced by the most recent `calibrate` call. */
export function currentFit(): CalibrationFit {
  return lastFit;
}

/**
 * Fit the null and systematic-error models on this comparison's negative
 * controls and write calibrated values back onto every row.
 */
export function calibrate(rows: EstimateRow[]): EstimateRow[] {
  const controls = rows
    .filter(
      (r) =>
        r.is_negative_control &&
        r.log_rr != null &&
        r.se_log_rr != null &&
        r.se_log_rr > 0,
    )
    .map((r) => ({ logRr: r.log_rr as number, seLogRr: r.se_log_rr as number }));

  const nul = fitNull(controls);
  const sem = fitSystematicError(controls);
  lastFit = {
    null: nul,
    systematicError: sem,
    coverage: coverage(controls),
    ease: nul ? expectedAbsoluteSystematicError(nul) : null,
    nControls: controls.length,
  };

  for (const row of rows) {
    row.cal_rr = null;
    row.cal_lb = null;
    row.cal_ub = null;
    row.cal_p = null;
    if (row.log_rr == null || row.se_log_rr == null || row.se_log_rr <= 0) {
      continue;
    }
    const estimate = { logRr: row.log_rr, seLogRr: row.se_log_rr };
    if (nul) row.cal_p = calibrateP(nul, estimate);
    if (sem) {
      const c = calibrateCi(sem, estimate);
      row.cal_rr = c.rr;
      row.cal_lb = c.lb95;
      row.cal_ub = c.ub95;
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// diagnostics
// ---------------------------------------------------------------------------

export interface PreferenceScoreRow {
  preference_score: number;
  target_density: number;
  comparator_density: number;
}

export async function loadPreferenceScores(
  s: Selection,
): Promise<PreferenceScoreRow[]> {
  return query<PreferenceScoreRow>(
    `SELECT preference_score, target_density, comparator_density
       FROM preference_score_dist
      WHERE ${where(s)}
      ORDER BY preference_score`,
  );
}

export interface BalanceRow {
  covariate_id: number;
  covariate_name: string;
  std_diff_before: number | null;
  std_diff_after: number | null;
  target_mean_after: number | null;
  comparator_mean_after: number | null;
}

export async function loadBalance(s: Selection): Promise<BalanceRow[]> {
  return query<BalanceRow>(
    `SELECT b.covariate_id,
            COALESCE(c.covariate_name, 'Covariate ' || b.covariate_id)
              AS covariate_name,
            b.std_diff_before, b.std_diff_after,
            b.target_mean_after, b.comparator_mean_after
       FROM covariate_balance b
       LEFT JOIN covariate c USING (covariate_id)
      WHERE ${where(s, "b")}
        AND b.std_diff_before IS NOT NULL
        AND b.std_diff_after IS NOT NULL`,
  );
}

export interface KaplanMeierRow {
  time: number;
  target_survival: number | null;
  target_survival_lb: number | null;
  target_survival_ub: number | null;
  comparator_survival: number | null;
  comparator_survival_lb: number | null;
  comparator_survival_ub: number | null;
}

export async function loadKaplanMeier(
  s: Selection,
  outcomeId: number,
): Promise<KaplanMeierRow[]> {
  return query<KaplanMeierRow>(
    `SELECT time, target_survival, target_survival_lb, target_survival_ub,
            comparator_survival, comparator_survival_lb, comparator_survival_ub
       FROM kaplan_meier_dist
      WHERE ${where(s)} AND outcome_id = ${outcomeId}
      ORDER BY time`,
  );
}

export interface AttritionRow {
  sequence_number: number;
  description: string;
  subjects: number;
  exposure_id: number;
}

export async function loadAttrition(
  s: Selection,
  outcomeId: number,
): Promise<AttritionRow[]> {
  return query<AttritionRow>(
    `SELECT sequence_number, description, subjects, exposure_id
       FROM attrition
      WHERE ${where(s)} AND outcome_id = ${outcomeId}
      ORDER BY exposure_id, sequence_number`,
  );
}

export interface FollowUpRow {
  target_median_days: number;
  target_p25_days: number;
  target_p75_days: number;
  target_max_days: number;
  comparator_median_days: number;
  comparator_p25_days: number;
  comparator_p75_days: number;
  comparator_max_days: number;
}

export async function loadFollowUp(
  s: Selection,
  outcomeId: number,
): Promise<FollowUpRow | null> {
  return queryOne<FollowUpRow>(
    `SELECT * FROM cm_follow_up_dist
      WHERE ${where(s)} AND outcome_id = ${outcomeId} LIMIT 1`,
  );
}

/**
 * Diagnostic summary for one comparison, with a pass/warning/fail verdict per
 * check. Thresholds follow OHDSI convention: equipoise >= 0.1 of subjects in
 * the 0.3-0.7 preference-score band, all |SMD| <= 0.1 after matching,
 * EASE <= 0.25.
 */
export type Verdict = "pass" | "warn" | "fail" | "unknown";

export interface Diagnostic {
  id: string;
  label: string;
  value: string;
  verdict: Verdict;
  explanation: string;
}

export async function loadDiagnostics(s: Selection): Promise<Diagnostic[]> {
  const [ps, balance] = await Promise.all([
    loadPreferenceScores(s),
    loadBalance(s),
  ]);
  const fit = currentFit();

  const diagnostics: Diagnostic[] = [];

  // Equipoise: share of the (density-weighted) population in preference score
  // 0.3-0.7, where the two treatments are plausibly interchangeable.
  if (ps.length > 0) {
    const total = ps.reduce(
      (a, d) => a + d.target_density + d.comparator_density,
      0,
    );
    const inBand = ps
      .filter((d) => d.preference_score >= 0.3 && d.preference_score <= 0.7)
      .reduce((a, d) => a + d.target_density + d.comparator_density, 0);
    const equipoise = total > 0 ? inBand / total : 0;
    diagnostics.push({
      id: "equipoise",
      label: "Clinical equipoise",
      value: fmtPct(equipoise),
      verdict: equipoise >= 0.2 ? "pass" : equipoise >= 0.1 ? "warn" : "fail",
      explanation:
        "Share of the preference-score distribution between 0.3 and 0.7. " +
        "Low values mean the two treatments are given to different kinds of " +
        "patient, so no amount of adjustment makes them comparable.",
    });
  }

  if (balance.length > 0) {
    const maxAfter = Math.max(
      ...balance.map((b) => Math.abs(b.std_diff_after ?? 0)),
    );
    diagnostics.push({
      id: "balance",
      label: "Max covariate imbalance after PS",
      value: maxAfter.toFixed(3),
      verdict: maxAfter <= 0.1 ? "pass" : maxAfter <= 0.15 ? "warn" : "fail",
      explanation:
        `Largest absolute standardised mean difference across ` +
        `${balance.length.toLocaleString()} baseline covariates after ` +
        "propensity-score adjustment. Convention is that every covariate " +
        "should be at or below 0.1.",
    });
  }

  if (fit.ease != null) {
    diagnostics.push({
      id: "ease",
      label: "Expected absolute systematic error",
      value: fit.ease.toFixed(3),
      verdict: fit.ease <= 0.1 ? "pass" : fit.ease <= 0.25 ? "warn" : "fail",
      explanation:
        `Fitted on ${fit.nControls} negative controls, whose true hazard ` +
        "ratio is known to be 1. It measures how far the method's estimates " +
        "drift from the truth on this data, on the log scale.",
    });
  }

  if (fit.coverage != null) {
    diagnostics.push({
      id: "coverage",
      label: "Negative-control 95% CI coverage",
      value: fmtPct(fit.coverage),
      verdict:
        fit.coverage >= 0.9 ? "pass" : fit.coverage >= 0.8 ? "warn" : "fail",
      explanation:
        "Fraction of negative controls whose uncalibrated 95% interval " +
        "covers 1. A well-behaved analysis lands near 95%; lower means the " +
        "nominal intervals are too narrow and p-values too small.",
    });
  }

  const counts = await queryOne<{ n_estimable: number; n_total: number }>(
    `SELECT COUNT(*) FILTER (WHERE rr IS NOT NULL) AS n_estimable,
            COUNT(*) AS n_total
       FROM cohort_method_result WHERE ${whereIndexed(s)}`,
  );
  if (counts) {
    const frac = counts.n_total ? counts.n_estimable / counts.n_total : 0;
    diagnostics.push({
      id: "estimable",
      label: "Estimable outcomes",
      value: `${counts.n_estimable} / ${counts.n_total}`,
      verdict: frac >= 0.5 ? "pass" : frac >= 0.25 ? "warn" : "fail",
      explanation:
        "Outcomes with enough events to fit the outcome model. When most " +
        "outcomes are inestimable the calibration fit rests on few controls.",
    });
  }

  return diagnostics;
}

function fmtPct(x: number): string {
  return `${(100 * x).toFixed(1)}%`;
}
