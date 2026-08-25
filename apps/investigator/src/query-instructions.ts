/**
 * Sentinel/KQL guidance, added only after the investigation first uses a Sentinel tool.
 *
 * The initial system prompt stays free of query tactics. Once the agent chooses telemetry, this
 * overlay persists for the remaining provider turns so query repair and follow-up queries see the
 * same rules without repeating them in every tool result.
 */
export const SENTINEL_QUERY_INSTRUCTIONS = `## Querying Sentinel

Query results return at most 500 rows and have a fixed response-size limit. Prefer aggregation (summarize, count, dcount) over dumping rows when looking at volume, and project only the columns you need from wide tables.

A schema lookup and a query that depends on it are not independent: if you do not already know the columns, wait for the schema result before writing the query. Only listed schema columns exist, and some tables have no datetime column. Never guess column names.

Before querying, identify the unresolved questions whose answers could change the verdict or impact. Start with those two decision axes and add another line of enquiry only when evidence reveals a material pivot. Prefer one aggregated query that covers related facts, and batch independent questions in one turn. Do not repeat a question that returned evidence already answered.

Use '| count' for a row count. Never write '| order by count()': order by must reference an output column, so name the aggregate and write '| summarize total=count() by Column | order by total desc'. Do not put a comma before 'by'. Apply the same naming rule whenever a later operator refers to an aggregate.`;

/**
 * Defender/advanced-hunting guidance, added only after the investigation first uses a Defender tool.
 *
 * Same job as the Sentinel overlay: the things a competent analyst knows before writing the first
 * query, and nothing that steers the investigation. PRD-8 §4.1 D11 requires the content come from
 * Phase 0's measured findings rather than from the published schema reference, and every claim
 * below was either measured by `scripts/probe-defender.ts` against a real tenant or is documented
 * behaviour the probe did not contradict.
 *
 * What the probe changed about this text: the error contract is stated as a fact rather than a
 * hope — a rejected query comes back as HTTP 400 with the Kusto engine's own message passed through
 * verbatim — and the "table does not exist" case is called out separately, because an unresolvable
 * table returns the same 400 as a typo but means the tenant is not licensed for that workload.
 * An agent that reads "Failed to resolve table" as a spelling mistake will retry the same query.
 */
export function defenderQueryInstructions(maxRows: number): string {
  return `## Querying Microsoft Defender advanced hunting

Data goes back 30 days. That is a hard boundary, not a default: a longer lookback returns nothing extra rather than an error. All data is UTC regardless of any timezone setting, so write time filters in UTC.

The time column is 'Timestamp' in every table. There is no 'TimeGenerated' here — that is Sentinel's name for it.

Alerts live in two tables joined on 'AlertId': 'AlertInfo' is one row per alert (Timestamp, AlertId, Title, Category, Severity, ServiceSource, DetectionSource, AttackTechniques) and 'AlertEvidence' is one row per entity involved in that alert. Neither carries an incident column, so the alerts of an incident cannot be gathered by query.

Query results return at most ${maxRows} rows and have a fixed response-size limit. Prefer aggregation (summarize, count, dcount) over dumping rows when looking at volume, and project only the columns you need — rows in these tables are wide, and a single unprojected table dump can exceed the response budget on its own.

'search' and 'union' work but must be scoped to named tables — 'search in (EmailEvents, IdentityInfo) "value"', not a bare 'search'. Unscoped forms span every table and fail on query size.

A rejected query comes back with the engine's own message. Read it: "Failed to resolve scalar expression named 'X'" is a column that does not exist, and "Failed to resolve table or column expression named 'X'" for a table name means this tenant does not hold that table at all — it is not licensed for that workload, so no spelling of it will work. Ask for the schema instead of retrying.

A schema lookup and a query that depends on it are not independent: if you do not already know the columns, wait for the schema result before writing the query. Only listed schema columns exist. Never guess column names.

Before querying, identify the unresolved questions whose answers could change the verdict or impact. Start with those two decision axes and add another line of enquiry only when evidence reveals a material pivot. Prefer one aggregated query that covers related facts, and batch independent questions in one turn. Do not repeat a question that returned evidence already answered.

Use '| count' for a row count. Never write '| order by count()': order by must reference an output column, so name the aggregate and write '| summarize total=count() by Column | order by total desc'. Do not put a comma before 'by'. Apply the same naming rule whenever a later operator refers to an aggregate.`;
}
