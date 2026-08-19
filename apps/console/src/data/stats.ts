import { join } from "node:path";

import type { RunArtifact } from "./runs.ts";
import { indexTrace, type TraceIndex } from "./trace-index.ts";

export interface Spread {
  avg: number;
  min: number;
  max: number;
}

export interface Aggregate {
  /** How many investigations were counted, and how many exist. Never presented without this. */
  traced: number;
  total: number;
  /** False while background indexing is still running (PRD-3 §10). */
  complete: boolean;
  tokens?: Spread;
  cost?: Spread;
  turns?: Spread;
  calls?: Spread;
  totalSpend: number;
}

function spread(values: number[]): Spread | undefined {
  if (values.length === 0) return undefined;
  const total = values.reduce((sum, value) => sum + value, 0);
  return { avg: total / values.length, min: Math.min(...values), max: Math.max(...values) };
}

export function tracePath(tracesDir: string, runId: string, alertId: string): string {
  return join(tracesDir, `${runId}-${alertId}.jsonl`);
}

/**
 * Where a run's transcript actually is.
 *
 * The artifact records `traceDir` as the investigator resolved it, relative to *its* working
 * directory. The console may well be started from somewhere else, so the recorded value is tried
 * first and the console's own configured directory second, rather than trusting either alone.
 */
export async function resolveTracePath(
  runId: string,
  alertId: string,
  recordedDir: string | undefined,
  fallbackDir: string,
): Promise<string | undefined> {
  const seen = new Set<string>();
  for (const dir of [recordedDir, fallbackDir]) {
    if (dir === undefined || seen.has(dir)) continue;
    seen.add(dir);
    const candidate = tracePath(dir, runId, alertId);
    // eslint-disable-next-line no-await-in-loop
    if (await Bun.file(candidate).exists()) return candidate;
  }
  return undefined;
}

export interface RunTotals {
  tokens: number;
  cost: number;
  tracedAlerts: number;
  totalAlerts: number;
  /**
   * True when some of the run's alerts have no transcript.
   *
   * PRD-3 §4.4 binds per-run totals as well as cross-run averages: a partly traced sweep has a
   * partial total, and presenting it unlabelled would be a quiet lie.
   */
  partial: boolean;
}

export function runTotals(run: RunArtifact, indexes: Map<string, TraceIndex>): RunTotals {
  let tokens = 0;
  let cost = 0;
  let tracedAlerts = 0;

  for (const result of run.results) {
    const index = indexes.get(`${run.runId}-${result.alertId}`);
    if (index === undefined) continue;
    tracedAlerts += 1;
    tokens += index.totals.totalTokens;
    cost += index.totals.cost;
  }

  return {
    tokens,
    cost,
    tracedAlerts,
    totalAlerts: run.results.length,
    partial: tracedAlerts < run.results.length,
  };
}

export function aggregate(indexes: TraceIndex[], totalInvestigations: number): Aggregate {
  const tokens = indexes.map((index) => index.totals.totalTokens);
  const costs = indexes.map((index) => index.totals.cost);
  const turns = indexes.map((index) => index.turns.length);
  const calls = indexes.map((index) => index.toolCalls.length);

  return {
    traced: indexes.length,
    total: totalInvestigations,
    complete: indexes.length >= totalInvestigations,
    ...(spread(tokens) === undefined ? {} : { tokens: spread(tokens) }),
    ...(spread(costs) === undefined ? {} : { cost: spread(costs) }),
    ...(spread(turns) === undefined ? {} : { turns: spread(turns) }),
    ...(spread(calls) === undefined ? {} : { calls: spread(calls) }),
    totalSpend: costs.reduce((sum, value) => sum + value, 0),
  };
}

/**
 * Index every transcript a set of runs refers to, reporting progress as it goes.
 *
 * The aggregate view needs all of them, so this runs in the background and the pane shows partial
 * figures until it finishes rather than blocking on a directory of 23 MB files (PRD-3 §10).
 */
export async function indexAll(
  runs: RunArtifact[],
  tracesDir: string,
  onProgress?: (indexes: TraceIndex[], done: number, total: number) => void,
): Promise<TraceIndex[]> {
  const wanted: { runId: string; alertId: string; dir: string | undefined }[] = [];
  for (const run of runs) {
    for (const result of run.results) {
      wanted.push({ runId: run.runId, alertId: result.alertId, dir: run.traceDir });
    }
  }

  const indexes: TraceIndex[] = [];
  for (const [done, item] of wanted.entries()) {
    // Sequential on purpose: indexing several 23 MB transcripts at once would spike memory for no
    // wall-clock gain on a local disk, and progress is reported per file.
    // eslint-disable-next-line no-await-in-loop
    const path = await resolveTracePath(item.runId, item.alertId, item.dir, tracesDir);
    if (path !== undefined) {
      try {
        // eslint-disable-next-line no-await-in-loop
        indexes.push(await indexTrace(path));
      } catch {
        // A transcript that cannot be indexed is missing data, not a reason to lose the rest.
      }
    }
    onProgress?.(indexes, done + 1, wanted.length);
  }
  return indexes;
}
