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
export function buildInitialContext(
  alert: SecurityAlertResource,
  tableNames: string[],
  analystContext?: string,
): string {
  const lines = [
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
  ];

  const premise = sanitiseAnalystContext(analystContext);
  if (premise !== undefined) {
    lines.push(
      "",
      "An analyst has supplied context the telemetry cannot show. Treat it as stated in your",
      "instructions: environment facts to work with, and any verdict in it as a hypothesis to test.",
      "",
      "<analyst_context>",
      premise,
      "</analyst_context>",
    );
  }

  return lines.join("\n");
}

/** Cap on the embedded premise. Long enough for real context, short enough not to dominate turn 0. */
export const ANALYST_CONTEXT_MAX_CHARS = 4_000;

/**
 * Strip the envelope delimiters out of the embedded copy, and cap it.
 *
 * The raw text is stored on the artifact unmodified (PRD-5 §9), which is what makes this
 * transformation auditable. Removing the delimiters matters because the premise is operator-typed
 * free text arriving at turn 0: without it, a premise containing `</analyst_context>` could close
 * its own envelope and continue as if it were the harness speaking.
 */
export function sanitiseAnalystContext(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const stripped = text
    .replaceAll(/<\/?analyst_context>/gi, "")
    .replaceAll(/<\/?alert>/gi, "")
    .replaceAll(/<\/?available_tables>/gi, "")
    .trim();
  if (stripped === "") return undefined;
  return stripped.length <= ANALYST_CONTEXT_MAX_CHARS
    ? stripped
    : `${stripped.slice(0, ANALYST_CONTEXT_MAX_CHARS)}… (truncated)`;
}
