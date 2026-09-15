#!/usr/bin/env bun
/**
 * Open the console against a live tenant.
 *
 * `bun run console` resolves whatever `.env` names, which for a checkout configured to build the
 * benchmark corpus is Mock Sentinel — so the queue reports "Mock Sentinel is not reachable" and the
 * analyst reasonably concludes the connector is broken rather than unselected. Live runs need three
 * things set together, and setting two of them is worse than setting none: `createSecurityClient`
 * picks the source, and `assertLiveTenantArtifactDirectories` then refuses to open at all unless
 * both artifact directories sit under `.data/`. Typing that prefix by hand is how it gets typed
 * wrong.
 *
 * **The source is an argument, not a default.** "Live" names three configurations, not one, and a
 * script that silently meant `defender` would be wrong for the other two in a way nothing reports.
 *
 * **What this deliberately does not set: `DEFENDER_ALERT_WINDOW`.** That is a fact about a tenant's
 * detection cadence, not about running live, and it changes underneath a repo script — a quiet week
 * empties a window that worked yesterday. It belongs in `.env` beside the credentials.
 *
 *   bun run console:live defender
 *   bun run console:live sentinel
 *   bun run console:live defender,sentinel
 *   bun run console:live defender --fresh
 *   bun run console:live sentinel --runs .data/scratch --traces .data/scratch/traces
 */
import { resolve } from "node:path";

/** The source ids this launcher can select, and what each one means live. */
const SOURCES = {
  /** Graph `alerts_v2` plus advanced hunting; credentials are the `DEFENDER_*` triple. */
  defender: { securitySource: "defender", artifacts: "defender" },
  /**
   * A real Log Analytics workspace rather than the local corpus. `sentinel` is the same source id
   * in both cases — `SENTINEL_CONNECTOR` is what makes it live — which is why naming it here is not
   * redundant with `SECURITY_SOURCES`.
   */
  sentinel: { securitySource: "sentinel", artifacts: "azure" },
} as const;

type SourceName = keyof typeof SOURCES;

const NAMES = Object.keys(SOURCES) as SourceName[];

export interface LaunchPlan {
  /** Environment to layer over the inherited one, in `SECURITY_SOURCES` order. */
  env: Record<string, string>;
  /** Everything after the source, forwarded to the console untouched. */
  consoleArgs: string[];
}

function isSourceName(value: string): value is SourceName {
  return (NAMES as string[]).includes(value);
}

/**
 * Split the source list from the console's own flags.
 *
 * The source must come first and must not look like a flag, so that forwarding stays a slice rather
 * than a second parser that has to know every flag the console accepts.
 */
export function planLaunch(argv: string[]): LaunchPlan {
  const [head, ...rest] = argv;

  if (head === undefined || head.startsWith("-")) {
    throw new Error(
      `console:live needs a source: ${NAMES.join(" | ")} | ${NAMES.join(",")}\n\n` +
        `  bun run console:live defender\n` +
        `  bun run console:live defender,sentinel --fresh`,
    );
  }

  const requested = head
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");

  if (requested.length === 0) throw new Error("console:live needs at least one source.");

  const unknown = requested.filter((name) => !isSourceName(name));
  if (unknown.length > 0) {
    throw new Error(`Unknown source "${unknown[0]}". Known: ${NAMES.join(", ")}.`);
  }

  const names = requested as SourceName[];
  const duplicate = names.find((name, at) => names.indexOf(name) !== at);
  if (duplicate !== undefined) throw new Error(`Source ${duplicate} named more than once.`);

  // A multi-source run needs somewhere of its own: neither corpus owns a run that drew on both.
  const artifacts =
    names.length === 1 ? (SOURCES[names[0] as SourceName].artifacts ?? "live") : "live";
  const runsDir = `.data/${artifacts}-runs`;

  const env: Record<string, string> = {
    SECURITY_SOURCES: names.map((name) => SOURCES[name].securitySource).join(","),
    RUNS_DIR: runsDir,
    INVESTIGATOR_TRACE_DIR: `${runsDir}/traces`,
  };

  // Only when Sentinel is live. Left alone, `SENTINEL_CONNECTOR` keeps whatever `.env` says, which
  // is how `console:live defender` stays a Defender-only run on a checkout set up for the corpus.
  if (names.includes("sentinel")) env["SENTINEL_CONNECTOR"] = "azure";

  // Required by the factory past one source, and the written order is the answer to "which queue".
  if (names.length > 1) {
    env["PRIMARY_ALERT_SOURCE"] = SOURCES[names[0] as SourceName].securitySource;
  }

  return { env, consoleArgs: rest };
}

if (import.meta.main) {
  try {
    const plan = planLaunch(Bun.argv.slice(2));
    const entrypoint = resolve(import.meta.dir, "../apps/console/src/index.ts");

    const child = Bun.spawn(["bun", entrypoint, ...plan.consoleArgs], {
      // The console is a full-screen TUI: it needs the real terminal, not a pipe.
      stdio: ["inherit", "inherit", "inherit"],
      env: { ...process.env, ...plan.env },
    });

    process.exit(await child.exited);
  } catch (error) {
    console.error(`[console:live] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
