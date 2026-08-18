import { beforeAll, describe, expect, test } from "bun:test";

import { KustoClient, KustoError } from "../../src/kusto/client.ts";
import { loadScenarios } from "../../src/scenarios/scenarios.ts";
import { bootstrap, verifyOnly, VerificationError } from "../../src/telemetry/bootstrap.ts";
import { TELEMETRY_TABLES } from "../../src/telemetry/tables.ts";
import { SCENARIO_PROBES } from "../../src/telemetry/verify.ts";

/**
 * Exercises the loader against a real Kusto Emulator.
 *
 * There is no faked query engine here by design (AGENTS.md §7): the telemetry is
 * only reachable through Kusto, so anything that asserts on the data has to go
 * through it. Runs against its own database so a test run never disturbs the
 * developer's `SentinelLab`.
 *
 * Skips — loudly — when no emulator is reachable. Start one with
 * `bun run infra:up`.
 */
const endpoint = Bun.env["KUSTO_ENDPOINT"] ?? "http://localhost:8080";
const database = "SentinelLabTest";
const client = new KustoClient({ endpoint, timeoutMs: 60_000 });

const reachable = await client.isReachable();
if (!reachable) {
  console.warn(
    `[integration] skipping: no Kusto Emulator at ${endpoint}. Start one with \`bun run infra:up\`.`,
  );
}

describe.skipIf(!reachable)("telemetry bootstrap against a live Kusto Emulator", () => {
  beforeAll(async () => {
    await bootstrap({ client, database, reset: true });
  }, 300_000);

  test.each(TELEMETRY_TABLES.map((t) => [t.table, t] as const))(
    "%s holds its expected row count",
    async (_name, table) => {
      const result = await client.query(database, `${table.table} | count`);

      expect(Number(result.rows[0]?.[0])).toBe(table.expectedRows);
    },
  );

  test("reports a schema derived from the engine, not the manifest", async () => {
    const result = await client.mgmt(`.show database ${database} schema`, database);
    const tables = new Set(
      result.rows.map((row) => String((row as unknown[])[1] ?? "")).filter(Boolean),
    );

    for (const table of TELEMETRY_TABLES) expect(tables.has(table.table)).toBe(true);
  });

  test("preserves relative event spacing rather than restamping to ingestion time", async () => {
    // The upstream loader sets `TimeGenerated = now()` on every row, collapsing
    // the lab to a single instant. ADR 001 refuses to copy that, so the exact
    // 59m38s span of the SecurityEvent window has to survive the load — and the
    // uniform time shift that makes relative-time KQL usable.
    const result = await client.query(
      database,
      "SecurityEvent | summarize spanMs = tolong((max(TimeGenerated) - min(TimeGenerated)) / 1ms), " +
        "distinctInstants = dcount(TimeGenerated)",
    );

    expect(Number(result.rows[0]?.[0])).toBe(3_578_048);
    // Restamping would leave exactly one distinct instant.
    expect(Number(result.rows[0]?.[1])).toBeGreaterThan(1000);
  });

  test("shifts telemetry forward so relative-time KQL finds the attack chain", async () => {
    // The point of the shift: `ago()` is what every Microsoft detection rule and
    // most natural analyst queries use, and against the raw 2026-02 timestamps
    // it would match nothing.
    const result = await client.query(
      database,
      "OktaV2_CL | where TimeGenerated > ago(7d) | count",
    );

    expect(Number(result.rows[0]?.[0])).toBe(36);
  });

  test.each(SCENARIO_PROBES.map((p) => [p.name, p] as const))(
    "scenario probe: %s",
    async (_name, probe) => {
      const result = await client.query(database, probe.query);
      expect(Number(result.rows[0]?.[0])).toBe(probe.expected);
    },
  );

  test("keeps multi-line payloads intact through ingestion", async () => {
    // Every newline-bearing field in SecurityEvents.csv lives in EventData, and
    // there are 3,228 of them. Inline ingestion has to round-trip quoted fields
    // containing raw newlines or this number collapses.
    const result = await client.query(
      database,
      'SecurityEvent | where EventData contains "\\n" | count',
    );

    expect(Number(result.rows[0]?.[0])).toBe(3228);
  });

  test("exposes dynamic columns as navigable JSON", async () => {
    const result = await client.query(
      database,
      "AWSCloudTrail | where isnotnull(RequestParameters.userName) " +
        "| summarize by user=tostring(RequestParameters.userName)",
    );

    expect(result.rows.flat()).toContain("backdoor-svc");
  });

  test("surfaces a real Kusto error for invalid KQL instead of repairing it", async () => {
    const failure = await client.query(database, "NoSuchTable | take 5").catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(KustoError);
    const error = failure as KustoError;
    expect(error.status).toBe(400);
    // PRD-1 §4.4: the caller must be able to see what Kusto actually said.
    expect(JSON.stringify(error.details)).toContain("SEM0100");
  });

  test("a second bootstrap is idempotent", async () => {
    const summary = await bootstrap({ client, database });

    // +1 for the generated SecurityAlert table.
    expect(summary.tables).toBe(TELEMETRY_TABLES.length + 1);
    expect(summary.rows).toBe(24_979 + summary.alerts);
    expect(summary.alerts).toBeGreaterThan(100);
  }, 300_000);

  test("every scenario's starting alert exists in the database", async () => {
    // startingAlertId values are content-addressed hashes of rule output, so a
    // changed rule moves them. Resolving each one here is what converts that
    // from a hidden fragility into a failing test.
    const scenarios = await loadScenarios();

    const found = await Promise.all(
      scenarios.map(async (scenario) => {
        const result = await client.query(
          database,
          `SecurityAlert | where SystemAlertId == "${scenario.startingAlertId}" | count`,
        );
        return { scenario: scenario.id, found: Number(result.rows[0]?.[0]) };
      }),
    );

    expect(found).toEqual(scenarios.map((scenario) => ({ scenario: scenario.id, found: 1 })));
  }, 120_000);

  test("each scenario's discriminating queries actually run", async () => {
    // A scenario whose decisive query does not execute cannot grade anything.
    const scenarios = await loadScenarios();
    const checks = scenarios.flatMap((scenario) =>
      scenario.discriminatingEvidence.map((evidence) => ({ scenario, evidence })),
    );

    const outcomes = await Promise.all(
      checks.map(async ({ scenario, evidence }) => ({
        scenario: scenario.id,
        q: evidence.question,
        outcome: await client
          .query(database, evidence.kql)
          .then(() => "ok")
          .catch((error: unknown) => (error as Error).message),
      })),
    );

    expect(outcomes.filter((o) => o.outcome !== "ok")).toEqual([]);
  }, 300_000);

  test("verification fails loudly when the loaded data drifts", async () => {
    // Bootstrap recreates each table, so tampering has to happen after a good
    // load and be caught by the verification pass rather than repaired by it.
    const scratch = "SentinelLabTamper";
    await bootstrap({ client, database: scratch, reset: true });
    await client.mgmt(".drop table OktaV2_CL", scratch);

    const failure = await verifyOnly({ client, database: scratch })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(VerificationError);
    expect((failure as VerificationError).issues.some((i) => i.table === "OktaV2_CL")).toBe(true);

    await client.mgmt(`.drop database ${scratch} ifexists`);
  }, 300_000);
});
