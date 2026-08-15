/**
 * Cross-study comparison data.
 *
 * Effect sizes are not comparable across studies — different drugs, outcomes,
 * and populations. What *is* comparable is how much systematic error each
 * analysis carries, because every study measures that on the same scale: its
 * own negative controls, whose true hazard ratio is 1 everywhere.
 *
 * So this module fits a null distribution for every
 * (study, database, target, comparator, analysis) group and reports EASE and
 * negative-control CI coverage per group. Those two numbers put every
 * comparison in every study on one axis pair.
 */
import { query } from "./db";
import type { Study } from "./model";
import CalibrationWorker from "../workers/calibration.worker?worker";
import type {
  CalibrationJob,
  GroupFit,
  WorkerMessage,
} from "../workers/calibration.worker";

export interface ComparisonSummary {
  study_id: string;
  study_name: string;
  database_id: string;
  target_id: number;
  comparator_id: number;
  analysis_id: number;
  target_name: string;
  comparator_name: string;
  n_controls: number;
  n_outcomes: number;
  ease: number | null;
  coverage: number | null;
  null_mean: number | null;
  null_sd: number | null;
}

interface ControlRow {
  study_id: string;
  database_id: string;
  target_id: number;
  comparator_id: number;
  analysis_id: number;
  log_rr: number;
  se_log_rr: number;
}

// U+0001, which cannot occur in a study or database id. Database ids in this
// corpus contain spaces and hyphens ("DA Germany", "VA-OMOP"), so an ordinary
// punctuation separator would make keys ambiguous.
const SEPARATOR = "\u0001";

function groupKey(r: {
  study_id: string;
  database_id: string;
  target_id: number;
  comparator_id: number;
  analysis_id: number;
}): string {
  return [
    r.study_id,
    r.database_id,
    r.target_id,
    r.comparator_id,
    r.analysis_id,
  ].join(SEPARATOR);
}

/**
 * Fit every comparison in every study. Progress is reported as a fraction so
 * the caller can show a bar; the whole run is a few thousand small fits.
 */
export async function loadCrossStudy(
  studies: Study[],
  onProgress: (fraction: number, note: string) => void = () => {},
): Promise<ComparisonSummary[]> {
  onProgress(0, "Reading negative controls for every study…");

  // One scan of the stacked estimate table: the negative controls, which are
  // all the null fit needs.
  const controls = await query<ControlRow>(
    `SELECT r.study_id, r.database_id, r.target_id, r.comparator_id,
            r.analysis_id, r.log_rr, r.se_log_rr
       FROM cohort_method_result r
       JOIN negative_control_outcome n
            ON n.outcome_id = r.outcome_id AND n.study_id = r.study_id
      WHERE r.log_rr IS NOT NULL
        AND r.se_log_rr IS NOT NULL
        AND r.se_log_rr > 0
        AND isfinite(r.log_rr)
        AND isfinite(r.se_log_rr)`,
  );

  // Counts of outcomes of interest per group, for context in the table.
  const outcomeCounts = await query<{
    study_id: string;
    database_id: string;
    target_id: number;
    comparator_id: number;
    analysis_id: number;
    n_outcomes: number;
  }>(
    `SELECT r.study_id, r.database_id, r.target_id, r.comparator_id,
            r.analysis_id, COUNT(*) AS n_outcomes
       FROM cohort_method_result r
       JOIN outcome_of_interest o
            ON o.outcome_id = r.outcome_id AND o.study_id = r.study_id
      WHERE r.rr IS NOT NULL
      GROUP BY r.study_id, r.database_id, r.target_id, r.comparator_id,
               r.analysis_id`,
  );

  const exposureNames = await query<{
    study_id: string;
    exposure_id: number;
    exposure_name: string;
  }>(
    `SELECT study_id, exposure_id, MAX(exposure_name) AS exposure_name
       FROM exposure_of_interest GROUP BY study_id, exposure_id`,
  );

  if (controls.length === 0) return [];

  // Group the controls into contiguous runs so the worker gets flat arrays.
  const byKey = new Map<string, ControlRow[]>();
  for (const row of controls) {
    const key = groupKey(row);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(row);
    else byKey.set(key, [row]);
  }

  const keys = [...byKey.keys()];
  const offsets = new Int32Array(keys.length + 1);
  const logRr = new Float64Array(controls.length);
  const seLogRr = new Float64Array(controls.length);

  let cursor = 0;
  keys.forEach((key, index) => {
    offsets[index] = cursor;
    for (const row of byKey.get(key) as ControlRow[]) {
      logRr[cursor] = row.log_rr;
      seLogRr[cursor] = row.se_log_rr;
      cursor += 1;
    }
  });
  offsets[keys.length] = cursor;

  onProgress(
    0.05,
    `Fitting a null distribution for ${keys.length.toLocaleString()} comparisons…`,
  );

  const fits = await runWorker({ keys, offsets, logRr, seLogRr }, (done, total) =>
    onProgress(
      0.05 + 0.9 * (done / Math.max(1, total)),
      `Fitting nulls: ${done.toLocaleString()} / ${total.toLocaleString()}`,
    ),
  );

  const studyNames = new Map(studies.map((s) => [s.study_id, s.study_name]));
  const outcomeByKey = new Map(
    outcomeCounts.map((r) => [groupKey(r), r.n_outcomes]),
  );
  const exposureByKey = new Map(
    exposureNames.map((r) => [`${r.study_id}${SEPARATOR}${r.exposure_id}`, r.exposure_name]),
  );

  return fits.map((fit) => {
    const [studyId, databaseId, target, comparator, analysis] =
      fit.key.split(SEPARATOR);
    const targetId = Number(target);
    const comparatorId = Number(comparator);
    return {
      study_id: studyId,
      study_name: studyNames.get(studyId) ?? studyId,
      database_id: databaseId,
      target_id: targetId,
      comparator_id: comparatorId,
      analysis_id: Number(analysis),
      target_name:
        exposureByKey.get(`${studyId}${SEPARATOR}${targetId}`) ?? `Cohort ${targetId}`,
      comparator_name:
        exposureByKey.get(`${studyId}${SEPARATOR}${comparatorId}`) ??
        `Cohort ${comparatorId}`,
      n_controls: fit.nControls,
      n_outcomes: outcomeByKey.get(fit.key) ?? 0,
      ease: fit.ease,
      coverage: fit.coverage,
      null_mean: fit.nullMean,
      null_sd: fit.nullSd,
    };
  });
}

function runWorker(
  job: CalibrationJob,
  onProgress: (done: number, total: number) => void,
): Promise<GroupFit[]> {
  return new Promise((resolve, reject) => {
    const worker = new CalibrationWorker();
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === "progress") {
        onProgress(message.done, message.total);
      } else {
        worker.terminate();
        resolve(message.fits);
      }
    };
    worker.onerror = (error) => {
      worker.terminate();
      reject(new Error(error.message));
    };
    // The typed arrays are transferred, not copied.
    worker.postMessage(job, [
      job.offsets.buffer,
      job.logRr.buffer,
      job.seLogRr.buffer,
    ]);
  });
}
