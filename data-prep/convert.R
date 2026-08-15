# Convert the OHDSI CohortMethod RDS results shipped with the
# Covid19EstimationIl6JakInhibitors study (IL-6 / JAK inhibitors in RA) into a
# small set of Parquet files that DuckDB-WASM can read directly in the browser.
#
#   Rscript data-prep/convert.R [source-dir] [out-dir]
#
# Source layout is one RDS per (table, database), e.g. data/cohort_method_result_CCAE.rds
# and per-comparison tables suffixed t<targetId>_c<comparatorId>.

suppressPackageStartupMessages({
  library(arrow)
  library(dplyr)
})

args <- commandArgs(trailingOnly = TRUE)
srcDir <- if (length(args) >= 1) args[[1]] else
  "~/Desktop/ohdsi-study-results/Covid19EstimationIl6JakInhibitors/data"
outDir <- if (length(args) >= 2) args[[2]] else "public/data"

srcDir <- path.expand(srcDir)
dir.create(outDir, recursive = TRUE, showWarnings = FALSE)

files <- list.files(srcDir, pattern = "\\.rds$", full.names = TRUE)
stopifnot(length(files) > 0)

# "cohort_method_result_CCAE.rds"                -> table "cohort_method_result"
# "covariate_balance_t29_c28_Open Claims.rds"    -> table "covariate_balance"
databases <- c("CCAE", "Optum", "Open Claims")
tableOf <- function(path) {
  stem <- sub("\\.rds$", "", basename(path))
  for (db in databases) stem <- sub(paste0("_", db, "$"), "", stem)
  sub("_t(NA|\\d+)_c(NA|\\d+)$", "", stem)
}

# Some concept names in the source carry latin-1 bytes (e.g. the "ö" in
# "Henoch-Schönlein purpura"). R will happily write those into Parquet as
# invalid UTF-8, and DuckDB then refuses to read the file at all, so repair
# every character column on the way in.
toUtf8 <- function(x) {
  for (cl in names(x)) {
    if (!is.character(x[[cl]])) next
    bad <- !is.na(x[[cl]]) & !validUTF8(x[[cl]])
    if (any(bad)) {
      x[[cl]][bad] <- iconv(x[[cl]][bad], from = "latin1", to = "UTF-8",
                            sub = "?")
    }
    Encoding(x[[cl]]) <- "UTF-8"
  }
  x
}

readOne <- function(path) {
  x <- as.data.frame(readRDS(path))
  attr(x, "spec") <- NULL          # readr col_spec attribute, not needed
  attr(x, "problems") <- NULL
  toUtf8(x)
}

# Bind rows across databases/comparisons, tolerating columns that are all-NA
# logical in one file and numeric in another (readr guessed per-file).
bindLoose <- function(dfs) {
  cols <- unique(unlist(lapply(dfs, names)))
  numericCols <- cols[vapply(cols, function(cl) {
    any(vapply(dfs, function(d) cl %in% names(d) && is.numeric(d[[cl]]), logical(1)))
  }, logical(1))]
  dfs <- lapply(dfs, function(d) {
    for (cl in setdiff(cols, names(d))) d[[cl]] <- NA
    for (cl in intersect(numericCols, names(d))) d[[cl]] <- as.numeric(d[[cl]])
    d[cols]
  })
  do.call(rbind, dfs)
}

byTable <- split(files, vapply(files, tableOf, character(1)))

message(sprintf("Converting %d tables from %s", length(byTable), srcDir))

written <- list()
for (tbl in names(byTable)) {
  df <- bindLoose(lapply(byTable[[tbl]], readOne))

  # Covariate balance is emitted once per outcome but is identical across
  # outcomes for a given target/comparator/analysis: keep one copy. This is the
  # difference between a ~100 MB and a ~5 MB download.
  if (tbl == "covariate_balance") {
    df <- df %>%
      filter(!is.na(std_diff_before) | !is.na(std_diff_after)) %>%
      group_by(database_id, target_id, comparator_id, analysis_id, covariate_id) %>%
      slice(1) %>%
      ungroup() %>%
      select(-outcome_id, -interaction_covariate_id)
  }

  # Cohort/analysis definitions are large JSON blobs nobody filters on; the app
  # shows names only.
  if (tbl %in% c("exposure_of_interest", "outcome_of_interest", "cohort_method_analysis")) {
    df <- df %>% select(-any_of("definition")) %>% distinct()
  }
  if (tbl %in% c("covariate_analysis", "negative_control_outcome", "database")) {
    df <- distinct(df)
  }

  # The covariate name lookup is repeated per database; one copy is enough.
  if (tbl == "covariate") {
    df <- df %>%
      select(covariate_id, covariate_name, covariate_analysis_id) %>%
      distinct(covariate_id, .keep_all = TRUE)
  }

  path <- file.path(outDir, paste0(tbl, ".parquet"))
  write_parquet(df, path, compression = "zstd")
  written[[tbl]] <- nrow(df)
  message(sprintf("  %-28s %8d rows  %6.1f MB", tbl, nrow(df),
                  file.size(path) / 1024^2))
}

message(sprintf("Total: %.1f MB in %s",
                sum(file.size(list.files(outDir, "\\.parquet$", full.names = TRUE))) / 1024^2,
                outDir))
