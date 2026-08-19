#!/usr/bin/env bun
import { SentinelApiClient } from "@soc/sentinel-client";

import { BraveSearchClient } from "./clients/brave.ts";
import { HttpWebFetchClient } from "./clients/fetch.ts";
import type { InvestigationResult, InvestigationRun } from "./contracts/run.ts";
import { env } from "./env.ts";
import { InvestigationHarness } from "./harness.ts";
import { DEFAULT_INSTRUCTIONS } from "./instructions.ts";
import { resolveModel } from "./model.ts";
import { writeRunArtifact } from "./run-artifact.ts";
import { runAlerts } from "./runner.ts";
import { createTracer } from "./trace.ts";

export interface CliArgs {
  alertId?: string;
}

/**
 * The repo's `new Set(Bun.argv.slice(2))` idiom cannot carry a value, so this extends it. A
 * malformed `--alert` is an error rather than a silent fall-through to sweeping every alert, which
 * would be an expensive way to learn about a typo.
 */
export function parseArgs(argv: string[]): CliArgs {
  let alertId: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--alert") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(
          "--alert requires an alert id, e.g. --alert cc6430ca-0fc5-b704-c048-1d5f3d8a2524",
        );
      }
      alertId = value;
      index += 1;
    } else if (arg?.startsWith("--alert=")) {
      const value = arg.slice("--alert=".length);
      if (value === "") throw new Error("--alert requires an alert id.");
      alertId = value;
    } else if (arg !== undefined && arg.startsWith("--")) {
      throw new Error(`Unknown option "${arg}". Usage: bun run investigate [--alert <id>]`);
    }
  }

  return alertId === undefined ? {} : { alertId };
}

function log(message: string): void {
  console.info(message);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The sweep's lifecycle, distinct from the per-alert `InvestigationResult.status` (PRD-3 §7). */
type RunStatus = NonNullable<InvestigationRun["status"]>;

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));

  const sentinel = new SentinelApiClient({
    baseUrl: env.SENTINEL_BASE_URL,
    timeoutMs: env.SENTINEL_TIMEOUT_MS,
  });

  if (env.BRAVE_API_KEY === undefined) {
    log("[investigator] BRAVE_API_KEY is not set — web_search will fail if the agent uses it.");
  }
  const webSearch = new BraveSearchClient({
    apiKey: env.BRAVE_API_KEY ?? "",
    timeoutMs: env.BRAVE_TIMEOUT_MS,
    count: env.BRAVE_RESULT_COUNT,
  });
  const webFetch = new HttpWebFetchClient({ timeoutMs: env.WEB_FETCH_TIMEOUT_MS });

  const { model, streamFn } = await resolveModel(env.INVESTIGATOR_PROVIDER, env.INVESTIGATOR_MODEL);

  const harness = new InvestigationHarness({
    sentinel,
    webSearch,
    webFetch,
    model,
    streamFn,
    instructions: DEFAULT_INSTRUCTIONS,
    thinkingLevel: env.INVESTIGATOR_THINKING_LEVEL,
    maxTurns: env.INVESTIGATOR_MAX_TURNS,
    timeoutMs: env.INVESTIGATOR_TIMEOUT_MS,
    resultMaxChars: env.INVESTIGATOR_RESULT_MAX_CHARS,
  });

  const alerts =
    args.alertId === undefined
      ? await sentinel.listAlerts()
      : [await sentinel.getAlert(args.alertId)];

  const runId = Bun.randomUUIDv7();
  const startedAt = new Date().toISOString();
  log(
    `[investigator] run ${runId} — ${alerts.length} alert(s) via ` +
      `${env.INVESTIGATOR_PROVIDER}/${env.INVESTIGATOR_MODEL}`,
  );

  const collected: InvestigationResult[] = [];
  const flush = async (status: RunStatus) => {
    const path = await writeRunArtifact(env.RUNS_DIR, {
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      status,
      // Written before the first alert so a reader can say how much of the sweep is left, and
      // which alert each remaining slot is; `results` only ever holds finished alerts (PRD-3 §7,
      // §11). A reader needs the id to find the in-flight alert's transcript, which is named after
      // it, and the title to name the alert without one.
      alertCount: alerts.length,
      plannedAlerts: alerts.map((alert) => ({
        alertId: alert.properties.systemAlertId,
        alertTitle: alert.properties.alertDisplayName,
      })),
      ...(env.INVESTIGATOR_TRACE ? { traceDir: env.INVESTIGATOR_TRACE_DIR } : {}),
      config: {
        thinkingLevel: env.INVESTIGATOR_THINKING_LEVEL,
        resultMaxChars: env.INVESTIGATOR_RESULT_MAX_CHARS,
        sentinelBaseUrl: env.SENTINEL_BASE_URL,
        webSearchConfigured: env.BRAVE_API_KEY !== undefined,
      },
      model: { provider: env.INVESTIGATOR_PROVIDER, id: env.INVESTIGATOR_MODEL },
      limits: { maxTurns: env.INVESTIGATOR_MAX_TURNS, timeoutMs: env.INVESTIGATOR_TIMEOUT_MS },
      results: collected,
    });
    return path;
  };

  /**
   * Serialise the flushes.
   *
   * `runAlerts` calls `onResult` synchronously while `flush` is async, so firing and forgetting
   * would let two writes interleave and would let the SIGINT flush race one already in flight
   * (PRD-3 §7). Chaining makes the last write win in call order.
   *
   * A failed flush is reported and swallowed rather than breaking the chain: losing one
   * intermediate artifact write is survivable, losing the rest of the sweep to it is not.
   */
  let queue: Promise<string | undefined> = Promise.resolve(undefined);
  const flushQueued = (status: RunStatus): Promise<string | undefined> => {
    queue = queue.then(async () => {
      try {
        return await flush(status);
      } catch (error) {
        log(`[investigator] could not write the run artifact — ${describe(error)}`);
        return undefined;
      }
    });
    return queue;
  };

  // The artifact exists from the first moment, so an in-flight sweep is visible to a reader before
  // its first alert finishes (PRD-3 §7).
  await flushQueued("running");

  // An interrupted sweep should still leave usable data — these runs are not cheap to repeat.
  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    log("\n[investigator] interrupted — writing partial run artifact.");
    void flushQueued("interrupted").then((path) => {
      if (path !== undefined) log(`[investigator] wrote ${path}`);
      process.exit(130);
    });
  });

  if (env.INVESTIGATOR_TRACE) {
    log(`[investigator] tracing enabled — transcripts in ${env.INVESTIGATOR_TRACE_DIR}/`);
  }

  await runAlerts({
    harness,
    alerts,
    log,
    onResult: (result) => {
      collected.push(result);
      void flushQueued("running");
    },
    createEventSink: env.INVESTIGATOR_TRACE
      ? (alert) =>
          createTracer({
            runId,
            alertId: alert.properties.systemAlertId,
            dir: env.INVESTIGATOR_TRACE_DIR,
            console: true,
            streamDeltas: env.INVESTIGATOR_TRACE_STREAM,
            log,
          }).onEvent
      : undefined,
  });

  const path = await flushQueued("completed");
  const completed = collected.filter((r) => r.status === "completed").length;
  log(
    `[investigator] ${completed}/${collected.length} completed` +
      (path === undefined ? "" : ` — wrote ${path}`),
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`[investigator] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
