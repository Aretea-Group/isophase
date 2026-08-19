import type { RunArtifact, RunResult } from "../data/runs.ts";
import {
  clockTime,
  duration,
  truncate,
  verdictBand,
  type Tone,
  type VerdictBand,
} from "./format.ts";

export type RunState = "running" | "stale" | "completed" | "interrupted";

/** Glyphs carry the state on their own; colour only reinforces it (PRD-3 §9.8). */
export const RUN_GLYPH: Record<RunState, string> = {
  running: "●",
  stale: "◌",
  completed: "✓",
  interrupted: "⚠",
};

/**
 * Grace added to a run's own per-alert ceiling before it is called stale.
 *
 * The threshold is derived from the run rather than fixed. PRD-3 §10.2 asks for "several minutes",
 * but the artifact is only flushed between alerts and one alert may legitimately take up to
 * `limits.timeoutMs` — 600 s by default. A fixed few-minute threshold would therefore report a
 * perfectly healthy sweep as stale whenever tracing was off. Waiting out the ceiling the run was
 * actually configured with keeps the intent — a dead run stops being shown as active — without
 * that false positive.
 */
const STALE_GRACE_MS = 60_000;
const FALLBACK_TIMEOUT_MS = 600_000;

/** A run's state, as a tone. The glyph in `RUN_GLYPH` carries it without colour (PRD-3 §9.8). */
export function runStateTone(state: RunState): Tone | undefined {
  switch (state) {
    case "running":
      return "running";
    case "stale":
      return "stale";
    case "interrupted":
      return "inconclusive";
    default:
      return "ok";
  }
}

export interface LivenessInput {
  run: RunArtifact;
  now: number;
  /** Whether this run's transcript is still growing. Only known when tracing was on. */
  traceGrowing?: boolean;
}

/**
 * What the run list should say about a run.
 *
 * `status: "running"` is a claim about a process that may no longer exist: a sweep killed outright
 * never writes `completed` or `interrupted`. Rather than reclassify it as finished — the console
 * cannot know whether it finished — a run that has stopped moving is reported as stale, with the
 * time it was last written (PRD-3 §10.2).
 */
export function classifyRun(input: LivenessInput): RunState {
  const { run, now, traceGrowing } = input;

  if (run.status === "completed") return "completed";
  if (run.status === "interrupted") return "interrupted";

  if (run.status === "running") {
    if (traceGrowing === true) return "running";
    const lastWritten = Date.parse(run.completedAt ?? "");
    if (Number.isNaN(lastWritten)) return "stale";
    const ceiling = (run.limits?.timeoutMs ?? FALLBACK_TIMEOUT_MS) + STALE_GRACE_MS;
    return now - lastWritten <= ceiling ? "running" : "stale";
  }

  // Written before PRD-3 added the lifecycle: the artifact only ever appeared once the sweep had
  // finished, so its absence means finished — unless a transcript says otherwise.
  return traceGrowing === true ? "running" : "completed";
}

export interface RunRow {
  runId: string;
  state: RunState;
  glyph: string;
  model: string;
  /** The sweep's headline: its single alert's title, or a count when it covers several. */
  label: string;
  tpPercent?: number;
  band: VerdictBand;
  impact?: string;
  /** Finished alerts, and how many the sweep set out to cover when it recorded that. */
  done: number;
  planned?: number;
  /** Elapsed time for a finished single-alert run, or "last written" while one is in flight. */
  detail: string;
}

export function runLabel(run: RunArtifact): string {
  const first = run.results[0];
  if (run.results.length === 1 && first?.alertTitle !== undefined) return first.alertTitle;
  if (run.results.length > 1) return `${run.results.length} alerts`;
  return first?.alertTitle ?? first?.alertId ?? "(no alerts yet)";
}

export function toRunRow(input: LivenessInput): RunRow {
  const { run } = input;
  const state = classifyRun(input);
  const only = run.results.length === 1 ? run.results[0] : undefined;
  const tpPercent = only?.summary?.tpPercent;

  const detail =
    state === "running" || state === "stale"
      ? `last written ${clockTime(run.completedAt)}`
      : duration(only?.durationMs);

  return {
    runId: run.runId,
    state,
    glyph: RUN_GLYPH[state],
    model: run.model?.id ?? "—",
    label: runLabel(run),
    ...(tpPercent === undefined ? {} : { tpPercent }),
    band: verdictBand(tpPercent),
    ...(only?.summary?.impact === undefined ? {} : { impact: only.summary.impact }),
    done: run.results.length,
    ...(run.alertCount === undefined ? {} : { planned: run.alertCount }),
    detail,
  };
}

/** Alerts pending in a sweep that is still going (PRD-3 §11). */
export function pendingCount(run: RunArtifact): number | undefined {
  if (run.alertCount === undefined) return undefined;
  return Math.max(0, run.alertCount - run.results.length);
}

export interface ResultRow {
  alertId: string;
  title: string;
  failed: boolean;
  glyph: string;
  tpPercent?: number;
  band: VerdictBand;
  impact?: string;
  detail: string;
}

export function toResultRow(result: RunResult, width = 44): ResultRow {
  const failed = result.status === "failed";
  const tpPercent = result.summary?.tpPercent;
  return {
    alertId: result.alertId,
    title: truncate(result.alertTitle ?? result.alertId, width),
    failed,
    glyph: failed ? "✗" : "✓",
    ...(tpPercent === undefined ? {} : { tpPercent }),
    band: verdictBand(tpPercent),
    ...(result.summary?.impact === undefined ? {} : { impact: result.summary.impact }),
    detail: failed ? (result.error?.name ?? "failed") : duration(result.durationMs),
  };
}
