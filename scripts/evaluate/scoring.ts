/**
 * How a draw is scored, and how far a condition beats a blind guess (PRD-6 §6.2, §6.3, §6.4).
 *
 * Pure: no I/O, no scenario import, no knowledge of run artifacts. `evaluate-runs.ts` joins to
 * ground truth and hands this module numbers, which is what lets the maths be tested without
 * fixtures and what keeps the answer key in exactly one place (PRD-2 §20).
 */

/** What a perfectly calibrated answer would report, as a probability. */
export type Target = 0 | 0.5 | 1;
export type Verdict = "true-positive" | "false-positive" | "inconclusive";

/**
 * The verdict bands (PRD-6 §6.10).
 *
 * These **partition** `[0, 100]`: no percentage satisfies two classes. The previous bands overlapped
 * — a true positive passed at `>= 60` while an inconclusive passed across `30–70` — so a constant
 * `65` was simultaneously a passing true positive and a passing inconclusive, and a stub answering
 * it to every alert scored 12/14 without issuing a query.
 *
 * Measured across the 40 scoreable draws on disk when this landed, the partition flips exactly one:
 * `app-credential-added` at `tp=60`. That draw is also the best-calibrated inconclusive answer in
 * the corpus (Brier 0.010), marked FAIL for sitting one point over a boundary — which is the
 * argument for `skill` below rather than against the partition. Both columns print.
 */
export const BANDS = {
  falsePositiveMax: 40,
  inconclusiveMin: 41,
  inconclusiveMax: 59,
  truePositiveMin: 60,
} as const;

/** The pre-partition bands, kept only so `band⁰` can print beside `band` for one release. */
export const LEGACY_BANDS = {
  falsePositiveMax: 40,
  inconclusiveMin: 30,
  inconclusiveMax: 70,
  truePositiveMin: 60,
} as const;

export type BandSet = typeof BANDS | typeof LEGACY_BANDS;

/** Did the agent lean the correct way? Not whether it hit a number (PRD-2 §23). */
export function bandOk(verdict: Verdict, tpPercent: number, bands: BandSet = BANDS): boolean {
  switch (verdict) {
    case "true-positive":
      return tpPercent >= bands.truePositiveMin;
    case "false-positive":
      return tpPercent <= bands.falsePositiveMax;
    case "inconclusive":
      return tpPercent >= bands.inconclusiveMin && tpPercent <= bands.inconclusiveMax;
  }
}

export function targetFor(verdict: Verdict): Target {
  switch (verdict) {
    case "true-positive":
      return 1;
    case "false-positive":
      return 0;
    case "inconclusive":
      return 0.5;
  }
}

/** Squared error of one answer. `p` is a probability, not a percentage. */
export function drawScore(p: number, t: Target): number {
  return (p - t) ** 2;
}

export interface CellScore {
  /** Mean of the draw scores — **not** the score of the mean draw. */
  score: number;
  /** Systematic error: how far the average answer sits from the truth. */
  bias2: number;
  /** Instability: how far the draws sit from their own average. */
  variance: number;
  n: number;
  median: number;
  /** Max minus min, in percentage points. Zero at n=1. */
  spread: number;
}

/**
 * Score a cell holding every repeat (PRD-6 §6.2).
 *
 * **Score then average, never average then score.** One cell on disk holds two draws, 15 and 90,
 * against a target of 0.5. Averaging the answers first gives `(0.525 - 0.5)² = 0.0006` and ranks
 * the corpus's most unstable cell as near-perfect; averaging the scores gives `0.141`, a factor of
 * 226 apart. A cell that answered 15 and 90 to the same question has not answered it.
 *
 * `bias2 + variance === score` exactly, which is the decomposition that makes the difference
 * legible rather than merely correct.
 */
export function cellScore(draws: readonly number[], t: Target): CellScore {
  if (draws.length === 0) throw new Error("cellScore needs at least one draw.");
  const probabilities = draws.map((percent) => percent / 100);
  const score = probabilities.reduce((sum, p) => sum + drawScore(p, t), 0) / probabilities.length;
  const mean = probabilities.reduce((sum, p) => sum + p, 0) / probabilities.length;
  const bias2 = (mean - t) ** 2;
  const variance =
    probabilities.reduce((sum, p) => sum + (p - mean) ** 2, 0) / probabilities.length;
  const sorted = [...draws].toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
      : (sorted[mid] ?? 0);
  return {
    score,
    bias2,
    variance,
    n: draws.length,
    median,
    spread: (sorted.at(-1) ?? 0) - (sorted[0] ?? 0),
  };
}

/**
 * The probability a blind answer should report, computed over the **whole** corpus.
 *
 * A corpus property, deliberately: the base rate does not depend on which scenarios a condition
 * happened to reach.
 */
export function baseRate(verdicts: readonly Verdict[]): number {
  if (verdicts.length === 0) return 0.5;
  return verdicts.reduce((sum, verdict) => sum + targetFor(verdict), 0) / verdicts.length;
}

/**
 * How far a condition beats always answering the base rate (PRD-6 §6.3).
 *
 * **The reference is computed over the covered scenarios only, while the base rate comes from all
 * of them.** Mixing the two — an all-14 denominator against a subset numerator — inflates a
 * condition that happened to cover six easy scenarios from 0.531 to 0.781. `covered K/N` therefore
 * prints on the same line as skill, always.
 *
 * A blind constant can never score above zero: the skill-optimal constant *is* the base rate, where
 * skill is exactly 0 by construction. That is what makes the baseline row a floor rather than a
 * target.
 */
export function skill(brier: number, reference: number): number {
  if (reference === 0) return 0;
  return 1 - brier / reference;
}

export function referenceBrier(coveredVerdicts: readonly Verdict[], rate: number): number {
  if (coveredVerdicts.length === 0) return 0;
  return (
    coveredVerdicts.reduce((sum, verdict) => sum + (rate - targetFor(verdict)) ** 2, 0) /
    coveredVerdicts.length
  );
}

/** Multiplicative binomial coefficient: exact for the corpus sizes here, and never overflows. */
function choose(total: number, k: number): number {
  let result = 1;
  for (let i = 1; i <= k; i += 1) result = (result * (total - k + i)) / i;
  return result;
}

/**
 * Exact two-sided binomial tail over the non-ties (PRD-6 §6.4).
 *
 * Eight lines of integer factorial rather than a dependency. At 7 shared scenarios it takes all 7
 * one way to reach `p <= 0.05`, and that bar is the point: the tool should be able to say *no
 * measurable difference* rather than reporting a sign it cannot support.
 */
export function signTest(up: number, down: number): number {
  const n = up + down;
  if (n === 0) return 1;
  const pointMass = (k: number): number => choose(n, k) / 2 ** n;
  const observed = pointMass(up);
  let p = 0;
  for (let k = 0; k <= n; k += 1) {
    // Floating point: two symmetric tails must compare equal, so the tolerance is not optional.
    if (pointMass(k) <= observed + 1e-12) p += pointMass(k);
  }
  return Math.min(1, p);
}

/**
 * The smallest delta a condition's own cells can distinguish (PRD-6 §6.4).
 *
 * **Per condition, never pooled.** Pooling across conditions is dominated by the one bimodal cell
 * on disk and would either hide real movement or invent it. A condition with no repeats has no
 * measured variance and therefore no floor it can honestly claim — `undefined`, not zero.
 */
export function noiseFloor(cells: readonly CellScore[]): number | undefined {
  const repeated = cells.filter((cell) => cell.n > 1);
  if (repeated.length === 0) return undefined;
  return repeated.reduce((sum, cell) => sum + cell.variance, 0) / repeated.length;
}

/**
 * The best a blind constant can do under a band set — the row printed under every report.
 *
 * Returned as a sweep result rather than a literal so it survives roadmap §7 rebalancing the
 * corpus: what the report claims is a property of the bands and the class mix, not the number 9.
 */
export function blindConstant(
  verdicts: readonly Verdict[],
  percent: number,
  bands: BandSet = BANDS,
): number {
  return verdicts.filter((verdict) => bandOk(verdict, percent, bands)).length;
}

export function bestBlindConstant(
  verdicts: readonly Verdict[],
  bands: BandSet = BANDS,
): { percent: number; passed: number } {
  let best = { percent: 0, passed: -1 };
  for (let percent = 0; percent <= 100; percent += 1) {
    const passed = blindConstant(verdicts, percent, bands);
    if (passed > best.passed) best = { percent, passed };
  }
  return best;
}
