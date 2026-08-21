import { apiError, SchemaResponse } from "@soc/contracts";
import { Hono } from "hono";

import type { Config } from "../config.ts";
import { KustoUnavailableError, type KustoClient } from "../kusto/client.ts";
import { isInternalTable } from "../telemetry/corpus.ts";
import { clrToKusto } from "../telemetry/verify.ts";

export interface SchemaRoutesOptions {
  config: Config;
  kusto: KustoClient;
}

/**
 * `GET /schema` — the tables and columns that can actually be queried.
 *
 * Read from the engine on every request rather than from the manifest. ADR 001
 * requires exactly this: a hand-maintained schema can drift from what is really
 * queryable, and the agent that trusts it then writes KQL against columns which
 * do not exist.
 */
export function schemaRoutes(options: SchemaRoutesOptions): Hono {
  const { config, kusto } = options;
  const app = new Hono();

  app.get("/schema", async (c) => {
    try {
      const result = await kusto.mgmt(
        `.show database ${config.KUSTO_DATABASE} schema`,
        config.KUSTO_DATABASE,
      );

      // Rows arrive flat — one per column, with database and table rows
      // interleaved — so they are regrouped here.
      const tables = new Map<string, { name: string; type: string }[]>();
      for (const row of result.rows) {
        const [, tableName, columnName, columnType] = row as (string | null)[];
        if (!tableName) continue;
        // Infrastructure, not telemetry (PRD-6 §6.8). The harness puts every name this route
        // returns into the agent's opening `<available_tables>` block, so a bookkeeping table would
        // be a table the agent is invited to query — and a benchmarking change that silently alters
        // turn-0 context is a change to the thing being measured.
        if (isInternalTable(tableName)) continue;
        const columns = tables.get(tableName) ?? [];
        if (columnName)
          columns.push({ name: columnName, type: clrToKusto(String(columnType ?? "")) });
        tables.set(tableName, columns);
      }

      const body = SchemaResponse.parse({
        database: config.KUSTO_DATABASE,
        tables: [...tables.entries()]
          .map(([name, columns]) => ({ name, columns }))
          .toSorted((a, b) => a.name.localeCompare(b.name)),
      });

      return c.json(body, 200);
    } catch (error) {
      if (error instanceof KustoUnavailableError) {
        return c.json(apiError("upstream_unavailable", error.message), 503);
      }
      throw error;
    }
  });

  return app;
}
