#!/usr/bin/env bun
/**
 * Generates the alert-to-scenario map the console uses to mark alerts that have ground truth.
 *
 * This lives in `scripts/` for the same reason `evaluate-runs.ts` does: it reads
 * `fixtures/scenarios/`, which is the hidden answer key, and `scripts/` is the one tree exempt from
 * both ground-truth guards (PRD-2 §20). The console must never open those files itself — under
 * PRD-5 §5.1 the console process *is* the process an agent runs in, so console source is agent-side
 * source and joined the isolation `ROOTS`.
 *
 * What it emits is therefore ids and nothing else. No verdict, no discriminating evidence, no trap,
 * no evaluator notes. Knowing that an alert has an answer behind it is not knowing the answer, and
 * an ids-only artifact means even a bug in the console cannot surface one.
 *
 * The field is `alertId`, deliberately not the fixtures' own name for it, which is one of the
 * forbidden needles the isolation test scans for — a map using it would fail the guard it exists to
 * respect.
 *
 *   bun run data:manifest        # regenerates this alongside the telemetry manifest
 *   bun run scripts/generate-benchmark-map.ts --check
 */
import { loadScenarios } from "../apps/mock-sentinel/src/scenarios/scenarios.ts";

export const BENCHMARK_MAP_PATH = "fixtures/benchmark-map.generated.json";

export interface BenchmarkMapEntry {
  scenarioId: string;
  alertId: string;
}

/** The whole projection: two ids per scenario, sorted so the file has no spurious diffs. */
export async function buildBenchmarkMap(): Promise<BenchmarkMapEntry[]> {
  const scenarios = await loadScenarios();
  return scenarios
    .map((scenario) => ({ scenarioId: scenario.id, alertId: scenario.startingAlertId }))
    .toSorted((a, b) => a.scenarioId.localeCompare(b.scenarioId));
}

export function serialise(entries: BenchmarkMapEntry[]): string {
  return `${JSON.stringify(entries, null, 2)}\n`;
}

async function main(): Promise<void> {
  const flags = new Set(Bun.argv.slice(2));
  const entries = await buildBenchmarkMap();
  const text = serialise(entries);

  if (flags.has("--check")) {
    const existing = await Bun.file(BENCHMARK_MAP_PATH)
      .text()
      .catch(() => "");
    if (existing !== text) {
      console.error(
        `[benchmark-map] ${BENCHMARK_MAP_PATH} is out of date — run bun run data:manifest`,
      );
      process.exit(1);
    }
    console.info(`[benchmark-map] up to date — ${entries.length} scenario(s)`);
    return;
  }

  await Bun.write(BENCHMARK_MAP_PATH, text);
  console.info(`[benchmark-map] wrote ${BENCHMARK_MAP_PATH} — ${entries.length} scenario(s)`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`[benchmark-map] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
