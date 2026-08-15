import { describe, it, expect } from "vitest";
import {
  fitNull,
  fitSystematicError,
  calibrateP,
  calibrateCi,
  coverage,
  expectedAbsoluteSystematicError,
  normalCdf,
  nelderMead,
  type Estimate,
} from "../src/data/calibration";

/** Deterministic standard normal draws (Box-Muller on a seeded LCG). */
function normals(n: number, seed = 42): number[] {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return (s + 1) / 4294967297;
  };
  const out: number[] = [];
  while (out.length < n) {
    const u1 = rand();
    const u2 = rand();
    const r = Math.sqrt(-2 * Math.log(u1));
    out.push(r * Math.cos(2 * Math.PI * u2), r * Math.sin(2 * Math.PI * u2));
  }
  return out.slice(0, n);
}

/** Negative controls drawn from a known null, with known SEs. */
function simulate(mu: number, sigma: number, n: number, seed = 7): Estimate[] {
  const z = normals(2 * n, seed);
  return Array.from({ length: n }, (_, i) => {
    const se = 0.1 + 0.4 * Math.abs(z[n + i]) / 3;
    return { logRr: mu + sigma * z[i] + se * z[(i + 3) % n], seLogRr: se };
  });
}

describe("normalCdf", () => {
  it("matches known quantiles", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959963985)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1.959963985)).toBeCloseTo(0.025, 4);
    expect(normalCdf(2.5758293)).toBeCloseTo(0.995, 4);
  });
});

describe("nelderMead", () => {
  it("finds the minimum of a quadratic bowl", () => {
    const fit = nelderMead((p) => (p[0] - 3) ** 2 + (p[1] + 1) ** 2, [0, 0]);
    expect(fit).not.toBeNull();
    expect(fit![0]).toBeCloseTo(3, 3);
    expect(fit![1]).toBeCloseTo(-1, 3);
  });

  it("finds the minimum of Rosenbrock from a standard start", () => {
    const fit = nelderMead(
      (p) => (1 - p[0]) ** 2 + 100 * (p[1] - p[0] ** 2) ** 2,
      [-1.2, 1],
      5000,
    );
    expect(fit![0]).toBeCloseTo(1, 2);
    expect(fit![1]).toBeCloseTo(1, 2);
  });
});

describe("fitNull", () => {
  it("recovers the mean and SD it was simulated from", () => {
    const fit = fitNull(simulate(0.2, 0.3, 400));
    expect(fit).not.toBeNull();
    expect(fit!.mean).toBeCloseTo(0.2, 1);
    expect(fit!.sd).toBeGreaterThan(0.15);
    expect(fit!.sd).toBeLessThan(0.5);
  });

  it("returns a near-zero mean for unbiased controls", () => {
    const fit = fitNull(simulate(0, 0.2, 300, 11));
    expect(Math.abs(fit!.mean)).toBeLessThan(0.08);
  });

  it("refuses to fit fewer than five controls", () => {
    expect(fitNull(simulate(0, 0.2, 4))).toBeNull();
  });

  it("ignores non-finite and non-positive standard errors", () => {
    const data = [
      ...simulate(0, 0.2, 40),
      { logRr: NaN, seLogRr: 0.2 },
      { logRr: 0.1, seLogRr: 0 },
      { logRr: 0.1, seLogRr: -1 },
    ];
    expect(fitNull(data)).not.toBeNull();
  });
});

describe("calibrateP", () => {
  it("gives p = 1 for an estimate sitting exactly on the null mean", () => {
    const nul = { mean: 0.3, sd: 0.25 };
    expect(calibrateP(nul, { logRr: 0.3, seLogRr: 0.1 })).toBeCloseTo(1, 6);
  });

  it("is larger than the uncalibrated p when the null is biased", () => {
    // An estimate at logRr = 0.5 looks significant on its own...
    const estimate = { logRr: 0.5, seLogRr: 0.2 };
    const uncalibrated =
      2 * Math.min(normalCdf(0.5 / 0.2), 1 - normalCdf(0.5 / 0.2));
    // ...but not once the negative controls show the method runs high.
    const calibrated = calibrateP({ mean: 0.4, sd: 0.3 }, estimate);
    expect(uncalibrated).toBeLessThan(0.05);
    expect(calibrated).toBeGreaterThan(uncalibrated);
    expect(calibrated).toBeGreaterThan(0.5);
  });

  it("is symmetric around the null mean", () => {
    const nul = { mean: 0.1, sd: 0.2 };
    const up = calibrateP(nul, { logRr: 0.6, seLogRr: 0.15 });
    const down = calibrateP(nul, { logRr: -0.4, seLogRr: 0.15 });
    expect(up).toBeCloseTo(down, 6);
  });
});

describe("fitSystematicError and calibrateCi", () => {
  it("widens the interval relative to the uncalibrated one", () => {
    const model = fitSystematicError(simulate(0.15, 0.25, 300));
    expect(model).not.toBeNull();
    const estimate = { logRr: Math.log(1.5), seLogRr: 0.2 };
    const c = calibrateCi(model!, estimate);
    const uncalWidth = Math.exp(estimate.logRr + 1.96 * 0.2) -
      Math.exp(estimate.logRr - 1.96 * 0.2);
    expect(c.ub95 - c.lb95).toBeGreaterThan(uncalWidth);
    expect(c.lb95).toBeLessThan(c.rr);
    expect(c.rr).toBeLessThan(c.ub95);
  });

  it("shifts the point estimate against the fitted bias", () => {
    // Controls run high (mean log RR 0.4), so a positive estimate is pulled down.
    const model = fitSystematicError(simulate(0.4, 0.2, 300, 3));
    const c = calibrateCi(model!, { logRr: 0.4, seLogRr: 0.2 });
    expect(c.rr).toBeLessThan(Math.exp(0.4));
  });
});

describe("coverage", () => {
  it("is 1 when every control interval covers the null", () => {
    const data = [
      { logRr: 0.0, seLogRr: 0.5 },
      { logRr: 0.1, seLogRr: 0.5 },
      { logRr: -0.2, seLogRr: 0.5 },
    ];
    expect(coverage(data)).toBe(1);
  });

  it("is 0 when no control interval covers the null", () => {
    const data = [
      { logRr: 2, seLogRr: 0.1 },
      { logRr: -2, seLogRr: 0.1 },
    ];
    expect(coverage(data)).toBe(0);
  });

  it("is near 0.95 for well-behaved controls", () => {
    // Unbiased, no extra dispersion: nominal coverage should hold.
    const z = normals(500, 99);
    const data = z.map((zi) => ({ logRr: 0.25 * zi, seLogRr: 0.25 }));
    expect(coverage(data)!).toBeGreaterThan(0.9);
  });

  it("returns null with no usable estimates", () => {
    expect(coverage([])).toBeNull();
  });
});

describe("expectedAbsoluteSystematicError", () => {
  it("is 0 for a point mass at 0", () => {
    expect(expectedAbsoluteSystematicError({ mean: 0, sd: 1e-9 })).toBeCloseTo(
      0,
      6,
    );
  });

  it("equals |mu| when the SD is negligible", () => {
    expect(
      expectedAbsoluteSystematicError({ mean: 0.5, sd: 1e-9 }),
    ).toBeCloseTo(0.5, 4);
  });

  it("grows with the null SD", () => {
    const small = expectedAbsoluteSystematicError({ mean: 0, sd: 0.1 });
    const large = expectedAbsoluteSystematicError({ mean: 0, sd: 0.5 });
    expect(large).toBeGreaterThan(small);
  });

  it("matches the half-normal mean when mu is 0", () => {
    // E|X| for X ~ N(0, sd^2) is sd * sqrt(2/pi).
    const sd = 0.3;
    expect(expectedAbsoluteSystematicError({ mean: 0, sd })).toBeCloseTo(
      sd * Math.sqrt(2 / Math.PI),
      4,
    );
  });
});
