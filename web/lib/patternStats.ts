/* ------------------------------------------------------------------ *
 * Pattern statistics — the test layer behind the pattern explorer.
 *
 * Pure, standard, dependency-free implementations chosen to match the
 * direction each variable type reports:
 *
 *   · numeric     — Mann-Whitney U (two-sided, normal approx with tie
 *                   correction): do winners and losers differ on the
 *                   raw values?
 *   · categorical — Fisher's exact test on the extreme 2×2 table
 *                   (best cell vs worst cell × win/loss) — exact for
 *                   small samples, and it tests exactly the comparison
 *                   the "⚡ prefers X over Y" direction reports.
 *   · presence    — Cochran-Mantel-Haenszel, stratified by strategy
 *                   family: present vs absent × win/loss inside each
 *                   family, combined — matching the family-balanced
 *                   direction the explorer reports.
 *
 * Multiple comparisons: Benjamini-Hochberg FDR step-up over every
 * variable tested in one run; a variable is "significant" at q < 0.10.
 *
 * These are reading aids on live journal samples, not a substitute for
 * the archive studies' train/test discipline — the verdicts carry
 * explicit sample-size gates (see minePatterns).
 * Pure + unit-tested (fisher values cross-checked against the classic
 * tea-tasting table).
 * ------------------------------------------------------------------ */

/* ---- math primitives ------------------------------------------------ */

/** natural log of Γ(x), Lanczos approximation (safe to n ~ thousands) */
function lnGamma(x: number): number {
  if (x < 0.5) {
    // reflection: Γ(x)Γ(1−x) = π / sin(πx)
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  }
  const g = 7;
  const C = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  const z = x - 1;
  let s = C[0];
  for (let i = 1; i < g + 2; i++) s += C[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (x - 0.5) * Math.log(t) - t + Math.log(s);
}

const lnC = (n: number, k: number): number => {
  if (k < 0 || k > n) return -Infinity;
  return lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1);
};

/** lower regularized gamma P(a, x) — series + continued fraction (NR) */
function gammaP(a: number, x: number): number {
  if (x < 0 || a <= 0) return 0;
  if (x === 0) return 0;
  const gln = lnGamma(a);
  if (x < a + 1) {
    let term = 1 / a;
    let sum = term;
    let ap = a;
    for (let i = 0; i < 200; i++) {
      ap += 1;
      term *= x / ap;
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  // continued fraction
  const b = x + 1 - a;
  let c = 1e300;
  let d = 1 / Math.max(1e-300, b);
  let h = d;
  for (let i = 1; i < 200; i++) {
    const an = -i * (i - a);
    const bb = b + 2 * i;
    d = Math.max(1e-300, an * d + bb);
    c = Math.max(1e-300, bb + an / c);
    d = 1 / Math.max(1e-300, d);
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - gln) * h;
}

/** χ² CDF with k degrees of freedom */
export function chi2cdf(x: number, k: number): number {
  if (x <= 0) return 0;
  return gammaP(k / 2, x / 2);
}

/** standard normal CDF */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

/* ---- the three tests ------------------------------------------------ */

/** Fisher's exact test, two-sided, on the 2×2 table
 *  [[a, b], [c, d]] (rows = wins/losses of the two compared cells). */
export function fisherExact(a: number, b: number, c: number, d: number): number {
  const n = a + b + c + d;
  const row1 = a + b;
  const col1 = a + c;
  const lnP = (k: number): number => lnC(row1, k) + lnC(n - row1, col1 - k) - lnC(n, col1);
  const lnObs = lnP(a);
  let p = 0;
  const kmax = Math.min(row1, col1);
  for (let k = 0; k <= kmax; k++) {
    const lp = lnP(k);
    if (lp <= lnObs + 1e-12) p += Math.exp(lp);
  }
  return Math.min(1, p);
}

/** Mann-Whitney U, two-sided, normal approximation with tie correction.
 *  xs = winner values, ys = loser values. */
export function mannWhitneyP(xs: number[], ys: number[]): number {
  const n0 = xs.length;
  const n1 = ys.length;
  if (n0 === 0 || n1 === 0) return 1;
  const all = [
    ...xs.map((v) => ({ v, g: 0 })),
    ...ys.map((v) => ({ v, g: 1 })),
  ].sort((p, q) => p.v - q.v);

  // average ranks with ties
  let i = 0;
  const N = all.length;
  let sumRank0 = 0;
  let tieCorr = 0;
  while (i < N) {
    let j = i;
    while (j + 1 < N && all[j + 1].v === all[i].v) j++;
    const t = j - i + 1;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) {
      if (all[k].g === 0) sumRank0 += avg;
    }
    if (t > 1) tieCorr += t * t * t - t;
    i = j + 1;
  }

  const U = sumRank0 - (n0 * (n0 + 1)) / 2;
  const mean = (n0 * n1) / 2;
  const sd = Math.sqrt((n0 * n1 / 12) * (N + 1 - tieCorr / (N * (N - 1))));
  if (sd === 0) return 1;
  const z = (U - mean) / sd;
  return Math.min(1, 2 * (1 - normalCdf(Math.abs(z))));
}

/** Cochran-Mantel-Haenszel over the per-stratum 2×2 tables
 *  [[a, b], [c, d]] = present-win/present-loss × absent-win/absent-loss. */
export function cmhP(tables: Array<{ a: number; b: number; c: number; d: number }>): number {
  let num = 0;
  let den = 0;
  for (const t of tables) {
    const n = t.a + t.b + t.c + t.d;
    if (n < 2 || (t.a + t.b) === 0 || (t.c + t.d) === 0) continue;
    const E = ((t.a + t.b) * (t.a + t.c)) / n;
    const V = ((t.a + t.b) * (t.c + t.d) * (t.a + t.c) * (t.b + t.d)) / (n * n * (n - 1));
    num += t.a - E;
    den += V;
  }
  if (den <= 0) return 1;
  const chisq = (num * num) / den;
  return 1 - chi2cdf(chisq, 1);
}

/** Benjamini-Hochberg FDR step-up: returns q-values in the input order. */
export function bhFdr(ps: number[]): number[] {
  const m = ps.length;
  const q = new Array<number>(m).fill(1);
  if (m === 0) return q;
  const order = ps
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p - b.p);
  let next = 1;
  for (let r = m - 1; r >= 0; r--) {
    const { p, i } = order[r];
    const qv = Math.min((p * m) / (r + 1), next);
    q[i] = qv;
    next = qv;
  }
  return q;
}
