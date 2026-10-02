import { mkdir } from "node:fs/promises";

import { parseInvestigatorEnv } from "@soc/investigator/env";

import type { CommandModule } from "./command-module.ts";
import {
  ARTIFACT_DIRECTORIES,
  isTrack,
  nextCommand,
  renderEnvTemplate,
  requiredFields,
  TRACKS,
  type Track,
} from "./env-template.ts";

/**
 * `isophase init` — what it does, and nothing else (PRD-11 §4.1 D6).
 *
 * Writes `.env` for the chosen track, creates the artifact directories the template names, checks
 * the file against the investigator's own schema and the Bun version against the package's floor,
 * and prints the next command. It never provisions a tenant resource, registers an application,
 * creates a service principal or changes a permission, and it makes no network call (§3, AC8):
 * the operator does those with the tooling that owns them, and `isophase probe` is where the
 * result gets checked.
 *
 * Creating an empty `.data/runs` is not writing a run artifact; the investigator stays the sole
 * writer of those (ADR 007 §2, ADR 014).
 */

export const USAGE = `isophase init [--track defender|sentinel] [--force]

  --track <t>   which tenant the .env is for: defender (Microsoft Defender XDR) or sentinel
                (Microsoft Sentinel through Azure Monitor Logs). Asked for when omitted.
  --force       overwrite an existing .env. Without it, init refuses and changes nothing.
  --help        this message

Writes .env in the current directory with the track's credential lines blank, creates
${ARTIFACT_DIRECTORIES.RUNS_DIR} and ${ARTIFACT_DIRECTORIES.INVESTIGATOR_TRACE_DIR}, checks the file
and the Bun version, and prints what to run next. Creates nothing in your tenant.`;

/** The lowest Bun the package runs on; mirrors \`engines.bun\`. */
export const MIN_BUN = "1.3.0";

export interface InitArgs {
  track?: Track;
  force: boolean;
}

export function parseArgs(argv: readonly string[]): InitArgs {
  const args: InitArgs = { force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    const [flag, inline] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, undefined];
    if (flag === "--track") {
      const value = inline ?? argv[index + 1];
      if (inline === undefined) index += 1;
      if (value === undefined || !isTrack(value)) {
        throw new Error(`--track takes one of: ${TRACKS.join(", ")}.`);
      }
      args.track = value;
    } else if (flag === "--force") {
      args.force = true;
    } else {
      throw new Error(`Unknown option "${arg}".\n\n${USAGE}`);
    }
  }
  return args;
}

function versionParts(text: string): number[] {
  return (text.split("-")[0] ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0);
}

/** `major.minor.patch` compared numerically; anything after a hyphen is ignored. */
export function bunVersionSatisfies(actual: string, minimum: string): boolean {
  const a = versionParts(actual);
  const m = versionParts(minimum);
  for (let index = 0; index < 3; index += 1) {
    const left = a[index] ?? 0;
    const right = m[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

/**
 * A `.env` file as the apps will read it: `KEY=value` lines, `#` comments, surrounding quotes
 * dropped. Enough to validate what `init` itself wrote; the runtime loader is Bun's.
 */
export function parseDotenv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals === -1) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

async function askTrack(): Promise<Track> {
  if (!process.stdin.isTTY) {
    throw new Error(`--track is required when not run from a terminal: ${TRACKS.join(" | ")}.`);
  }
  const answer = prompt(`Which tenant is this .env for? (${TRACKS.join(" | ")})`)?.trim() ?? "";
  if (!isTrack(answer)) throw new Error(`"${answer}" is not a track. Use ${TRACKS.join(" or ")}.`);
  return answer;
}

export interface InitOptions {
  /** Directory to initialise. The working directory when run as a command. */
  cwd?: string;
  now?: () => Date;
  log?: (line: string) => void;
}

export async function init(args: InitArgs, options: InitOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? ((text: string): void => console.log(text));
  const now = options.now ?? ((): Date => new Date());
  const track = args.track ?? (await askTrack());
  const envPath = `${cwd}/.env`;
  const envFile = Bun.file(envPath);

  if (!args.force && (await envFile.exists())) {
    throw new Error(`.env already exists here. Pass --force to overwrite it, or edit it in place.`);
  }

  const text = renderEnvTemplate(track, now());

  // Validate before writing, so a template the schema rejects leaves no file behind.
  parseInvestigatorEnv(parseDotenv(text));

  await Bun.write(envPath, text);
  // The trace directory is inside the runs directory, so one recursive mkdir creates both.
  await mkdir(`${cwd}/${ARTIFACT_DIRECTORIES.INVESTIGATOR_TRACE_DIR}`, { recursive: true });

  log(`[init] wrote .env for the ${track} track`);
  log(
    `[init] created ${ARTIFACT_DIRECTORIES.RUNS_DIR}/ and ${ARTIFACT_DIRECTORIES.INVESTIGATOR_TRACE_DIR}/`,
  );
  log(`[init] .env validates against the investigator's schema`);
  const bun = Bun.version;
  if (bunVersionSatisfies(bun, MIN_BUN)) {
    log(`[init] Bun ${bun} (needs ${MIN_BUN} or later)`);
  } else {
    log(
      `[init] Bun ${bun} is older than ${MIN_BUN}, which this package needs — upgrade before the next step`,
    );
  }
  log(`[init] fill in ${requiredFields(track).join(", ")} in .env, then run:`);
  log("");
  log(`    ${nextCommand(track)}`);
  return 0;
}

export const command: CommandModule = {
  usage: () => Promise.resolve(USAGE),
  run: (argv) => init(parseArgs(argv)),
};
