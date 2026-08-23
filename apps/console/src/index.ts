#!/usr/bin/env bun
import {
  InProcessControl,
  type InProcessControlOptions,
  type InvestigationControl,
} from "@soc/investigator/control";
import {
  assertLlamaServerThinkingLevel,
  type LlamaServerAuth,
  type LlamaServerConfig,
  llamaServerAuthFromEnv,
  llamaServerConfigFromEnv,
} from "@soc/investigator/model";
import {
  assertAzureArtifactDirectories,
  createSentinelClient,
  sentinelClientConfigFromEnv,
  sentinelClientTarget,
} from "@soc/sentinel-client";

import { env } from "./env.ts";
import type { ConsoleEnv } from "./env.ts";
import { runApp } from "./ui/app.ts";

export function buildInvestigatorConfig(
  source: ConsoleEnv,
  options: {
    runsDir: string;
    tracesDir: string;
    sentinelBaseUrl: string;
    llamaServer?: LlamaServerConfig;
    llamaServerAuth?: LlamaServerAuth;
  },
): InProcessControlOptions["config"] {
  assertLlamaServerThinkingLevel(
    source.INVESTIGATOR_PROVIDER,
    source.INVESTIGATOR_THINKING_LEVEL,
    options.llamaServer,
  );

  return {
    provider: source.INVESTIGATOR_PROVIDER,
    modelId: source.INVESTIGATOR_MODEL,
    thinkingLevel: source.INVESTIGATOR_THINKING_LEVEL,
    maxTurns: source.INVESTIGATOR_MAX_TURNS,
    timeoutMs: source.INVESTIGATOR_TIMEOUT_MS,
    resultMaxChars: source.INVESTIGATOR_RESULT_MAX_CHARS,
    sentinelBaseUrl: options.sentinelBaseUrl,
    webSearchConfigured: source.BRAVE_API_KEY !== undefined,
    runsDir: options.runsDir,
    trace: true,
    traceDir: options.tracesDir,
    traceStream: false,
    ...(options.llamaServer === undefined ? {} : { llamaServer: options.llamaServer }),
    ...(options.llamaServerAuth === undefined ? {} : { llamaServerAuth: options.llamaServerAuth }),
  };
}

/**
 * Build the in-process control (PRD-5 §5.1).
 *
 * This is the line where the console stops being a reader. It executes investigations in its own
 * process — which is what buys live agent events with no trace files, real cancellation from a
 * keypress, and the model picker, and which costs the fault isolation a child process would have
 * given. `InProcessControl`'s supervisor contains the ordinary faults; an OOM still takes the
 * terminal, and the header says so.
 */
function buildControl(
  runsDir: string,
  tracesDir: string,
  llamaServer: LlamaServerConfig | undefined,
  llamaServerAuth: LlamaServerAuth | undefined,
): InvestigationControl {
  const sentinelConfig = sentinelClientConfigFromEnv(env);
  assertAzureArtifactDirectories(sentinelConfig, [runsDir, tracesDir]);

  return new InProcessControl({
    // Console-started runs always trace. Without it the Transcript and Stream tabs are empty for
    // exactly the run the analyst just started and is watching (PRD-5 §18, question 2).
    config: buildInvestigatorConfig(env, {
      runsDir,
      tracesDir,
      sentinelBaseUrl: sentinelClientTarget(sentinelConfig),
      ...(llamaServer === undefined ? {} : { llamaServer }),
      ...(llamaServerAuth === undefined ? {} : { llamaServerAuth }),
    }),
    deps: { source: createSentinelClient(sentinelConfig) },
    ...(env.BRAVE_API_KEY === undefined ? {} : { web: { braveApiKey: env.BRAVE_API_KEY } }),
    maxConcurrent: env.CONSOLE_MAX_CONCURRENT_RUNS,
  });
}

export interface CliArgs {
  runsDir?: string;
  tracesDir?: string;
  help?: boolean;
  readOnly?: boolean;
  fresh?: boolean;
}

export const USAGE = `bun run console [--runs <dir>] [--traces <dir>] [--fresh] [--read-only]

  --runs <dir>     where run artifacts live (RUNS_DIR, currently "${env.RUNS_DIR}")
  --traces <dir>   where transcripts live (INVESTIGATOR_TRACE_DIR, currently "${env.INVESTIGATOR_TRACE_DIR}")
  --fresh          hide runs that existed when the console opened; new runs appear normally
  --read-only      open without a control: no queue, no starting runs (PRD-3 behaviour)
  --help           this message

The console reads the selected Sentinel connector for the alert queue and can start investigations in this process.
It never writes to runs/ — the investigator remains the sole writer of run artifacts and
transcripts. Analyst classifications are written under "${env.FEEDBACK_DIR}/".`;

/**
 * Hand-rolled, matching `apps/investigator/src/index.ts` rather than adding a CLI dependency
 * (PRD-3 §5.2). An unknown flag is an error: silently ignoring one would leave the analyst reading
 * a different directory than they asked for and drawing conclusions from it.
 */
function valueOf(flag: string, inline: string | undefined, next: string | undefined): string {
  if (inline !== undefined) {
    if (inline === "") throw new Error(`${flag} requires a directory.`);
    return inline;
  }
  if (next === undefined || next.startsWith("--")) {
    throw new Error(`${flag} requires a directory, e.g. ${flag} runs`);
  }
  return next;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    const [flag, inline] =
      arg.startsWith("--") && arg.includes("=")
        ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
        : [arg, undefined];

    if (flag === "--runs") {
      args.runsDir = valueOf(flag, inline, argv[index + 1]);
      if (inline === undefined) index += 1;
    } else if (flag === "--traces") {
      args.tracesDir = valueOf(flag, inline, argv[index + 1]);
      if (inline === undefined) index += 1;
    } else if (flag === "--read-only") {
      args.readOnly = true;
    } else if (flag === "--fresh") {
      args.fresh = true;
    } else if (flag === "--help" || flag === "-h") {
      args.help = true;
    } else if (flag.startsWith("--")) {
      throw new Error(`Unknown option "${flag}".\n\n${USAGE}`);
    }
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  if (args.help === true) {
    console.log(USAGE);
    return;
  }
  if (args.fresh === true && args.readOnly === true) {
    throw new Error("--fresh requires the alert queue and cannot be combined with --read-only.");
  }
  const llamaServer = llamaServerConfigFromEnv(env);
  const llamaServerAuth = llamaServerAuthFromEnv(env, llamaServer);
  const runsDir = args.runsDir ?? env.RUNS_DIR;
  const tracesDir = args.tracesDir ?? env.INVESTIGATOR_TRACE_DIR;
  const app = await runApp({
    runsDir,
    tracesDir,
    env,
    fresh: args.fresh === true,
    ...(args.readOnly === true
      ? {}
      : {
          control: buildControl(runsDir, tracesDir, llamaServer, llamaServerAuth),
        }),
  });
  await app.ready;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`[console] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
