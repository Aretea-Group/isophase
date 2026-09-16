import type { SecurityAlert } from "@soc/contracts";
import { alertWindowMs } from "@soc/sentinel-client";

import { classifyPollError, nextDelayMs } from "./backoff.ts";
import type { ControlEvent, InvestigationControl } from "./control.ts";

/**
 * The unattended loop (PRD-9 §4.1 D2, §4.2).
 *
 * A role of the investigator binary rather than a fourth app: it consumes `InvestigationControl`,
 * which ADR 007 already names a non-in-process implementation as the intended second consumer of,
 * and it adds no second execution path. Everything it needs beyond that interface is injected, so
 * the whole loop is testable without a clock, a tenant or a model.
 */
export interface WatchOptions {
  pollIntervalMs: number;
  /** ISO 8601 duration the primary source draws its queue from. */
  alertWindow: string;
  /**
   * How many poll intervals the window must cover (PRD-9 §4.1 D10).
   *
   * The invariant `window >= k * interval` is what makes a sweep complete rather than lossy: an
   * alert created just after one poll must still be inside the window at the next one, with slack
   * for a cycle that ran long. Asserted at startup because the failure is silent — alerts are never
   * investigated and nothing reports that they were missed.
   */
  windowIntervalRatio: number;
  /** Stop when this much has been spent. Unattended means nobody notices the bill. */
  spendCeilingUsd?: number;
  /** Park an alert after this many failed investigations, for the process lifetime. */
  maxFailuresPerAlert: number;
  /**
   * Vendor status strings to skip, supplied by the operator (PRD-9 §4.1 D11).
   *
   * Never a hardcoded comparison: `SecurityAlert.status` is verbatim from the source (ADR 010 §2),
   * so `status !== "resolved"` here would be a branch on source kind in disguise. Empty by default —
   * a wrong default silently skips alerts, which is worse than a visible cost.
   */
  skipStatuses: ReadonlySet<string>;
  /** Alerts requested per cycle. Receiving exactly this many is the truncation signal. */
  listLimit: number;
  /**
   * Ceiling on a single backoff wait (ADR 012 §11).
   *
   * Load-bearing for the window invariant below, not just for patience: backing off widens the
   * *effective* interval between polls, so a cap larger than the window lets alerts age out while
   * the loop is waiting — the exact silent loss `assertWatchWindow` exists to prevent.
   */
  backoffMaxMs: number;
  /** Stop after this many cycles. Undefined runs until cancelled; tests pass a number. */
  maxCycles?: number;
}

export interface WatchDeps {
  control: Pick<InvestigationControl, "listAlerts" | "start" | "subscribe" | "shutdown">;
  /**
   * Alert ids that already have a run artifact, read once at startup (PRD-9 §4.2 step 3).
   *
   * A set rather than a directory scan per cycle: the loop owns it for its lifetime and adds to it
   * as runs complete. Passed in because reading `runs/` is the caller's business — the CLI has a
   * directory, a test has a literal.
   */
  seenAlertIds: Set<string>;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
  signal?: AbortSignal;
}

export class WatchConfigurationError extends Error {
  override readonly name = "WatchConfigurationError";
}

/**
 * Refuse a configuration that would silently lose alerts (PRD-9 AC18).
 *
 * Separate from `runWatch` so the CLI can fail before authenticating to anything, and so the
 * failure is a value a test can assert on rather than a process exit.
 */
export function assertWatchWindow(options: WatchOptions): void {
  const windowMs = alertWindowMs(options.alertWindow);
  /**
   * The *effective* gap between polls, which is the backoff cap when that exceeds the interval.
   *
   * Checking the interval alone would pass a loop that is safe while healthy and lossy the moment
   * it backs off — and backing off is exactly when a tenant is least able to tell you that alerts
   * are being missed.
   */
  const effectiveIntervalMs = Math.max(options.pollIntervalMs, options.backoffMaxMs);
  const required = effectiveIntervalMs * options.windowIntervalRatio;
  if (windowMs < required) {
    const driver =
      effectiveIntervalMs === options.pollIntervalMs
        ? `${options.pollIntervalMs} ms poll interval`
        : `${options.backoffMaxMs} ms backoff ceiling (longer than the ${options.pollIntervalMs} ms interval)`;
    throw new WatchConfigurationError(
      `The alert window ${options.alertWindow} (${windowMs} ms) is shorter than ` +
        `${options.windowIntervalRatio} × the ${driver} (${required} ms). ` +
        "An alert created between two polls would age out of the window before either saw it. " +
        "Widen the window, shorten the interval, or lower the backoff ceiling.",
    );
  }
}

/** What one cycle did, returned so the caller can assert on it and the loop can report it. */
export interface CycleReport {
  seen: number;
  skippedAlreadyRun: number;
  skippedByStatus: number;
  skippedParked: number;
  started: string[];
  truncated: boolean;
  /** Distinct vendor status values observed, so `WATCH_SKIP_STATUSES` can be configured (AC23). */
  statusValues: string[];
  haltedOnSpend: boolean;
  /** How long this cycle waited before polling, after a failure. Zero on a healthy cycle. */
  backoffMs: number;
}

/**
 * Poll, investigate what is new, report, sleep.
 *
 * "New" is the sliding window intersected with "has no run artifact" (D10), and neither half writes
 * state — which is what keeps D6's removal of state management honest rather than moving the state
 * somewhere else.
 */
export async function runWatch(options: WatchOptions, deps: WatchDeps): Promise<CycleReport[]> {
  assertWatchWindow(options);

  const { control, seenAlertIds, log } = deps;
  // A function, not a narrowed read: `signal.aborted` flips underneath the loop, and TypeScript
  // narrows it to `false` after the first check inside a block it believes is synchronous.
  const aborted = (): boolean => deps.signal?.aborted === true;
  const failures = new Map<string, number>();
  const parked = new Set<string>();
  const reports: CycleReport[] = [];
  /** Consecutive failed polls. Reset on the first success, so backoff is not sticky. */
  let pollFailures = 0;
  let spentUsd = 0;
  let reportedStatusValues = false;

  const unsubscribe = control.subscribe((event: ControlEvent) => {
    if (event.type === "run_completed") {
      seenAlertIds.add(event.alertId);
      failures.delete(event.alertId);
      spentUsd += runCostUsd(event);
    }
    if (event.type === "run_failed") {
      const count = (failures.get(event.alertId) ?? 0) + 1;
      failures.set(event.alertId, count);
      if (count >= options.maxFailuresPerAlert) {
        parked.add(event.alertId);
        log(
          `[watch] parked ${event.alertId} after ${count} failed investigation(s) — ` +
            `not retried in this process. Last error: ${event.error.message}`,
        );
        // The claim is released here too, so `parked` is what stops the retry and the cycle report
        // says *parked* rather than *already run*. §7 asks for parked alerts to be visible; a park
        // counted as an ordinary skip is a park nobody can see.
        seenAlertIds.delete(event.alertId);
        return;
      }
      /**
       * Release the in-flight claim so a failure can be retried (PRD-9 AC10).
       *
       * `seenAlertIds` carries two things that look alike and are not: alerts with a run artifact
       * on disk, seeded at startup, and alerts this loop has *in flight*, claimed just before
       * `start`. The claim exists only to stop the same alert being started twice before its first
       * run reports; a run that has already failed is not in flight, so holding its claim would
       * make `maxFailuresPerAlert` unreachable and would drop an alert on one transient error for
       * the rest of the process.
       *
       * Across processes the artifact still wins: a failed run wrote one, so the next startup seeds
       * this alert as seen and does not retry it. Retrying is bounded to a single process lifetime,
       * which is what AC10 asks for.
       */
      seenAlertIds.delete(event.alertId);
    }
  });

  try {
    /**
     * Sequential on purpose, and this is the concurrency answer rather than an oversight.
     *
     * Awaiting each run before starting the next is what keeps an unattended loop from opening 500
     * investigations at once against a tenant's rate limit and a provider's bill. Bounded
     * concurrency, when it is wanted, belongs to `InProcessControl.maxConcurrent` (PRD-5 §8) —
     * one ceiling, in the place that already owns it, not two that can disagree.
     */
    /* eslint-disable no-await-in-loop */
    for (let cycle = 0; options.maxCycles === undefined || cycle < options.maxCycles; cycle += 1) {
      if (aborted()) break;

      /**
       * A poll that fails must not end the daemon (ADR 012 §11, PRD-9 §4.2, §7).
       *
       * Before this, `listAlerts()` was bare: one Graph 429 at 03:00 propagated out of `runWatch`,
       * `index.ts` printed a line and exited 1. A permanent failure still stops — an expired secret
       * does not heal, and a loop that keeps polling through one looks alive while doing nothing —
       * but a transient one is waited out.
       *
       * The wait goes through `deps.sleep`, the same injected seam the poll interval uses, so this
       * stays testable with no clock and honours an abort mid-backoff.
       */
      let alerts: SecurityAlert[];
      try {
        alerts = await control.listAlerts();
        if (pollFailures > 0) {
          log(`[watch] backoff left — the source answered after ${pollFailures} failed poll(s).`);
          pollFailures = 0;
        }
      } catch (error) {
        const kind = classifyPollError(error);
        const described = error instanceof Error ? error.message : String(error);

        if (kind === "permanent") {
          log(
            `[watch] stopping — the source rejected the poll and will keep rejecting it: ${described}. ` +
              "Check the credential and its consented permissions (docs/defender-setup.md), then restart.",
          );
          throw error;
        }

        pollFailures += 1;
        const delayMs = nextDelayMs(pollFailures, kind, {
          pollIntervalMs: options.pollIntervalMs,
          maxMs: options.backoffMaxMs,
        });
        log(
          `[watch] backoff entered — ${kind} poll failure ${pollFailures} (${described}); ` +
            `waiting ${delayMs} ms before the next poll.`,
        );
        reports.push({ ...emptyCycle(), backoffMs: delayMs });
        await deps.sleep(delayMs);
        continue;
      }

      const report: CycleReport = {
        seen: alerts.length,
        skippedAlreadyRun: 0,
        skippedByStatus: 0,
        skippedParked: 0,
        started: [],
        truncated: alerts.length >= options.listLimit,
        statusValues: [...new Set(alerts.map(statusOf))].toSorted(),
        haltedOnSpend: false,
        backoffMs: 0,
      };

      if (report.truncated) {
        log(
          `[watch] received ${alerts.length} alert(s), which is the requested cap of ` +
            `${options.listLimit} — the window holds more than one cycle can see. ` +
            "Shorten the alert window, or alerts beyond the cap will never be investigated.",
        );
      }

      if (!reportedStatusValues) {
        reportedStatusValues = true;
        log(
          `[watch] alert status values in this source: ${report.statusValues.join(", ") || "(none)"}. ` +
            "Set WATCH_SKIP_STATUSES from these to skip alerts a human has already closed.",
        );
      }

      for (const alert of alerts) {
        if (aborted()) break;
        if (seenAlertIds.has(alert.id)) {
          report.skippedAlreadyRun += 1;
          continue;
        }
        if (parked.has(alert.id)) {
          report.skippedParked += 1;
          continue;
        }
        if (options.skipStatuses.has(statusOf(alert))) {
          report.skippedByStatus += 1;
          continue;
        }
        if (options.spendCeilingUsd !== undefined && spentUsd >= options.spendCeilingUsd) {
          report.haltedOnSpend = true;
          log(
            `[watch] spend ceiling reached — $${spentUsd.toFixed(4)} of ` +
              `$${options.spendCeilingUsd.toFixed(2)}. Stopping before ${alert.id}.`,
          );
          break;
        }

        const runId = crypto.randomUUID();
        // Claim before starting: `start` returns immediately and the run reports through
        // `subscribe`, so without this the same alert is started again on the next pass through
        // this loop and by the next cycle before any artifact exists.
        seenAlertIds.add(alert.id);
        report.started.push(alert.id);
        const handle = control.start({ runId, alertId: alert.id, alertTitle: alert.title });
        await handle.settled;
      }

      log(
        `[watch] cycle ${cycle}: ${report.seen} seen, ${report.skippedAlreadyRun} already run, ` +
          `${report.skippedByStatus} skipped by status, ${report.skippedParked} parked, ` +
          `${report.started.length} started, $${spentUsd.toFixed(4)} spent` +
          (options.spendCeilingUsd === undefined
            ? ""
            : ` of $${options.spendCeilingUsd.toFixed(2)}`),
      );
      reports.push(report);

      if (report.haltedOnSpend) break;
      if (options.maxCycles !== undefined && cycle + 1 >= options.maxCycles) break;
      if (aborted()) break;
      await deps.sleep(options.pollIntervalMs);
    }
    /* eslint-enable no-await-in-loop */
  } finally {
    unsubscribe();
    if (aborted()) {
      /**
       * Graceful shutdown (PRD-9 §4.2, AC11).
       *
       * Breaking out of the loop stops it *starting* anything further; it does nothing about what
       * is already running. `shutdown` is `InvestigationControl`'s "cancel everything still
       * running", and without this call a SIGINT would leave in-flight investigations spending
       * money on a loop that has already stopped caring about their results.
       *
       * In the `finally` so it runs whether the loop exited on the signal or threw on the way.
       */
      log("[watch] stopping — cancelling investigations still in flight.");
      control.shutdown();
    }
  }

  return reports;
}

/** A cycle that never got to look at alerts, because the poll itself failed. */
function emptyCycle(): CycleReport {
  return {
    seen: 0,
    skippedAlreadyRun: 0,
    skippedByStatus: 0,
    skippedParked: 0,
    started: [],
    truncated: false,
    statusValues: [],
    haltedOnSpend: false,
    backoffMs: 0,
  };
}

/** The vendor's own word, or the empty string — never normalised (ADR 010 §2). */
function statusOf(alert: SecurityAlert): string {
  return alert.status ?? "";
}

/** What a completed run cost, summed across its results. Absent usage counts as zero, not as free. */
function runCostUsd(event: Extract<ControlEvent, { type: "run_completed" }>): number {
  return event.run.results.reduce((total, result) => total + (result.usage?.costUsd ?? 0), 0);
}
