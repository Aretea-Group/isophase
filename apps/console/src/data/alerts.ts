import type { SecurityAlert } from "@soc/contracts";
import { SentinelApiError } from "@soc/sentinel-client";
import type { SecurityDataSource } from "@soc/sentinel-client";
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
 * `SecurityDataSource` also exposes query and schema access. Handing `data/` the whole source
 * would compile ad-hoc KQL execution into the console from the first increment — which PRD-3 §14
 * excludes by name, and which this PRD does not reopen. The queue needs two reads and gets two.
 */
export type AlertReader = Pick<SecurityDataSource, "listAlerts" | "getAlert">;

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
  resource: SecurityAlert;
}

export interface AlertsSnapshot {
  alerts: QueueAlert[];
  /** A human-readable reason the fetch failed, already phrased as what to do about it. */
  error?: string;
}

/**
 * Which product the console just failed to reach.
 *
 * Two fields rather than one because they answer different questions, and collapsing them is what
 * made this wrong: `id` is the active primary source, while `connector` distinguishes Sentinel's
 * two backends and means nothing for any other source.
 */
export interface AlertSource {
  /** The active primary source id — `sentinel`, `defender`. Never a Sentinel connector name. */
  id: string;
  /** Meaningful only when `id` is `sentinel`: the local corpus, or a real workspace. */
  connector: "mock" | "azure";
}

/**
 * Why a fetch failed, said in terms of the action that fixes it.
 *
 * Today 100% of console sessions run with no Sentinel at all, so this is the common path rather
 * than the exceptional one and deserves better than a stack trace (PRD-5 §7).
 *
 * **Branch on the source, not on the connector.** This took `"mock" | "azure"` and was handed
 * `SENTINEL_CONNECTOR`, which cannot express "the active source is Defender" — so a Graph timeout
 * under a Defender-only run rendered as "Mock Sentinel is not reachable — start it with
 * `bun run dev:mock-sentinel`", naming the wrong product and prescribing a process that has nothing
 * to do with the failure. `DefenderClient` throws the same `SentinelApiError` with the same
 * `unreachable` code, so the error itself carries nothing to tell them apart. There is deliberately
 * no default: a caller that does not know which source it queried cannot describe its failure.
 */
export function describeAlertError(error: unknown, source: AlertSource): string {
  if (error instanceof SentinelApiError) {
    if (source.id === "sentinel") {
      if (source.connector === "azure") {
        return `Azure Sentinel returned ${error.code}: ${error.message}`;
      }
      if (error.code === "unreachable") {
        return "Mock Sentinel is not reachable — start it with `bun run dev:mock-sentinel`.";
      }
      if (error.code === "upstream_unavailable") {
        return "Mock Sentinel is up but Kusto is not — check `bun run infra:up`.";
      }
      return `Mock Sentinel returned ${error.code}: ${error.message}`;
    }
    if (source.id === "defender") {
      if (error.code === "unreachable") {
        return "Microsoft Graph is not reachable — check the DEFENDER_* credential group and network.";
      }
      return `Defender returned ${error.code}: ${error.message}`;
    }
    // An id this build does not know how to advise about still names itself rather than borrowing
    // another source's remedy.
    return `${source.id} returned ${error.code}: ${error.message}`;
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

function toQueueAlert(resource: SecurityAlert, scenarios: Map<string, string>): QueueAlert {
  const scenarioId = scenarios.get(resource.id);
  return {
    alertId: resource.id,
    title: resource.title,
    severity: resource.severity ?? "Unknown",
    vendorStatus: resource.status ?? "Unknown",
    startTimeUtc: resource.startTimeUtc ?? resource.timeGenerated ?? "",
    ...(resource.compromisedEntity === undefined
      ? {}
      : { compromisedEntity: resource.compromisedEntity }),
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
  source: AlertSource,
): Promise<AlertsSnapshot> {
  const scenarios = await readBenchmarkMap(benchmarkMapPath);
  try {
    const resources = await client.listAlerts();
    return { alerts: resources.map((resource) => toQueueAlert(resource, scenarios)) };
  } catch (error) {
    return { alerts: [], error: describeAlertError(error, source) };
  }
}
