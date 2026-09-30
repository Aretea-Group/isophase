import { describe, expect, test } from "bun:test";

import { ALERT_COMMENT_MAX_CHARS, AnalystClassification } from "../src/index.ts";

/**
 * PRD-10 AC2 — the vocabulary survived the feature that carried it.
 *
 * Phase 0 deleted the console's feedback capture, where these lived. Asserting the four members
 * from the package barrel is the check that the lift in §4.1 D7 actually happened, rather than the
 * enum leaving with `drive/feedback.ts`.
 */
describe("analyst classification vocabulary", () => {
  test("Given @soc/contracts, When AnalystClassification is imported, Then it exports exactly the four members", () => {
    expect(AnalystClassification.options).toEqual([
      "TruePositive",
      "BenignPositive",
      "FalsePositive",
      "Undetermined",
    ]);
  });

  test("Given a value outside the four, When it is parsed, Then it is rejected", () => {
    expect(AnalystClassification.safeParse("TruePositive").success).toBe(true);
    // Sentinel distinguishes two false-positive variants; this project does not, and a value that
    // looks plausible is exactly the one that would slip in unnoticed.
    expect(AnalystClassification.safeParse("FalsePositiveIncorrectAlertLogic").success).toBe(false);
  });

  test("Given the documented Sentinel bound, When the comment cap is read, Then it is 30,000 characters", () => {
    expect(ALERT_COMMENT_MAX_CHARS).toBe(30_000);
  });
});
