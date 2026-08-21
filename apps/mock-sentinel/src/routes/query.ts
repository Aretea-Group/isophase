import { apiError, QueryRequest, QueryResponse } from "@soc/contracts";
import { Hono } from "hono";

import type { Config } from "../config.ts";
import { KustoError, KustoUnavailableError, type KustoClient } from "../kusto/client.ts";
import { referencesInternalTable } from "../telemetry/corpus.ts";

export interface QueryRoutesOptions {
  config: Config;
  kusto: KustoClient;
}

/**
 * Detects a Kusto control command.
 *
 * This guard is load-bearing, not defence in depth. Measured against the
 * emulator: `POST /v1/rest/query` happily executes `.show databases`, and by
 * extension `.drop table SecurityEvent`. Kusto's *query* language has no
 * mutating syntax at all — every destructive operation is a control command,
 * and every control command begins with `.` — so refusing a leading dot is a
 * complete boundary rather than a partial one.
 *
 * Leading whitespace and KQL line comments are stripped first, so
 * `"  // go\n.drop table X"` cannot slip through.
 */
export function isControlCommand(query: string): boolean {
  const firstStatement = query
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "" && !line.startsWith("//"));

  return firstStatement?.startsWith(".") ?? false;
}

export function queryRoutes(options: QueryRoutesOptions): Hono {
  const { config, kusto } = options;
  const app = new Hono();

  app.post("/query", async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const parsed = QueryRequest.safeParse(body);
    if (!parsed.success) {
      return c.json(apiError("bad_request", "Invalid query request", parsed.error.flatten()), 400);
    }

    const { query } = parsed.data;

    if (isControlCommand(query)) {
      // Reported as a query error, not a 403: PRD-1 §4.4 wants the caller — a
      // future agent included — to see a normal, actionable failure it can
      // correct, rather than a special case it has to learn about separately.
      return c.json(
        apiError(
          "query_error",
          "Control commands are not permitted. POST /query executes read-only KQL; " +
            "commands beginning with '.' modify the workspace and are rejected.",
          { rejected: query.trim().split("\n", 1)[0] },
        ),
        400,
      );
    }

    const internal = referencesInternalTable(query);
    if (internal !== undefined) {
      // Same shape as the control-command rejection: a normal, actionable query error rather than
      // a special case the caller has to learn about (PRD-1 §4.4).
      return c.json(
        apiError(
          "query_error",
          `Table ${internal} is internal bookkeeping, not telemetry, and cannot be queried. ` +
            "GET /schema lists every table that can.",
          { rejected: internal },
        ),
        400,
      );
    }

    try {
      // One row over the cap is enough to prove truncation, so ask for that and
      // no more — the alternative is materialising a result the caller will
      // never see.
      const limited = `${query}\n| take ${config.QUERY_MAX_ROWS + 1}`;
      const result = await kusto.query(config.KUSTO_DATABASE, limited);

      const truncated = result.rows.length > config.QUERY_MAX_ROWS;
      const rows = truncated ? result.rows.slice(0, config.QUERY_MAX_ROWS) : result.rows;

      const response: QueryResponse = {
        tables: [
          {
            name: "PrimaryResult",
            columns: result.columns.map((column) => ({ name: column.name, type: column.type })),
            rows,
          },
        ],
        truncation: {
          truncated,
          returnedRows: rows.length,
          maxRows: config.QUERY_MAX_ROWS,
        },
      };

      return c.json(QueryResponse.parse(response), 200);
    } catch (error) {
      if (error instanceof KustoError) {
        // Handed back verbatim. PRD-1 §4.4 forbids repairing invalid KQL: the
        // caller must be able to see what the engine actually said and decide
        // whether to retry.
        return c.json(apiError("query_error", error.message, error.details), 400);
      }
      if (error instanceof KustoUnavailableError) {
        return c.json(apiError("upstream_unavailable", error.message), 503);
      }
      throw error;
    }
  });

  return app;
}
