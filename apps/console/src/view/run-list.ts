import type { RunArtifact, RunResult } from "../data/runs.ts";
import {
  clockTime,
  duration,
  truncate,
  verdictBand,
  type Tone,
  type VerdictBand,
} from "./format.ts";

export type RunState = "running" | "stale" | "completed" | "interrupted" | "failed";

/** Glyphs carry the state on their own; colour only reinforces it (PRD-3 §9.8). */
export const RUN_GLYPH: Record<RunState, string> = {
  running: "●",
  stale: "◌",
  completed: "✓",
  interrupted: "⚠",
  failed: "✗",
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
/**
 * The state as a word, for a sentence rather than a glyph.
 *
 * `RUN_GLYPH` covers the list rows. A message has to *say* it: "nothing to cancel" on its own reads
 * as a console that did not understand the key, where "01a01960 is already finished" reads as an
 * answer.
 */
export const RUN_STATE_WORD: Record<RunState, string> = {
  running: "still running",
  stale: "not writing any more",
  completed: "already finished",
  interrupted: "already interrupted",
  failed: "already failed",
};

export function runStateTone(state: RunState): Tone | undefined {
  switch (state) {
    case "running":
      return "running";
    case "stale":
      return "stale";
    case "failed":
      return "failed";
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
  // A sweep that died before investigating anything (PRD-5 §5.2). Checked here rather than left to
  // the pre-PRD-3 fallback below, which infers "finished" from the mere presence of `completedAt`
  // and would therefore render a startup failure as a clean completed run — the exact opposite of
  // why the status was recorded.
  if (run.status === "failed") return "failed";

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

/**
 * The sweep's headline.
 *
 * Sized by what the run set out to cover, not by what has finished: a single-alert run has no
 * finished result for as long as it takes — up to `limits.timeoutMs` — and labelling it "(no
 * alerts yet)" for those ten minutes described the artifact rather than the investigation. The
 * planned list carries the title, so a run is named from the moment it starts.
 *
 * "(no alerts yet)" survives for artifacts written before the planned list existed, where an
 * unfinished run genuinely has nothing to be named after.
 */
export function runLabel(run: RunArtifact): string {
  const planned = run.plannedAlerts ?? [];
  const covered = Math.max(run.results.length, run.alertCount ?? 0, planned.length);
  if (covered > 1) return `${covered} alerts`;
  const first = run.results[0] ?? planned[0];
  return first?.alertTitle ?? first?.alertId ?? "(no alerts yet)";
}

/**
 * The alerts a sweep is still working through, as rows the rest of the console can address.
 *
 * The artifact records `results` only when an alert *finishes*, so everything downstream of a
 * selected result — the transcript tail, the tab bar, pane [4] — had nothing to point at while an
 * investigation was in flight, and a single-alert run is entirely in flight until it is entirely
 * over. These rows exist only in the view: nothing writes a `running` result to disk, and the per
 * alert status on disk stays `completed | failed`.
 *
 * Only for a run whose artifact still claims to be running. An interrupted sweep's unstarted
 * alerts are not pending, they are abandoned, and showing them as live work on a dead run would
 * be the same lie `classifyRun` exists to avoid (PRD-3 §10.2).
 */
export function pendingResults(run: RunArtifact | undefined): RunResult[] {
  if (run === undefined || run.status !== "running") return [];
  const finished = new Set(run.results.map((result) => result.alertId));
  const pending: RunResult[] = [];
  for (const planned of run.plannedAlerts ?? []) {
    if (finished.has(planned.alertId)) continue;
    const row: RunResult = { alertId: planned.alertId, status: "running" };
    if (planned.alertTitle !== undefined) row.alertTitle = planned.alertTitle;
    pending.push(row);
  }
  return pending;
}

/** A run's alerts: what has finished, then what it is still working through, in planned order. */
export function resultsWithPending(run: RunArtifact | undefined): RunResult[] {
  if (run === undefined) return [];
  return [...run.results, ...pendingResults(run)];
}

/** A row synthesised by `pendingResults`, rather than an outcome the investigator wrote. */
export function isPending(result: RunResult): boolean {
  return result.status === "running";
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
  /** Still being investigated — a `pendingResults` row, with no outcome of its own yet. */
  pending: boolean;
  glyph: string;
  tpPercent?: number;
  band: VerdictBand;
  impact?: string;
  detail: string;
}

export function toResultRow(result: RunResult, width = 44): ResultRow {
  const failed = result.status === "failed";
  const pending = isPending(result);
  const tpPercent = result.summary?.tpPercent;
  return {
    alertId: result.alertId,
    title: truncate(result.alertTitle ?? result.alertId, width),
    failed,
    pending,
    // The same glyph the run list gives a live run, for the same reason: this row is one, and its
    // outcome is not a quiet "✓" that happens to have no verdict beside it (PRD-3 §9.8).
    glyph: pending ? RUN_GLYPH.running : failed ? "✗" : "✓",
    ...(tpPercent === undefined ? {} : { tpPercent }),
    band: verdictBand(tpPercent),
    ...(result.summary?.impact === undefined ? {} : { impact: result.summary.impact }),
    detail: pending
      ? "investigating"
      : failed
        ? (result.error?.name ?? "failed")
        : duration(result.durationMs),
  };
}
