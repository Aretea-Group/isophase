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

export const SENTINEL_QUERY_TOOL_NAMES = ["get_security_schema", "query_security_data"] as const;

const SENTINEL_TOOL_NAMES = new Set<string>(SENTINEL_QUERY_TOOL_NAMES);

export function isSentinelTool(name: string): boolean {
  return SENTINEL_TOOL_NAMES.has(name);
}

export function addSentinelQueryInstructions(systemPrompt: string): string {
  return `${systemPrompt}\n\n${SENTINEL_QUERY_INSTRUCTIONS}`;
}
