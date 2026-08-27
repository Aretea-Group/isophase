import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { QueryResponse, SecurityAlert, SecuritySchema } from "@soc/contracts";

import {
  SentinelApiError,
  createSentinelClient,
  sentinelClientConfigFromEnv,
} from "../../src/index.ts";

/**
 * Long enough that the connector's own timeout is what fires, never this one.
 *
 * Five sequential Log Analytics calls behind a credential acquisition, each bounded by
 * `SENTINEL_TIMEOUT_MS` (30s by default). Bun's 5s default cannot express that, and the Defender
 * suite next door proved the consequence on its first live run: a cold start failed at 5001ms and
 * then passed in 3.7s, which reports a slow network as a test defect.
 */
setDefaultTimeout(6 * 30_000);

const workspaceId = process.env["AZURE_LOG_ANALYTICS_WORKSPACE_ID"] ?? "";

const enabled = process.env["AZURE_SENTINEL_LIVE_TEST"] === "true" && workspaceId !== "";

describe.skipIf(!enabled)("AzureSentinelClient against a real workspace", () => {
  test("loads schema, queries data, round-trips an alert, and preserves KQL errors", async () => {
    const client = createSentinelClient(
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

    const schema = SecuritySchema.parse(await client.getSchema());
    expect(schema.tables.some((table) => table.name === "SecurityAlert")).toBeTrue();

    QueryResponse.parse(await client.query("SecurityAlert | count"));

    const alerts = await client.listAlerts(1);
    expect(alerts).toHaveLength(1);
    const first = SecurityAlert.parse(alerts[0]);
    expect(SecurityAlert.parse(await client.getAlert(first.id))).toEqual(first);

    const error = await client
      .query("SecurityAlert | project ColumnThatDoesNotExistForConnectorSmokeTest")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SentinelApiError);
    expect(error).toMatchObject({ code: "query_error" });
    expect(String(error)).toContain("ColumnThatDoesNotExistForConnectorSmokeTest");
  });
});
