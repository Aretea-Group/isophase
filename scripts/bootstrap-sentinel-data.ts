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
          log,
        });

  log(
    `[bootstrap] ok — ${summary.tables} tables, ${summary.rows.toLocaleString("en-US")} rows, ` +
      `${summary.columns} columns in ${(summary.elapsedMs / 1000).toFixed(1)}s`,
  );
} catch (error) {
  if (error instanceof VerificationError) {
    console.error(`[bootstrap] ${error.message}`);
  } else {
    console.error(`[bootstrap] ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(1);
}
