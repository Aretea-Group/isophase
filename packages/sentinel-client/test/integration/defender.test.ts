import { describe, expect, test } from "bun:test";

import { QueryResponse, SecuritySchema } from "@soc/contracts";

import {
  createSecurityClient,
  defenderClientConfigFromEnv,
  SentinelApiError,
} from "../../src/index.ts";

/**
 * One live smoke test against a real Defender tenant (PRD-8 AC9).
 *
 * Gated twice — on `DEFENDER_LIVE_TEST` and on a complete credential group — and skips with a
 * printed reason otherwise, so `bun test` stays green in a fresh checkout and proves nothing about
 * this file. That is the same discipline `integration/azure.test.ts` follows.
 *
 * Deliberately small. Advanced hunting bills against a shared per-tenant CPU allowance that blocks
 * every other consumer in the tenant until the next 15-minute cycle once exhausted, so a smoke test
 * that swept the schema on every run would be a poor citizen of somebody's production tenant. The
 * exhaustive measurement is `scripts/probe-defender.ts`, which an operator runs deliberately.
 */

const config = (() => {
  try {
    // `process.env` is an index signature, so it is read key by key — `noPropertyAccessFromIndexSignature`
    // is on and the config type names its keys explicitly.
    return defenderClientConfigFromEnv({
      ...(process.env["DEFENDER_TENANT_ID"] === undefined
        ? {}
        : { DEFENDER_TENANT_ID: process.env["DEFENDER_TENANT_ID"] }),
      ...(process.env["DEFENDER_CLIENT_ID"] === undefined
        ? {}
        : { DEFENDER_CLIENT_ID: process.env["DEFENDER_CLIENT_ID"] }),
      ...(process.env["DEFENDER_CLIENT_SECRET"] === undefined
        ? {}
        : { DEFENDER_CLIENT_SECRET: process.env["DEFENDER_CLIENT_SECRET"] }),
      ...(process.env["DEFENDER_WORKSPACE_ID"] === undefined
        ? {}
        : { DEFENDER_WORKSPACE_ID: process.env["DEFENDER_WORKSPACE_ID"] }),
      ...(process.env["DEFENDER_ALERT_WINDOW"] === undefined
        ? {}
        : { DEFENDER_ALERT_WINDOW: process.env["DEFENDER_ALERT_WINDOW"] }),
    });
  } catch {
    // A partial credential group is a configuration error the unit tests already cover. Here it
    // just means "not configured for a live run".
    return undefined;
  }
})();

const enabled = process.env["DEFENDER_LIVE_TEST"] === "true" && config !== undefined;

if (!enabled) {
  console.info(
    "[defender] live smoke test skipped — set DEFENDER_LIVE_TEST=true and the DEFENDER_* credential group. See docs/defender-setup.md.",
  );
}

describe.skipIf(!enabled)("DefenderClient against a real tenant", () => {
  test("loads schema, queries data, round-trips an alert, and preserves query errors", async () => {
    if (config === undefined) throw new Error("unreachable: the suite is gated on this");
    const client = createSecurityClient({ id: "defender", ...config });

    // Schema first: it is one request, and every assertion below depends on the tenant holding
    // the alert tables.
    const schema = SecuritySchema.parse(await client.getSchema());
    expect(schema.tables.length).toBeGreaterThan(0);
    const alertInfo = schema.tables.find((table) => table.name === "AlertInfo");
    expect(alertInfo?.columns.map((column) => column.name)).toContain("AlertId");

    // An aggregate rather than rows: cheap for the engine, and it exercises the positional
    // projection without pulling tenant telemetry into a test process.
    const result = QueryResponse.parse(
      await client.query("AlertInfo | summarize Alerts = count()"),
    );
    expect(result.tables[0]?.columns[0]?.name).toBe("Alerts");
    expect(result.truncation.truncated).toBeFalse();

    // The alert round trip is skipped rather than failed on a tenant with nothing in the window:
    // an empty queue is a property of the tenant, not a defect in the connector.
    const alerts = await client.listAlerts(1);
    if (alerts.length === 0) {
      console.info("[defender] no alerts in DEFENDER_ALERT_WINDOW — round trip not exercised.");
    } else {
      const first = alerts[0];
      if (first === undefined) throw new Error("unreachable: length was checked");
      expect((await client.getAlert(first.id)).id).toBe(first.id);
    }

    // ADR 010 §3: the engine's own diagnostic reaches the caller, naming what it rejected, so the
    // model can repair its own query without the connector inventing text.
    const error = await client
      .query("AlertInfo | project ColumnThatDoesNotExistForConnectorSmokeTest")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SentinelApiError);
    expect(error).toMatchObject({ code: "query_error" });
    expect(String(error)).toContain("ColumnThatDoesNotExistForConnectorSmokeTest");
  });
});
