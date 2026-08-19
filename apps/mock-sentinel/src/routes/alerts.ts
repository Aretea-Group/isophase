import { AlertListResponse, apiError } from "@soc/contracts";
import { Hono } from "hono";

import { ALERT_PROJECTION_COLUMNS, projectAlert, type AlertRow } from "../alerts/project.ts";
import { SECURITY_ALERT_TABLE } from "../alerts/table.ts";
import type { Config } from "../config.ts";
import { KustoError, KustoUnavailableError, type KustoClient } from "../kusto/client.ts";

export interface AlertRoutesOptions {
  config: Config;
  kusto: KustoClient;
}

/** Escapes a value for safe interpolation into a KQL string literal. */
function kqlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

const PROJECTION = ALERT_PROJECTION_COLUMNS.join(", ");

/** Zips a Kusto result into objects keyed by column name. */
function toRows(columns: readonly { name: string }[], rows: readonly unknown[][]): AlertRow[] {
  return rows.map((row) => Object.fromEntries(columns.map((column, i) => [column.name, row[i]])));
}

/**
 * `GET /alerts` and `GET /alerts/:id`.
 *
 * Alerts are read from the `SecurityAlert` table rather than a fixture file, so
 * REST and KQL cannot disagree about what exists — the same relationship real
 * Sentinel has between its API and its table. Responses are ARM-shaped; see
 * `packages/contracts/src/alerts.ts` for the two documented deviations.
 */
export function alertRoutes(options: AlertRoutesOptions): Hono {
  const { config, kusto } = options;
  const app = new Hono();

  app.get("/alerts", async (c) => {
    // `$top` follows the ARM convention. Optional: the full list is 154 alerts,
    // which is a realistic queue rather than something needing pagination.
    const topRaw = c.req.query("$top");
    const top = topRaw === undefined ? undefined : Number(topRaw);
    if (top !== undefined && (!Number.isInteger(top) || top < 1)) {
      return c.json(apiError("bad_request", "$top must be a positive integer"), 400);
    }

    try {
      const query =
        `${SECURITY_ALERT_TABLE.table}\n` +
        `| order by TimeGenerated desc\n` +
        (top === undefined ? "" : `| take ${top}\n`) +
        `| project ${PROJECTION}`;

      const result = await kusto.query(config.KUSTO_DATABASE, query);
      const value = toRows(result.columns, result.rows).map(projectAlert);

      return c.json(AlertListResponse.parse({ value }), 200);
    } catch (error) {
      return handle(error, c);
    }
  });

  app.get("/alerts/:id", async (c) => {
    const id = c.req.param("id");

    try {
      const query =
        `${SECURITY_ALERT_TABLE.table}\n` +
        `| where SystemAlertId == ${kqlString(id)}\n` +
        `| take 1\n` +
        `| project ${PROJECTION}`;

      const result = await kusto.query(config.KUSTO_DATABASE, query);
      const rows = toRows(result.columns, result.rows);
      const row = rows[0];

      if (row === undefined) {
        return c.json(apiError("not_found", `No alert with id ${id}`), 404);
      }
      return c.json(projectAlert(row), 200);
    } catch (error) {
      return handle(error, c);
    }
  });

  return app;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono's context type
function handle(
  error: unknown,
  c: { json: (body: unknown, status: 400 | 503) => Response },
): Response {
  if (error instanceof KustoError) {
    return c.json(apiError("query_error", error.message, error.details), 400);
  }
  if (error instanceof KustoUnavailableError) {
    return c.json(apiError("upstream_unavailable", error.message), 503);
  }
  throw error;
}
