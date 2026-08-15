/**
 * "Compare studies" tab: every comparison in every study on one pair of axes.
 *
 * The fits are expensive enough to be worth doing once, so the result is cached
 * for the session; switching studies only re-highlights.
 */
import {
  loadCrossStudy,
  type ComparisonSummary,
} from "../data/crossStudy";
import { shortName, type Selection, type Study } from "../data/model";
import { renderCrossStudyScatter } from "../charts/crossStudy";
import { renderTable } from "./table";
import { fmt, fmtInt, escapeHtml } from "../charts/common";

let cache: ComparisonSummary[] | null = null;
let inFlight: Promise<ComparisonSummary[]> | null = null;

export interface CompareOptions {
  studies: Study[];
  selection: Selection;
  /** Jump to a comparison in the other tabs. */
  onOpen: (target: Selection) => void;
}

export async function renderCompareView(
  root: HTMLElement,
  { studies, selection, onOpen }: CompareOptions,
): Promise<void> {
  root.innerHTML = `
    <div class="panel">
      <h2>Comparing ${studies.length} population-level estimation studies</h2>
      <p class="hint">Effect sizes are not comparable across studies — different
        drugs, outcomes, and populations. How much <em>systematic error</em> an
        analysis carries is, because every study measures it the same way: on its
        own negative controls, whose true hazard ratio is 1 everywhere. Each mark
        below is one comparison in one database; the fits run in a background
        worker.</p>
      <div id="cmp-progress" class="muted small"></div>
    </div>
    <div class="panel" id="cmp-scatter-panel" hidden>
      <h2>Systematic error vs interval coverage</h2>
      <p class="hint">A trustworthy comparison sits in the shaded top-left. Marks
        to the right carry bias; marks low down have confidence intervals too
        narrow for the error they carry. Hover for detail, click to open.</p>
      <div id="cmp-scatter"></div>
    </div>
    <div class="panel" id="cmp-studies-panel" hidden>
      <h2>Studies</h2>
      <p class="hint">Median systematic error across each study's comparisons.
        Click a row to switch to that study.</p>
      <div id="cmp-studies"></div>
    </div>
    <div class="panel" id="cmp-table-panel" hidden>
      <h2>All comparisons</h2>
      <p class="hint">Every comparison across every study, sortable. Click a row
        to open it.</p>
      <div id="cmp-table"></div>
    </div>`;

  const progress = root.querySelector("#cmp-progress") as HTMLElement;

  let rows: ComparisonSummary[];
  try {
    rows = await fetchOnce(studies, (fraction, note) => {
      progress.textContent = `${note} (${Math.round(100 * fraction)}%)`;
    });
  } catch (error) {
    progress.innerHTML = `<strong>Could not fit the cross-study comparison.</strong>
      <span class="small">${escapeHtml(String(error))}</span>`;
    return;
  }

  const fitted = rows.filter((r) => r.ease != null);
  progress.innerHTML =
    `${fitted.length.toLocaleString()} of ${rows.length.toLocaleString()} ` +
    `comparisons had enough negative controls to fit a null distribution.` +
    (rows.length > fitted.length
      ? ` The rest are omitted — with fewer than five estimable controls there is
         nothing to calibrate against.`
      : "");

  for (const id of ["cmp-scatter-panel", "cmp-studies-panel", "cmp-table-panel"]) {
    (root.querySelector(`#${id}`) as HTMLElement).hidden = false;
  }

  const open = (row: ComparisonSummary) =>
    onOpen({
      studyId: row.study_id,
      databaseId: row.database_id,
      targetId: row.target_id,
      comparatorId: row.comparator_id,
      analysisId: row.analysis_id,
    });

  renderCrossStudyScatter(
    root.querySelector("#cmp-scatter") as HTMLElement,
    rows,
    { focusStudyId: selection.studyId, onSelect: open, height: 460 },
  );

  renderStudyTable(
    root.querySelector("#cmp-studies") as HTMLElement,
    studies,
    rows,
    selection.studyId,
    (studyId) => {
      const first = rows.find((r) => r.study_id === studyId);
      if (first) open(first);
    },
  );

  renderTable(
    root.querySelector("#cmp-table") as HTMLElement,
    rows,
    [
      { key: "study", label: "Study", value: (r) => r.study_name },
      {
        key: "comparison",
        label: "Comparison",
        value: (r) =>
          `${shortName(r.target_name)} vs ${shortName(r.comparator_name)}`,
      },
      { key: "db", label: "Database", value: (r) => r.database_id },
      {
        key: "analysis",
        label: "Analysis",
        value: (r) => r.analysis_id,
        numeric: true,
      },
      {
        key: "ease",
        label: "EASE",
        value: (r) => r.ease,
        render: (r) => fmt(r.ease, 3),
        numeric: true,
        title: "Expected absolute systematic error; lower is better",
      },
      {
        key: "coverage",
        label: "Control coverage",
        value: (r) => r.coverage,
        render: (r) =>
          r.coverage == null ? "—" : `${(100 * r.coverage).toFixed(1)}%`,
        numeric: true,
        title: "Should be near 95%",
      },
      {
        key: "controls",
        label: "Controls",
        value: (r) => r.n_controls,
        render: (r) => fmtInt(r.n_controls),
        numeric: true,
      },
      {
        key: "outcomes",
        label: "Outcomes",
        value: (r) => r.n_outcomes,
        render: (r) => fmtInt(r.n_outcomes),
        numeric: true,
      },
    ],
    { sortKey: "ease", maxHeight: 560, onSelect: open },
  );
}

function renderStudyTable(
  container: HTMLElement,
  studies: Study[],
  rows: ComparisonSummary[],
  focusStudyId: string,
  onSelect: (studyId: string) => void,
): void {
  const summaries = studies.map((study) => {
    const mine = rows.filter((r) => r.study_id === study.study_id);
    const eases = mine
      .map((r) => r.ease)
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b);
    const coverages = mine
      .map((r) => r.coverage)
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b);
    return {
      ...study,
      is_focus: study.study_id === focusStudyId,
      n_fitted: eases.length,
      median_ease: median(eases),
      median_coverage: median(coverages),
    };
  });

  renderTable(
    container,
    summaries,
    [
      {
        key: "name",
        label: "Study",
        value: (r) => r.study_name,
        render: (r) =>
          escapeHtml(r.study_name) +
          (r.is_focus ? ' <span class="chip">selected</span>' : ""),
      },
      {
        key: "estimates",
        label: "Estimates",
        value: (r) => r.n_estimates,
        render: (r) => fmtInt(r.n_estimates),
        numeric: true,
      },
      {
        key: "databases",
        label: "Databases",
        value: (r) => r.n_databases,
        numeric: true,
      },
      {
        key: "comparisons",
        label: "Comparisons",
        value: (r) => r.n_comparisons,
        numeric: true,
      },
      {
        key: "fitted",
        label: "Calibratable",
        value: (r) => r.n_fitted,
        numeric: true,
        title: "Comparison-database-analysis groups with enough negative controls",
      },
      {
        key: "ease",
        label: "Median EASE",
        value: (r) => r.median_ease,
        render: (r) => fmt(r.median_ease, 3),
        numeric: true,
      },
      {
        key: "coverage",
        label: "Median coverage",
        value: (r) => r.median_coverage,
        render: (r) =>
          r.median_coverage == null
            ? "—"
            : `${(100 * r.median_coverage).toFixed(1)}%`,
        numeric: true,
      },
    ],
    { sortKey: "ease", onSelect: (r) => onSelect(r.study_id) },
  );
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** One fit per session, shared by every visit to the tab. */
function fetchOnce(
  studies: Study[],
  onProgress: (fraction: number, note: string) => void,
): Promise<ComparisonSummary[]> {
  if (cache) return Promise.resolve(cache);
  inFlight ??= loadCrossStudy(studies, onProgress).then((rows) => {
    cache = rows;
    inFlight = null;
    return rows;
  });
  return inFlight;
}
