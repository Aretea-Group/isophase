import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { SecurityAlertResource } from "@soc/contracts";

import type { AlertContext, InvestigationResult } from "./contracts/run.ts";
import type { InvestigationHarness } from "./harness.ts";

export interface InvestigateAlertsOptions {
  harness: Pick<InvestigationHarness, "investigate">;
  alerts: SecurityAlertResource[];
  log?: (message: string) => void;
  /** Called after each alert so a long run can be flushed if it is interrupted. */
  onResult?: (result: InvestigationResult) => void;
  /** Build a per-alert Pi event observer, when tracing is enabled. */
  createEventSink?: (alert: SecurityAlertResource) => ((event: AgentEvent) => void) | undefined;
  /**
   * Stop the run (PRD-5 §6).
   *
   * Passed down to each investigation *and* checked between them. Aborting the harness alone stops
   * the current alert and leaves the loop free to start the next one, which is not cancellation.
   */
  signal?: AbortSignal;
  /** Carried into each investigation's opening context (PRD-5 §9). */
  analystContext?: string;
}

/**
 * The alert's own triage facts, copied into the result (PRD-3 §6.1).
 *
 * Recorded for both outcomes: a failed investigation still needs to be placeable in time, and a
 * run that failed on a High-severity alert is not the same finding as one that failed on an
 * informational one.
 */
function alertContext(alert: SecurityAlertResource): AlertContext {
  const properties = alert.properties;
  return {
    severity: properties.severity,
    startTimeUtc: properties.startTimeUtc,
    endTimeUtc: properties.endTimeUtc,
    timeGenerated: properties.timeGenerated,
    tactics: properties.tactics,
    techniques: properties.techniques,
    alertType: properties.alertType,
    ...(properties.compromisedEntity === undefined
      ? {}
      : { compromisedEntity: properties.compromisedEntity }),
  };
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
    const alertId = alert.properties.systemAlertId;
    const position = `${index + 1}/${alerts.length}`;
    const started = new Date();
    log(`[investigator] ${position} ${alertId} — ${alert.properties.alertDisplayName}`);

    let result: InvestigationResult;
    try {
      const onEvent = options.createEventSink?.(alert);
      // eslint-disable-next-line no-await-in-loop -- sequential by design (PRD-2 §6)
      const summary = await harness.investigate(alert, {
        ...(onEvent === undefined ? {} : { onEvent }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.analystContext === undefined ? {} : { analystContext: options.analystContext }),
      });
      const completed = new Date();
      result = {
        alertId,
        alertTitle: alert.properties.alertDisplayName,
        alert: alertContext(alert),
        status: "completed",
        startedAt: started.toISOString(),
        completedAt: completed.toISOString(),
        durationMs: completed.getTime() - started.getTime(),
        summary,
      };
      const seconds = (result.durationMs / 1000).toFixed(1);
      log(
        `[investigator] ${position} completed in ${seconds}s — TP ${summary.tpPercent}% / FP ${summary.fpPercent}%`,
      );
    } catch (error) {
      const completed = new Date();
      const described = describe(error);
      result = {
        alertId,
        alertTitle: alert.properties.alertDisplayName,
        alert: alertContext(alert),
        status: "failed",
        startedAt: started.toISOString(),
        completedAt: completed.toISOString(),
        durationMs: completed.getTime() - started.getTime(),
        error: described,
      };
      log(`[investigator] ${position} FAILED — ${described.name}: ${described.message}`);
    }

    results.push(result);
    onResult?.(result);
  }

  return results;
}
