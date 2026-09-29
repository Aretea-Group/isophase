#!/usr/bin/env bun
import {
  ALERT_LIST_CAP,
  assertLiveTenantArtifactDirectories,
  securitySourceConfigSetFromEnv,
  type SecuritySourceConfigSet,
} from "@soc/sentinel-client";

import { BraveSearchClient } from "./clients/brave.ts";
import { HttpWebFetchClient } from "./clients/fetch.ts";
import { InProcessControl, serveControl } from "./control.ts";
import { env } from "./env.ts";
import { executeRun, type InvestigatorConfig } from "./execute-run.ts";
import {
  assertLlamaServerThinkingLevel,
  llamaServerAuthFromEnv,
  llamaServerConfigFromEnv,
} from "./model.ts";
import { selectPublisher } from "./publish.ts";
import { readSeenAlertIds } from "./seen-alerts.ts";
import { alertWindowOf, createSecuritySources, queryMaxRowsOf } from "./source-profile.ts";
import { assertWatchWindow, runWatch } from "./watch.ts";

export interface CliArgs {
  alertId?: string;
  /** Run as the unattended loop rather than one sweep (PRD-10 §4.1 D2). */
  watch?: boolean;
}

/**
 * The repo's `new Set(Bun.argv.slice(2))` idiom cannot carry a value, so this extends it. A
 * malformed `--alert` is an error rather than a silent fall-through to sweeping every alert, which
 * would be an expensive way to learn about a typo.
 */
export function parseArgs(argv: string[]): CliArgs {
  let alertId: string | undefined;
  let watch = false;

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
    } else if (arg === "--watch") {
      watch = true;
    } else if (arg !== undefined && arg.startsWith("--")) {
      throw new Error(
        `Unknown option "${arg}". Usage: bun run investigate [--alert <id>] [--watch]`,
      );
    }
  }

  if (watch && alertId !== undefined) {
    // One sweep of one alert and an unattended loop are different programs. Accepting both would
    // mean guessing which the operator meant, and both guesses cost money.
    throw new Error("--watch investigates every new alert; it cannot be combined with --alert.");
  }

  return {
    ...(alertId === undefined ? {} : { alertId }),
    ...(watch ? { watch: true } : {}),
  };
}

/**
 * Sleep, but wake early when the run is aborted (ADR 013 §11).
 *
 * A bare `setTimeout` was fine while the only wait was a five-minute poll interval. Backoff can
 * wait fifteen minutes, and a `SIGINT` during one would have sat out the whole delay before any
 * cleanup ran — undoing the graceful shutdown the signal handler above exists to provide.
 *
 * The timer is cleared either way, so an aborted wait leaves nothing pending on the event loop.
 */
function sleepUntilAborted(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const elapsed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  const stopped = new Promise<void>((resolve) => {
    onAbort = (): void => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
  });

  // Both sides are cleaned up whichever wins: the timer so an aborted wait leaves nothing pending,
  // and the listener because the process-level signal outlives every individual sleep — a backoff
  // that ran hourly would otherwise accumulate listeners on it for the life of the daemon.
  return Promise.race([elapsed, stopped]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  });
}

function log(message: string): void {
  console.info(message);
}

/**
 * Module-scoped so the exit code survives the unwind.
 *
 * The signal handler no longer exits in place, so `main()` returns normally after an abort and the
 * process would otherwise report success for a run the operator stopped.
 */
let interrupted = false;

/** The CLI's whole configuration contract: `env` in, a `InvestigatorConfig` out (PRD-5 §5.2). */
export function configFromEnv(
  sourceConfig: SecuritySourceConfigSet = securitySourceConfigSetFromEnv(env),
): InvestigatorConfig {
  // Generalised over the active set (PRD-8 §4.1 D10): any active source that reads a live tenant
  // forces the whole run under `.data/`, including when Sentinel is `mock`.
  assertLiveTenantArtifactDirectories(sourceConfig.sources, [
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
    // Read from the resolved source rather than from `env` directly, so a run that did not select a
    // windowed source records no window instead of the environment's unused default.
    ...(alertWindowOf(sourceConfig.primary) === undefined
      ? {}
      : { alertWindow: alertWindowOf(sourceConfig.primary) }),
    ...(queryMaxRowsOf(sourceConfig.sources) === undefined
      ? {}
      : { queryMaxRows: queryMaxRowsOf(sourceConfig.sources) }),
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
  /**
   * Watch mode overrides the alert window at the source, not on the run config (PRD-10 §4.1 D10).
   *
   * An earlier cut set `InvestigatorConfig.alertWindow`, which `execute-run.ts` uses *only* to stamp
   * the artifact — so the loop polled `DEFENDER_ALERT_WINDOW` (a week, by default) while recording
   * `WATCH_ALERT_WINDOW`, and `assertWatchWindow` validated a number the query never saw. The window
   * that filters the poll belongs to the connector, and this is where the connector is built.
   */
  const sourceConfig = securitySourceConfigSetFromEnv(
    args.watch === true ? { ...env, DEFENDER_ALERT_WINDOW: env.WATCH_ALERT_WINDOW } : env,
  );
  const config = configFromEnv(sourceConfig);
  const securitySources = createSecuritySources(sourceConfig);

  if (env.BRAVE_API_KEY === undefined) {
    log("[investigator] BRAVE_API_KEY is not set — web_search will fail if the agent uses it.");
  }
  const webSearch = new BraveSearchClient({
    apiKey: env.BRAVE_API_KEY ?? "",
    timeoutMs: env.BRAVE_TIMEOUT_MS,
    count: env.BRAVE_RESULT_COUNT,
  });
  const webFetch = new HttpWebFetchClient({ timeoutMs: env.WEB_FETCH_TIMEOUT_MS });

  // Capability, not kind (ADR 013 §7). `undefined` means `executeRun` uses the local publisher.
  const publisher = selectPublisher(securitySources.primary.client, {
    enabled: env.PUBLISH_FINDINGS,
  });
  if (env.PUBLISH_FINDINGS && publisher === undefined) {
    log(
      "[investigator] PUBLISH_FINDINGS is on, but the primary source cannot publish — findings stay local.",
    );
  } else if (publisher !== undefined) {
    log(`[investigator] publishing findings via ${publisher.id}.`);
  }

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

  /**
   * Abort, then let the process unwind — do not kill it in the same tick.
   *
   * The previous version called `process.exit(130)` immediately after `controller.abort()`, which
   * meant none of the asynchronous cleanup the abort is *for* ever ran: not `executeRun`'s
   * `flushQueued("interrupted")`, not `runWatch`'s shutdown of in-flight runs, not `server.close()`.
   * The artifact stayed as the pre-investigation flush left it — `status: "running"` with the alert
   * already in `plannedAlerts`, which `readSeenAlertIds` counts as seen, so the alert was consumed
   * and never retried. That is the opposite of what §4.1 D3 promises.
   *
   * The original intent survives intact: a second Ctrl-C exits at once, and the grace period is
   * bounded so a wedged provider cannot hold the terminal. `unref()` so a clean unwind is not
   * delayed by the timer itself.
   */
  const GRACE_MS = 15_000;
  const stop = (signal: string): void => {
    if (interrupted) process.exit(130);
    interrupted = true;
    log(`\n[investigator] ${signal} — finishing the current write, then exiting.`);
    controller.abort();
    setTimeout(() => {
      log("[investigator] cleanup did not finish in time; exiting anyway.");
      process.exit(130);
    }, GRACE_MS).unref();
  };

  process.on("SIGINT", () => stop("interrupted"));
  // A daemon's default stop signal. Without this, systemd, docker and launchd all killed the loop
  // with no abort, no flush and no socket cleanup.
  process.on("SIGTERM", () => stop("terminated"));

  if (args.watch === true) {
    /**
     * The unattended role (PRD-10 §4.1 D2).
     *
     * Built on `InProcessControl` rather than calling `executeRun` directly, so the loop consumes
     * exactly the interface ADR 007 says a second implementation would swap behind — which is what
     * makes Phase 4's socket additive rather than a rewrite.
     *
     * The alert window is overridden here and nowhere else: the one-shot default suits a backfill,
     * a loop needs one sized to its interval (D10), and `configFromEnv` must keep answering for
     * `bun run investigate` unchanged.
     */
    const control = new InProcessControl({
      // `config.alertWindow` already carries the watch window: `configFromEnv` derives it from the
      // resolved source, which was built with the override above. Re-applying it here is what
      // previously made the artifact disagree with the query.
      config,
      deps: { securitySources, ...(publisher === undefined ? {} : { publisher }) },
      web: {
        ...(env.BRAVE_API_KEY === undefined ? {} : { braveApiKey: env.BRAVE_API_KEY }),
        braveTimeoutMs: env.BRAVE_TIMEOUT_MS,
        braveResultCount: env.BRAVE_RESULT_COUNT,
        webFetchTimeoutMs: env.WEB_FETCH_TIMEOUT_MS,
      },
    });
    const skipStatuses = new Set(
      env.WATCH_SKIP_STATUSES.split(",")
        .map((value) => value.trim())
        .filter((value) => value !== ""),
    );
    const watchOptions = {
      pollIntervalMs: env.WATCH_POLL_INTERVAL_MS,
      alertWindow: env.WATCH_ALERT_WINDOW,
      windowIntervalRatio: env.WATCH_WINDOW_INTERVAL_RATIO,
      ...(env.WATCH_SPEND_CEILING_USD === undefined
        ? {}
        : { spendCeilingUsd: env.WATCH_SPEND_CEILING_USD }),
      maxFailuresPerAlert: env.WATCH_MAX_FAILURES_PER_ALERT,
      skipStatuses,
      listLimit: ALERT_LIST_CAP,
      backoffMaxMs: env.WATCH_BACKOFF_MAX_MS,
    };
    // Before the socket and before the first request: a configuration that would silently lose
    // alerts should fail while the operator is still looking at the terminal, not after a listener
    // is bound and a console may already have attached (AC18).
    assertWatchWindow(watchOptions);

    const seenAlertIds = await readSeenAlertIds(env.RUNS_DIR);
    log(
      `[watch] ${seenAlertIds.size} alert(s) already have a run in ${env.RUNS_DIR}/ — ` +
        `polling every ${env.WATCH_POLL_INTERVAL_MS} ms over ${env.WATCH_ALERT_WINDOW}.`,
    );

    /**
     * The control socket comes up before the first poll and closes after the last (PRD-10 Phase 4).
     *
     * Before, so a console attaching early is not racing the first investigation; in a `finally`,
     * so a crash does not leave a socket file that the next start would have to reclaim. Reclaiming
     * works (AC15) but it is a recovery, not a plan.
     */
    const server = await serveControl({
      control,
      path: env.WATCH_CONTROL_SOCKET,
      log,
    });
    log(`[watch] attach a console with: bun run console --attach ${server.path}`);

    try {
      await runWatch(watchOptions, {
        control,
        seenAlertIds,
        sleep: (ms) => sleepUntilAborted(ms, controller.signal),
        log,
        signal: controller.signal,
      });
    } finally {
      await server.close();
    }
    return;
  }

  const run = await executeRun(
    config,
    { securitySources, webSearch, webFetch, ...(publisher === undefined ? {} : { publisher }) },
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
    if (interrupted) process.exit(130);
  } catch (error) {
    console.error(`[investigator] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
