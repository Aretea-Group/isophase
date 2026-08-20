import { describe, expect, test } from "bun:test";

import {
  BANDS,
  bandOk,
  baseRate,
  bestBlindConstant,
  blindConstant,
  cellScore,
  drawScore,
  LEGACY_BANDS,
  noiseFloor,
  referenceBrier,
  signTest,
  skill,
  targetFor,
  type Verdict,
} from "./scoring.ts";

/**
 * The scoring maths, asserted as properties rather than as remembered numbers.
 *
 * Every claim here is one PRD-6 makes in prose, and the reason they are properties is that roadmap
 * §7 will rebalance the corpus: `9/14` is a fact about today's 9/2/3 class mix, while "no blind
 * constant beats the class-mix floor" is a fact about the bands.
 */

/** Today's corpus: 9 true positives, 2 false positives, 3 inconclusive. */
const CORPUS: Verdict[] = [
  ...Array.from<Verdict>({ length: 9 }).fill("true-positive"),
  ...Array.from<Verdict>({ length: 2 }).fill("false-positive"),
  ...Array.from<Verdict>({ length: 3 }).fill("inconclusive"),
];

describe("bands", () => {
  test("partition the range — exactly one class accepts each percentage", () => {
    for (let percent = 0; percent <= 100; percent += 1) {
      const accepted = (["true-positive", "false-positive", "inconclusive"] as const).filter(
        (verdict) => bandOk(verdict, percent, BANDS),
      );
      expect({ percent, accepted: accepted.length }).toEqual({ percent, accepted: 1 });
    }
  });

  test("the legacy bands did not — which is the defect", () => {
    const overlapping = Array.from({ length: 101 }, (_, percent) => percent).filter(
      (percent) =>
        (["true-positive", "false-positive", "inconclusive"] as const).filter((verdict) =>
          bandOk(verdict, percent, LEGACY_BANDS),
        ).length > 1,
    );
    expect(overlapping.length).toBeGreaterThan(0);
    // 65 is the constant that scored 12/14 while issuing no query.
    expect(overlapping).toContain(65);
  });

  test("no blind constant beats the class-mix floor under the partition", () => {
    const floor = CORPUS.filter((verdict) => verdict === "true-positive").length;
    expect(bestBlindConstant(CORPUS, BANDS).passed).toBe(floor);
    // Under the old bands it beat that floor, which is what made a stub competitive.
    expect(bestBlindConstant(CORPUS, LEGACY_BANDS).passed).toBeGreaterThan(floor);
  });

  test("the partition moves the exemplar constant and the legacy bands do not", () => {
    expect(blindConstant(CORPUS, 65, BANDS)).toBe(9);
    expect(blindConstant(CORPUS, 65, LEGACY_BANDS)).toBe(12);
  });
});

describe("cellScore", () => {
  test("bias² + variance is exactly the score", () => {
    for (const draws of [[15, 90], [99], [2, 4, 70], [50, 50, 50]]) {
      const scored = cellScore(draws, 0.5);
      expect(scored.bias2 + scored.variance).toBeCloseTo(scored.score, 12);
    }
  });

  test("score-then-average is not average-then-score, and the difference is the whole point", () => {
    // The corpus's most unstable cell: two draws, 15 and 90, against an inconclusive target.
    const scored = cellScore([15, 90], 0.5);
    const averageThenScore = drawScore((0.15 + 0.9) / 2, 0.5);

    expect(scored.score).toBeCloseTo(0.141_25, 6);
    expect(averageThenScore).toBeCloseTo(0.000_625, 6);
    // Two orders of magnitude apart. Averaging the answers first calls this cell near-perfect.
    expect(scored.score / averageThenScore).toBeGreaterThan(200);
  });

  test("variance is zero at n=1 and the score is entirely bias", () => {
    const scored = cellScore([99], 1);
    expect(scored.variance).toBe(0);
    expect(scored.bias2).toBeCloseTo(scored.score, 12);
    expect(scored.spread).toBe(0);
  });

  test("median and spread describe the draws, not the score", () => {
    const scored = cellScore([15, 90, 60], 0.5);
    expect(scored.median).toBe(60);
    expect(scored.spread).toBe(75);
    expect(scored.n).toBe(3);
  });

  test("refuses an empty cell rather than inventing one", () => {
    expect(() => cellScore([], 1)).toThrow("at least one draw");
  });
});

describe("skill", () => {
  test("a blind constant can never show positive skill, and the base rate scores exactly zero", () => {
    const rate = baseRate(CORPUS);
    const reference = referenceBrier(CORPUS, rate);
    for (let percent = 0; percent <= 100; percent += 1) {
      const p = percent / 100;
      const brier =
        CORPUS.reduce((sum, verdict) => sum + drawScore(p, targetFor(verdict)), 0) / CORPUS.length;
      expect(skill(brier, reference)).toBeLessThanOrEqual(1e-12);
    }
    const atBaseRate =
      CORPUS.reduce((sum, verdict) => sum + drawScore(rate, targetFor(verdict)), 0) / CORPUS.length;
    expect(skill(atBaseRate, reference)).toBeCloseTo(0, 12);
  });

  test("the reference is over the covered scenarios, so coverage cannot inflate it", () => {
    const rate = baseRate(CORPUS);
    const easy: Verdict[] = ["true-positive", "true-positive", "true-positive"];
    // An all-corpus reference against a subset numerator is the inflation this guards against.
    expect(referenceBrier(easy, rate)).not.toBeCloseTo(referenceBrier(CORPUS, rate), 6);
  });

  test("an empty reference is zero skill, not a division by zero", () => {
    expect(skill(0.1, 0)).toBe(0);
    expect(referenceBrier([], 0.75)).toBe(0);
  });
});

describe("signTest", () => {
  test("a 3-3 split cannot reject a coin", () => {
    expect(signTest(3, 3)).toBeCloseTo(1, 6);
  });

  test("it takes a clean sweep of seven to reach p <= 0.05", () => {
    expect(signTest(7, 0)).toBeCloseTo(2 / 128, 6);
    expect(signTest(6, 1)).toBeGreaterThan(0.05);
  });

  test("the two tails are symmetric", () => {
    expect(signTest(5, 1)).toBeCloseTo(signTest(1, 5), 12);
  });

  test("all ties is p = 1", () => {
    expect(signTest(0, 0)).toBe(1);
  });
});

describe("noiseFloor", () => {
  test("is undefined when nothing was repeated — there is no measured noise to claim", () => {
    expect(noiseFloor([cellScore([99], 1), cellScore([2], 0)])).toBeUndefined();
  });

  test("comes only from the cells that actually hold repeats", () => {
    const floor = noiseFloor([cellScore([15, 90], 0.5), cellScore([99], 1)]);
    expect(floor).toBeCloseTo(cellScore([15, 90], 0.5).variance, 12);
  });
});

describe("targets", () => {
  test("map each verdict to what a calibrated answer would report", () => {
    expect(targetFor("true-positive")).toBe(1);
    expect(targetFor("false-positive")).toBe(0);
    expect(targetFor("inconclusive")).toBe(0.5);
  });

  test("the base rate is a corpus property", () => {
    expect(baseRate(CORPUS)).toBeCloseTo(0.75, 12);
  });
});
