import { apiError } from "@soc/contracts";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import type { Config } from "./config.ts";
import type { KustoClient } from "./kusto/client.ts";
import { alertRoutes } from "./routes/alerts.ts";
import { healthRoutes, type DependencyProbe } from "./routes/health.ts";
import { queryRoutes } from "./routes/query.ts";
import { schemaRoutes } from "./routes/schema.ts";

export interface CreateAppOptions {
  config: Config;
  /**
   * Kusto client backing `/alerts`, `/schema` and `/query`.
   *
   * Optional so `/health`-only tests stay hermetic; the domain routes are
   * mounted only when it is supplied.
   */
  kusto?: KustoClient;
  /** Injected so integration tests can run without the Kusto container. */
  probes?: Record<string, DependencyProbe>;
}

/**
 * Builds the Mock Sentinel REST facade.
 *
 * This service owns the *entire* public surface of the mock environment.
 * Kusto and the alert fixtures are internal implementation details and must
 * never be reachable by a consumer except through these routes (PRD-1 §7).
 *
 * The Sentinel surface is `/alerts`, `/alerts/:id`, `/schema` and `/query`;
 * `/health` is operational only and not part of the domain capability.
 */
export function createApp(options: CreateAppOptions): Hono {
  const { config, kusto, probes } = options;
  const startedAt = Date.now();

  const app = new Hono();

  app.route("/", healthRoutes({ config, startedAt, probes, declared: ["kusto", "database"] }));

  if (kusto !== undefined) {
    app.route("/", alertRoutes({ config, kusto }));
    app.route("/", schemaRoutes({ config, kusto }));
    app.route("/", queryRoutes({ config, kusto }));
  }

  app.notFound((c) =>
    c.json(apiError("not_found", `No route for ${c.req.method} ${c.req.path}`), 404),
  );

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json(apiError("bad_request", err.message), err.status);
    }
    console.error("[mock-sentinel] unhandled error", err);
    return c.json(apiError("internal_error", "Unexpected error"), 500);
  });

  return app;
}
