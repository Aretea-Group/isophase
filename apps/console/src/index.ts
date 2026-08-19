#!/usr/bin/env bun
import { env } from "./env.ts";
import { runApp } from "./ui/app.ts";

export interface CliArgs {
  runsDir?: string;
  tracesDir?: string;
  help?: boolean;
}

export const USAGE = `bun run console [--runs <dir>] [--traces <dir>]

  --runs <dir>     where run artifacts live (RUNS_DIR, currently "${env.RUNS_DIR}")
  --traces <dir>   where transcripts live (INVESTIGATOR_TRACE_DIR, currently "${env.INVESTIGATOR_TRACE_DIR}")
  --help           this message

The console is read-only. It never writes to runs/, never calls a model provider, and never
calls Mock Sentinel.`;

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
  const app = await runApp({
    runsDir: args.runsDir ?? env.RUNS_DIR,
    tracesDir: args.tracesDir ?? env.INVESTIGATOR_TRACE_DIR,
    env,
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
