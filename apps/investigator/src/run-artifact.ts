import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { InvestigationRun } from "./contracts/run.ts";

/**
 * Write the run artifact.
 *
 * Validated on the way out: the artifact is the durable product of a run and the input to every
 * later comparison against ground truth, so a malformed one should fail loudly here rather than
 * confuse an evaluator weeks later.
 */
export async function writeRunArtifact(directory: string, run: InvestigationRun): Promise<string> {
  const validated = InvestigationRun.parse(run);
  await mkdir(directory, { recursive: true });

  const path = join(directory, `${validated.runId}.json`);

  // Written beside the target and renamed over it, rather than truncated in place. PRD-3 flushes
  // this artifact after every alert while the analyst console polls the directory once a second
  // (PRD-3 §7, §10.2), so an in-place rewrite would make torn reads routine rather than
  // exceptional. A same-directory rename is atomic, so a reader sees either the previous artifact
  // or the next one — never half of either, and never a parse error from a healthy run.
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
