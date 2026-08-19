import { mkdir } from "node:fs/promises";
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
  await Bun.write(path, `${JSON.stringify(validated, null, 2)}\n`);
  return path;
}
