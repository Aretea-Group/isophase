import type { SecurityAlertResource } from "@soc/contracts";

/**
 * Build the first user message for an investigation (PRD-2 §7).
 *
 * The alert arrives whole, but the schema does not: the loaded environment reports 22 tables and
 * ~1,168 columns, and injecting all of it would spend the context window before the agent knows
 * which telemetry matters. Table names are enough to choose from; `get_security_schema` covers the
 * rest on demand.
 *
 * This is deliberately the *user* message. Stable instructions live in the system prompt, so
 * run-specific data never contaminates the replaceable part (PRD-2 §8).
 */
export function buildInitialContext(alert: SecurityAlertResource, tableNames: string[]): string {
  return [
    "Investigate the following Microsoft Sentinel alert.",
    "",
    "<alert>",
    JSON.stringify(alert, null, 2),
    "</alert>",
    "",
    "These are the tables you can query. Request schemas for whichever look relevant.",
    "",
    "<available_tables>",
    tableNames.join("\n"),
    "</available_tables>",
  ].join("\n");
}
