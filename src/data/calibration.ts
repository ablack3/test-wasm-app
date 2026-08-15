/**
 * Empirical calibration of effect estimates against negative controls.
 *
 * Port of the core of the OHDSI `EmpiricalCalibration` R package. The study's
 * exported results carry `calibrated_rr = NA`, so every calibrated number in
 * this app is computed here, in the browser, from the negative-control
 * estimates for the same database / target / comparator / analysis.
 *
 * Two models are fitted:
 *
 *  - Null distribution (`fitNull`): logRr_i ~ N(mu, sigma^2 + se_i^2).
 *    Used for calibrated p-values.
 *  - Systematic error model (`fitSystematicError`): the mean and SD of the
 *    error are allowed to grow with the standard error, i.e.
 *    logRr_i ~ N(mu0 + mu1*se_i, (sigma0 + sigma1*se_i)^2 + se_i^2).
 *    Used for calibrated confidence intervals.
 */

export interface Estimate {
  logRr: number;
  seLogRr: number;
}

export interface Null {
  mean: number;
  sd: number;
}

export interface SystematicErrorModel {
  meanIntercept: number;
  meanSlope: number;
  sdIntercept: number;
  sdSlope: number;
}

export interface CalibratedEstimate {
  rr: number;
  lb95: number;
  ub95: number;
  p: number;
}

const Z95 = 1.959963984540054;

/** Estimates usable for fitting: finite, positive SE. */
export function usable(estimates: Estimate[]): Estimate[] {
  return estimates.filter(
    (e) =>
      Number.isFinite(e.logRr) && Number.isFinite(e.seLogRr) && e.seLogRr > 0,
  );
}

function logLikNull(mu: number, logSigma: number, data: Estimate[]): number {
  const sigma2 = Math.exp(logSigma) ** 2;
  let ll = 0;
  for (const d of data) {
    const v = sigma2 + d.seLogRr * d.seLogRr;
    ll += -0.5 * Math.log(2 * Math.PI * v) - ((d.logRr - mu) ** 2) / (2 * v);
  }
  return ll;
}

/** MLE of the null distribution over the negative controls. */
export function fitNull(estimates: Estimate[]): Null | null {
  const data = usable(estimates);
  if (data.length < 5) return null;

  const start = [mean(data.map((d) => d.logRr)), Math.log(0.2)];
  const fit = nelderMead((p) => -logLikNull(p[0], p[1], data), start);
  if (!fit) return null;
  return { mean: fit[0], sd: Math.exp(fit[1]) };
}

function logLikSystematic(p: number[], data: Estimate[]): number {
  const [mu0, mu1, logSd0, logSd1] = p;
  const sd0 = Math.exp(logSd0);
  const sd1 = Math.exp(logSd1);
  let ll = 0;
  for (const d of data) {
    const mu = mu0 + mu1 * d.seLogRr;
    const sd = sd0 + sd1 * d.seLogRr;
    const v = sd * sd + d.seLogRr * d.seLogRr;
    ll += -0.5 * Math.log(2 * Math.PI * v) - ((d.logRr - mu) ** 2) / (2 * v);
  }
  return ll;
}

/**
 * Systematic error model fitted on negative controls, whose true effect is
 * assumed to be logRr = 0.
 */
export function fitSystematicError(
  estimates: Estimate[],
): SystematicErrorModel | null {
  const data = usable(estimates);
  if (data.length < 5) return null;

  const seed = fitNull(data);
  const start = [
    seed?.mean ?? 0,
    0,
    Math.log(Math.max(seed?.sd ?? 0.2, 1e-3)),
    Math.log(0.1),
  ];
  const fit = nelderMead((p) => -logLikSystematic(p, data), start);
  if (!fit) return null;
  return {
    meanIntercept: fit[0],
    meanSlope: fit[1],
    sdIntercept: Math.exp(fit[2]),
    sdSlope: Math.exp(fit[3]),
  };
}

/**
 * Two-sided calibrated p-value: the probability, under the null fitted on the
 * negative controls, of an estimate at least as extreme as this one.
 */
export function calibrateP(nul: Null, estimate: Estimate): number {
  const sd = Math.sqrt(nul.sd * nul.sd + estimate.seLogRr * estimate.seLogRr);
  const z = (estimate.logRr - nul.mean) / sd;
  return 2 * Math.min(normalCdf(z), 1 - normalCdf(z));
}

/**
 * Calibrated point estimate and 95% CI: the estimate is shifted by the modelled
 * systematic error and its SE inflated by the modelled error SD.
 */
export function calibrateCi(
  model: SystematicErrorModel,
  estimate: Estimate,
): CalibratedEstimate {
  const se = estimate.seLogRr;
  const bias = model.meanIntercept + model.meanSlope * se;
  const errorSd = model.sdIntercept + model.sdSlope * se;
  const calLogRr = estimate.logRr - bias;
  const calSe = Math.sqrt(se * se + errorSd * errorSd);
  const z = calLogRr / calSe;
  return {
    rr: Math.exp(calLogRr),
    lb95: Math.exp(calLogRr - Z95 * calSe),
    ub95: Math.exp(calLogRr + Z95 * calSe),
    p: 2 * Math.min(normalCdf(z), 1 - normalCdf(z)),
  };
}

/**
 * Fraction of negative controls whose 95% CI covers the true (null) effect.
 * Well below 0.95 is the standard signal that a comparison carries residual
 * systematic error.
 */
export function coverage(estimates: Estimate[]): number | null {
  const data = usable(estimates);
  if (data.length === 0) return null;
  let covered = 0;
  for (const d of data) {
    if (Math.abs(d.logRr) <= Z95 * d.seLogRr) covered += 1;
  }
  return covered / data.length;
}

/** Expected absolute systematic error: E|mu| under the fitted null. */
export function expectedAbsoluteSystematicError(nul: Null): number {
  // E|X| for X ~ N(mu, sd^2)
  const { mean: mu, sd } = nul;
  return (
    sd * Math.SQRT2 * Math.exp(-(mu * mu) / (2 * sd * sd)) / Math.sqrt(Math.PI) +
    mu * (1 - 2 * normalCdf(-mu / sd))
  );
}

// ---------------------------------------------------------------------------
// numerics
// ---------------------------------------------------------------------------

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Abramowitz & Stegun 7.1.26 based standard normal CDF. */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/**
 * Nelder-Mead simplex minimisation. The likelihoods here are smooth and
 * low-dimensional (2-4 parameters over at most a few hundred negative
 * controls), so a derivative-free method is both adequate and dependency-free.
 */
export function nelderMead(
  fn: (p: number[]) => number,
  start: number[],
  maxIter = 2000,
  tol = 1e-10,
): number[] | null {
  const n = start.length;
  const alpha = 1;
  const gamma = 2;
  const rho = 0.5;
  const sigma = 0.5;

  let simplex: { p: number[]; v: number }[] = [
    { p: [...start], v: fn(start) },
  ];
  for (let i = 0; i < n; i++) {
    const p = [...start];
    p[i] += p[i] !== 0 ? 0.05 * Math.abs(p[i]) : 0.05;
    simplex.push({ p, v: fn(p) });
  }
  if (simplex.some((s) => !Number.isFinite(s.v))) return null;

  for (let iter = 0; iter < maxIter; iter++) {
    simplex.sort((a, b) => a.v - b.v);
    if (Math.abs(simplex[n].v - simplex[0].v) < tol) break;

    const centroid = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) centroid[j] += simplex[i].p[j] / n;
    }
    const worst = simplex[n];

    const reflected = centroid.map((c, j) => c + alpha * (c - worst.p[j]));
    const vR = fn(reflected);

    if (vR < simplex[0].v) {
      const expanded = centroid.map((c, j) => c + gamma * (reflected[j] - c));
      const vE = fn(expanded);
      simplex[n] = vE < vR ? { p: expanded, v: vE } : { p: reflected, v: vR };
    } else if (vR < simplex[n - 1].v) {
      simplex[n] = { p: reflected, v: vR };
    } else {
      const contracted = centroid.map((c, j) => c + rho * (worst.p[j] - c));
      const vC = fn(contracted);
      if (vC < worst.v) {
        simplex[n] = { p: contracted, v: vC };
      } else {
        const best = simplex[0].p;
        simplex = simplex.map((s) => {
          const p = s.p.map((x, j) => best[j] + sigma * (x - best[j]));
          return { p, v: fn(p) };
        });
      }
    }
  }

  simplex.sort((a, b) => a.v - b.v);
  return Number.isFinite(simplex[0].v) ? simplex[0].p : null;
}
