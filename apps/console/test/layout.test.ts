import { describe, expect, test } from "bun:test";

import {
  RUNS_MIN_HEIGHT,
  balancedCuts,
  columnCount,
  layout,
  tooSmall,
} from "../src/view/layout.ts";

/** Widths and heights a terminal, a tmux split or an editor drawer plausibly is. */
const SIZES = [60, 80, 99, 100, 120, 160, 200, 240].flatMap((width) =>
  [12, 18, 22, 24, 32, 40, 60]
    .filter((height) => tooSmall(width, height) === undefined)
    .map((height): [number, number] => [width, height]),
);

describe("the pane budget", () => {
  test("never hands out more rows than the terminal has, and always leaves [4] some", () => {
    // The two failures this replaces, both geometric and neither visible from the source. Below 23
    // rows the three sidebar floors summed to more than the column had, so the run list's bottom
    // border was drawn over the key bar. Between 60 and 99 columns the stacked sidebar took every
    // row and pane [4] — verdict, transcript, stream — was allotted none, with no key that brought
    // it back.
    for (const [width, height] of SIZES) {
      const l = layout(width, height);
      expect(l.caseHeight + l.alertsHeight + l.runsHeight).toBe(l.sidebarHeight);
      expect(l.sidebarHeight).toBeLessThanOrEqual(height - 2);
      expect(l.runsHeight).toBeGreaterThanOrEqual(RUNS_MIN_HEIGHT);
      if (l.narrow) expect(height - 2 - l.sidebarHeight).toBeGreaterThanOrEqual(10);
    }
  });

  test("keeps 120 columns exactly as it was, and spends the surplus above it on the sidebar", () => {
    // 120 is the width this console is read at, so the common case must not move. Above it the
    // sidebar grows, because it is the pane whose titles were being cut while the main pane had
    // width it was not using.
    expect(layout(120, 40).sidebarWidth).toBe(46);
    expect(layout(200, 40).sidebarWidth).toBeGreaterThan(46);
  });
});

describe("column balance", () => {
  test("cuts by height, not by meaning", () => {
    // The shape that showed the problem: a fourteen-line WHAT HAPPENED, two eight-line arguments,
    // and a fifty-line stack of evidence. Cut by meaning — context | argument | evidence — the
    // first column ran out after fourteen rows while the last kept going for sixty, which is not
    // two columns, it is one column and a hole.
    const heights = [14, 8, 8, 28, 24];
    const worst = (cuts: number[]): number => {
      let from = 0;
      let tallest = 0;
      for (const cut of cuts) {
        tallest = Math.max(
          tallest,
          heights.slice(from, cut).reduce((a, b) => a + b, 0),
        );
        from = cut;
      }
      return tallest;
    };

    expect(worst(balancedCuts(heights, 2))).toBeLessThanOrEqual(52);
    expect(worst(balancedCuts(heights, 3))).toBeLessThanOrEqual(30);
    // Reading order survives: the cuts are contiguous and cover every section exactly once.
    expect(balancedCuts(heights, 3).at(-1)).toBe(heights.length);
    // Never more columns than there are sections to put in them.
    expect(balancedCuts([10], 3)).toEqual([1]);
  });

  test("only splits when there is width for readable columns", () => {
    expect(columnCount(70)).toBe(1);
    expect(columnCount(120)).toBe(1);
    expect(columnCount(160)).toBe(2);
    expect(columnCount(400)).toBe(3);
  });
});
