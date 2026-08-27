import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { QueryResponse, SecurityAlert, SecuritySchema } from "@soc/contracts";

import {
  createSentinelClient,
  type SecurityDataSource,
  SentinelApiError,
  sentinelClientConfigFromEnv,
} from "../../src/index.ts";

/**
 * Long enough that the connector's own timeout is what fires, never this one.
 *
 * Sequential Log Analytics calls behind a credential acquisition, each bounded by
 * `SENTINEL_TIMEOUT_MS` (30s by default). Bun's 5s default cannot express that, and the Defender
 * suite next door proved the consequence on its first live run: a cold start failed at 5001ms and
 * then passed in 3.7s, which reports a slow network as a test defect.
 */
setDefaultTimeout(6 * 30_000);

const workspaceId = process.env["AZURE_LOG_ANALYTICS_WORKSPACE_ID"] ?? "";

const enabled = process.env["AZURE_SENTINEL_LIVE_TEST"] === "true" && workspaceId !== "";

/**
 * Built on first use and shared by the tests below.
 *
 * Lazy because `sentinelClientConfigFromEnv` throws without a workspace id, and a skipped suite must
 * not resolve configuration it does not have. Shared because the client caches its token and its
 * workspace metadata per instance, so a second instance would pay for both again.
 */
let shared: SecurityDataSource | undefined;
function client(): SecurityDataSource {
  shared ??= createSentinelClient(
    sentinelClientConfigFromEnv({
      SENTINEL_CONNECTOR: "azure",
      SENTINEL_BASE_URL: "http://localhost:8787",
      SENTINEL_TIMEOUT_MS: 30_000,
      AZURE_TENANT_ID: process.env["AZURE_TENANT_ID"],
      AZURE_CLIENT_ID: process.env["AZURE_CLIENT_ID"],
      AZURE_CLIENT_SECRET: process.env["AZURE_CLIENT_SECRET"],
      AZURE_LOG_ANALYTICS_WORKSPACE_ID: workspaceId,
    }),
  );
  return shared;
}

/**
 * PRD-7 §7 asks this suite for two things: that it "loads schema, queries `SecurityAlert`,
 * round-trips one alert" *and* that it "observes an actionable invalid-KQL error". They are two
 * tests rather than one because they fail for unrelated reasons, and as one test the first silently
 * destroyed the second.
 *
 * A workspace holding no `SecurityAlert` rows — a new one, or one whose analytics rules have not
 * fired yet — made `expect(alerts).toHaveLength(1)` abort before the error-contract assertions ran.
 * So an empty workspace did not merely fail: it withdrew the coverage of ADR 010 §3's "preserve
 * actionable query errors" without saying so, and reported it as a single failure naming the
 * connector rather than the tenant.
 *
 * Split, an empty workspace fails exactly one test whose name says what is missing, and the error
 * contract is still proven. Neither assertion is weakened — `toHaveLength(1)` stays a hard failure,
 * because whether an empty workspace is acceptable is a question about the tenant and this suite
 * should keep asking it. That is the deliberate difference from `defender.test.ts`, which skips its
 * round trip on an empty tenant; Defender's queue is a live product's alert feed, where a Sentinel
 * workspace with no alerts means nobody wrote a rule.
 */
describe.skipIf(!enabled)("AzureSentinelClient against a real workspace", () => {
  test("loads schema, queries data, and preserves KQL errors", async () => {
    const schema = SecuritySchema.parse(await client().getSchema());
    expect(schema.tables.some((table) => table.name === "SecurityAlert")).toBeTrue();

    QueryResponse.parse(await client().query("SecurityAlert | count"));

    const error = await client()
      .query("SecurityAlert | project ColumnThatDoesNotExistForConnectorSmokeTest")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SentinelApiError);
    expect(error).toMatchObject({ code: "query_error" });
    expect(String(error)).toContain("ColumnThatDoesNotExistForConnectorSmokeTest");
  });

  test("round-trips one alert", async () => {
    const alerts = await client().listAlerts(1);

    // The precondition is stated rather than discovered. `expect(alerts).toHaveLength(1)` reports
    // "expected 1, received 0", which names the connector for a fact about the tenant — and a
    // Sentinel workspace holds no alerts until an analytics rule produces one, so a workspace
    // carrying only the built-in Fusion rule can stay empty indefinitely without anything being
    // wrong with this code. Still a hard failure, deliberately: an empty workspace is a real gap
    // in what this suite can prove, and it should keep saying so.
    if (alerts.length === 0) {
      throw new Error(
        "Precondition unmet: the workspace holds no SecurityAlert rows, so no alert can be " +
          "round-tripped. Sentinel writes them only when an analytics rule fires. This is a fact " +
          "about the tenant, not a defect in the connector.",
      );
    }

    const first = SecurityAlert.parse(alerts[0]);
    expect(SecurityAlert.parse(await client().getAlert(first.id))).toEqual(first);
  });
});
