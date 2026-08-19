#!/usr/bin/env bun
import { SentinelApiClient } from "@soc/sentinel-client";

import { BraveSearchClient } from "./clients/brave.ts";
import { HttpWebFetchClient } from "./clients/fetch.ts";
import type { InvestigationResult } from "./contracts/run.ts";
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
  const flush = async () => {
    const path = await writeRunArtifact(env.RUNS_DIR, {
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      model: { provider: env.INVESTIGATOR_PROVIDER, id: env.INVESTIGATOR_MODEL },
      limits: { maxTurns: env.INVESTIGATOR_MAX_TURNS, timeoutMs: env.INVESTIGATOR_TIMEOUT_MS },
      results: collected,
    });
    return path;
  };

  // An interrupted sweep should still leave usable data — these runs are not cheap to repeat.
  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    log("\n[investigator] interrupted — writing partial run artifact.");
    void flush().then((path) => {
      log(`[investigator] wrote ${path}`);
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
    onResult: (result) => collected.push(result),
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

  const path = await flush();
  const completed = collected.filter((r) => r.status === "completed").length;
  log(`[investigator] ${completed}/${collected.length} completed — wrote ${path}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`[investigator] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
