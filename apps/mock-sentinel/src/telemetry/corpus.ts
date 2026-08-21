import { createHash } from "node:crypto";

import type { CorpusIdentity } from "@soc/contracts";

import type { KustoClient } from "../kusto/client.ts";
import { ingestRows } from "./ingest.ts";
import type { TelemetryTable } from "./manifest.ts";

/**
 * The corpus's identity, written into the database it describes (PRD-6 §6.8, ADR 008 §5).
 *
 * A marker **table** rather than a generated file, and the reason is that it cannot go stale: the
 * database is volatile, so the manifest dies with it. A file on disk would survive a
 * `bun run data:reset` and start describing a corpus that no longer exists — which is exactly the
 * failure mode a corpus identity is supposed to prevent.
 *
 * **It must not reach the agent.** `GET /schema` runs `.show database schema` with no allowlist,
 * the harness holds the whole result, and `buildInitialContext` puts every table name into the
 * opening `<available_tables>` block — so a table added to this database is a table the agent is
 * invited to query. `_CorpusManifest` carries no ground truth, but a benchmarking change that
 * silently alters turn-0 context is a change to the thing being measured.
 */

/** The whole convention. Nothing in `TELEMETRY_TABLES` uses a leading underscore. */
export const INTERNAL_TABLE_PREFIX = "_";

export const CORPUS_MANIFEST_TABLE: TelemetryTable = {
  table: "_CorpusManifest",
  // `generated`, like `SecurityAlert`: produced at bootstrap rather than vendored, so the
  // file-backed drift checks do not apply and `file` is inert.
  source: "generated",
  file: "",
  expectedRows: 1,
  columns: [
    { name: "AnchorUtc", type: "datetime" },
    { name: "OffsetMs", type: "long" },
    { name: "TelemetryRevision", type: "string" },
    { name: "AlertSetHash", type: "string" },
    { name: "QueryMaxRows", type: "long" },
    { name: "GeneratedAt", type: "datetime" },
  ],
};

/** Every table this service creates for its own bookkeeping rather than for the agent to query. */
export const INTERNAL_TABLES: readonly string[] = [CORPUS_MANIFEST_TABLE.table];

/** True when `name` is infrastructure rather than telemetry. */
export function isInternalTable(name: string): boolean {
  return name.startsWith(INTERNAL_TABLE_PREFIX);
}

/**
 * Does this query reach for an internal table?
 *
 * Matched against the known names rather than against the `_` prefix, deliberately. Four telemetry
 * tables carry columns called `_ResourceId` and one carries `_table`, so a prefix rule applied to
 * free-form KQL would reject legitimate queries. `GET /schema` can use the prefix because it is
 * listing what exists; this is parsing what someone wrote.
 */
export function referencesInternalTable(query: string): string | undefined {
  return INTERNAL_TABLES.find((name) =>
    new RegExp(String.raw`(^|[^\w])${name}([^\w]|$)`).test(query),
  );
}

/** sha256/12 over the sorted alert ids — the number that catches a re-pinned corpus (ADR 004). */
export function alertSetHash(systemAlertIds: readonly string[]): string {
  return createHash("sha256")
    .update([...systemAlertIds].toSorted().join("\n"))
    .digest("hex")
    .slice(0, 12);
}

export async function writeCorpusManifest(
  client: KustoClient,
  database: string,
  identity: CorpusIdentity,
): Promise<void> {
  await client.mgmt(`.drop table ${CORPUS_MANIFEST_TABLE.table} ifexists`, database);
  await ingestRows(client, database, CORPUS_MANIFEST_TABLE, [
    {
      AnchorUtc: identity.anchorUtc,
      OffsetMs: String(identity.offsetMs),
      TelemetryRevision: identity.telemetryRevision,
      AlertSetHash: identity.alertSetHash,
      QueryMaxRows: String(identity.queryMaxRows),
      GeneratedAt: identity.generatedAt,
    },
  ]);
}

/**
 * Read the manifest back, or `undefined` when the database predates it.
 *
 * Degrading rather than throwing is what keeps an older Mock Sentinel from breaking
 * `bun run investigate`: the report prints `corpus unknown` instead of a fabricated match.
 */
export async function readCorpusManifest(
  client: KustoClient,
  database: string,
): Promise<CorpusIdentity | undefined> {
  const result = await client
    .query(
      database,
      `${CORPUS_MANIFEST_TABLE.table} | project AnchorUtc, OffsetMs, TelemetryRevision, AlertSetHash, QueryMaxRows, GeneratedAt | take 1`,
    )
    .catch(() => undefined);

  const row = result?.rows[0];
  if (row === undefined) return undefined;

  const [anchorUtc, offsetMs, telemetryRevision, hash, queryMaxRows, generatedAt] = row as (
    | string
    | number
    | null
  )[];

  return {
    anchorUtc: new Date(String(anchorUtc)).toISOString(),
    offsetMs: Number(offsetMs ?? 0),
    telemetryRevision: String(telemetryRevision ?? ""),
    alertSetHash: String(hash ?? ""),
    queryMaxRows: Number(queryMaxRows ?? 0),
    generatedAt: new Date(String(generatedAt)).toISOString(),
  };
}
