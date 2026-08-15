/**
 * App shell: boots DuckDB-WASM, owns the filter state, and swaps tab views.
 *
 * Filter state lives in the URL hash so any view of the data is a shareable
 * link and the back button works.
 */
import "./styles.css";
import { initDb } from "./data/db";
import {
  loadLookups,
  loadEstimates,
  shortName,
  type Lookups,
  type Selection,
} from "./data/model";
import {
  renderOverview,
  renderFunnelView,
  renderEstimatesView,
  renderDiagnosticsView,
  renderAboutView,
  type ViewContext,
} from "./components/views";
import { closeDrawer } from "./components/drawer";
import { escapeHtml, hideTooltip } from "./charts/common";

const TABS = [
  { id: "overview", label: "Overview", render: renderOverview },
  { id: "funnel", label: "Funnel plot", render: renderFunnelView },
  { id: "estimates", label: "Effect estimates", render: renderEstimatesView },
  { id: "diagnostics", label: "Diagnostics", render: renderDiagnosticsView },
  { id: "about", label: "Definitions", render: renderAboutView },
] as const;

type TabId = (typeof TABS)[number]["id"];

interface AppState extends Selection {
  tab: TabId;
}

let lookups: Lookups;
let state: AppState;

const app = document.getElementById("app") as HTMLElement;

async function boot(): Promise<void> {
  const status = (message: string) => {
    app.innerHTML = `<div class="loading">${escapeHtml(message)}</div>`;
  };

  status("Starting…");
  await initDb(status);
  status("Loading study metadata…");
  lookups = await loadLookups();

  state = { ...defaultState(), ...parseHash() };
  renderShell();
  window.addEventListener("hashchange", () => {
    const next = { ...state, ...parseHash() };
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    closeDrawer();
    syncControls();
    void renderTab();
  });
  await renderTab();
}

function defaultState(): AppState {
  const first = lookups.comparisons[0];
  return {
    tab: "overview",
    databaseId: lookups.databases[0]?.database_id ?? "CCAE",
    targetId: first?.target_id ?? 0,
    comparatorId: first?.comparator_id ?? 0,
    analysisId: lookups.analyses[0]?.analysis_id ?? 1,
  };
}

// ------------------------------------------------------------- URL state

function parseHash(): Partial<AppState> {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const out: Partial<AppState> = {};
  const tab = params.get("tab");
  if (tab && TABS.some((t) => t.id === tab)) out.tab = tab as TabId;
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

function writeHash(): void {
  const params = new URLSearchParams({
    tab: state.tab,
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
      <h1>IL-6 &amp; JAK inhibitors in rheumatoid arthritis — evidence explorer</h1>
      <p>Comparative safety and effectiveness estimates from the OHDSI
        <code>Covid19EstimationIl6JakInhibitors</code> study, with negative-control
        calibration computed in the browser. Pick a comparison, then read the
        diagnostics before the estimates.</p>
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
        `Exposure ${id}`,
    );

  filters.innerHTML = `
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
              a.description,
            )}</option>`,
        )
        .join("")}</select>
    </div>`;

  const db = document.getElementById("f-db") as HTMLSelectElement;
  const comparison = document.getElementById("f-comparison") as HTMLSelectElement;
  const analysis = document.getElementById("f-analysis") as HTMLSelectElement;

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
  const db = document.getElementById("f-db") as HTMLSelectElement | null;
  const comparison = document.getElementById(
    "f-comparison",
  ) as HTMLSelectElement | null;
  const analysis = document.getElementById(
    "f-analysis",
  ) as HTMLSelectElement | null;
  if (db) db.value = state.databaseId;
  if (comparison) comparison.value = `${state.targetId}:${state.comparatorId}`;
  if (analysis) analysis.value = String(state.analysisId);
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
  view.innerHTML = `<div class="loading">Querying results…</div>`;

  const selection: Selection = {
    databaseId: state.databaseId,
    targetId: state.targetId,
    comparatorId: state.comparatorId,
    analysisId: state.analysisId,
  };

  const estimates = await loadEstimates(selection);
  if (token !== renderToken) return;

  const name = (id: number) =>
    lookups.exposures.find((e) => e.exposure_id === id)?.exposure_name ??
    `Exposure ${id}`;

  const ctx: ViewContext = {
    selection,
    lookups,
    estimates,
    targetName: name(state.targetId),
    comparatorName: name(state.comparatorId),
  };

  const tab = TABS.find((t) => t.id === state.tab) ?? TABS[0];
  await tab.render(view, ctx);
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
