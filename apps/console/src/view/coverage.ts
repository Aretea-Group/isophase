import type { QueueAlert } from "../data/alerts.ts";
import type { RunArtifact } from "../data/runs.ts";
import type { Tone } from "./format.ts";

/**
 * What has been tried against an alert (PRD-5 §7).
 *
 * Derived, never stored. The set of alerts with no run is `listAlerts()` folded against the run
 * artifacts already in memory — a pure function over two things the console reads anyway. It holds
 * no state, owns no invalidation, and is correct across a restart for free. A queue *table* would
 * make the console the owner of a truth it does not produce (PRD-5 §4.2).
 */
export type CoverageState = "no-run" | "in-flight" | "investigated" | "attempted";

export interface Coverage {
  state: CoverageState;
  /** How many runs have covered this alert, finished or not. */
  runCount: number;
  /**
   * False when every run covering this alert carried analyst context.
   *
   * Queue honesty, not benchmarking: without it the pane reports an alert as handled when the only
   * thing that ever ran against it was a steered experiment, in the one view an analyst uses to
   * decide what to work on next. It interprets nothing and feeds no score (PRD-5 §4.5).
   */
  baseline: boolean;
}

export const COVERAGE_GLYPH: Record<CoverageState, string> = {
  "no-run": " ",
  "in-flight": "●",
  investigated: "✓",
  attempted: "✗",
};

/** Glyphs carry the state on their own; colour only reinforces it (PRD-3 §9.8). */
export function coverageTone(coverage: Coverage): Tone | undefined {
  switch (coverage.state) {
    case "in-flight":
      return "running";
    case "investigated":
      return coverage.baseline ? "ok" : "dim";
    case "attempted":
      return "failed";
    default:
      return undefined;
  }
}

export function coverageGlyph(coverage: Coverage): string {
  const glyph = COVERAGE_GLYPH[coverage.state];
  // A steered-only investigation is still an investigation, but it should not read as one.
  return coverage.state === "investigated" && !coverage.baseline ? "✓·" : glyph;
}

interface AlertCoverageAccumulator {
  finished: number;
  failed: number;
  planned: number;
  runCount: number;
  steeredOnly: boolean;
}

/**
 * Fold every run over every alert, once.
 *
 * `in-flight` reads `plannedAlerts` — the artifact records which alerts a sweep set out to cover,
 * so an alert being worked on right now is visible before its first result exists. Gated on
 * `status === "running"` so a finished or interrupted sweep never leaves an alert looking live.
 *
 * `attempted` is load-bearing: an alert whose every run failed must not read the same as one never
 * tried, because hiding a crashed investigation is the one outcome that silently loses work.
 */
export function coverageByAlert(runs: RunArtifact[]): Map<string, Coverage> {
  const accumulators = new Map<string, AlertCoverageAccumulator>();

  const touch = (alertId: string): AlertCoverageAccumulator => {
    const existing = accumulators.get(alertId);
    if (existing !== undefined) return existing;
    const created: AlertCoverageAccumulator = {
      finished: 0,
      failed: 0,
      planned: 0,
      runCount: 0,
      steeredOnly: true,
    };
    accumulators.set(alertId, created);
    return created;
  };

  for (const run of runs) {
    const steered = run.config?.analystContext !== undefined && run.config.analystContext !== "";
    const seen = new Set<string>();

    for (const result of run.results) {
      const accumulator = touch(result.alertId);
      seen.add(result.alertId);
      if (result.status === "failed") accumulator.failed += 1;
      else accumulator.finished += 1;
      if (!steered) accumulator.steeredOnly = false;
    }

    if (run.status === "running") {
      for (const planned of run.plannedAlerts ?? []) {
        if (seen.has(planned.alertId)) continue;
        const accumulator = touch(planned.alertId);
        accumulator.planned += 1;
        seen.add(planned.alertId);
        if (!steered) accumulator.steeredOnly = false;
      }
    }

    for (const alertId of seen) touch(alertId).runCount += 1;
  }

  const coverage = new Map<string, Coverage>();
  for (const [alertId, accumulator] of accumulators) {
    const state: CoverageState =
      accumulator.planned > 0
        ? "in-flight"
        : accumulator.finished > 0
          ? "investigated"
          : accumulator.failed > 0
            ? "attempted"
            : "no-run";
    coverage.set(alertId, {
      state,
      runCount: accumulator.runCount,
      baseline: !accumulator.steeredOnly,
    });
  }
  return coverage;
}

const NO_RUN: Coverage = { state: "no-run", runCount: 0, baseline: true };

export function coverageFor(coverage: Map<string, Coverage>, alertId: string): Coverage {
  return coverage.get(alertId) ?? NO_RUN;
}

export interface DuplicateSpend {
  otherAlerts: number;
  withRun: number;
}

/**
 * A narrow warning about likely duplicate spend, not an alert-grouping model.
 *
 * The corpus does not expose a trustworthy vendor correlation id, so this deliberately uses only
 * the exact entity and one-second window stated by PRD-5. Nothing is persisted or folded together.
 */
export function duplicateSpend(
  selected: QueueAlert,
  alerts: QueueAlert[],
  runs: RunArtifact[],
): DuplicateSpend | undefined {
  if (selected.compromisedEntity === undefined) return undefined;
  const selectedAt = Date.parse(selected.startTimeUtc);
  if (!Number.isFinite(selectedAt)) return undefined;

  const coverage = coverageByAlert(runs);
  const matches = alerts.filter((candidate) => {
    if (candidate.alertId === selected.alertId) return false;
    if (candidate.compromisedEntity !== selected.compromisedEntity) return false;
    const candidateAt = Date.parse(candidate.startTimeUtc);
    return Number.isFinite(candidateAt) && Math.abs(candidateAt - selectedAt) <= 1_000;
  });

  if (matches.length === 0) return undefined;
  return {
    otherAlerts: matches.length,
    withRun: matches.filter((candidate) => coverageFor(coverage, candidate.alertId).runCount > 0)
      .length,
  };
}

export interface QueueRow {
  alertId: string;
  /** The scenario id when ground truth exists, blank otherwise. Never carries a verdict. */
  groundTruth: string;
  severity: string;
  vendorStatus: string;
  title: string;
  coverage: Coverage;
  glyph: string;
  tone: Tone | undefined;
}

/**
 * Alerts still needing work: never investigated, or investigated and every run failed.
 *
 * `attempted` counts as outstanding on purpose. It has a run, but the run produced nothing, and
 * treating "has a run" as "done" would hide a crashed investigation — the one outcome that
 * silently loses work.
 */
function isOutstanding(coverage: Coverage): boolean {
  return coverage.state === "no-run" || coverage.state === "attempted";
}

export function queueRows(
  alerts: QueueAlert[],
  runs: RunArtifact[],
  options: { groundTruthOnly?: boolean; outstandingOnly?: boolean } = {},
): QueueRow[] {
  const coverage = coverageByAlert(runs);
  return alerts
    .filter((alert) => options.groundTruthOnly !== true || alert.scenarioId !== undefined)
    .filter(
      (alert) =>
        options.outstandingOnly !== true || isOutstanding(coverageFor(coverage, alert.alertId)),
    )
    .map((alert) => {
      const alertCoverage = coverageFor(coverage, alert.alertId);
      return {
        alertId: alert.alertId,
        groundTruth: alert.scenarioId ?? "",
        severity: alert.severity,
        vendorStatus: alert.vendorStatus,
        title: alert.title,
        coverage: alertCoverage,
        glyph: coverageGlyph(alertCoverage),
        tone: coverageTone(alertCoverage),
      };
    });
}

/**
 * The header count, with the caveat it cannot honestly be shown without.
 *
 * 107 of the corpus's alerts are two vendor views of the same 54 endpoint events, so a bare count
 * overstates outstanding work by roughly fifty — exactly the authoritative-looking number PRD-3
 * §4.4 forbids. Dedupe itself is not built: `vendorOriginalId` is broken in the vendored CSV, so
 * any grouping would be a corpus-fitted heuristic.
 */
export function queueHeadline(rows: QueueRow[]): string {
  const withoutRun = rows.filter((row) => row.coverage.state === "no-run").length;
  const groundTruth = rows.filter((row) => row.groundTruth !== "").length;
  return `${withoutRun} of ${rows.length} with no run · ${groundTruth} with ground truth · duplicates not folded`;
}
