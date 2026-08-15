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

/** Parquet files under public/data, registered as views of the same name. */
const TABLES = [
  "cohort_method_result",
  "cohort_method_analysis",
  "exposure_of_interest",
  "outcome_of_interest",
  "negative_control_outcome",
  "database",
  "covariate",
  "covariate_analysis",
  "covariate_balance",
  "preference_score_dist",
  "kaplan_meier_dist",
  "attrition",
  "cm_follow_up_dist",
  "comparison_summary",
  "propensity_model",
  "exposure_summary",
] as const;

let connection: duckdb.AsyncDuckDBConnection | null = null;
let ready: Promise<duckdb.AsyncDuckDBConnection> | null = null;

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

  onProgress("Registering study results…");
  for (const table of TABLES) {
    const url = assetUrl(`data/${table}.parquet`);
    await db.registerFileURL(
      `${table}.parquet`,
      url,
      duckdb.DuckDBDataProtocol.HTTP,
      false,
    );
    await conn.query(
      `CREATE OR REPLACE VIEW ${table} AS
         SELECT * FROM read_parquet('${table}.parquet')`,
    );
  }

  connection = conn;
  return conn;
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
