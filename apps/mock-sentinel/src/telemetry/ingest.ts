/* oxlint-disable eslint/no-await-in-loop --
 * Ingestion is deliberately sequential. The Kusto Emulator is a single-node
 * engine running under x86-64 translation on Apple Silicon, where concurrency
 * has already been observed to destabilise it (infra/kusto/README.md documents
 * the .NET/Rosetta crashes and the flags that fix them). Ordering also matters:
 * a table is created before it is filled, and a chunk is only sent once the
 * previous one is durable. Fanning these out with Promise.all would trade a
 * bootstrap that already completes in ~1.6s for a flaky one.
 */
/**
 * Creates tables in the Kusto Emulator and loads the normalised telemetry.
 *
 * Ingestion goes through `.ingest inline`, which was chosen over the
 * mount-a-volume-and-`.ingest into table (@"/path")` route after measuring both:
 * the whole of `SecurityEvent` (23,864 rows / 4.1 MB) lands in ~0.2 s in a
 * single command, and Kusto's CSV reader round-trips quoted fields containing
 * embedded newlines and doubled quotes exactly — which the data needs, since
 * `SecurityEvents.csv` alone has 3,228 such fields.
 *
 * Inline also keeps the emulator a black box reachable only over HTTP: no bind
 * mount, no shared host path, and identical behaviour wherever it runs.
 */

import type { KustoClient } from "../kusto/client.ts";
import { encodeCsvRows } from "./csv.ts";
import type { TelemetryTable } from "./manifest.ts";
import type { NormalizedTable } from "./normalize.ts";

/**
 * Rough cap on the CSV payload of a single `.ingest inline` command.
 *
 * The largest table fits comfortably in one command today; this exists so that
 * growth degrades into more commands rather than into an opaque request-size
 * failure.
 */
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

/** `.create table` DDL. Column names are already plain Kusto identifiers. */
export function createTableCommand(table: TelemetryTable): string {
  const columns = table.columns.map((c) => `${c.name}:${c.type}`).join(", ");
  return `.create table ${table.table} (${columns})`;
}

/** Splits rows into chunks whose encoded size stays under `MAX_CHUNK_BYTES`. */
export function chunkRows(rows: readonly (readonly string[])[]): string[] {
  const chunks: string[] = [];
  let current: (readonly string[])[] = [];
  let size = 0;

  for (const row of rows) {
    const encoded = encodeCsvRows([row]);
    if (current.length > 0 && size + encoded.length + 1 > MAX_CHUNK_BYTES) {
      chunks.push(encodeCsvRows(current));
      current = [];
      size = 0;
    }
    current.push(row);
    size += encoded.length + 1;
  }
  if (current.length > 0) chunks.push(encodeCsvRows(current));

  return chunks;
}

export interface IngestResult {
  table: string;
  rows: number;
  commands: number;
}

/**
 * Creates a table and loads rows supplied as column-keyed objects.
 *
 * Used for generated tables such as `SecurityAlert`, where rows are built in
 * memory rather than read from a CSV. Values are ordered by the table's own
 * column list, so a missing key becomes an empty cell instead of silently
 * shifting every later column.
 */
export async function ingestRows(
  client: KustoClient,
  database: string,
  table: TelemetryTable,
  rows: readonly Record<string, string>[],
): Promise<IngestResult> {
  await client.mgmt(createTableCommand(table), database);

  const positional = rows.map((row) => table.columns.map((column) => row[column.name] ?? ""));
  const chunks = chunkRows(positional);
  for (const chunk of chunks) {
    await client.mgmt(`.ingest inline into table ${table.table} <|\n${chunk}`, database);
  }

  return { table: table.table, rows: rows.length, commands: chunks.length };
}

/** Creates the table and loads every row. Assumes the table does not yet exist. */
export async function ingestTable(
  client: KustoClient,
  database: string,
  table: TelemetryTable,
  normalized: NormalizedTable,
): Promise<IngestResult> {
  await client.mgmt(createTableCommand(table), database);

  const chunks = chunkRows(normalized.rows);
  for (const chunk of chunks) {
    await client.mgmt(`.ingest inline into table ${table.table} <|\n${chunk}`, database);
  }

  return { table: table.table, rows: normalized.rows.length, commands: chunks.length };
}
