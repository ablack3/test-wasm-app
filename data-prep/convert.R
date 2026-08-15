# Convert OHDSI population-level-estimation study results (the "EvidenceExplorer"
# Shiny result sets) into Parquet files that DuckDB-WASM can read in the browser.
#
#   Rscript data-prep/convert.R [results-root] [out-dir]
#
# Each study ships one RDS per (table, database), e.g.
# cohort_method_result_CCAE.rds, plus per-comparison files suffixed
# t<targetId>_c<comparatorId>. Database suffixes are arbitrary across studies
# ("CCAE", "DA Germany", "VA-OMOP", "TruvenCCAE"), so tables are identified by
# matching the filename against a known list of table names as a prefix, longest
# match first, rather than by trying to strip the suffix.
#
# Output layout:
#   <out>/index/<table>.parquet   small tables, all studies stacked, keyed by study_id
#   <out>/<study>/<table>.parquet large per-study tables, loaded on demand
#   <out>/index/study.parquet     the study catalogue

suppressPackageStartupMessages({
  library(arrow)
  library(dplyr)
})

args <- commandArgs(trailingOnly = TRUE)
root <- path.expand(if (length(args) >= 1) args[[1]] else
  "~/Desktop/ohdsi-study-results")
outDir <- if (length(args) >= 2) args[[2]] else "public/data"

# Studies carrying CohortMethod effect estimates in the standard schema.
# Deliberately excluded, with reasons:
#   AceBeta9Outcomes, Sglt2iDka, SystematicEvidence  bespoke per-analysis file
#     formats (auc_/psDensity_, est_/km_/bal_, est_<drug>_<drug>) that share no
#     schema with the rest.
#   GLP1Generalizability, UveitisSafetyEstimation    ship diagnostics only, with
#     no effect-estimate table, so they cannot join a cross-study comparison.
STUDIES <- c(
  "Covid19EstimationFamotidine",
  "Covid19EstimationHydroxychloroquine",
  "Covid19EstimationHydroxychloroquine2",
  "Covid19EstimationIl6JakInhibitors",
  "Covid19EstimationProteaseInhibitors",
  "Covid19SusceptibilityAlphaBlockers",
  "DoacsWarfarinSub",
  "GLP1ReproducibilityExacerbation",
  "GLP1ReproducibilityHospitalization",
  "GLP1ReproducibilityHospitalizationSulf",
  "GrahamReplicationDemo",
  "IcariusSusceptibility",
  "MskaiEstimationPrelim",
  "Ohdsi2022EstimationTutorial",
  "OutcomeMisclassificationEval",
  "ProstateCancerCVDRisk",
  "QbaEvaluation",
  "RanitidineCancerRisk",
  "StrokeRiskInElderlyApUsers",
  "StrokeRiskInNonElderlyApUsers",
  "TicagrelorVsClopidogrel",
  "UkaTkaSafetyEffectiveness",
  "corazon"
)

# Human-readable titles for the study picker.
STUDY_TITLES <- c(
  Covid19EstimationFamotidine = "Famotidine in COVID-19",
  Covid19EstimationHydroxychloroquine = "Hydroxychloroquine safety (RA)",
  Covid19EstimationHydroxychloroquine2 = "Hydroxychloroquine + azithromycin",
  Covid19EstimationIl6JakInhibitors = "IL-6 & JAK inhibitors in RA",
  Covid19EstimationProteaseInhibitors = "Protease inhibitors in COVID-19",
  Covid19SusceptibilityAlphaBlockers = "Alpha blockers and COVID-19 susceptibility",
  DoacsWarfarinSub = "DOACs vs warfarin",
  GLP1ReproducibilityExacerbation = "GLP-1 reproducibility: exacerbation",
  GLP1ReproducibilityHospitalization = "GLP-1 reproducibility: hospitalisation",
  GLP1ReproducibilityHospitalizationSulf = "GLP-1 reproducibility: vs sulfonylureas",
  GrahamReplicationDemo = "Graham replication demo",
  IcariusSusceptibility = "ICARIUS: drug susceptibility",
  MskaiEstimationPrelim = "Musculoskeletal AI estimation",
  Ohdsi2022EstimationTutorial = "OHDSI 2022 estimation tutorial",
  OutcomeMisclassificationEval = "Outcome misclassification evaluation",
  ProstateCancerCVDRisk = "Prostate cancer therapy and CVD risk",
  QbaEvaluation = "Quantitative bias analysis evaluation",
  RanitidineCancerRisk = "Ranitidine and cancer risk",
  StrokeRiskInElderlyApUsers = "Stroke risk: elderly antipsychotic users",
  StrokeRiskInNonElderlyApUsers = "Stroke risk: non-elderly antipsychotic users",
  TicagrelorVsClopidogrel = "Ticagrelor vs clopidogrel",
  UkaTkaSafetyEffectiveness = "Partial vs total knee replacement",
  corazon = "CORAZON: cardiovascular outcomes"
)

# Studies keep their results in one of these subdirectories.
DATA_DIRS <- c("data", "shinyData", "shinyDataSmall", "shinyDataAll")

# Tables stacked across all studies and loaded at startup. These drive the
# filters, the funnel plot, and the calibration, and are small.
INDEX_TABLES <- c(
  "cohort_method_result",
  "cohort_method_analysis",
  "exposure_of_interest",
  "outcome_of_interest",
  "negative_control_outcome",
  "database",
  "comparison_summary"
)

# Tables written per study and registered only when that study is selected.
# propensity_model is deliberately absent: nothing in the app reads it, and it
# is pure weight.
STUDY_TABLES <- c(
  "covariate_balance",
  "covariate",
  "covariate_analysis",
  "preference_score_dist",
  "kaplan_meier_dist",
  "attrition",
  "cm_follow_up_dist"
)

# The app always views one (database, target, comparator, analysis) at a time.
# Sorting each large table on those keys puts a comparison's rows in a handful
# of contiguous row groups, so DuckDB's HTTP range requests skip the rest of the
# file on the Parquet statistics rather than downloading it. The file stays big
# on disk; the transfer per view does not.
SORT_KEYS <- c("database_id", "target_id", "comparator_id", "analysis_id",
               "outcome_id")

# Small enough that row-group skipping is fine-grained, large enough that the
# statistics footer stays cheap.
ROW_GROUP_SIZE <- 65536

KNOWN_TABLES <- union(INDEX_TABLES, STUDY_TABLES)

`%||%` <- function(a, b) if (is.null(a) || is.na(a)) b else a

#' Table a results file belongs to, or NA if it is not one we handle.
#' Longest match wins so "covariate_balance" beats "covariate".
tableOf <- function(path) {
  stem <- sub("\\.rds$", "", basename(path))
  hits <- KNOWN_TABLES[startsWith(stem, KNOWN_TABLES)]
  if (length(hits) == 0) return(NA_character_)
  hits[which.max(nchar(hits))]
}

# Some concept names carry latin-1 bytes (the "ö" in "Henoch-Schönlein
# purpura"). R writes those into Parquet as invalid UTF-8, and DuckDB then
# refuses to read the file at all, so repair every character column on the way
# in.
# Works on the distinct values and maps back, rather than touching every
# element. A single covariate_balance file holds millions of rows but only a
# handful of distinct database ids, so the element-wise version was both slow
# and a memory spike large enough to be OOM-killed.
toUtf8 <- function(x) {
  for (cl in names(x)) {
    if (!is.character(x[[cl]])) next
    values <- unique(x[[cl]])
    bad <- !is.na(values) & !validUTF8(values)
    if (!any(bad)) next
    fixed <- values
    fixed[bad] <- iconv(values[bad], from = "latin1", to = "UTF-8", sub = "?")
    Encoding(fixed) <- "UTF-8"
    x[[cl]] <- fixed[match(x[[cl]], values)]
  }
  x
}

# Studies were exported over several years with three different column-naming
# conventions: snake_case (most), camelCase (MskaiEstimationPrelim), and a
# bias-analysis variant with its own spellings (QbaEvaluation,
# OutcomeMisclassificationEval). Normalise all three onto the snake_case schema
# the app models, or the tables cannot be stacked across studies.
COLUMN_ALIASES <- c(
  ci95_lb = "ci_95_lb",             ci95_ub = "ci_95_ub",
  ci_95lb = "ci_95_lb",             ci_95ub = "ci_95_ub",
  calibrated_ci95_lb = "calibrated_ci_95_lb",
  calibrated_ci95_ub = "calibrated_ci_95_ub",
  i2 = "i_2",
  events_target = "target_outcomes",
  events_comparator = "comparator_outcomes",
  std_diff_bef = "std_diff_before",
  analysis_description = "description"
)

normalizeNames <- function(x) {
  n <- names(x)
  n <- gsub("([a-z0-9])([A-Z])", "\\1_\\2", n)   # targetId -> target_Id
  n <- tolower(n)
  n <- sub("^_+", "", n)                          # QBA's "_t_p" columns
  hit <- n %in% names(COLUMN_ALIASES)
  n[hit] <- unname(COLUMN_ALIASES[n[hit]])
  names(x) <- make.unique(n)
  x
}

# Dropped as soon as the file is read, before any copy: on a 6-million-row
# covariate_balance file these three columns are a quarter of the memory.
DROP_COLUMNS <- c("outcome_id", "interaction_covariate_id",
                  "target_mean_before", "comparator_mean_before")

readOne <- function(path, tbl = NA_character_) {
  x <- try(readRDS(path), silent = TRUE)
  if (inherits(x, "try-error")) return(NULL)
  x <- as.data.frame(x)
  attr(x, "spec") <- NULL          # readr col_spec attribute, not needed
  attr(x, "problems") <- NULL
  if (nrow(x) == 0) return(NULL)
  x <- normalizeNames(x)
  if (!is.na(tbl) && tbl == "covariate_balance") {
    x <- x[, setdiff(names(x), DROP_COLUMNS), drop = FALSE]
  }
  toUtf8(x)
}

# Bind rows tolerating columns that are all-NA logical in one file and numeric
# in another (readr guessed types per file), and columns missing entirely from
# some studies.
bindLoose <- function(dfs) {
  dfs <- Filter(Negate(is.null), dfs)
  if (length(dfs) == 0) return(NULL)
  cols <- unique(unlist(lapply(dfs, names)))
  typeOf <- function(cl, test) {
    any(vapply(dfs, function(d) cl %in% names(d) && test(d[[cl]]), logical(1)))
  }
  numericCols <- cols[vapply(cols, typeOf, logical(1), is.numeric)]
  charCols <- setdiff(cols[vapply(cols, typeOf, logical(1), is.character)],
                      numericCols)
  dfs <- lapply(dfs, function(d) {
    for (cl in setdiff(cols, names(d))) d[[cl]] <- NA
    for (cl in intersect(numericCols, names(d))) d[[cl]] <- as.numeric(d[[cl]])
    for (cl in intersect(charCols, names(d))) d[[cl]] <- as.character(d[[cl]])
    d[cols]
  })
  do.call(rbind, dfs)
}

#' Shrink one source file as it is read, before anything is bound together.
#'
#' Covariate balance is the memory bottleneck: a single study can ship five
#' 40 MB compressed RDS files that expand to tens of millions of rows, and
#' binding them all before deduplicating is enough to be OOM-killed. Each file
#' holds one database, and the dedup key is scoped to the database, so doing it
#' per file is equivalent and keeps peak memory to one file.
pruneChunk <- function(tbl, df) {
  if (is.null(df) || tbl != "covariate_balance") return(df)
  if (!all(c("std_diff_before", "std_diff_after") %in% names(df))) return(df)
  df <- df[!is.na(df$std_diff_before) | !is.na(df$std_diff_after), , drop = FALSE]
  keys <- intersect(c("database_id", "target_id", "comparator_id",
                      "analysis_id", "covariate_id"), names(df))
  # A composite numeric key deduplicates without materialising a data frame of
  # the key columns, which matters at six million rows.
  if (length(keys) > 0) {
    signature <- do.call(paste, c(unname(df[keys]), sep = "\r"))
    df <- df[!duplicated(signature), , drop = FALSE]
    rm(signature)
  }
  df
}

#' Shrink a table before it is written.
prune <- function(tbl, df) {
  # Covariate balance is emitted once per outcome but is identical across
  # outcomes for a given target/comparator/analysis: keep one copy. This is the
  # difference between a ~100 MB and a ~5 MB download per study.
  if (tbl == "covariate_balance") {
    # pruneChunk already did the work per file; this only catches keys that
    # spanned two files.
    keys <- intersect(c("database_id", "target_id", "comparator_id",
                        "analysis_id", "covariate_id"), names(df))
    if (length(keys) > 0) df <- df[!duplicated(df[keys]), , drop = FALSE]
  }

  # The covariate name lookup is repeated per database; one copy is enough.
  if (tbl == "covariate") {
    df <- df %>%
      select(any_of(c("covariate_id", "covariate_name",
                      "covariate_analysis_id"))) %>%
      distinct(covariate_id, .keep_all = TRUE)
  }

  # Cohort and analysis definitions are large JSON blobs nobody filters on;
  # the app shows names only.
  if (tbl %in% c("exposure_of_interest", "outcome_of_interest",
                 "cohort_method_analysis")) {
    df <- df %>% select(-any_of("definition")) %>% distinct()
  }
  if (tbl %in% c("covariate_analysis", "negative_control_outcome", "database")) {
    df <- distinct(df)
  }
  df
}

writeParquet <- function(df, path, sorted = FALSE) {
  dir.create(dirname(path), recursive = TRUE, showWarnings = FALSE)
  if (sorted) {
    keys <- intersect(SORT_KEYS, names(df))
    if (length(keys) > 0) df <- df[do.call(order, df[keys]), , drop = FALSE]
    write_parquet(df, path, compression = "zstd",
                  chunk_size = ROW_GROUP_SIZE)
  } else {
    write_parquet(df, path, compression = "zstd")
  }
  file.size(path)
}

# ---------------------------------------------------------------------------

dir.create(outDir, recursive = TRUE, showWarnings = FALSE)
indexAccum <- setNames(vector("list", length(INDEX_TABLES)), INDEX_TABLES)
catalogue <- list()
perStudyTables <- list()

for (study in STUDIES) {
  dataDir <- NULL
  for (candidate in file.path(root, study, DATA_DIRS)) {
    if (dir.exists(candidate) &&
        length(list.files(candidate, pattern = "\\.rds$")) > 0) {
      dataDir <- candidate
      break
    }
  }
  if (is.null(dataDir)) {
    message(sprintf("!! %-40s no results directory, skipped", study))
    next
  }

  files <- list.files(dataDir, pattern = "\\.rds$", full.names = TRUE)
  byTable <- split(files, vapply(files, tableOf, character(1)))
  byTable <- byTable[!is.na(names(byTable))]

  if (!"cohort_method_result" %in% names(byTable)) {
    message(sprintf("!! %-40s no effect estimates, skipped", study))
    next
  }

  studyBytes <- 0
  nEstimates <- 0
  written <- character(0)
  balanceCovariates <- NULL

  # Balance first, so the covariate name lookup can be trimmed to the ids it
  # actually references.
  ordered <- c(intersect("covariate_balance", names(byTable)),
               setdiff(names(byTable), "covariate_balance"))

  for (tbl in ordered) {
    target <- file.path(outDir, study, paste0(tbl, ".parquet"))
    # Resume: a per-study table already on disk is not rebuilt. Index tables are
    # cheap and always re-read, since they must all be stacked at the end.
    if (!(tbl %in% INDEX_TABLES) && file.exists(target) && file.size(target) > 0) {
      studyBytes <- studyBytes + file.size(target)
      written <- c(written, tbl)
      next
    }

    chunks <- lapply(byTable[[tbl]], function(f) {
      chunk <- pruneChunk(tbl, readOne(f, tbl))
      gc(verbose = FALSE)
      chunk
    })
    df <- bindLoose(chunks)
    rm(chunks)
    gc(verbose = FALSE)
    if (is.null(df) || nrow(df) == 0) next
    df <- prune(tbl, df)

    if (tbl == "covariate_balance") {
      balanceCovariates <- unique(df$covariate_id)
    }
    if (tbl == "covariate" && !is.null(balanceCovariates)) {
      df <- df[df$covariate_id %in% balanceCovariates, , drop = FALSE]
    }
    if (nrow(df) == 0) next

    if (tbl %in% INDEX_TABLES) {
      df$study_id <- study
      indexAccum[[tbl]][[study]] <- df
      if (tbl == "cohort_method_result") nEstimates <- nrow(df)
    } else {
      studyBytes <- studyBytes + writeParquet(df, target, sorted = TRUE)
      written <- c(written, tbl)
    }
  }
  perStudyTables[[study]] <- written

  cmr <- indexAccum[["cohort_method_result"]][[study]]
  required <- c("target_id", "comparator_id", "outcome_id", "analysis_id",
                "database_id", "rr", "log_rr", "se_log_rr")
  missing <- setdiff(required, names(cmr))
  if (length(missing) > 0) {
    message(sprintf("!! %-40s missing %s, skipped", study,
                    paste(missing, collapse = ", ")))
    indexAccum <- lapply(indexAccum, function(a) { a[[study]] <- NULL; a })
    perStudyTables[[study]] <- NULL
    unlink(file.path(outDir, study), recursive = TRUE)
    next
  }

  catalogue[[study]] <- data.frame(
    study_id = study,
    study_name = unname(STUDY_TITLES[study] %||% study),
    n_estimates = nrow(cmr),
    n_databases = length(unique(cmr$database_id)),
    n_comparisons = nrow(unique(cmr[c("target_id", "comparator_id")])),
    n_analyses = length(unique(cmr$analysis_id)),
    stringsAsFactors = FALSE
  )

  gc(verbose = FALSE)
  message(sprintf("   %-40s %6d estimates  %5.1f MB per-study",
                  study, nEstimates, studyBytes / 1024^2))
}

for (tbl in INDEX_TABLES) {
  df <- bindLoose(unname(indexAccum[[tbl]]))
  if (is.null(df)) next
  bytes <- writeParquet(df, file.path(outDir, "index", paste0(tbl, ".parquet")))
  message(sprintf("index %-28s %8d rows  %6.1f MB", tbl, nrow(df),
                  bytes / 1024^2))
}

studyTable <- do.call(rbind, catalogue)
studyTable <- studyTable[order(studyTable$study_name), ]
invisible(writeParquet(studyTable, file.path(outDir, "index", "study.parquet")))

# Tells the app which per-study tables exist, so it can register an empty view
# rather than pointing at a Parquet file that was never written.
jsonlite::write_json(perStudyTables[studyTable$study_id],
                     file.path(outDir, "manifest.json"), auto_unbox = FALSE)

total <- sum(file.size(list.files(outDir, pattern = "\\.parquet$",
                                  recursive = TRUE, full.names = TRUE)))
message(sprintf("\n%d studies, %s total in %s",
                nrow(studyTable), format(structure(total, class = "object_size"),
                                         units = "auto"), outDir))
