import { join } from "node:path";

import { z } from "zod";

/**
 * The console's own view of the run artifact.
 *
 * Deliberately not imported from `apps/investigator`: the artifact is the contract between them,
 * not the module (ADR 006 §3). Deliberately looser than the investigator's schema as well, because
 * this reads files written by earlier versions of a schema that is still moving, and a strict parse
 * would turn a historical run into an error page. `scripts/evaluate-runs.ts` set that precedent.
 *
 * Every optional field is read on its own rather than by detecting a "shape". Two shapes exist on
 * disk today — `impact`/`researchDone` and the legacy `nextAction` — but they are independently
 * optional in the producing schema, so a third is one amendment away (PRD-3 §6.1).
 */
const Summary = z.object({
  tpPercent: z.number().optional(),
  tpReason: z.string().optional(),
  fpPercent: z.number().optional(),
  fpReason: z.string().optional(),
  whatHappened: z.string().optional(),
  impact: z.string().optional(),
  keyEvidence: z.array(z.string()).optional(),
  researchDone: z.array(z.string()).optional(),
  /** Present only on artifacts written before `researchDone` replaced it (ADR 005 §1). */
  nextAction: z.string().optional(),
});

/** Triage facts about the alert itself, written by PRD-3's investigator (PRD-3 §6.1). */
const Alert = z.object({
  severity: z.string().optional(),
  startTimeUtc: z.string().optional(),
  endTimeUtc: z.string().optional(),
  timeGenerated: z.string().optional(),
  tactics: z.array(z.string()).optional(),
  techniques: z.array(z.string()).optional(),
  compromisedEntity: z.string().optional(),
  alertType: z.string().optional(),
});

const Result = z.object({
  alertId: z.string(),
  alertTitle: z.string().optional(),
  /** Per alert: `completed | failed`. Never the sweep's lifecycle — see `RunArtifact.status`. */
  status: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  durationMs: z.number().optional(),
  /** Absent on artifacts written before PRD-3; the console falls back to the transcript. */
  alert: Alert.optional(),
  summary: Summary.optional(),
  error: z.object({ name: z.string(), message: z.string() }).optional(),
});

const Artifact = z.object({
  runId: z.string().min(1),
  startedAt: z.string().optional(),
  /** "Last written", not "finished" — the investigator flushes after every alert (PRD-3 §7). */
  completedAt: z.string().optional(),
  /** The sweep's lifecycle: `running | completed | interrupted`. Absent before PRD-3. */
  status: z.string().optional(),
  alertCount: z.number().optional(),
  traceDir: z.string().optional(),
  config: z
    .object({
      thinkingLevel: z.string().optional(),
      resultMaxChars: z.number().optional(),
      sentinelBaseUrl: z.string().optional(),
      webSearchConfigured: z.boolean().optional(),
    })
    .optional(),
  model: z.object({ provider: z.string().optional(), id: z.string().optional() }).optional(),
  limits: z
    .object({ maxTurns: z.number().optional(), timeoutMs: z.number().optional() })
    .optional(),
  results: z.array(Result).default([]),
});

export type RunAlert = z.infer<typeof Alert>;
export type RunSummary = z.infer<typeof Summary>;
export type RunResult = z.infer<typeof Result>;
export type RunArtifact = z.infer<typeof Artifact>;

/** A file that could not be read. Surfaced as a row rather than swallowed (PRD-3 §11). */
export interface UnreadableRun {
  path: string;
  issue: string;
}

export interface RunsSnapshot {
  runs: RunArtifact[];
  unreadable: UnreadableRun[];
}

function describe(error: unknown): string {
  if (error instanceof z.ZodError) {
    const first = error.issues[0];
    return first === undefined
      ? "did not match the run artifact shape"
      : `${first.path.join(".") || "(root)"}: ${first.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function readRun(path: string): Promise<RunArtifact | UnreadableRun> {
  try {
    return Artifact.parse(await Bun.file(path).json());
  } catch (error) {
    return { path, issue: describe(error) };
  }
}

function isUnreadable(value: RunArtifact | UnreadableRun): value is UnreadableRun {
  return "issue" in value;
}

/**
 * Read every run artifact in a directory, newest first.
 *
 * `runId` is a UUIDv7, so a lexicographic sort is chronological and does not depend on any
 * timestamp inside the file being present or well formed.
 */
export async function readRuns(directory: string): Promise<RunsSnapshot> {
  const paths: string[] = [];
  try {
    for (const name of new Bun.Glob("*.json").scanSync({ cwd: directory })) {
      paths.push(join(directory, name));
    }
  } catch (error) {
    // A directory that cannot be scanned is reported, not swallowed. Returning an empty snapshot
    // made a mistyped `--runs` indistinguishable from a machine that has never run an
    // investigation, and those two want very different things from the reader.
    return {
      runs: [],
      unreadable: [
        { path: directory, issue: error instanceof Error ? error.message : "cannot be read" },
      ],
    };
  }

  const read = await Promise.all(paths.toSorted().map(readRun));
  const runs = read.filter((value): value is RunArtifact => !isUnreadable(value));
  const unreadable = read.filter(isUnreadable);
  runs.reverse();
  return { runs, unreadable };
}
