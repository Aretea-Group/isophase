import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

/**
 * The console's only filesystem write primitive (PRD-5 §14).
 *
 * `drive/` is the one directory the write-isolation scan excludes, which is exactly why everything
 * here is small, pure where it can be, and unit-tested on its hostile inputs. The investigator
 * remains the sole writer of `runs/*.json` and `runs/traces/**`; this writes under `feedback/` and
 * nowhere else.
 */

export const AnalystClassification = z.enum([
  "TruePositive",
  "BenignPositive",
  "FalsePositive",
  "Undetermined",
]);

export const AnalystFeedback = z.object({
  /**
   * Present from the first record, and one of the three things that make this "wired for memory"
   * at no cost — the others being the analyst's own words and a stable (runId, alertId) key.
   */
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  alertId: z.string().min(1),
  at: z.iso.datetime(),
  classification: AnalystClassification,
  /** Capped at Sentinel's own documented bound for an alert comment. */
  comment: z.string().max(30_000).optional(),
  analyst: z.string().optional(),
  /**
   * Frozen, and not optional in spirit (PRD-5 §10).
   *
   * The record otherwise points at a file that is rewritten in place, and six months later would
   * say the analyst disagreed with a verdict that is no longer there.
   */
  agentAssessment: z.object({
    tpPercent: z.number().optional(),
    model: z.string().optional(),
  }),
});

export type AnalystFeedback = z.infer<typeof AnalystFeedback>;

/** Ids come from artifacts, but this writes a path, so they are treated as untrusted anyway. */
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

/**
 * `feedback/<runId>-<alertId>.json`, and never anything else.
 *
 * A separate root from `runs/`: `.gitignore` documents `runs/` as regenerable developer scratch, so
 * `rm -rf runs/` is a documented-safe action and storing the only copy of unreproducible human
 * judgement inside it would be a straightforward error. It also keeps "the console never writes
 * under runs/" literally true rather than resting on a glob's non-recursion.
 */
export function feedbackPath(directory: string, runId: string, alertId: string): string {
  if (!SAFE_ID.test(runId) || !SAFE_ID.test(alertId)) {
    throw new Error("Feedback ids must be alphanumeric with . _ - only.");
  }
  return join(directory, `${runId}-${alertId}.json`);
}

/**
 * Write one classification, last-write-wins per `(runId, alertId)`.
 *
 * Renamed into place for the same reason the run artifact is: a reader polling the directory should
 * see either the previous record or the next one, never half of either.
 */
export async function writeFeedback(directory: string, feedback: AnalystFeedback): Promise<string> {
  const validated = AnalystFeedback.parse(feedback);
  const path = feedbackPath(directory, validated.runId, validated.alertId);
  await mkdir(directory, { recursive: true });

  const temporary = join(directory, `.${validated.runId}.${process.pid}.tmp`);
  try {
    await Bun.write(temporary, `${JSON.stringify(validated, null, 2)}\n`);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return path;
}
