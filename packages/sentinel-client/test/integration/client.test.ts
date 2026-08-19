import { describe, expect, test } from "bun:test";

import { SentinelApiClient, SentinelApiError } from "../../src/index.ts";

/**
 * The Sentinel Client is a consumer of the REST boundary, not part of Mock Sentinel, so this
 * suite deliberately crosses real HTTP rather than mounting the Hono app in-process — going over
 * the wire is the only thing the client actually adds (AGENTS.md §3, PRD-1 §7).
 *
 * Requires a running Mock Sentinel backed by a bootstrapped Kusto Emulator:
 *   bun run infra:up && bun run data:bootstrap && bun run dev:mock-sentinel
 */
const baseUrl = Bun.env["SENTINEL_BASE_URL"] ?? "http://localhost:8787";
const client = new SentinelApiClient({ baseUrl, timeoutMs: 60_000 });

const reachable = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) })
  .then((res) => res.ok)
  .catch(() => false);
if (!reachable) {
  console.warn(`[integration] skipping sentinel-client: no Mock Sentinel at ${baseUrl}.`);
}

describe.skipIf(!reachable)("SentinelApiClient against a live Mock Sentinel", () => {
  test("listAlerts returns contract-valid alerts", async () => {
    const alerts = await client.listAlerts();

    expect(alerts.length).toBeGreaterThan(100);
    expect(alerts[0]?.kind).toBe("SecurityAlert");
    expect(alerts[0]?.properties.systemAlertId).toBeTruthy();
  });

  test("listAlerts bounds the list with $top", async () => {
    expect((await client.listAlerts(5)).length).toBe(5);
  });

  test("getAlert round-trips a systemAlertId from the list", async () => {
    const [first] = await client.listAlerts(1);
    const id = first!.properties.systemAlertId;

    expect((await client.getAlert(id)).properties.systemAlertId).toBe(id);
  });

  test("an unknown alert id surfaces as a not_found SentinelApiError", async () => {
    const failure = await client
      .getAlert("00000000-0000-0000-0000-000000000000")
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(SentinelApiError);
    expect((failure as SentinelApiError).code).toBe("not_found");
    expect((failure as SentinelApiError).status).toBe(404);
  });

  test("getSchema returns the queryable tables", async () => {
    const schema = await client.getSchema();

    expect(schema.tables.length).toBeGreaterThan(20);
    expect(schema.tables.map((t) => t.name)).toContain("SecurityAlert");
    // The size is why PRD-2 §7 injects names only and lets the agent pull schemas on demand.
    expect(schema.tables.flatMap((t) => t.columns).length).toBeGreaterThan(1_000);
  });

  test("query returns a PrimaryResult table", async () => {
    const result = await client.query("SecurityAlert | count");

    expect(result.tables[0]?.name).toBe("PrimaryResult");
    expect(Number(result.tables[0]?.rows[0]?.[0])).toBeGreaterThan(100);
  });

  test("query reports truncation rather than silently capping", async () => {
    const result = await client.query("SecurityEvent | project TimeGenerated");

    expect(result.truncation.truncated).toBe(true);
    expect(result.truncation.returnedRows).toBe(result.truncation.maxRows);
  });

  test("invalid KQL arrives as a query_error carrying the Kusto diagnostic", async () => {
    // The diagnostic is the whole point: it is what lets an agent repair its own query.
    const failure = await client
      .query("SecurityEvent | where Compter == 'x'")
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(SentinelApiError);
    expect((failure as SentinelApiError).code).toBe("query_error");
    expect((failure as SentinelApiError).message).toContain("Compter");
  });

  test("the read-only boundary still holds through the client", async () => {
    const failure = await client.query(".drop table SecurityEvent").catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(SentinelApiError);
    expect((failure as SentinelApiError).code).toBe("query_error");
    expect(await client.query("SecurityEvent | count")).toBeTruthy();
  });

  test("an unreachable service is distinguishable from a service-level failure", async () => {
    const offline = new SentinelApiClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 2_000 });
    const failure = await offline.listAlerts().catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(SentinelApiError);
    expect((failure as SentinelApiError).code).toBe("unreachable");
    expect((failure as SentinelApiError).status).toBe(0);
  });
});
