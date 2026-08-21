import { describe, expect, test } from "bun:test";

import { CorpusIdentity } from "@soc/contracts";

import { createApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import type { KustoClient } from "../src/kusto/client.ts";
import { isControlCommand } from "../src/routes/query.ts";
import {
  alertSetHash,
  CORPUS_MANIFEST_TABLE,
  INTERNAL_TABLES,
  isInternalTable,
  referencesInternalTable,
} from "../src/telemetry/corpus.ts";
import { TELEMETRY_REVISION } from "../src/telemetry/source.ts";
import { TELEMETRY_TABLES } from "../src/telemetry/tables.ts";

/**
 * The corpus manifest, and the boundary that keeps it away from the agent (PRD-6 §6.8, ADR 008 §5).
 *
 * The dangerous property here is not the manifest's content — it carries no ground truth — but its
 * *existence*: `GET /schema` runs `.show database schema` with no allowlist, the harness holds the
 * whole result, and `buildInitialContext` puts every table name into the opening
 * `<available_tables>` block. A benchmarking change that silently alters turn-0 context is a change
 * to the thing being measured.
 */

const CONFIG = {
  KUSTO_DATABASE: "SecurityData",
  QUERY_MAX_ROWS: 500,
  PORT: 8787,
  LOG_LEVEL: "error",
} as unknown as Config;

/** A Kusto whose schema includes the manifest table, as a real bootstrapped database would. */
function kustoStub(tables: string[]): KustoClient {
  return {
    mgmt: () =>
      Promise.resolve({
        columns: [],
        rows: tables.flatMap((name) => [
          [CONFIG.KUSTO_DATABASE, name, "TimeGenerated", "System.DateTime"],
        ]),
      }),
    query: () =>
      Promise.resolve({
        columns: [],
        rows: [
          [
            "2026-08-20T00:00:00.0000000Z",
            157_680_000_000,
            TELEMETRY_REVISION,
            "9c2e4f1a8b30",
            500,
            "2026-08-20T00:00:00.0000000Z",
          ],
        ],
      }),
  } as unknown as KustoClient;
}

async function tableNames(response: Response): Promise<string[]> {
  return ((await response.json()) as { tables: { name: string }[] }).tables.map((t) => t.name);
}

describe("the internal-table convention", () => {
  test("no telemetry table uses a leading underscore, so the prefix is unambiguous", () => {
    for (const table of TELEMETRY_TABLES) {
      expect(isInternalTable(table.table)).toBe(false);
    }
    expect(isInternalTable(CORPUS_MANIFEST_TABLE.table)).toBe(true);
  });

  test("a query is rejected by table name, not by the underscore prefix", () => {
    // Four telemetry tables carry a `_ResourceId` column and one carries `_table`, so a prefix rule
    // applied to free-form KQL would reject legitimate queries. /schema can use the prefix because
    // it is listing what exists; this is parsing what someone wrote.
    expect(referencesInternalTable("SecurityEvent | project _ResourceId, _table")).toBeUndefined();
    expect(referencesInternalTable("AWSCloudTrail | where _ResourceId != ''")).toBeUndefined();
    expect(referencesInternalTable("_CorpusManifest | take 1")).toBe("_CorpusManifest");
    expect(referencesInternalTable("union _CorpusManifest, SecurityEvent")).toBe("_CorpusManifest");
  });

  test("the rejection list is derived from the tables this service creates", () => {
    // Adding a second `_` table extends the rejection with no edit here, which is the point of
    // reading the same constant rather than restating the names.
    expect(INTERNAL_TABLES).toContain(CORPUS_MANIFEST_TABLE.table);
    for (const name of INTERNAL_TABLES) expect(isInternalTable(name)).toBe(true);
  });

  test("the control-command guard is untouched by any of this", () => {
    expect(isControlCommand(".drop table SecurityEvent")).toBe(true);
    expect(isControlCommand("SecurityEvent | take 1")).toBe(false);
  });
});

describe("GET /schema excludes internal tables", () => {
  test("the agent's table-name list is unchanged by writing the manifest", async () => {
    const telemetry = ["AWSCloudTrail", "SecurityAlert", "SecurityEvent"];

    // Before: a database with no manifest. After: the same database with one.
    const before = await createApp({ config: CONFIG, kusto: kustoStub(telemetry) }).request(
      "/schema",
    );
    const after = await createApp({
      config: CONFIG,
      kusto: kustoStub([...telemetry, CORPUS_MANIFEST_TABLE.table]),
    }).request("/schema");

    const withoutManifest = await tableNames(before);
    const withManifest = await tableNames(after);

    // Byte-identical, not merely "does not contain the manifest": this is the list that reaches
    // `buildInitialContext`, and turn-0 context is the thing being measured.
    expect(withManifest).toEqual(withoutManifest);
    expect(withManifest).toEqual(telemetry);
  });
});

describe("POST /query rejects internal tables", () => {
  test("as an ordinary, actionable query error rather than a special case", async () => {
    const response = await createApp({
      config: CONFIG,
      kusto: kustoStub(["SecurityEvent"]),
    }).request("/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "_CorpusManifest | take 1" }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("query_error");
    expect(body.error.message).toContain("internal bookkeeping");
  });
});

describe("GET /corpus", () => {
  test("reports the identity of the loaded corpus", async () => {
    const response = await createApp({
      config: CONFIG,
      kusto: kustoStub([CORPUS_MANIFEST_TABLE.table]),
    }).request("/corpus");

    expect(response.status).toBe(200);
    const parsed = CorpusIdentity.safeParse(await response.json());
    expect(parsed.success ? "ok" : JSON.stringify(parsed.error?.issues)).toBe("ok");
    expect(parsed.data?.telemetryRevision).toBe(TELEMETRY_REVISION);
    expect(parsed.data?.queryMaxRows).toBe(500);
  });

  test("404s rather than erroring when the database predates the manifest", async () => {
    const empty = {
      mgmt: () => Promise.resolve({ columns: [], rows: [] }),
      query: () => Promise.reject(new Error("'_CorpusManifest' could not be resolved")),
    } as unknown as KustoClient;

    const response = await createApp({ config: CONFIG, kusto: empty }).request("/corpus");

    // The client turns this into `undefined`, so an older Mock Sentinel degrades rather than
    // breaking `bun run investigate`, and the artifact records no corpus rather than a fake one.
    expect(response.status).toBe(404);
  });
});

describe("alertSetHash", () => {
  test("is order-independent, so a re-ordered generator does not read as a corpus change", () => {
    expect(alertSetHash(["b", "a", "c"])).toBe(alertSetHash(["a", "b", "c"]));
  });

  test("moves when the alert set does — the change that genuinely breaks the join (ADR 004)", () => {
    expect(alertSetHash(["a", "b"])).not.toBe(alertSetHash(["a", "b", "c"]));
  });
});

describe("the pinned revision", () => {
  test("matches fixtures/telemetry/SOURCE.md", async () => {
    // Duplicated because prose cannot be imported. Bumping one and not the other would make every
    // artifact claim a corpus it was not built from.
    const source = await Bun.file(
      new URL("../../../fixtures/telemetry/SOURCE.md", import.meta.url).pathname,
    ).text();
    expect(source).toContain(TELEMETRY_REVISION);
  });
});
