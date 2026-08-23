import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { SecurityAlert } from "@soc/contracts";

import type { AlertContext, InvestigationResult } from "./contracts/run.ts";
import type { InvestigationHarness, InvestigationMetrics } from "./harness.ts";

export interface InvestigateAlertsOptions {
  harness: Pick<InvestigationHarness, "investigate">;
  alerts: SecurityAlert[];
  log?: (message: string) => void;
  /** Called after each alert so a long run can be flushed if it is interrupted. */
  onResult?: (result: InvestigationResult) => void;
  /** Build a per-alert Pi event observer, when tracing is enabled. */
  createEventSink?: (alert: SecurityAlert) => ((event: AgentEvent) => void) | undefined;
  /**
   * Stop the run (PRD-5 §6).
   *
   * Passed down to each investigation *and* checked between them. Aborting the harness alone stops
   * the current alert and leaves the loop free to start the next one, which is not cancellation.
   */
  signal?: AbortSignal;
  /** Carried into each investigation's opening context (PRD-5 §9). */
  analystContext?: string;
  /**
   * Raw counters for each investigation, as the harness reports them (PRD-6 §6.7).
   *
   * `onResult` already carries the per-result subset. This exists for the run-level facts that are
   * not per-result — `servedModelId` is identical across a run and belongs in `provenance`, not
   * repeated on every result, where it would be a string the artifact grows by alert count.
   */
  onMetrics?: (alert: SecurityAlert, metrics: InvestigationMetrics) => void;
}

/**
 * The alert's own triage facts, copied into the result (PRD-3 §6.1).
 *
 * Recorded for both outcomes: a failed investigation still needs to be placeable in time, and a
 * run that failed on a High-severity alert is not the same finding as one that failed on an
 * informational one.
 */
function alertContext(alert: SecurityAlert): AlertContext {
  return {
    ...(alert.severity === undefined ? {} : { severity: alert.severity }),
    ...(alert.startTimeUtc === undefined ? {} : { startTimeUtc: alert.startTimeUtc }),
    ...(alert.endTimeUtc === undefined ? {} : { endTimeUtc: alert.endTimeUtc }),
    ...(alert.timeGenerated === undefined ? {} : { timeGenerated: alert.timeGenerated }),
    tactics: alert.tactics,
    techniques: alert.techniques,
    ...(alert.alertType === undefined ? {} : { alertType: alert.alertType }),
    ...(alert.compromisedEntity === undefined
      ? {}
      : { compromisedEntity: alert.compromisedEntity }),
  };
}

/** Spread the counters into a result, or nothing at all when the harness never reported any. */
function recorded(
  metrics: InvestigationMetrics | undefined,
): Pick<InvestigationResult, "turns" | "toolCalls" | "usage"> {
  if (metrics === undefined) return {};
  return { turns: metrics.turns, toolCalls: metrics.toolCalls, usage: metrics.usage };
}

function describe(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "UnknownError", message: String(error) };
}

/**
 * Investigate a list of alerts sequentially (PRD-2 §6).
 *
 * The middle rung of the ladder: `executeRun` carries out one run, this walks its alerts, and
 * `harness.investigate()` handles one. Named for the inner unit it operates on — it was
 * `runAlerts`, which used the outer unit's verb to do the inner unit's job and read against the
 * vocabulary once "run" came to mean the batch.
 *
 * One alert's failure never stops the batch, and there are no retries — a failed investigation is
 * recorded as a failure and the run moves on. Parallel processing is deliberately deferred; the
 * harness holds no shared mutable state per run, so adding it later should not require redesigning
 * anything here.
 */
export async function investigateAlerts(
  options: InvestigateAlertsOptions,
): Promise<InvestigationResult[]> {
  const { harness, alerts, onResult } = options;
  const log = options.log ?? (() => undefined);
  const results: InvestigationResult[] = [];

  for (const [index, alert] of alerts.entries()) {
    // Between alerts, not only inside one: `agent.abort()` ends the current investigation and this
    // loop would otherwise pick up the next.
    if (options.signal?.aborted === true) {
      log(`[investigator] cancelled — ${alerts.length - index} alert(s) not investigated.`);
      break;
    }
    const alertId = alert.id;
    const position = `${index + 1}/${alerts.length}`;
    const started = new Date();
    log(`[investigator] ${position} ${alertId} — ${alert.title}`);

    // Captured into a local *before* the try, and spread into both branches below. The harness
    // fires `onMetrics` from the `finally` around `agent.prompt()`, so a run that times out having
    // burned its whole budget still records what it cost — which is the run a cost comparison most
    // needs and the one a widened return type would lose (PRD-6 §6.7).
    let metrics: InvestigationMetrics | undefined;

    let result: InvestigationResult;
    try {
      const onEvent = options.createEventSink?.(alert);
      // eslint-disable-next-line no-await-in-loop -- sequential by design (PRD-2 §6)
      const summary = await harness.investigate(alert, {
        ...(onEvent === undefined ? {} : { onEvent }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.analystContext === undefined ? {} : { analystContext: options.analystContext }),
        onMetrics: (reported) => {
          metrics = reported;
          options.onMetrics?.(alert, reported);
        },
      });
      const completed = new Date();
      result = {
        alertId,
        alertTitle: alert.title,
        alert: alertContext(alert),
        status: "completed",
        startedAt: started.toISOString(),
        completedAt: completed.toISOString(),
        durationMs: completed.getTime() - started.getTime(),
        summary,
        ...recorded(metrics),
      };
      const seconds = (result.durationMs / 1000).toFixed(1);
      const cost = metrics === undefined ? "" : ` · $${metrics.usage.costUsd.toFixed(2)}`;
      log(
        `[investigator] ${position} completed in ${seconds}s — TP ${summary.tpPercent}% / FP ${summary.fpPercent}%${cost}`,
      );
    } catch (error) {
      const completed = new Date();
      const described = describe(error);
      result = {
        alertId,
        alertTitle: alert.title,
        alert: alertContext(alert),
        status: "failed",
        startedAt: started.toISOString(),
        completedAt: completed.toISOString(),
        durationMs: completed.getTime() - started.getTime(),
        error: described,
        ...recorded(metrics),
      };
      log(`[investigator] ${position} FAILED — ${described.name}: ${described.message}`);
    }

    results.push(result);
    onResult?.(result);
  }

  return results;
}
