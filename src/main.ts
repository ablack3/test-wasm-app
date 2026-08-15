/**
 * App shell: boots DuckDB-WASM, owns the filter state, and swaps tab views.
 *
 * Filter state lives in the URL hash so any view of the data is a shareable
 * link and the back button works.
 */
import "./styles.css";
import { initDb, useStudy } from "./data/db";
import {
  loadLookups,
  loadStudies,
  loadEstimates,
  shortName,
  type Lookups,
  type Selection,
  type Study,
} from "./data/model";
import {
  renderOverview,
  renderFunnelView,
  renderEstimatesView,
  renderDiagnosticsView,
  renderAboutView,
  type ViewContext,
} from "./components/views";
import { renderCompareView } from "./components/compare";
import { closeDrawer } from "./components/drawer";
import { escapeHtml, hideTooltip } from "./charts/common";

/**
 * "compare" is cross-study and needs only the study catalogue; every other tab
 * renders one selected comparison and needs the full context.
 */
const TABS = [
  { id: "compare", label: "Compare studies", scope: "cross" },
  { id: "overview", label: "Overview", scope: "study" },
  { id: "funnel", label: "Funnel plot", scope: "study" },
  { id: "estimates", label: "Effect estimates", scope: "study" },
  { id: "diagnostics", label: "Diagnostics", scope: "study" },
  { id: "about", label: "Definitions", scope: "study" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const STUDY_VIEWS: Record<
  Exclude<TabId, "compare">,
  (root: HTMLElement, ctx: ViewContext) => void | Promise<void>
> = {
  overview: renderOverview,
  funnel: renderFunnelView,
  estimates: renderEstimatesView,
  diagnostics: renderDiagnosticsView,
  about: renderAboutView,
};

interface AppState extends Selection {
  tab: TabId;
}

let studies: Study[];
let lookups: Lookups;
let state: AppState;

const app = document.getElementById("app") as HTMLElement;

async function boot(): Promise<void> {
  const status = (message: string) => {
    app.innerHTML = `<div class="loading">${escapeHtml(message)}</div>`;
  };

  status("Starting…");
  await initDb(status);

  status("Loading study catalogue…");
  studies = await loadStudies();
  if (studies.length === 0) throw new Error("No studies found in the catalogue.");

  // The study has to be resolved before lookups, since every other filter
  // option depends on it.
  const studyId = studyFromHash() ?? defaultStudyId();
  await selectStudy(studyId);

  state = { ...defaultState(studyId), ...parseHash() };
  renderShell();

  window.addEventListener("hashchange", () => {
    void onHashChange();
  });
  await renderTab();
}

/** Default to the study this app was originally built around, if present. */
function defaultStudyId(): string {
  const preferred = "Covid19EstimationIl6JakInhibitors";
  return studies.some((s) => s.study_id === preferred)
    ? preferred
    : studies[0].study_id;
}

function defaultState(studyId: string): AppState {
  const first = lookups.comparisons[0];
  return {
    tab: "overview",
    studyId,
    databaseId: lookups.databases[0]?.database_id ?? "",
    targetId: first?.target_id ?? 0,
    comparatorId: first?.comparator_id ?? 0,
    analysisId: lookups.analyses[0]?.analysis_id ?? 1,
  };
}

/** Register the study's tables and reload its filter options. */
async function selectStudy(studyId: string): Promise<void> {
  await useStudy(studyId);
  lookups = await loadLookups(studyId);
}

/**
 * Move to a comparison that may belong to another study, re-registering tables
 * and repairing any filter value the new study does not have.
 */
export async function goTo(target: Selection, tab?: TabId): Promise<void> {
  if (target.studyId !== state.studyId) await selectStudy(target.studyId);
  state = { ...state, ...target, tab: tab ?? state.tab };
  reconcile();
  renderFilters();
  await renderTab();
}

/** Clamp the selection onto options the current study actually has. */
function reconcile(): void {
  if (!lookups.databases.some((d) => d.database_id === state.databaseId)) {
    state.databaseId = lookups.databases[0]?.database_id ?? "";
  }
  if (
    !lookups.comparisons.some(
      (c) =>
        c.target_id === state.targetId && c.comparator_id === state.comparatorId,
    )
  ) {
    const first = lookups.comparisons[0];
    state.targetId = first?.target_id ?? 0;
    state.comparatorId = first?.comparator_id ?? 0;
  }
  if (!lookups.analyses.some((a) => a.analysis_id === state.analysisId)) {
    state.analysisId = lookups.analyses[0]?.analysis_id ?? 1;
  }
}

// ------------------------------------------------------------- URL state

function hashParams(): URLSearchParams {
  return new URLSearchParams(location.hash.replace(/^#/, ""));
}

function studyFromHash(): string | null {
  const id = hashParams().get("study");
  return id && studies.some((s) => s.study_id === id) ? id : null;
}

function parseHash(): Partial<AppState> {
  const params = hashParams();
  const out: Partial<AppState> = {};

  const tab = params.get("tab");
  if (tab && TABS.some((t) => t.id === tab)) out.tab = tab as TabId;

  const study = params.get("study");
  if (study && studies.some((s) => s.study_id === study)) out.studyId = study;

  const db = params.get("db");
  if (db && lookups.databases.some((d) => d.database_id === db)) {
    out.databaseId = db;
  }

  const target = Number(params.get("t"));
  const comparator = Number(params.get("c"));
  if (
    lookups.comparisons.some(
      (x) => x.target_id === target && x.comparator_id === comparator,
    )
  ) {
    out.targetId = target;
    out.comparatorId = comparator;
  }

  const analysis = Number(params.get("a"));
  if (lookups.analyses.some((a) => a.analysis_id === analysis)) {
    out.analysisId = analysis;
  }
  return out;
}

async function onHashChange(): Promise<void> {
  const study = studyFromHash();
  if (study && study !== state.studyId) {
    await selectStudy(study);
    state.studyId = study;
    renderFilters();
  }
  const next = { ...state, ...parseHash() };
  if (JSON.stringify(next) === JSON.stringify(state)) return;
  state = next;
  closeDrawer();
  syncControls();
  await renderTab();
}

function writeHash(): void {
  const params = new URLSearchParams({
    tab: state.tab,
    study: state.studyId,
    db: state.databaseId,
    t: String(state.targetId),
    c: String(state.comparatorId),
    a: String(state.analysisId),
  });
  const next = `#${params}`;
  if (location.hash !== next) history.replaceState(null, "", next);
}

// ---------------------------------------------------------------- shell

function renderShell(): void {
  app.innerHTML = `
    <header class="app">
      <h1>OHDSI population-level estimation — evidence explorer</h1>
      <p>Comparative effect estimates from ${studies.length} OHDSI studies, read
        straight from Parquet by DuckDB-WASM in your browser with no server.
        Negative-control calibration is computed here, live. Pick a study and a
        comparison, read the diagnostics before the estimates — or use
        <strong>Compare studies</strong> to see how much systematic error each
        analysis carries.</p>
    </header>
    <div class="filters" id="filters"></div>
    <nav class="tabs" role="tablist" id="tabs"></nav>
    <main id="view"><div class="loading">Loading…</div></main>`;

  renderFilters();
  renderTabs();
}

function renderFilters(): void {
  const filters = document.getElementById("filters") as HTMLElement;
  const exposureLabel = (id: number) =>
    shortName(
      lookups.exposures.find((e) => e.exposure_id === id)?.exposure_name ??
        `Cohort ${id}`,
    );

  filters.innerHTML = `
    <div class="filter">
      <label for="f-study">Study</label>
      <select id="f-study">${studies
        .map(
          (s) =>
            `<option value="${escapeHtml(s.study_id)}">${escapeHtml(
              s.study_name,
            )}</option>`,
        )
        .join("")}</select>
    </div>
    <div class="filter">
      <label for="f-db">Database</label>
      <select id="f-db">${lookups.databases
        .map(
          (d) =>
            `<option value="${escapeHtml(d.database_id)}">${escapeHtml(
              d.database_name,
            )}</option>`,
        )
        .join("")}</select>
    </div>
    <div class="filter">
      <label for="f-comparison">Comparison (target vs comparator)</label>
      <select id="f-comparison">${lookups.comparisons
        .map(
          (c) =>
            `<option value="${c.target_id}:${c.comparator_id}">${escapeHtml(
              `${exposureLabel(c.target_id)} vs ${exposureLabel(c.comparator_id)}`,
            )}</option>`,
        )
        .join("")}</select>
    </div>
    <div class="filter">
      <label for="f-analysis">Analysis</label>
      <select id="f-analysis">${lookups.analyses
        .map(
          (a) =>
            `<option value="${a.analysis_id}">${escapeHtml(
              a.description ?? `Analysis ${a.analysis_id}`,
            )}</option>`,
        )
        .join("")}</select>
    </div>`;

  const study = document.getElementById("f-study") as HTMLSelectElement;
  const db = document.getElementById("f-db") as HTMLSelectElement;
  const comparison = document.getElementById("f-comparison") as HTMLSelectElement;
  const analysis = document.getElementById("f-analysis") as HTMLSelectElement;

  study.addEventListener("change", () => {
    void (async () => {
      const view = document.getElementById("view") as HTMLElement;
      view.innerHTML = `<div class="loading">Loading study…</div>`;
      await selectStudy(study.value);
      state.studyId = study.value;
      reconcile();
      renderFilters();
      await renderTab();
    })();
  });
  db.addEventListener("change", () => {
    state.databaseId = db.value;
    void renderTab();
  });
  comparison.addEventListener("change", () => {
    const [t, c] = comparison.value.split(":").map(Number);
    state.targetId = t;
    state.comparatorId = c;
    void renderTab();
  });
  analysis.addEventListener("change", () => {
    state.analysisId = Number(analysis.value);
    void renderTab();
  });

  syncControls();
}

function syncControls(): void {
  const set = (id: string, value: string) => {
    const el = document.getElementById(id) as HTMLSelectElement | null;
    if (el) el.value = value;
  };
  set("f-study", state.studyId);
  set("f-db", state.databaseId);
  set("f-comparison", `${state.targetId}:${state.comparatorId}`);
  set("f-analysis", String(state.analysisId));
  renderTabs();
}

function renderTabs(): void {
  const tabs = document.getElementById("tabs") as HTMLElement;
  tabs.innerHTML = TABS.map(
    (t) =>
      `<button role="tab" data-tab="${t.id}" aria-selected="${
        t.id === state.tab
      }">${t.label}</button>`,
  ).join("");
  tabs.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      state.tab = (button as HTMLElement).dataset.tab as TabId;
      void renderTab();
    });
  });
}

// ------------------------------------------------------------------ views

/** Guards against an out-of-order render when filters change mid-query. */
let renderToken = 0;

async function renderTab(): Promise<void> {
  const token = ++renderToken;
  writeHash();
  syncControls();
  hideTooltip();

  const view = document.getElementById("view") as HTMLElement;
  const selection: Selection = {
    studyId: state.studyId,
    databaseId: state.databaseId,
    targetId: state.targetId,
    comparatorId: state.comparatorId,
    analysisId: state.analysisId,
  };

  if (state.tab === "compare") {
    view.innerHTML = `<div class="loading">Preparing cross-study comparison…</div>`;
    await renderCompareView(view, {
      studies,
      selection,
      onOpen: (target) => void goTo(target, "overview"),
    });
    return;
  }

  view.innerHTML = `<div class="loading">Querying results…</div>`;
  const estimates = await loadEstimates(selection);
  if (token !== renderToken) return;

  const name = (id: number) =>
    lookups.exposures.find((e) => e.exposure_id === id)?.exposure_name ??
    `Cohort ${id}`;

  const ctx: ViewContext = {
    selection,
    lookups,
    estimates,
    studyName:
      studies.find((s) => s.study_id === state.studyId)?.study_name ??
      state.studyId,
    targetName: name(state.targetId),
    comparatorName: name(state.comparatorId),
  };

  await STUDY_VIEWS[state.tab](view, ctx);
}

boot().catch((error: unknown) => {
  console.error(error);
  app.innerHTML = `<div class="loading">
    <strong>Could not load the study results.</strong>
    <p class="small">${escapeHtml(String(error))}</p>
    <p class="small">If this is the deployed site, check that the Parquet files
      under <code>data/</code> resolve beneath the configured base path.</p>
  </div>`;
});
