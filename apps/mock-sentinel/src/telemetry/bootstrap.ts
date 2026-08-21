/* oxlint-disable eslint/no-await-in-loop --
 * Ingestion is deliberately sequential. The Kusto Emulator is a single-node
 * engine running under x86-64 translation on Apple Silicon, where concurrency
 * has already been observed to destabilise it (infra/kusto/README.md documents
 * the .NET/Rosetta crashes and the flags that fix them). Ordering also matters:
 * a table is created before it is filled, and a chunk is only sent once the
 * previous one is durable. Fanning these out with Promise.all would trade a
 * bootstrap that already completes in ~1.6s for a flaky one.
 */

import type { CorpusIdentity } from "@soc/contracts";

import { generateAlerts } from "../alerts/generate.ts";
import { SECURITY_ALERT_TABLE } from "../alerts/table.ts";
import { KustoError, type KustoClient } from "../kusto/client.ts";
import { alertSetHash, writeCorpusManifest } from "./corpus.ts";
import { parseCsv } from "./csv.ts";
import { ingestRows, ingestTable } from "./ingest.ts";
import type { TelemetryTable } from "./manifest.ts";
import { applyTimeShift, normalizeTable, type NormalizedTable } from "./normalize.ts";
import { readTelemetryFile, TELEMETRY_REVISION } from "./source.ts";
import { TELEMETRY_TABLES } from "./tables.ts";
import {
  expectedNonEmpty,
  runScenarioProbes,
  verifyColumnPopulation,
  verifySchema,
  type VerificationIssue,
} from "./verify.ts";

/**
 * The bootstrap: cold Kusto Emulator to a populated `SentinelLab`.
 *
 * Responsibilities are ADR 001's — obtain telemetry from a pinned revision,
 * create the database, create schemas, ingest, verify representative
 * tables/rows, and fail loudly on drift — plus the alert generation this
 * environment needs, since the Training Lab ships no `SecurityAlert` data.
 *
 * The emulator keeps data only for the lifetime of its container, so this must
 * stay re-runnable: it is the single source of truth for recreating the
 * environment.
 */

export interface BootstrapOptions {
  client: KustoClient;
  database: string;
  /** Drop and recreate the database rather than reusing it. */
  reset?: boolean;
  /**
   * Instant the newest event is moved onto. Defaults to now; pin it for a
   * reproducible run.
   */
  timeAnchor?: Date;
  /**
   * The row cap `POST /query` will apply, recorded into `_CorpusManifest` (PRD-6 §6.8).
   *
   * Passed in rather than read here: bootstrap does not read the environment, and a corpus that
   * claims a cap the service does not enforce is worse than one that claims nothing.
   */
  queryMaxRows?: number;
  log?: (message: string) => void;
}

export interface BootstrapSummary {
  tables: number;
  rows: number;
  columns: number;
  alerts: number;
  /** How far the telemetry was moved forward, in milliseconds. */
  timeOffsetMs: number;
  elapsedMs: number;
  /** What was written into `_CorpusManifest`, so a caller can log it without reading it back. */
  corpus?: CorpusIdentity;
}

/** Fails with every issue listed, not just the first, so one run shows the whole picture. */
export class VerificationError extends Error {
  readonly issues: readonly VerificationIssue[];

  constructor(issues: readonly VerificationIssue[]) {
    super(
      `Telemetry verification failed with ${issues.length} issue(s):\n` +
        issues.map((i) => `  [${i.table}] ${i.detail}`).join("\n"),
    );
    this.name = "VerificationError";
    this.issues = issues;
  }
}

/**
 * Row count for one table, or `null` when the table cannot be queried at all.
 *
 * A missing table is a verification finding, not a transport failure: reporting
 * it as an issue keeps a single run listing everything that is wrong instead of
 * aborting on the first gap.
 */
async function countRows(
  client: KustoClient,
  database: string,
  table: string,
): Promise<number | null> {
  try {
    const result = await client.query(database, `${table} | count`);
    return Number(result.rows[0]?.[0] ?? -1);
  } catch (error) {
    if (error instanceof KustoError) return null;
    throw error;
  }
}

export async function waitForKusto(
  client: KustoClient,
  {
    timeoutMs = 120_000,
    intervalMs = 1_000,
    log,
  }: { timeoutMs?: number; intervalMs?: number; log?: (m: string) => void } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let announced = false;

  while (Date.now() < deadline) {
    if (await client.isReachable()) return;
    if (!announced) {
      log?.(`waiting for Kusto at ${client.endpoint} …`);
      announced = true;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(
    `Kusto at ${client.endpoint} did not become reachable within ${timeoutMs}ms. ` +
      `Start it with \`bun run infra:up\`; on Apple Silicon it needs Colima with ` +
      `Apple Virtualization + Rosetta (see infra/kusto/README.md).`,
  );
}

interface PreparedTable {
  table: TelemetryTable;
  normalized: NormalizedTable;
}

export async function bootstrap(options: BootstrapOptions): Promise<BootstrapSummary> {
  const { client, database, reset = false } = options;
  const log = options.log ?? (() => {});
  const startedAt = Date.now();

  await waitForKusto(client, { log });

  // --- Pass 1: read, normalise and validate everything before touching Kusto.
  //
  // Nothing is ingested until every file has passed its drift checks, so a
  // rejected file cannot leave a half-populated database behind. This pass also
  // finds the newest event across the whole dataset, which the time shift needs
  // before any single table can be written.
  const prepared: PreparedTable[] = [];
  let latest: Date | undefined;

  for (const table of TELEMETRY_TABLES) {
    const csv = parseCsv(await readTelemetryFile(table.file), table.file);
    const normalized = normalizeTable(csv, table);
    prepared.push({ table, normalized });

    const tableLatest = normalized.latestTimestamp;
    if (tableLatest !== undefined && (latest === undefined || tableLatest > latest)) {
      latest = tableLatest;
    }
  }

  const anchor = options.timeAnchor ?? new Date();
  const offsetMs = latest === undefined ? 0 : anchor.getTime() - latest.getTime();
  log(
    `time shift: newest event ${latest?.toISOString() ?? "n/a"} -> ${anchor.toISOString()} ` +
      `(+${(offsetMs / 86_400_000).toFixed(1)} days, applied uniformly)`,
  );

  if (reset) {
    log(`dropping database ${database}`);
    await client.mgmt(`.drop database ${database} ifexists`);
  }
  await client.mgmt(`.create database ${database} volatile ifnotexists`);

  // --- Pass 2: shift and ingest.
  let totalRows = 0;
  let totalColumns = 0;
  const issues: VerificationIssue[] = [];

  for (const { table, normalized } of prepared) {
    const shifted = applyTimeShift(normalized, offsetMs);

    await client.mgmt(`.drop table ${table.table} ifexists`, database);
    const result = await ingestTable(client, database, table, shifted);

    const actualRows = await countRows(client, database, table.table);
    if (actualRows !== table.expectedRows) {
      issues.push({
        table: table.table,
        detail:
          actualRows === null
            ? "table is not queryable after ingestion"
            : `ingested ${actualRows} rows, manifest expects ${table.expectedRows}`,
      });
    }

    issues.push(
      ...(await verifyColumnPopulation(client, database, table, expectedNonEmpty(shifted))),
    );

    totalRows += result.rows;
    totalColumns += table.columns.length;
    log(
      `  ${table.table.padEnd(32)} ${String(result.rows).padStart(6)} rows  ` +
        `${String(table.columns.length).padStart(3)} cols  ${result.commands} cmd`,
    );
  }

  // --- Pass 3: alerts.
  //
  // Runs last because both alert sources read the telemetry that was just
  // loaded: Microsoft's detection rules query it, and the connector mappers
  // read the vendor alert tables.
  log("generating alerts");
  const generated = await generateAlerts(client, database, log, { ingestionTime: anchor });

  await client.mgmt(`.drop table ${SECURITY_ALERT_TABLE.table} ifexists`, database);
  await ingestRows(client, database, SECURITY_ALERT_TABLE, generated.rows);

  const alertRows = await countRows(client, database, SECURITY_ALERT_TABLE.table);
  if (alertRows !== generated.rows.length) {
    issues.push({
      table: SECURITY_ALERT_TABLE.table,
      detail: `ingested ${alertRows} alerts, generator produced ${generated.rows.length}`,
    });
  }
  log(
    `  ${SECURITY_ALERT_TABLE.table.padEnd(32)} ${String(generated.rows.length).padStart(6)} rows  ` +
      `(${generated.fromRules} from rules, ${generated.fromConnectors} from connectors)`,
  );

  // The corpus's own identity, written into the database it describes (PRD-6 §6.8, ADR 008 §5).
  // A marker table rather than a generated file, because it must not be able to outlive what it
  // describes: the database is volatile, so this dies with it.
  const corpus: CorpusIdentity = {
    anchorUtc: anchor.toISOString(),
    offsetMs,
    telemetryRevision: TELEMETRY_REVISION,
    alertSetHash: alertSetHash(
      generated.rows.map((row) => row["SystemAlertId"] ?? "").filter((id) => id !== ""),
    ),
    queryMaxRows: options.queryMaxRows ?? 500,
    generatedAt: new Date().toISOString(),
  };
  await writeCorpusManifest(client, database, corpus);
  log(`  corpus ${corpus.alertSetHash} — telemetry ${corpus.telemetryRevision.slice(0, 8)}`);

  issues.push(
    ...(await verifySchema(client, database, [...TELEMETRY_TABLES, SECURITY_ALERT_TABLE])),
  );
  issues.push(...(await runScenarioProbes(client, database)));

  if (issues.length > 0) throw new VerificationError(issues);

  return {
    corpus,
    tables: TELEMETRY_TABLES.length + 1,
    rows: totalRows + generated.rows.length,
    columns: totalColumns + SECURITY_ALERT_TABLE.columns.length,
    alerts: generated.rows.length,
    timeOffsetMs: offsetMs,
    elapsedMs: Date.now() - startedAt,
  };
}

/** Re-runs the checks against an already-populated database, ingesting nothing. */
export async function verifyOnly(
  options: Omit<BootstrapOptions, "reset" | "timeAnchor">,
): Promise<BootstrapSummary> {
  const { client, database } = options;
  const log = options.log ?? (() => {});
  const startedAt = Date.now();

  await waitForKusto(client, { log });

  const issues: VerificationIssue[] = [];
  let totalRows = 0;
  let totalColumns = 0;

  for (const table of TELEMETRY_TABLES) {
    const actualRows = await countRows(client, database, table.table);
    if (actualRows !== table.expectedRows) {
      issues.push({
        table: table.table,
        detail:
          actualRows === null
            ? "table is missing or not queryable"
            : `holds ${actualRows} rows, manifest expects ${table.expectedRows}`,
      });
    }
    totalRows += actualRows ?? 0;
    totalColumns += table.columns.length;
  }

  const alertRows = (await countRows(client, database, SECURITY_ALERT_TABLE.table)) ?? 0;
  if (alertRows <= 0) {
    issues.push({ table: SECURITY_ALERT_TABLE.table, detail: "holds no alerts" });
  }

  issues.push(
    ...(await verifySchema(client, database, [...TELEMETRY_TABLES, SECURITY_ALERT_TABLE])),
  );
  issues.push(...(await runScenarioProbes(client, database)));

  if (issues.length > 0) throw new VerificationError(issues);

  return {
    tables: TELEMETRY_TABLES.length + 1,
    rows: totalRows + alertRows,
    columns: totalColumns + SECURITY_ALERT_TABLE.columns.length,
    alerts: alertRows,
    timeOffsetMs: 0,
    elapsedMs: Date.now() - startedAt,
  };
}
