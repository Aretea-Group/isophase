#!/usr/bin/env bun
import {
  assertAzureArtifactDirectories,
  createSentinelClient,
  sentinelClientConfigFromEnv,
  sentinelClientTarget,
  type SentinelClientConfig,
} from "@soc/sentinel-client";

import { BraveSearchClient } from "./clients/brave.ts";
import { HttpWebFetchClient } from "./clients/fetch.ts";
import { env } from "./env.ts";
import { executeRun, type InvestigatorConfig } from "./execute-run.ts";
import {
  assertLlamaServerThinkingLevel,
  llamaServerAuthFromEnv,
  llamaServerConfigFromEnv,
} from "./model.ts";

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

/** The CLI's whole configuration contract: `env` in, a `InvestigatorConfig` out (PRD-5 §5.2). */
export function configFromEnv(
  sentinelConfig: SentinelClientConfig = sentinelClientConfigFromEnv(env),
): InvestigatorConfig {
  assertAzureArtifactDirectories(sentinelConfig, [
    env.RUNS_DIR,
    ...(env.INVESTIGATOR_TRACE ? [env.INVESTIGATOR_TRACE_DIR] : []),
  ]);
  const llamaServer = llamaServerConfigFromEnv(env);
  const llamaServerAuth = llamaServerAuthFromEnv(env, llamaServer);
  assertLlamaServerThinkingLevel(
    env.INVESTIGATOR_PROVIDER,
    env.INVESTIGATOR_THINKING_LEVEL,
    llamaServer,
  );
  return {
    provider: env.INVESTIGATOR_PROVIDER,
    modelId: env.INVESTIGATOR_MODEL,
    thinkingLevel: env.INVESTIGATOR_THINKING_LEVEL,
    maxTurns: env.INVESTIGATOR_MAX_TURNS,
    timeoutMs: env.INVESTIGATOR_TIMEOUT_MS,
    resultMaxChars: env.INVESTIGATOR_RESULT_MAX_CHARS,
    sentinelBaseUrl: sentinelClientTarget(sentinelConfig),
    webSearchConfigured: env.BRAVE_API_KEY !== undefined,
    runsDir: env.RUNS_DIR,
    trace: env.INVESTIGATOR_TRACE,
    traceDir: env.INVESTIGATOR_TRACE_DIR,
    traceStream: env.INVESTIGATOR_TRACE_STREAM,
    ...(llamaServer === undefined ? {} : { llamaServer }),
    ...(llamaServerAuth === undefined ? {} : { llamaServerAuth }),
  };
}

/**
 * The CLI adapter.
 *
 * Everything here is what makes this a *program* rather than a capability: argv, the environment,
 * the signal handler, stdout, and the exit code. The run itself lives in `run.ts` so that a
 * console — or anything else — can run one without becoming a shell (PRD-5 §5.2).
 */
async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const sentinelConfig = sentinelClientConfigFromEnv(env);
  const config = configFromEnv(sentinelConfig);
  const sentinel = createSentinelClient(sentinelConfig);

  if (env.BRAVE_API_KEY === undefined) {
    log("[investigator] BRAVE_API_KEY is not set — web_search will fail if the agent uses it.");
  }
  const webSearch = new BraveSearchClient({
    apiKey: env.BRAVE_API_KEY ?? "",
    timeoutMs: env.BRAVE_TIMEOUT_MS,
    count: env.BRAVE_RESULT_COUNT,
  });
  const webFetch = new HttpWebFetchClient({ timeoutMs: env.WEB_FETCH_TIMEOUT_MS });

  const runId = Bun.randomUUIDv7();

  /**
   * An interrupted run should still leave usable data — these runs are not cheap to repeat.
   *
   * The CLI stops by dying, as it always has: the controller aborts so `investigateAlerts` stops between
   * alerts, and the exit follows. It deliberately does not wait for the in-flight investigation to
   * unwind, because a second Ctrl-C should always work and an analyst holding one is not asking to
   * wait ten minutes. The run's own flush chain has already written every finished alert.
   */
  const controller = new AbortController();
  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    log("\n[investigator] interrupted — the partial run artifact is on disk.");
    controller.abort();
    process.exit(130);
  });

  const run = await executeRun(
    config,
    { sentinel, webSearch, webFetch },
    {
      runId,
      ...(args.alertId === undefined ? {} : { alertId: args.alertId }),
      log,
      signal: controller.signal,
    },
  );

  const completed = run.results.filter((r) => r.status === "completed").length;
  log(
    `[investigator] ${completed}/${run.results.length} completed — wrote ${env.RUNS_DIR}/${runId}.json`,
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
