import { describe, it, expect } from "vitest";
import {
  fitNull,
  coverage,
  expectedAbsoluteSystematicError,
  type Estimate,
} from "../src/data/calibration";

/**
 * The cross-study tab groups estimates by
 * (study, database, target, comparator, analysis) and fits one null per group.
 * These tests pin the two properties that make that comparison meaningful:
 * groups are independent, and a group with too few controls yields no fit
 * rather than a bad one.
 */

interface Row {
  study_id: string;
  database_id: string;
  target_id: number;
  comparator_id: number;
  analysis_id: number;
  logRr: number;
  seLogRr: number;
}

const SEPARATOR = "\u0001";

function groupKey(r: Omit<Row, "logRr" | "seLogRr">): string {
  return [
    r.study_id,
    r.database_id,
    r.target_id,
    r.comparator_id,
    r.analysis_id,
  ].join(SEPARATOR);
}

function group(rows: Row[]): Map<string, Estimate[]> {
  const out = new Map<string, Estimate[]>();
  for (const r of rows) {
    const key = groupKey(r);
    const bucket = out.get(key);
    const estimate = { logRr: r.logRr, seLogRr: r.seLogRr };
    if (bucket) bucket.push(estimate);
    else out.set(key, [estimate]);
  }
  return out;
}

function makeRows(
  base: Omit<Row, "logRr" | "seLogRr">,
  logRrs: number[],
  se = 0.2,
): Row[] {
  return logRrs.map((logRr) => ({ ...base, logRr, seLogRr: se }));
}

const A = {
  study_id: "StudyA",
  database_id: "CCAE",
  target_id: 1,
  comparator_id: 2,
  analysis_id: 1,
};

describe("cross-study grouping", () => {
  it("separates studies that share cohort ids", () => {
    // Two studies numbering their cohorts 1 and 2 must not be pooled.
    const rows = [
      ...makeRows(A, [0.5, 0.55, 0.45, 0.5, 0.52, 0.48]),
      ...makeRows({ ...A, study_id: "StudyB" }, [0, 0.01, -0.01, 0, 0.02, -0.02]),
    ];
    const groups = group(rows);
    expect(groups.size).toBe(2);

    const a = fitNull(groups.get(groupKey(A)) as Estimate[]);
    const b = fitNull(
      groups.get(groupKey({ ...A, study_id: "StudyB" })) as Estimate[],
    );
    expect(a!.mean).toBeGreaterThan(0.4);
    expect(Math.abs(b!.mean)).toBeLessThan(0.1);
  });

  it("separates databases within one study", () => {
    const rows = [
      ...makeRows(A, [0.4, 0.42, 0.38, 0.41, 0.39, 0.4]),
      ...makeRows({ ...A, database_id: "Optum" }, [0, 0, 0.01, -0.01, 0, 0]),
    ];
    const groups = group(rows);
    expect(groups.size).toBe(2);
    expect(fitNull(groups.get(groupKey(A))!)!.mean).toBeGreaterThan(0.3);
  });

  it("separates analyses within one comparison", () => {
    const rows = [
      ...makeRows(A, [0.3, 0.31, 0.29, 0.3, 0.3, 0.3]),
      ...makeRows({ ...A, analysis_id: 2 }, [0, 0, 0, 0.01, -0.01, 0]),
    ];
    expect(group(rows).size).toBe(2);
  });

  it("keeps a separator that cannot appear inside a database id", () => {
    // Database ids in this corpus contain spaces and hyphens ("DA Germany",
    // "VA-OMOP"), so the key separator must not be either.
    const messy = { ...A, database_id: "DA Germany" };
    const alsoMessy = { ...A, database_id: "VA-OMOP" };
    expect(groupKey(messy)).not.toBe(groupKey(alsoMessy));
    // The separator must not be anything a real id can contain.
    expect(SEPARATOR).not.toMatch(/[\s\-:_|.a-zA-Z0-9]/);
  });

  it("round-trips a key back to its parts", () => {
    const [study, db, t, c, a] = groupKey(A).split(SEPARATOR);
    expect(study).toBe("StudyA");
    expect(db).toBe("CCAE");
    expect(Number(t)).toBe(1);
    expect(Number(c)).toBe(2);
    expect(Number(a)).toBe(1);
  });
});

describe("per-group fits", () => {
  it("declines to fit a group with fewer than five controls", () => {
    const rows = makeRows(A, [0.1, 0.2, -0.1, 0.05]);
    const fit = fitNull(group(rows).get(groupKey(A)) as Estimate[]);
    expect(fit).toBeNull();
  });

  it("ranks a biased group above an unbiased one on EASE", () => {
    const unbiased = fitNull(
      makeRows(A, [0, 0.01, -0.01, 0.02, -0.02, 0]).map((r) => ({
        logRr: r.logRr,
        seLogRr: r.seLogRr,
      })),
    );
    const biased = fitNull(
      makeRows(A, [0.6, 0.61, 0.59, 0.62, 0.58, 0.6]).map((r) => ({
        logRr: r.logRr,
        seLogRr: r.seLogRr,
      })),
    );
    expect(expectedAbsoluteSystematicError(biased!)).toBeGreaterThan(
      expectedAbsoluteSystematicError(unbiased!),
    );
  });

  it("flags a group whose intervals are far too narrow", () => {
    // Estimates scattered widely but with tiny standard errors: nominal
    // coverage collapses, which is exactly what the scatter should surface.
    const rows = makeRows(A, [0.8, -0.7, 0.9, -0.85, 0.75, -0.9], 0.05);
    const controls = group(rows).get(groupKey(A)) as Estimate[];
    expect(coverage(controls)).toBe(0);
  });
});
