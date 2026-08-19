import type { SecurityAlertResource } from "@soc/contracts";

import type { InvestigationResult } from "./contracts/run.ts";
import type { InvestigationHarness } from "./harness.ts";

export interface RunAlertsOptions {
  harness: InvestigationHarness;
  alerts: SecurityAlertResource[];
  log?: (message: string) => void;
  /** Called after each alert so a long sweep can be flushed if it is interrupted. */
  onResult?: (result: InvestigationResult) => void;
}

function describe(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "UnknownError", message: String(error) };
}

/**
 * Investigate a list of alerts sequentially (PRD-2 §6).
 *
 * One alert's failure never stops the batch, and there are no retries — a failed investigation is
 * recorded as a failure and the sweep moves on. Parallel processing is deliberately deferred; the
 * harness holds no shared mutable run state, so adding it later should not require redesigning
 * anything here.
 */
export async function runAlerts(options: RunAlertsOptions): Promise<InvestigationResult[]> {
  const { harness, alerts, onResult } = options;
  const log = options.log ?? (() => undefined);
  const results: InvestigationResult[] = [];

  for (const [index, alert] of alerts.entries()) {
    const alertId = alert.properties.systemAlertId;
    const position = `${index + 1}/${alerts.length}`;
    const started = new Date();
    log(`[investigator] ${position} ${alertId} — ${alert.properties.alertDisplayName}`);

    let result: InvestigationResult;
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential by design (PRD-2 §6)
      const summary = await harness.investigate(alert);
      const completed = new Date();
      result = {
        alertId,
        alertTitle: alert.properties.alertDisplayName,
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
