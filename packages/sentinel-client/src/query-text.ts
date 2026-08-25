import type { QueryResponse, QueryTable, QueryTruncation } from "@soc/contracts";

/**
 * Query-text rules shared by every connector that builds its own query (PRD-8 §4.1 D15).
 *
 * The row cap is pushed into the query so the engine never produces the extra rows. It bounds
 * *fetch* cost — bytes over the wire, engine work, and on Defender a shared per-tenant CPU
 * allowance — which is a property of the product, so each connector brings its own number. The
 * character budget is a different thing entirely: it bounds what reaches the model, it is a
 * property of the model rather than of any source, and it stays where it is, in
 * `INVESTIGATOR_RESULT_MAX_CHARS` above the connector.
 *
 * The rule this file exists to enforce is that **the cap is one value**. `azure.ts` used to hold
 * `QUERY_MAX_ROWS = 500` beside a hard-coded `| take 501`, two places that had to agree by hand:
 * raise the constant alone and the connector reports a complete result for a response the engine
 * truncated, which is the exact failure `QueryResponse.truncation` exists to prevent. Deriving both
 * from one argument makes that unrepresentable rather than merely unlikely.
 */

/**
 * Kusto control commands, which every connector here refuses.
 *
 * Leading comments and blank lines are skipped so `// note\n.show tables` is still recognised —
 * the check is on the first thing the engine would execute, not on the first character.
 */
export function isControlCommand(query: string): boolean {
  const firstStatement = query
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "" && !line.startsWith("//"));

  return firstStatement?.startsWith(".") ?? false;
}

/**
 * The query as sent: capped at one row *beyond* the limit.
 *
 * The extra row is what makes truncation detectable. Asking for exactly `maxRows` and receiving
 * exactly `maxRows` is ambiguous — it could be a complete result or a truncated one — and a caller
 * that cannot tell the difference reports "these are all the results" when they are not.
 */
export function withRowCap(query: string, maxRows: number): string {
  return `${query}\n| take ${maxRows + 1}`;
}

/**
 * Trim the primary table to the cap and report what that cost.
 *
 * `maxRows` is the same argument `withRowCap` received; passing a different one here is the bug
 * this module exists to prevent, which is why both are parameters of the same call site rather than
 * two constants in the same file.
 */
export function applyRowCap(
  tables: readonly QueryTable[],
  maxRows: number,
): { tables: QueryTable[]; truncation: QueryTruncation } {
  const primary = tables[0];
  const truncated = (primary?.rows.length ?? 0) > maxRows;
  const capped = tables.map((table, index) => ({
    name: table.name,
    columns: table.columns,
    rows: index === 0 && truncated ? table.rows.slice(0, maxRows) : table.rows,
  }));

  return {
    tables: capped,
    truncation: { truncated, returnedRows: capped[0]?.rows.length ?? 0, maxRows },
  };
}

/** `applyRowCap` in the shape the contract wants, for connectors that need nothing else. */
export function cappedResponse(tables: readonly QueryTable[], maxRows: number): QueryResponse {
  return applyRowCap(tables, maxRows);
}
