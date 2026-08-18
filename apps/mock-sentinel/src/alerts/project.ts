import { AlertEntity, SecurityAlertResource, type AlertSeverity } from "@soc/contracts";

import { decodeEntities } from "./entities.ts";
import { armAlertId } from "./table.ts";

/**
 * Projects a `SecurityAlert` row into the ARM resource `GET /alerts` returns.
 *
 * This is the impedance mismatch between Sentinel's two alert representations,
 * and it is real rather than self-inflicted — the Log Analytics table and the
 * ARM API genuinely disagree about how the same alert is shaped:
 *
 * | Field        | Table                     | ARM                |
 * |--------------|---------------------------|--------------------|
 * | Tactics      | `"CredentialAccess,Impact"`| `string[]`        |
 * | Entities     | JSON inside a `string`     | parsed objects     |
 * | Remediation  | JSON inside a `string`     | `string[]`         |
 * | Casing       | PascalCase                 | camelCase          |
 *
 * Keeping both faithful means translating here rather than compromising either.
 */

/** One row of a `SecurityAlert` query, keyed by column name. */
export type AlertRow = Record<string, unknown>;

const text = (row: AlertRow, column: string): string => {
  const value = row[column];
  return value === null || value === undefined ? "" : String(value);
};

/**
 * Normalises a Kusto datetime to millisecond ISO 8601.
 *
 * Kusto emits up to seven fractional digits; the contract expects ordinary ISO,
 * so everything is round-tripped through `Date` for a single consistent shape.
 */
function isoOrUndefined(value: string): string | undefined {
  if (value === "") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/** Splits the table's comma-delimited list columns. */
function list(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/** Parses a JSON-in-string column, tolerating anything that is not JSON. */
function jsonOr<T>(value: string, fallback: T): T {
  if (value.trim() === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

const SEVERITIES = new Set(["High", "Medium", "Low", "Informational"]);
const STATUSES = new Set(["Unknown", "New", "Resolved", "Dismissed", "InProgress"]);
const CONFIDENCE = new Set(["Unknown", "Low", "High"]);

/**
 * Builds the ARM resource for one alert row.
 *
 * Validated against the contract before returning, so a malformed row fails
 * here — at the boundary that produced it — rather than reaching a consumer.
 */
export function projectAlert(row: AlertRow): SecurityAlertResource {
  const systemAlertId = text(row, "SystemAlertId");
  const timeGenerated = isoOrUndefined(text(row, "TimeGenerated")) ?? new Date(0).toISOString();

  const severityRaw = text(row, "AlertSeverity");
  const severity: AlertSeverity = SEVERITIES.has(severityRaw)
    ? (severityRaw as AlertSeverity)
    : "Informational";

  const statusRaw = text(row, "Status");
  const confidenceRaw = text(row, "ConfidenceLevel");
  const confidenceScore = Number(text(row, "ConfidenceScore"));

  // Entities are validated individually: one malformed entity should cost that
  // entity, not the whole alert, since the rest of the alert is still usable
  // evidence for an investigation.
  const entities = decodeEntities(text(row, "Entities")).flatMap((candidate) => {
    const parsed = AlertEntity.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });

  return SecurityAlertResource.parse({
    id: armAlertId(systemAlertId),
    name: systemAlertId,
    type: "Microsoft.SecurityInsights/Entities",
    kind: "SecurityAlert",
    properties: {
      systemAlertId,
      alertDisplayName: text(row, "DisplayName") || text(row, "AlertName"),
      description: text(row, "Description"),
      severity,
      status: STATUSES.has(statusRaw) ? statusRaw : "Unknown",
      alertType: text(row, "AlertType") || "Unknown",
      vendorOriginalId: text(row, "VendorOriginalId") || undefined,
      vendorName: text(row, "VendorName") || "Unknown",
      productName: text(row, "ProductName") || "Unknown",
      productComponentName: text(row, "ProductComponentName") || undefined,
      providerName: text(row, "ProviderName") || "Unknown",
      tactics: list(text(row, "Tactics")),
      // The table splits parent techniques from sub-techniques across two
      // columns; ARM presents one list.
      techniques: [
        ...new Set([...list(text(row, "Techniques")), ...list(text(row, "SubTechniques"))]),
      ],
      startTimeUtc: isoOrUndefined(text(row, "StartTime")) ?? timeGenerated,
      endTimeUtc: isoOrUndefined(text(row, "EndTime")) ?? timeGenerated,
      timeGenerated,
      processingEndTime: isoOrUndefined(text(row, "ProcessingEndTime")) ?? timeGenerated,
      confidenceLevel: CONFIDENCE.has(confidenceRaw) ? confidenceRaw : "Unknown",
      confidenceScore:
        Number.isFinite(confidenceScore) && confidenceScore > 0 ? confidenceScore : undefined,
      compromisedEntity: text(row, "CompromisedEntity") || undefined,
      remediationSteps: jsonOr<string[]>(text(row, "RemediationSteps"), []),
      alertLink: text(row, "AlertLink") || undefined,
      additionalData: jsonOr<Record<string, unknown>>(text(row, "ExtendedProperties"), {}),
      entities,
    },
  });
}

/** Columns `/alerts` selects. Explicit so the projection cannot silently lose one. */
export const ALERT_PROJECTION_COLUMNS = [
  "SystemAlertId",
  "TimeGenerated",
  "DisplayName",
  "AlertName",
  "AlertSeverity",
  "Description",
  "Status",
  "AlertType",
  "VendorOriginalId",
  "VendorName",
  "ProductName",
  "ProductComponentName",
  "ProviderName",
  "Tactics",
  "Techniques",
  "SubTechniques",
  "StartTime",
  "EndTime",
  "ProcessingEndTime",
  "ConfidenceLevel",
  "ConfidenceScore",
  "CompromisedEntity",
  "RemediationSteps",
  "AlertLink",
  "ExtendedProperties",
  "Entities",
] as const;
