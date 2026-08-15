/**
 * Fits a null distribution per (study, database, comparison, analysis) group so
 * the cross-study tab can rank thousands of comparisons by how much systematic
 * error each carries.
 *
 * This runs off the main thread because the work is O(groups x controls x
 * simplex iterations) — a few thousand Nelder-Mead fits — and would otherwise
 * stall interaction for seconds. The boundary is kept compact: contiguous
 * Float64Arrays plus group offsets in, one summary array out. No object graphs
 * cross the wire.
 */
import {
  fitNull,
  coverage,
  expectedAbsoluteSystematicError,
  type Estimate,
} from "../data/calibration";

export interface CalibrationJob {
  /** Group labels, one per group. */
  keys: string[];
  /** Start index of each group in `logRr`/`seLogRr`; length = keys.length + 1. */
  offsets: Int32Array;
  logRr: Float64Array;
  seLogRr: Float64Array;
}

export interface GroupFit {
  key: string;
  nControls: number;
  nullMean: number | null;
  nullSd: number | null;
  ease: number | null;
  coverage: number | null;
}

export type WorkerMessage =
  | { type: "progress"; done: number; total: number }
  | { type: "done"; fits: GroupFit[] };

self.onmessage = (event: MessageEvent<CalibrationJob>) => {
  const { keys, offsets, logRr, seLogRr } = event.data;
  const fits: GroupFit[] = [];

  for (let g = 0; g < keys.length; g++) {
    const start = offsets[g];
    const end = offsets[g + 1];
    const controls: Estimate[] = [];
    for (let i = start; i < end; i++) {
      controls.push({ logRr: logRr[i], seLogRr: seLogRr[i] });
    }

    const nul = fitNull(controls);
    fits.push({
      key: keys[g],
      nControls: controls.length,
      nullMean: nul?.mean ?? null,
      nullSd: nul?.sd ?? null,
      ease: nul ? expectedAbsoluteSystematicError(nul) : null,
      coverage: coverage(controls),
    });

    // Report often enough for a live progress bar, rarely enough that posting
    // does not dominate the run.
    if (g % 50 === 0) {
      const message: WorkerMessage = {
        type: "progress",
        done: g,
        total: keys.length,
      };
      self.postMessage(message);
    }
  }

  const message: WorkerMessage = { type: "done", fits };
  self.postMessage(message);
};
