import { z } from "zod";

/**
 * Scenario metadata — the answer key (PRD-1 §5).
 *
 * **Nothing in `src/routes/` may import this module.** These records state the
 * correct verdict for a starting alert, and an agent able to fetch them does not
 * have to investigate anything. `test/scenarios.test.ts` asserts that no route
 * exposes scenario data, and that assertion is the point of the file.
 *
 * The metadata is layered over the shared telemetry; no scenario duplicates any
 * data. It exists to make a future agent's answer *checkable* — without a
 * recorded expected outcome, an autonomous investigation can only be judged by
 * reading it, which does not scale and is not repeatable.
 */

/** Was the detected activity real and malicious? */
export const ScenarioVerdict = z.enum(["true-positive", "false-positive", "inconclusive"]);
export type ScenarioVerdict = z.infer<typeof ScenarioVerdict>;

/**
 * Did the activity achieve anything?
 *
 * Deliberately separate from the verdict. A detection can be completely correct
 * about genuinely malicious activity that nonetheless accomplished nothing —
 * the `SOC-FW-RDP` brute force is exactly that — and collapsing the two is the
 * single most common triage error these scenarios exist to catch.
 */
export const ScenarioImpact = z.enum(["none", "contained", "confirmed-compromise", "unknown"]);
export type ScenarioImpact = z.infer<typeof ScenarioImpact>;

export const DiscriminatingEvidence = z.object({
  /** What the analyst is trying to establish. */
  question: z.string().min(1),
  /** A query that settles it. */
  kql: z.string().min(1),
  /** What that query should show. */
  expected: z.string().min(1),
});
export type DiscriminatingEvidence = z.infer<typeof DiscriminatingEvidence>;

export const Scenario = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /** `SystemAlertId` the investigation starts from. */
  startingAlertId: z.string().min(1),
  sourceData: z.string().min(1),
  verdict: ScenarioVerdict,
  impact: ScenarioImpact,
  summary: z.string().min(1),
  keyEntities: z.array(z.string()).min(1),
  /**
   * The queries that decide the outcome. An investigation that never covers
   * this ground cannot be right except by luck, which makes this the useful
   * thing to score against — more so than the final verdict alone.
   */
  discriminatingEvidence: z.array(DiscriminatingEvidence).min(1),
  /** The wrong conclusion this scenario is built to catch. */
  trap: z.string().min(1),
  evaluatorNotes: z.string().min(1),
});
export type Scenario = z.infer<typeof Scenario>;

/** Absolute path to `fixtures/scenarios/`. */
export const SCENARIOS_DIR = new URL("../../../../fixtures/scenarios/", import.meta.url).pathname;

/**
 * Loads and validates every scenario.
 *
 * Validation matters because these files pin `startingAlertId` values that are
 * content-addressed hashes of rule output. Change a rule and the hash moves;
 * the integration test resolves each id against the live database, which turns
 * that fragility into drift detection.
 */
export async function loadScenarios(): Promise<Scenario[]> {
  const glob = new Bun.Glob("*.json");
  const scenarios: Scenario[] = [];

  for await (const file of glob.scan({ cwd: SCENARIOS_DIR, absolute: true })) {
    const parsed = Scenario.safeParse(await Bun.file(file).json());
    if (!parsed.success) {
      throw new Error(`Invalid scenario ${file}:\n${z.prettifyError(parsed.error)}`);
    }
    scenarios.push(parsed.data);
  }

  if (scenarios.length === 0) {
    throw new Error(`No scenarios found under ${SCENARIOS_DIR}`);
  }
  return scenarios.toSorted((a, b) => a.id.localeCompare(b.id));
}
