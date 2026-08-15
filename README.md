# IL-6 & JAK inhibitors in RA — evidence explorer

A static, browser-only explorer for the OHDSI `Covid19EstimationIl6JakInhibitors`
study: comparative safety and effectiveness estimates for new users of
tocilizumab, sarilumab, and baricitinib against comparator DMARDs in patients
with rheumatoid arthritis, across three US claims databases.

There is no backend. DuckDB-WASM reads Parquet directly over HTTP, and the
empirical calibration is computed in the browser.

**Deployed at:** https://ablack3.github.io/test-wasm-app/

## What it shows

Five tabs, all responding to the database / comparison / analysis filters at the
top. Filter state lives in the URL hash, so any view is a shareable link.

| Tab | Contents |
|---|---|
| **Overview** | Headline counts, the diagnostic verdicts, and a forest plot of all outcomes of interest |
| **Funnel plot** | Every estimate in the comparison — HR on x, standard error on y — with the fitted null envelope. The centrepiece. |
| **Effect estimates** | Sortable table of all outcomes and negative controls, calibrated and uncalibrated |
| **Diagnostics** | Preference-score overlap, covariate balance, and the worst residual imbalances |
| **Definitions** | Cohort, outcome, analysis, and database metadata |

Clicking any estimate — in the funnel plot, a forest plot, or a table — opens a
drilldown with the effect across all three databases, the Kaplan-Meier curve,
follow-up distribution, and cohort attrition.

### The funnel plot

Hazard ratio on a log x axis against the standard error of the log hazard ratio
on an inverted y axis, so the most precise estimates sit at the top.

Hollow marks are the **negative controls**: outcomes the exposure is known not to
cause, whose true hazard ratio is therefore 1. Any spread away from 1 is the
analysis' own error, not a real effect. The shaded funnel is the 95% envelope of
the null distribution fitted to them, and outcomes of interest falling outside it
are highlighted — those are the estimates not explained by this analysis'
systematic error.

### Calibration is computed, not read

The study's exported results carry `calibrated_rr = NA` throughout, so every
calibrated figure in this app is fitted client-side in
[`src/data/calibration.ts`](src/data/calibration.ts), a port of the core of the
OHDSI `EmpiricalCalibration` R package:

- **Null distribution** — `logRr_i ~ N(mu, sigma² + se_i²)` by maximum
  likelihood over the negative controls, giving calibrated p-values.
- **Systematic error model** — mean and SD allowed to grow with the standard
  error, giving calibrated confidence intervals.
- **EASE** — expected absolute systematic error, and negative-control CI
  coverage, both reported as diagnostics.

Optimisation is Nelder-Mead, dependency-free. The fit was verified against an
independent grid-search MLE in R: for CCAE tocilizumab-vs-sulfasalazine the app
and R agree to four decimals (μ = 0.0071, σ = 0.0000, negLL = 35.1008).

## Local development

```bash
npm install
npm run dev
```

Then open the printed URL. The dev server serves `public/data/*.parquet`
directly, so no data step is needed for day-to-day work.

Other commands:

```bash
npm test
```

```bash
npm run build
```

```bash
npm run preview
```

### Testing the production artifact

The dev server hides base-path and WASM-loading bugs. To exercise what Pages
actually serves, build and serve `dist` under the repository path:

```bash
npm run build && mkdir -p /tmp/pages && cp -R dist /tmp/pages/test-wasm-app && npx http-server /tmp/pages -p 4178 -c-1
```

Then visit `http://localhost:4178/test-wasm-app/`.

## Data preparation

Source data is the OHDSI study's Shiny result set: one `.rds` per (table,
database) under
`~/Desktop/ohdsi-study-results/Covid19EstimationIl6JakInhibitors/data`.
[`data-prep/convert.R`](data-prep/convert.R) converts it to zstd Parquet:

```bash
npm run data
```

or, for a different source or destination:

```bash
Rscript data-prep/convert.R <source-dir> <out-dir>
```

Requires R with `arrow` and `dplyr`. The generated Parquet files are **committed**
under `public/data`, so CI needs no R toolchain.

Two things the conversion does that matter:

- **Deduplicates covariate balance.** The source writes one balance row per
  outcome, but balance depends only on target/comparator/analysis. Keeping one
  copy takes the download from ~100 MB to 4.3 MB.
- **Repairs string encoding.** Some concept names carry latin-1 bytes (the "ö" in
  *Henoch-Schönlein purpura*). R writes those into Parquet as invalid UTF-8, and
  DuckDB then refuses to read the file at all. Every character column is
  re-encoded on the way in.

Total shipped data: **7.9 MB** across 16 tables.

## Deployment

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) runs on every push
to `main`: install → test → verify data present → build → verify `dist` →
publish to Pages.

Enable Pages once, under **Settings → Pages → Build and deployment → Source:
GitHub Actions**.

The Vite `base` comes from the `BASE_PATH` environment variable, which the
workflow sets from the repository name, so renaming the repo does not break asset
paths. Locally it defaults to `/test-wasm-app/`. To change it, edit
[`vite.config.ts`](vite.config.ts).

### Notes on the WASM bundles

DuckDB's `mvp` and `eh` bundles are self-hosted through Vite rather than pulled
from jsDelivr, so the deployed page makes no third-party requests. Only one is
downloaded per visitor — `eh` on any current browser. The threaded `coi` bundle
is deliberately excluded: it requires COOP/COEP response headers, which GitHub
Pages cannot set.

The `.wasm` files make the built site large on disk (~74 MB) but the transfer is
one gzipped bundle of roughly 10 MB, cached thereafter.

## Layout

```text
data-prep/convert.R        RDS -> Parquet (run offline, output committed)
public/data/*.parquet      study results, queried in place by DuckDB
src/data/db.ts             DuckDB-WASM setup, Parquet views, query helpers
src/data/calibration.ts    empirical calibration (null + systematic error MLE)
src/data/model.ts          typed study model and all SQL
src/charts/                funnel, forest, PS density, balance, Kaplan-Meier
src/components/            tabs, sortable table, drilldown drawer
tests/                     calibration unit tests
```

Charts never issue SQL; `model.ts` is the only place queries live.

## Caveats

- This is a **demonstration app** built on one archived OHDSI study result set,
  not a validated clinical decision tool.
- Several comparisons fail their covariate-balance diagnostic. That is a genuine
  property of the underlying study, and the app is deliberately built to surface
  it rather than hide it — read the Diagnostics tab before the estimates.
- Everything shipped to Pages is public. The study results are already public
  aggregate data; do not add patient-level data to `public/`.
