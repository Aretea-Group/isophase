import { z } from "zod";

/**
 * Tabular result contract shared by source clients and `POST /query`.
 *
 * The response follows the Azure Monitor / Log Analytics query API shape —
 * `{ tables: [{ name, columns: [{ name, type }], rows }] }` — because that is
 * what running KQL against a real Sentinel workspace returns. Rows are
 * positional arrays aligned to `columns`, exactly as the engine emits them.
 *
 * `truncation` is ours, not Microsoft's: the real API has no such field, but
 * PRD-1 §4.4 requires truncation to be visible so a caller can tell "these are
 * all the results" from "these are the first 500". Keeping it a sibling of
 * `tables` leaves the Microsoft-shaped part untouched.
 */

export const QueryRequest = z.object({
  /** KQL. Control commands (anything starting with `.`) are rejected. */
  query: z.string().min(1, "query must not be empty"),
  /** ISO 8601 interval, accepted and echoed for API familiarity. */
  timespan: z.string().optional(),
});
export type QueryRequest = z.infer<typeof QueryRequest>;

export const QueryColumn = z.object({
  name: z.string(),
  /** Engine-native scalar type string, preserved without a cross-engine taxonomy. */
  type: z.string(),
});
export type QueryColumn = z.infer<typeof QueryColumn>;

export const QueryTable = z.object({
  name: z.string(),
  columns: z.array(QueryColumn),
  /** Positional rows aligned to `columns`. */
  rows: z.array(z.array(z.unknown())),
});
export type QueryTable = z.infer<typeof QueryTable>;

export const QueryTruncation = z.object({
  /** True when the engine produced more rows than were returned. */
  truncated: z.boolean(),
  returnedRows: z.number().int().nonnegative(),
  /** The cap applied, from `QUERY_MAX_ROWS`. */
  maxRows: z.number().int().positive(),
});
export type QueryTruncation = z.infer<typeof QueryTruncation>;

export const QueryResponse = z.object({
  tables: z.array(QueryTable),
  truncation: QueryTruncation,
});
export type QueryResponse = z.infer<typeof QueryResponse>;
