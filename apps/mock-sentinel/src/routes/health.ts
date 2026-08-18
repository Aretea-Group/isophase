import { HealthResponse } from "@soc/contracts";
import { Hono } from "hono";

import type { Config } from "../config.ts";

/**
 * A dependency probe reports whether an internal backend is reachable.
 * Probes are injected so tests never need the real Kusto container.
 */
export type DependencyProbe = () => Promise<"up" | "down">;

export interface HealthOptions {
  config: Config;
  startedAt: number;
  /** Probes keyed by dependency name. Unprobed dependencies report "unknown". */
  probes?: Record<string, DependencyProbe>;
  /** Dependencies the service declares but cannot yet probe. */
  declared?: readonly string[];
}

export function healthRoutes(options: HealthOptions): Hono {
  const { config, startedAt, probes = {}, declared = [] } = options;
  const app = new Hono();

  app.get("/health", async (c) => {
    const dependencies: Record<string, "up" | "down" | "unknown"> = {};
    for (const name of declared) {
      dependencies[name] = "unknown";
    }

    await Promise.all(
      Object.entries(probes).map(async ([name, probe]) => {
        try {
          dependencies[name] = await probe();
        } catch {
          dependencies[name] = "down";
        }
      }),
    );

    const body: HealthResponse = {
      status: Object.values(dependencies).includes("down") ? "degraded" : "ok",
      service: "mock-sentinel",
      version: config.SERVICE_VERSION,
      uptimeSeconds: Math.max(0, (Date.now() - startedAt) / 1000),
      dependencies,
    };

    return c.json(HealthResponse.parse(body), body.status === "ok" ? 200 : 503);
  });

  return app;
}
