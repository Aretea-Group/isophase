import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { QueryResponse } from "@soc/contracts";
import type { SecurityDataSource } from "@soc/sentinel-client";

export function querySecurityDataParameters(description: string) {
  return Type.Object(
    { query: Type.String({ minLength: 1, description }) },
    { additionalProperties: false },
  );
}

/** Default character budget for one query result. Roughly 10k tokens. */
export const DEFAULT_RESULT_MAX_CHARS = 40_000;

export interface FittedResult {
  text: string;
  keptRows: number;
  totalRows: number;
}

/**
 * Serialise a query result within a character budget.
 *
 * Two things are going on, and only one of them is a judgement call.
 *
 * Compact serialisation is free: pretty-printing a positional row array puts every scalar on its
 * own indented line and roughly doubles the payload for no added meaning.
 *
 * The row budget is a genuine guardrail, and ADR 002 requires one ("result-size limits"). Measured
 * against this environment, `OfficeActivity_CL | take 500` serialises to ~187k tokens pretty and
 * ~88k compact — a single query that exceeds the model's per-minute budget outright.
 *
 * Rows are dropped from the tail and the drop is reported. That keeps PRD-2 §11 intact: nothing
 * here decides which rows are interesting, summarises them, or extracts evidence — it reports how
 * much did not fit and hands the problem back to the model, which can aggregate or project
 * narrower. Silently truncating would be the harmful version, because the model would reason over
 * a partial result believing it was whole.
 */
export function fitResultToBudget(result: QueryResponse, maxChars: number): FittedResult {
  const compact = JSON.stringify(result);
  const table = result.tables[0];
  const totalRows = table?.rows.length ?? 0;

  if (compact.length <= maxChars || !table || totalRows === 0) {
    return { text: compact, keptRows: totalRows, totalRows };
  }

  // Binary search the largest row count that fits, so wide and narrow tables both land close to
  // the budget instead of one of them being punished by a fixed guess.
  let low = 0;
  let high = totalRows;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = { ...result, tables: [{ ...table, rows: table.rows.slice(0, mid) }] };
    if (JSON.stringify(candidate).length <= maxChars) low = mid;
    else high = mid - 1;
  }

  const kept = { ...result, tables: [{ ...table, rows: table.rows.slice(0, low) }] };
  const notice =
    `\n\nNOTE: this result was too large to return in full (${compact.length} characters, limit ${maxChars}). ` +
    `Showing the first ${low} of ${totalRows} rows. The rows are not a sample — they are simply the first ones. ` +
    `To see the whole picture, ask a narrower or aggregated query.`;

  return { text: JSON.stringify(kept) + notice, keptRows: low, totalRows };
}

/**
 * Arbitrary read-only source query against the security telemetry (PRD-2 §11, ADR 010 §3).
 *
 * The result is handed back uninterpreted: no summarisation, no evidence extraction, no semantic
 * normalisation. Understanding the rows is the model's job, and anything this layer chose to
 * emphasise would be an investigation playbook smuggled in through formatting.
 *
 * Failures are thrown rather than returned as content, which is how pi-agent-core wants tool errors
 * reported. The connector's actionable native diagnostic propagates untouched so the model can
 * repair its own query.
 */
/** Stable name and label; selected profile supplies description and `{ query }` help text. */
export const QUERY_SECURITY_DATA = {
  name: "query_security_data",
  label: "Query security data",
} as const;

export function createQuerySecurityDataTool(
  source: SecurityDataSource,
  description: string,
  parameterDescription: string,
  maxChars: number = DEFAULT_RESULT_MAX_CHARS,
): AgentTool<ReturnType<typeof querySecurityDataParameters>> {
  const parameters = querySecurityDataParameters(parameterDescription);
  return {
    ...QUERY_SECURITY_DATA,
    description,
    parameters,
    execute: async (_toolCallId, params) => {
      const result = await source.query(params.query);
      const fitted = fitResultToBudget(result, maxChars);

      return {
        content: [{ type: "text", text: fitted.text }],
        details: {
          query: params.query,
          truncation: result.truncation,
          keptRows: fitted.keptRows,
          totalRows: fitted.totalRows,
        },
      };
    },
  };
}
