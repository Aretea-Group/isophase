import type { SecurityAlertResource } from "@soc/contracts";
import { SentinelApiError } from "@soc/sentinel-client";
import type { SentinelApiClient } from "@soc/sentinel-client";
import { z } from "zod";

/**
 * The console's only network primitive (PRD-5 §14).
 *
 * Everything else in `apps/console/src` reads the local disk. This module exists so that claim is
 * checkable by a scan rather than by reading every file, and it is the only place the isolation
 * test excludes from the no-network pattern.
 */

/**
 * Narrowed on purpose, and load-bearing rather than tidy.
 *
 * `SentinelApiClient` also exposes `query(kql)` and `getSchema()`. Handing `data/` the whole client
 * would compile ad-hoc KQL execution into the console from the first increment — which PRD-3 §14
 * excludes by name, and which this PRD does not reopen. The queue needs two reads and gets two.
 */
export type AlertReader = Pick<SentinelApiClient, "listAlerts" | "getAlert">;

/** One entry of the generated ids-only scenario map (PRD-5 §7). */
const BenchmarkMapEntry = z.object({
  scenarioId: z.string().min(1),
  alertId: z.string().min(1),
});
const BenchmarkMap = z.array(BenchmarkMapEntry);

export interface QueueAlert {
  alertId: string;
  title: string;
  severity: string;
  /** The vendor's own status, rendered verbatim — see the naming note in PRD-5 §7. */
  vendorStatus: string;
  startTimeUtc: string;
  compromisedEntity?: string;
  /** Present when ground truth exists for this alert. Purely a label; it carries no verdict. */
  scenarioId?: string;
  /** Kept whole so pane [4] can render the alert's own facts without a second fetch. */
  resource: SecurityAlertResource;
}

export interface AlertsSnapshot {
  alerts: QueueAlert[];
  /** A human-readable reason the fetch failed, already phrased as what to do about it. */
  error?: string;
}

/**
 * Why a fetch failed, said in terms of the action that fixes it.
 *
 * Today 100% of console sessions run with no Sentinel at all, so this is the common path rather
 * than the exceptional one and deserves better than a stack trace (PRD-5 §7).
 */
export function describeAlertError(error: unknown): string {
  if (error instanceof SentinelApiError) {
    if (error.code === "unreachable") {
      return "Mock Sentinel is not reachable — start it with `bun run dev:mock-sentinel`.";
    }
    if (error.code === "upstream_unavailable") {
      return "Mock Sentinel is up but Kusto is not — check `bun run infra:up`.";
    }
    return `Mock Sentinel returned ${error.code}: ${error.message}`;
  }
  if (error instanceof z.ZodError) {
    return "The alert payload did not match the contract — the corpus and the console are out of step.";
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read the generated scenario map.
 *
 * A missing file is not an error: the console must open with nothing configured, and the only
 * consequence is that no alert shows a ground-truth marker. A *malformed* file is also degraded
 * rather than fatal, for the same reason.
 */
export async function readBenchmarkMap(path: string): Promise<Map<string, string>> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return new Map();
    const parsed = BenchmarkMap.safeParse(await file.json());
    if (!parsed.success) return new Map();
    return new Map(parsed.data.map((entry) => [entry.alertId, entry.scenarioId]));
  } catch {
    return new Map();
  }
}

function toQueueAlert(resource: SecurityAlertResource, scenarios: Map<string, string>): QueueAlert {
  const properties = resource.properties;
  const scenarioId = scenarios.get(properties.systemAlertId);
  return {
    alertId: properties.systemAlertId,
    title: properties.alertDisplayName,
    severity: properties.severity,
    vendorStatus: properties.status,
    startTimeUtc: properties.startTimeUtc,
    ...(properties.compromisedEntity === undefined
      ? {}
      : { compromisedEntity: properties.compromisedEntity }),
    ...(scenarioId === undefined ? {} : { scenarioId }),
    resource,
  };
}

/**
 * Fetch the alert corpus once.
 *
 * Deliberately not polled. The corpus only changes on `bun run data:bootstrap`, and a one-second
 * poll would be a quarter of a megabyte per second over loopback forever, in a TUI left open all
 * day — and would flap the degraded banner once a second whenever Sentinel was down (PRD-5 §7).
 */
export async function readAlerts(
  client: AlertReader,
  benchmarkMapPath: string,
): Promise<AlertsSnapshot> {
  const scenarios = await readBenchmarkMap(benchmarkMapPath);
  try {
    const resources = await client.listAlerts();
    return { alerts: resources.map((resource) => toQueueAlert(resource, scenarios)) };
  } catch (error) {
    return { alerts: [], error: describeAlertError(error) };
  }
}
