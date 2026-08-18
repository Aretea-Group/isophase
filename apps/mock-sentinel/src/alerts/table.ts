import type { TelemetryColumn, TelemetryTable } from "../telemetry/manifest.ts";

/**
 * The real `SecurityAlert` Log Analytics schema.
 *
 * Taken column-for-column from
 * learn.microsoft.com/azure/sentinel/security-alert-schema, including the
 * columns Microsoft marks DEPRECATED. Those are kept because real query results
 * contain them: an analyst — or an agent — that has read Sentinel documentation
 * will write `where IsIncident == false` or project `SourceSystem`, and getting
 * a "column not found" error for a column that exists in every real workspace
 * would be a fidelity bug, not a simplification.
 *
 * The billing columns `_BilledSize` and `_IsBillable` are excluded. They are
 * Log Analytics ingestion metadata rather than alert content, and ADR 001's
 * rule against permanently-uninformative columns applies.
 *
 * Note the types that are *not* what you would design: `Entities`,
 * `ExtendedProperties` and `ExtendedLinks` are `string` holding JSON, and
 * `Tactics`/`Techniques` are comma-delimited `string`, not arrays. That is how
 * the real table stores them, so that is how this one does.
 */
export const SECURITY_ALERT_COLUMNS: readonly TelemetryColumn[] = [
  { name: "TenantId", type: "string" },
  { name: "TimeGenerated", type: "datetime" },
  { name: "DisplayName", type: "string" },
  { name: "AlertName", type: "string" },
  { name: "AlertSeverity", type: "string" },
  { name: "Description", type: "string" },
  { name: "ProviderName", type: "string" },
  { name: "VendorName", type: "string" },
  { name: "VendorOriginalId", type: "string" },
  { name: "SystemAlertId", type: "string" },
  { name: "ResourceId", type: "string" },
  { name: "AlertType", type: "string" },
  { name: "ConfidenceLevel", type: "string" },
  { name: "ConfidenceScore", type: "real" },
  { name: "StartTime", type: "datetime" },
  { name: "EndTime", type: "datetime" },
  { name: "ProcessingEndTime", type: "datetime" },
  { name: "RemediationSteps", type: "string" },
  { name: "ExtendedProperties", type: "string" },
  { name: "Entities", type: "string" },
  { name: "ExtendedLinks", type: "string" },
  { name: "ProductName", type: "string" },
  { name: "ProductComponentName", type: "string" },
  { name: "AlertLink", type: "string" },
  { name: "Status", type: "string" },
  { name: "CompromisedEntity", type: "string" },
  { name: "Tactics", type: "string" },
  { name: "Techniques", type: "string" },
  { name: "SubTechniques", type: "string" },
  { name: "Type", type: "string" },
  // --- Deprecated upstream, retained for fidelity. See the header. ---
  /** DEPRECATED. Always false. */
  { name: "IsIncident", type: "bool" },
  /** DEPRECATED. Always the constant "Detection". */
  { name: "SourceSystem", type: "string" },
  /** DEPRECATED. Was the agent id of the server that raised the alert. */
  { name: "SourceComputerId", type: "string" },
  /** DEPRECATED. */
  { name: "WorkspaceResourceGroup", type: "string" },
  /** DEPRECATED. */
  { name: "WorkspaceSubscriptionId", type: "string" },
];

/**
 * `SecurityAlert` as a table definition, so it creates, ingests and verifies
 * through exactly the same machinery as the vendored telemetry.
 */
export const SECURITY_ALERT_TABLE: TelemetryTable = {
  table: "SecurityAlert",
  source: "generated",
  file: "(generated at bootstrap from detection rules and connectors)",
  // Row count is whatever the rules and connectors produce against the current
  // telemetry, so there is nothing to pin here; the bootstrap instead asserts
  // that what was ingested matches what was generated.
  expectedRows: 0,
  columns: SECURITY_ALERT_COLUMNS,
};

/** One `SecurityAlert` row, keyed by column name. */
export type SecurityAlertRow = Record<string, string>;

/** Constants a real workspace stamps onto every alert row. */
export const ALERT_ROW_CONSTANTS = {
  Type: "SecurityAlert",
  SourceSystem: "Detection",
  IsIncident: "false",
  SourceComputerId: "",
  WorkspaceResourceGroup: "",
  WorkspaceSubscriptionId: "",
} as const;

/**
 * Synthetic workspace coordinates.
 *
 * PRD-1 §3 rules out reproducing the ARM hierarchy, but alert `id` and
 * `ResourceId` values are ARM-shaped strings in every real workspace and some
 * clients parse them. These fixed values keep the shape honest without
 * pretending to be a real tenant.
 */
export const WORKSPACE = {
  tenantId: "00000000-0000-0000-0000-000000000001",
  subscriptionId: "00000000-0000-0000-0000-000000000002",
  resourceGroup: "soc-agent-poc",
  workspaceName: "SentinelLab",
} as const;

export function armAlertId(systemAlertId: string): string {
  return (
    `/subscriptions/${WORKSPACE.subscriptionId}` +
    `/resourceGroups/${WORKSPACE.resourceGroup}` +
    `/providers/Microsoft.OperationalInsights/workspaces/${WORKSPACE.workspaceName}` +
    `/providers/Microsoft.SecurityInsights/Entities/${systemAlertId}`
  );
}

export function workspaceResourceId(): string {
  return (
    `/subscriptions/${WORKSPACE.subscriptionId}` +
    `/resourceGroups/${WORKSPACE.resourceGroup}` +
    `/providers/Microsoft.OperationalInsights/workspaces/${WORKSPACE.workspaceName}`
  );
}
