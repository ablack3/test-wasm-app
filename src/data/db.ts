/**
 * DuckDB-WASM setup and query helpers.
 *
 * All Parquet files are registered as views over the deployed static assets, so
 * DuckDB fetches only the row groups a query touches rather than the whole
 * file. Callers see plain row objects; Arrow stays inside this module.
 */
import * as duckdb from "@duckdb/duckdb-wasm";

// Self-hosted DuckDB bundles. Vite rewrites these to fingerprinted URLs under
// the configured base path, so the app makes no third-party requests at
// runtime. The `coi` (threaded) bundle is deliberately omitted: it requires
// COOP/COEP response headers, which GitHub Pages cannot set.
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";

const BUNDLES: duckdb.DuckDBBundles = {
  mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
  eh: { mainModule: ehWasm, mainWorker: ehWorker },
};

export type Row = Record<string, unknown>;

/**
 * Small tables stacked across every study and keyed by `study_id`. Registered
 * at startup; they drive the filters, the funnel plot, and calibration.
 */
const INDEX_TABLES = [
  "study",
  "cohort_method_result",
  "cohort_method_analysis",
  "exposure_of_interest",
  "outcome_of_interest",
  "negative_control_outcome",
  "database",
  "comparison_summary",
] as const;

/**
 * Large tables written per study. Registered only when a study is selected, so
 * opening the app does not pull the diagnostics for all 23 studies.
 */
const STUDY_TABLES = [
  "covariate",
  "covariate_analysis",
  "covariate_balance",
  "preference_score_dist",
  "kaplan_meier_dist",
  "attrition",
  "cm_follow_up_dist",
] as const;

let connection: duckdb.AsyncDuckDBConnection | null = null;
let database: duckdb.AsyncDuckDB | null = null;
let ready: Promise<duckdb.AsyncDuckDBConnection> | null = null;
let registeredStudy: string | null = null;

/** Absolute URL for an asset, honouring the GitHub Pages base path. */
export function assetUrl(path: string): string {
  return new URL(path, new URL(import.meta.env.BASE_URL, location.href)).href;
}

async function connect(
  onProgress: (message: string) => void,
): Promise<duckdb.AsyncDuckDBConnection> {
  onProgress("Loading DuckDB-WASM…");
  // Picks `eh` where exception handling is supported, `mvp` otherwise.
  const bundle = await duckdb.selectBundle(BUNDLES);

  const worker = new Worker(bundle.mainWorker!);
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);

  const conn = await db.connect();

  onProgress("Registering study catalogue…");
  for (const table of INDEX_TABLES) {
    await registerView(db, conn, table, `data/index/${table}.parquet`);
  }

  connection = conn;
  database = db;
  return conn;
}

/**
 * Point a view at a Parquet file served over HTTP. DuckDB issues range
 * requests, so only the row groups a query touches are fetched.
 */
async function registerView(
  db: duckdb.AsyncDuckDB,
  conn: duckdb.AsyncDuckDBConnection,
  view: string,
  path: string,
): Promise<void> {
  const handle = path.replace(/\//g, "_");
  await db.registerFileURL(
    handle,
    assetUrl(path),
    duckdb.DuckDBDataProtocol.HTTP,
    false,
  );
  await conn.query(
    `CREATE OR REPLACE VIEW ${view} AS SELECT * FROM read_parquet('${handle}')`,
  );
}

/**
 * Make one study's per-study diagnostic tables queryable under their plain
 * names. Cheap and idempotent: registering a view does not fetch anything.
 *
 * A study that shipped no rows for a given table gets an empty view with the
 * right columns, so callers never have to special-case a missing table.
 */
export async function useStudy(studyId: string): Promise<void> {
  const conn = connection ?? (await initDb());
  if (registeredStudy === studyId) return;
  const db = database;
  if (!db) throw new Error("DuckDB is not initialised");

  const present = new Set(await studyTables(studyId));
  for (const table of STUDY_TABLES) {
    if (present.has(table)) {
      await registerView(db, conn, table, `data/${studyId}/${table}.parquet`);
    } else {
      await conn.query(`CREATE OR REPLACE VIEW ${table} AS ${emptyView(table)}`);
    }
  }
  registeredStudy = studyId;
}

/** Which per-study tables a study actually shipped, from the manifest. */
let manifest: Record<string, string[]> | null = null;

async function studyTables(studyId: string): Promise<string[]> {
  if (!manifest) {
    const response = await fetch(assetUrl("data/manifest.json"));
    manifest = (await response.json()) as Record<string, string[]>;
  }
  return manifest[studyId] ?? [];
}

/**
 * Column stubs so a query against a table a study never shipped returns no
 * rows instead of raising. Only the columns the app selects are declared.
 */
const EMPTY_COLUMNS: Record<string, Record<string, string>> = {
  covariate: {
    covariate_id: "INTEGER",
    covariate_name: "VARCHAR",
    covariate_analysis_id: "INTEGER",
  },
  covariate_analysis: {
    covariate_analysis_id: "INTEGER",
    covariate_analysis_name: "VARCHAR",
    analysis_id: "INTEGER",
  },
  covariate_balance: {
    database_id: "VARCHAR",
    target_id: "INTEGER",
    comparator_id: "INTEGER",
    analysis_id: "INTEGER",
    covariate_id: "INTEGER",
    std_diff_before: "DOUBLE",
    target_mean_after: "DOUBLE",
    comparator_mean_after: "DOUBLE",
    std_diff_after: "DOUBLE",
  },
  preference_score_dist: {
    database_id: "VARCHAR",
    target_id: "INTEGER",
    comparator_id: "INTEGER",
    analysis_id: "INTEGER",
    preference_score: "DOUBLE",
    target_density: "DOUBLE",
    comparator_density: "DOUBLE",
  },
  kaplan_meier_dist: {
    database_id: "VARCHAR",
    target_id: "INTEGER",
    comparator_id: "INTEGER",
    outcome_id: "INTEGER",
    analysis_id: "INTEGER",
    time: "DOUBLE",
    target_survival: "DOUBLE",
    target_survival_lb: "DOUBLE",
    target_survival_ub: "DOUBLE",
    comparator_survival: "DOUBLE",
    comparator_survival_lb: "DOUBLE",
    comparator_survival_ub: "DOUBLE",
  },
  attrition: {
    database_id: "VARCHAR",
    exposure_id: "INTEGER",
    target_id: "INTEGER",
    comparator_id: "INTEGER",
    outcome_id: "INTEGER",
    analysis_id: "INTEGER",
    sequence_number: "INTEGER",
    description: "VARCHAR",
    subjects: "INTEGER",
  },
  cm_follow_up_dist: {
    database_id: "VARCHAR",
    target_id: "INTEGER",
    comparator_id: "INTEGER",
    outcome_id: "INTEGER",
    analysis_id: "INTEGER",
    target_p25_days: "DOUBLE",
    target_median_days: "DOUBLE",
    target_p75_days: "DOUBLE",
    target_max_days: "DOUBLE",
    comparator_p25_days: "DOUBLE",
    comparator_median_days: "DOUBLE",
    comparator_p75_days: "DOUBLE",
    comparator_max_days: "DOUBLE",
  },
};

function emptyView(table: string): string {
  const columns = Object.entries(EMPTY_COLUMNS[table] ?? {})
    .map(([name, type]) => `CAST(NULL AS ${type}) AS ${name}`)
    .join(", ");
  return `SELECT ${columns} WHERE FALSE`;
}

export function initDb(
  onProgress: (message: string) => void = () => {},
): Promise<duckdb.AsyncDuckDBConnection> {
  ready ??= connect(onProgress);
  return ready;
}

/** Run a query and return rows as plain objects with JS-native values. */
export async function query<T = Row>(sql: string): Promise<T[]> {
  const conn = connection ?? (await initDb());
  const table = await conn.query(sql);
  return table.toArray().map((row) => normalize(row.toJSON())) as T[];
}

/** Convenience wrapper for queries known to return one row. */
export async function queryOne<T = Row>(sql: string): Promise<T | null> {
  const rows = await query<T>(sql);
  return rows[0] ?? null;
}

/**
 * Arrow returns BigInt for 64-bit integers and its own scalar wrappers; the
 * charts and tables want ordinary numbers, strings, and nulls.
 */
function normalize(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "bigint") out[key] = Number(value);
    else if (value === undefined) out[key] = null;
    else out[key] = value;
  }
  return out;
}

/** Escape a string literal for inline use in SQL. */
export function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
