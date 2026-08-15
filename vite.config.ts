import { defineConfig } from "vite";

// GitHub Pages project site: https://<owner>.github.io/<repo>/
// Override with BASE_PATH in CI so a rename of the repo does not break assets.
const base = process.env.BASE_PATH ?? "/test-wasm-app/";

export default defineConfig({
  base,
  worker: { format: "es" },
  build: {
    target: "es2022",
    // duckdb-wasm ships large .wasm bundles; don't warn on them.
    chunkSizeWarningLimit: 2000,
  },
  optimizeDeps: {
    // duckdb-wasm's worker bundles must not be pre-bundled.
    exclude: ["@duckdb/duckdb-wasm"],
  },
});
