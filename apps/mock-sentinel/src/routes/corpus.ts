import { apiError, CorpusIdentity } from "@soc/contracts";
import { Hono } from "hono";

import type { Config } from "../config.ts";
import { KustoUnavailableError, type KustoClient } from "../kusto/client.ts";
import { readCorpusManifest } from "../telemetry/corpus.ts";

export interface CorpusRoutesOptions {
  config: Config;
  kusto: KustoClient;
}

/**
 * `GET /corpus` — which data this environment actually holds (PRD-6 §6.8, ADR 008 §5).
 *
 * The sixth route, and the first addition to this surface since it was specified (`AGENTS.md` §9).
 * It exists so a run artifact can record what it was scored against: alert ids are content-addressed
 * over the rule and the projected row (ADR 004), so a `| project` reorder re-pins them and orphans
 * every prior run for that alert — reported today as an empty report and nothing else.
 *
 * Deliberately not folded into `/health`, which `packages/contracts/src/health.ts` records as
 * operational only and not an investigation primitive. This is neither operational nor an
 * investigation primitive; it is a fact about the corpus, read by evaluation tooling.
 *
 * **404 rather than an error when the marker table is missing.** An older Mock Sentinel, or a
 * database built before this landed, must not break `bun run investigate` — the client degrades to
 * `undefined` and the report prints `corpus unknown` rather than a fabricated match.
 */
export function corpusRoutes(options: CorpusRoutesOptions): Hono {
  const { config, kusto } = options;
  const app = new Hono();

  app.get("/corpus", async (c) => {
    try {
      const identity = await readCorpusManifest(kusto, config.KUSTO_DATABASE);
      if (identity === undefined) {
        return c.json(
          apiError(
            "not_found",
            "This database holds no corpus manifest. Re-run `bun run data:bootstrap` to write one.",
          ),
          404,
        );
      }
      return c.json(CorpusIdentity.parse(identity), 200);
    } catch (error) {
      if (error instanceof KustoUnavailableError) {
        return c.json(apiError("upstream_unavailable", error.message), 503);
      }
      throw error;
    }
  });

  return app;
}
