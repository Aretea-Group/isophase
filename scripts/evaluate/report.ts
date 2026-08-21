import { createHash } from "node:crypto";

import type { InvestigationRun } from "../../apps/investigator/src/contracts/run.ts";
import type { Scenario } from "../../apps/mock-sentinel/src/scenarios/scenarios.ts";
import { type Condition, conditionOf, fieldDiff } from "./condition.ts";
import {
  BANDS,
  bandOk,
  type CellScore,
  cellScore,
  LEGACY_BANDS,
  type Target,
  targetFor,
  type Verdict,
} from "./scoring.ts";

/**
 * Turning a set of run artifacts into cells (PRD-6 §6.5).
 *
 * Everything here is a pure function of the artifacts and the scenarios. `evaluate-runs.ts` does
 * the I/O and the printing; this decides what the numbers are, which is what makes the numbers
 * testable without a terminal.
 */

/** One answer to one scenario under one condition. Never overwritten, never deduplicated. */
export interface Draw {
  conditionId: string;
  scenarioId: string;
  runId: string;
  /** `undefined` when the investigation failed — see `failedDrawProbability`. */
  tpPercent?: number;
  actualImpact?: string;
  durationMs: number;
  status: "completed" | "failed";
  errorName?: string;
  turns?: number;
  toolCalls?: Record<string, number>;
  costUsd?: number;
  totalTokens?: number;
}

export interface Cell {
  conditionId: string;
  scenarioId: string;
  verdict: Verdict;
  expectedImpact: string;
  target: Target;
  draws: Draw[];
  /** The percentages that entered the score, failures included at the base rate. */
  probabilities: number[];
  score: CellScore;
  bandPass: boolean;
  legacyBandPass: boolean;
  impactOk: number;
  impactScored: number;
  failed: number;
}

export interface ConditionReport {
  condition: Condition;
  cells: Cell[];
  runIds: string[];
  /** Runs that produced no draw at all — a whole condition that failed to start. */
  runLevelFailures: { runId: string; errorName: string }[];
  covered: number;
  draws: number;
  failedDraws: number;
  brier: number;
  referenceBrier: number;
  skill: number;
  bandDirection: number;
  legacyBandDirection: number;
  meanDurationMs: number;
  totalCostUsd?: number;
}

/**
 * A run and the run it was derived from, scored on the scenarios they share (PRD-6 §6.11).
 *
 * This is the highest-value comparison in the report and the only one that is matched *by
 * construction*: an analyst re-ran one alert having changed one thing, so every other variable is
 * held still without anyone having to arrange it. A condition table cannot show it, because a
 * premise is written about a specific alert and most steered conditions are therefore one scenario
 * wide — the result is the paired delta, not a one-cell skill figure that looks like a model score.
 */
export interface DerivedPair {
  childRunId: string;
  parentRunId: string;
  childConditionId: string;
  parentConditionId?: string;
  /**
   * What changed besides the premise. Non-empty means the pair measures nothing in particular.
   *
   * The one `derivedFrom` pair on disk is a steered re-run of a **luna** parent under
   * `claude-haiku-4-5` — two variables at once. The report names that rather than PRD-5 constraining
   * what a re-run may change: the console should stay free, and the benchmark should be the thing
   * that notices (PRD-6 §12 Q6).
   */
  changedBeyondPremise: string[];
  scenarios: {
    scenarioId: string;
    verdict: Verdict;
    parentDraws: number[];
    childDraws: number[];
    parentScore: number;
    childScore: number;
  }[];
}

export interface SkippedRun {
  file: string;
  reason: string;
}

export interface Buckets {
  /** 140 of the 154 alerts have no ground truth. Silent, and correct. */
  noGroundTruth: number;
  /** Completed but carrying no summary — counted and reported, never silently dropped. */
  noSummary: number;
  failed: number;
  scored: number;
}

/**
 * A failed investigation answers the base rate (PRD-6 §6.5).
 *
 * It therefore lands at exactly zero skill, needs no special case anywhere in aggregation, and
 * raises the denominator — which is the whole point. Dropping failures let a model that timed out
 * on 13 of 14 alerts print `direction 1/1` with a *better* mean latency, because the 600 s timeouts
 * were absent from both.
 */
export function failedDrawProbability(baseRate: number): number {
  return baseRate * 100;
}

function isVerdict(value: string): value is Verdict {
  return value === "true-positive" || value === "false-positive" || value === "inconclusive";
}

/** A stable name for the exact set a number was computed over (PRD-6 §6.9). */
export function runSetFingerprint(runIds: readonly string[]): string {
  return createHash("sha256")
    .update([...runIds].toSorted().join("\n"))
    .digest("hex")
    .slice(0, 12);
}

export interface BuildInput {
  runs: InvestigationRun[];
  scenarios: Scenario[];
  baseRate: number;
}

export interface BuiltReport {
  conditions: ConditionReport[];
  buckets: Buckets;
  /** Alert ids that appeared in a run and matched no scenario — D7's silent zero, made loud. */
  unjoinedAlertIds: string[];
  conditionsById: Map<string, Condition>;
  drawsByRun: Map<string, Draw[]>;
  pairs: DerivedPair[];
}

/**
 * Group every run into `(condition, scenario)` cells holding every repeat.
 *
 * Three things this deliberately does not do, each of which was a defect:
 * it does not key on `model.id` (**D1**), it does not keep only the latest draw per scenario
 * (**D2**), and it does not skip steered runs (**D10**) — a premise is part of the condition, so a
 * steered run cannot contaminate a baseline cell without also being a different condition.
 */
export function buildReport(input: BuildInput): BuiltReport {
  const { runs, scenarios, baseRate } = input;
  const byAlert = new Map(scenarios.map((scenario) => [scenario.startingAlertId, scenario]));
  const buckets: Buckets = { noGroundTruth: 0, noSummary: 0, failed: 0, scored: 0 };
  const unjoined = new Set<string>();

  const conditionsById = new Map<string, Condition>();
  const runsByCondition = new Map<string, string[]>();
  const drawsByCell = new Map<string, Draw[]>();
  const drawsByRun = new Map<string, Draw[]>();
  const runLevelFailures = new Map<string, { runId: string; errorName: string }[]>();
  const conditionByRun = new Map<string, string>();
  const derived: { childRunId: string; parentRunId: string }[] = [];

  for (const run of runs) {
    const condition = conditionOf(run);
    conditionByRun.set(run.runId, condition.id);
    if (run.derivedFrom !== undefined) {
      derived.push({ childRunId: run.runId, parentRunId: run.derivedFrom.runId });
    }
    conditionsById.set(condition.id, condition);
    runsByCondition.set(condition.id, [...(runsByCondition.get(condition.id) ?? []), run.runId]);

    // A sweep that died before investigating anything (PRD-5 §5.2) is a condition with no draws,
    // not an absence. Without this a whole configuration can fail and the report say nothing.
    if (run.status === "failed" && run.results.length === 0) {
      runLevelFailures.set(condition.id, [
        ...(runLevelFailures.get(condition.id) ?? []),
        { runId: run.runId, errorName: run.error?.name ?? "UnknownError" },
      ]);
    }

    for (const result of run.results) {
      const scenario = byAlert.get(result.alertId);
      if (!scenario) {
        buckets.noGroundTruth += 1;
        unjoined.add(result.alertId);
        continue;
      }
      if (result.status === "completed" && result.summary === undefined) {
        buckets.noSummary += 1;
        continue;
      }

      const draw: Draw = {
        conditionId: condition.id,
        scenarioId: scenario.id,
        runId: run.runId,
        status: result.status,
        durationMs: result.durationMs,
        ...(result.summary === undefined ? {} : { tpPercent: result.summary.tpPercent }),
        ...(result.summary?.impact === undefined ? {} : { actualImpact: result.summary.impact }),
        ...(result.error === undefined ? {} : { errorName: result.error.name }),
        ...(result.turns === undefined ? {} : { turns: result.turns }),
        ...(result.toolCalls === undefined ? {} : { toolCalls: result.toolCalls }),
        ...(result.usage?.costUsd === undefined ? {} : { costUsd: result.usage.costUsd }),
        ...(result.usage?.totalTokens === undefined
          ? {}
          : { totalTokens: result.usage.totalTokens }),
      };

      if (result.status === "failed") buckets.failed += 1;
      else buckets.scored += 1;

      const key = `${condition.id}::${scenario.id}`;
      drawsByCell.set(key, [...(drawsByCell.get(key) ?? []), draw]);
      drawsByRun.set(run.runId, [...(drawsByRun.get(run.runId) ?? []), draw]);
    }
  }

  const cellsByCondition = new Map<string, Cell[]>();
  for (const [key, draws] of drawsByCell) {
    const scenarioId = key.split("::")[1] ?? "";
    const scenario = scenarios.find((candidate) => candidate.id === scenarioId);
    if (!scenario || !isVerdict(scenario.verdict)) continue;
    const target = targetFor(scenario.verdict);
    const probabilities = draws.map((draw) => draw.tpPercent ?? failedDrawProbability(baseRate));
    const score = cellScore(probabilities, target);
    const impactDraws = draws.filter((draw) => draw.actualImpact !== undefined);

    const cell: Cell = {
      conditionId: draws[0]?.conditionId ?? "",
      scenarioId,
      verdict: scenario.verdict,
      expectedImpact: scenario.impact,
      target,
      draws,
      probabilities,
      score,
      // A band is a property of the cell's median answer: with repeats there is no single
      // percentage to test, and the median is the draw a reader would quote.
      bandPass: bandOk(scenario.verdict, score.median, BANDS),
      legacyBandPass: bandOk(scenario.verdict, score.median, LEGACY_BANDS),
      impactOk: impactDraws.filter((draw) => draw.actualImpact === scenario.impact).length,
      impactScored: impactDraws.length,
      failed: draws.filter((draw) => draw.status === "failed").length,
    };
    cellsByCondition.set(cell.conditionId, [
      ...(cellsByCondition.get(cell.conditionId) ?? []),
      cell,
    ]);
  }

  const conditions: ConditionReport[] = [];
  for (const condition of conditionsById.values()) {
    const cells = (cellsByCondition.get(condition.id) ?? []).toSorted((a, b) =>
      a.scenarioId.localeCompare(b.scenarioId),
    );
    const draws = cells.flatMap((cell) => cell.draws);
    const brier =
      cells.length === 0
        ? 0
        : cells.reduce((sum, cell) => sum + cell.score.score, 0) / cells.length;
    // Over the covered scenarios only, against a base rate computed over all of them (PRD-6 §6.3).
    const reference =
      cells.length === 0
        ? 0
        : cells.reduce((sum, cell) => sum + (baseRate - cell.target) ** 2, 0) / cells.length;
    const costs = draws.filter((draw) => draw.costUsd !== undefined);

    conditions.push({
      condition,
      cells,
      runIds: [...new Set(runsByCondition.get(condition.id) ?? [])],
      runLevelFailures: runLevelFailures.get(condition.id) ?? [],
      covered: cells.length,
      draws: draws.length,
      failedDraws: draws.filter((draw) => draw.status === "failed").length,
      brier,
      referenceBrier: reference,
      skill: reference === 0 ? 0 : 1 - brier / reference,
      bandDirection: cells.filter((cell) => cell.bandPass).length,
      legacyBandDirection: cells.filter((cell) => cell.legacyBandPass).length,
      meanDurationMs:
        draws.length === 0
          ? 0
          : draws.reduce((sum, draw) => sum + draw.durationMs, 0) / draws.length,
      ...(costs.length === 0
        ? {}
        : { totalCostUsd: costs.reduce((sum, draw) => sum + (draw.costUsd ?? 0), 0) }),
    });
  }

  conditions.sort((a, b) => b.covered - a.covered || a.condition.id.localeCompare(b.condition.id));

  const byScenario = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const pairs: DerivedPair[] = [];
  for (const { childRunId, parentRunId } of derived) {
    const childConditionId = conditionByRun.get(childRunId);
    const parentConditionId = conditionByRun.get(parentRunId);
    if (childConditionId === undefined) continue;

    const child = conditionsById.get(childConditionId);
    const parent =
      parentConditionId === undefined ? undefined : conditionsById.get(parentConditionId);
    const changedBeyondPremise =
      child === undefined || parent === undefined
        ? []
        : fieldDiff(parent, child)
            .map((entry) => entry.field)
            .filter((field) => field !== "analystContext");

    const drawsOf = (runId: string, scenarioId: string): number[] =>
      (drawsByRun.get(runId) ?? [])
        .filter((draw) => draw.scenarioId === scenarioId)
        .map((draw) => draw.tpPercent ?? failedDrawProbability(baseRate));

    const shared = new Set((drawsByRun.get(childRunId) ?? []).map((draw) => draw.scenarioId));
    const scored: DerivedPair["scenarios"] = [];
    for (const scenarioId of [...shared].toSorted()) {
      const parentDraws = drawsOf(parentRunId, scenarioId);
      const childDraws = drawsOf(childRunId, scenarioId);
      const scenario = byScenario.get(scenarioId);
      if (parentDraws.length === 0 || childDraws.length === 0 || !scenario) continue;
      if (!isVerdict(scenario.verdict)) continue;
      const target = targetFor(scenario.verdict);
      scored.push({
        scenarioId,
        verdict: scenario.verdict,
        parentDraws,
        childDraws,
        parentScore: cellScore(parentDraws, target).score,
        childScore: cellScore(childDraws, target).score,
      });
    }

    pairs.push({
      childRunId,
      parentRunId,
      childConditionId,
      ...(parentConditionId === undefined ? {} : { parentConditionId }),
      changedBeyondPremise,
      scenarios: scored,
    });
  }

  return {
    conditions,
    buckets,
    unjoinedAlertIds: [...unjoined].toSorted(),
    conditionsById,
    drawsByRun,
    pairs,
  };
}

/** Cells short of `target` draws, and how many investigations would close the gap (PRD-6 §6.12). */
export interface Gap {
  conditionId: string;
  label: string;
  scenarioId: string;
  have: number;
  need: number;
}

export const READY_AT = 3;

export function gapsFor(
  report: BuiltReport,
  scenarios: readonly Scenario[],
  labels: Map<string, string>,
  target = READY_AT,
): Gap[] {
  const gaps: Gap[] = [];
  for (const condition of report.conditions) {
    // A condition that never reached a scenario needs all of them, so the gap is over the corpus
    // rather than over what it happens to cover — otherwise "ready" would mean "gave up early".
    const byScenario = new Map(condition.cells.map((cell) => [cell.scenarioId, cell.draws.length]));
    for (const scenario of scenarios) {
      const have = byScenario.get(scenario.id) ?? 0;
      if (have >= target) continue;
      gaps.push({
        conditionId: condition.condition.id,
        label: labels.get(condition.condition.id) ?? condition.condition.id,
        scenarioId: scenario.id,
        have,
        need: target - have,
      });
    }
  }
  return gaps;
}
