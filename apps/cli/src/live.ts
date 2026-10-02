/**
 * Open the console against a live tenant: `isophase console --live <source>`.
 *
 * `isophase console` resolves whatever `.env` names, which for a checkout configured to build the
 * benchmark corpus is Mock Sentinel — so the queue reports that the mock connector is unreachable
 * and the analyst reasonably concludes the connector is broken rather than unselected. Live runs
 * need three things set together, and setting two of them is worse than setting none:
 * `createSecurityClient` picks the source, and `assertLiveTenantArtifactDirectories` then refuses
 * to open at all unless both artifact directories sit under `.data/`. Typing that prefix by hand is
 * how it gets typed wrong.
 *
 * **The source is an argument, not a default.** "Live" names three configurations, not one, and a
 * flag that silently meant `defender` would be wrong for the other two in a way nothing reports.
 *
 * **What this deliberately does not set: `DEFENDER_ALERT_WINDOW`.** That is a fact about a tenant's
 * detection cadence, not about running live, and it changes underneath a repo script — a quiet week
 * empties a window that worked yesterday. It belongs in `.env` beside the credentials.
 *
 * This was `scripts/console-live.ts`, which spawned the console with the overlay as its
 * environment. It moved here so the published bundle can reach it (PRD-11 §4.1 D3); the dispatcher
 * applies the overlay to `process.env` and only then imports the console, whose `env.ts` reads the
 * environment at import.
 *
 *   isophase console --live defender
 *   isophase console --live sentinel
 *   isophase console --live defender,sentinel
 *   isophase console --live defender --fresh
 *   isophase console --live sentinel --runs .data/scratch --traces .data/scratch/traces
 */
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
  /** Everything but `--live <source>`, forwarded to the console's own parser untouched. */
  consoleArgs: string[];
}

/** The sources `--live` accepts, for help text. */
export const LIVE_SOURCE_NAMES: readonly string[] = NAMES;

function isSourceName(value: string): value is SourceName {
  return (NAMES as string[]).includes(value);
}

/**
 * Lift `--live <source>` out of the console's argv and turn it into an environment overlay.
 *
 * The flag may sit anywhere; everything else is forwarded as a slice rather than through a second
 * parser that has to know every flag the console accepts. Absent, there is no overlay and the
 * console opens against whatever `.env` names.
 */
export function planLaunch(argv: readonly string[]): LaunchPlan {
  const consoleArgs: string[] = [];
  let head: string | undefined;
  let seen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    const inline = arg.startsWith("--live=") ? arg.slice("--live=".length) : undefined;
    if (arg !== "--live" && inline === undefined) {
      consoleArgs.push(arg);
      continue;
    }
    if (seen) throw new Error("--live may be given once.");
    seen = true;
    const value = inline ?? argv[index + 1];
    if (inline === undefined) index += 1;
    if (value === undefined || value === "" || value.startsWith("-")) {
      throw new Error(
        `--live needs a source: ${NAMES.join(" | ")} | ${NAMES.join(",")}\n\n` +
          `  isophase console --live defender\n` +
          `  isophase console --live defender,sentinel --fresh`,
      );
    }
    head = value;
  }

  if (head === undefined) return { env: {}, consoleArgs };

  const requested = head
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");

  if (requested.length === 0) throw new Error("--live needs at least one source.");

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

  return { env, consoleArgs };
}
