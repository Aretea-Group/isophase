#!/usr/bin/env bun
/**
 * Loads the Training Lab telemetry into the local Kusto Emulator.
 *
 *     bun run data:bootstrap    # create/replace tables and ingest
 *     bun run data:reset        # drop the database first
 *     bun run data:verify       # check an existing database, ingest nothing
 *
 * This is part of Mock Sentinel rather than a consumer of it, which is why it
 * may reach into `apps/mock-sentinel` (see the scripts/ override in
 * .oxlintrc.json). Investigator code must go through the REST boundary.
 */

import { loadConfig } from "../apps/mock-sentinel/src/config.ts";
import { KustoClient } from "../apps/mock-sentinel/src/kusto/client.ts";
import {
  bootstrap,
  verifyOnly,
  VerificationError,
} from "../apps/mock-sentinel/src/telemetry/bootstrap.ts";

const args = new Set(Bun.argv.slice(2));
const config = loadConfig();
const client = new KustoClient({
  endpoint: config.KUSTO_ENDPOINT,
  timeoutMs: config.KUSTO_TIMEOUT_MS,
});

const log = (message: string): void => console.info(message);
const mode = args.has("--verify-only") ? "verify" : "bootstrap";

log(`[bootstrap] ${config.KUSTO_ENDPOINT} database=${config.KUSTO_DATABASE} mode=${mode}`);

try {
  const summary =
    mode === "verify"
      ? await verifyOnly({ client, database: config.KUSTO_DATABASE, log })
      : await bootstrap({
          client,
          database: config.KUSTO_DATABASE,
          reset: args.has("--reset"),
          // Two lines, and they are what stop TELEMETRY_TIME_ANCHOR being dead config (PRD-6 D15).
          // It was declared, accepted as an option, defaulted to `new Date()` — and never passed,
          // so the documented way to pin a reproducible corpus was unreachable.
          ...(config.TELEMETRY_TIME_ANCHOR === undefined
            ? {}
            : { timeAnchor: new Date(config.TELEMETRY_TIME_ANCHOR) }),
          queryMaxRows: config.QUERY_MAX_ROWS,
          log,
        });

  log(
    `[bootstrap] ok — ${summary.tables} tables, ${summary.rows.toLocaleString("en-US")} rows, ` +
      `${summary.columns} columns in ${(summary.elapsedMs / 1000).toFixed(1)}s`,
  );
  if (summary.corpus !== undefined) {
    log(
      `[bootstrap] corpus ${summary.corpus.alertSetHash} — anchor ${summary.corpus.anchorUtc}, ` +
        `telemetry ${summary.corpus.telemetryRevision.slice(0, 8)}, ` +
        `queryMaxRows ${summary.corpus.queryMaxRows}`,
    );
  }
} catch (error) {
  if (error instanceof VerificationError) {
    console.error(`[bootstrap] ${error.message}`);
  } else {
    console.error(`[bootstrap] ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(1);
}
