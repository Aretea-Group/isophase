import { z } from "zod";

/**
 * The classifications an analyst can reach about an alert (PRD-10 §4.1 D7).
 *
 * Lifted out of the console's feedback capture when PRD-10 Phase 0 removed it. The feature went;
 * this did not, because the vocabulary is not the console's invention — it is the set Microsoft
 * Sentinel closes incidents on, minus the two false-positive variants it distinguishes and this
 * project does not. Re-deriving it later from the same documentation is the waste D7 exists to
 * avoid.
 *
 * Nothing in the investigation path writes these today: PRD-10 §4.1 D5 fixes publication as additive
 * comment text and never a state change, so this is vocabulary held for a future decision rather
 * than a field in flight.
 */
export const AnalystClassification = z.enum([
  "TruePositive",
  "BenignPositive",
  "FalsePositive",
  "Undetermined",
]);
export type AnalystClassification = z.infer<typeof AnalystClassification>;

/**
 * The longest comment Microsoft Sentinel documents for an **alert**.
 *
 * Kept beside the vocabulary because the two were derived together. **Not the limit that applies to
 * publication** — see below; conflating them cost a live run.
 */
export const ALERT_COMMENT_MAX_CHARS = 30_000;

/**
 * The longest comment Microsoft Graph accepts on an **incident** — measured, not documented.
 *
 * `POST /security/incidents/{id}/comments` with 2,913 characters returns
 * `Maximum comment length is 1000 characters, received 2913.` The alert bound above is thirty times
 * larger and applies to a different object; assuming one covered both is what produced that error
 * on a live tenant (ADR 013 §8).
 *
 * A thousand characters is a *comment*, not a report. The renderer treats it as a hard constraint on
 * form rather than something to truncate a long body into: see `findingsComment`.
 */
export const INCIDENT_COMMENT_MAX_CHARS = 1_000;
