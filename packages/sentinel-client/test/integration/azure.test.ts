import { describe, expect, test } from "bun:test";

import { QueryResponse, SchemaResponse, SecurityAlertResource } from "@soc/contracts";

import {
  SentinelApiError,
  createSentinelClient,
  sentinelClientConfigFromEnv,
} from "../../src/index.ts";

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

    const schema = SchemaResponse.parse(await client.getSchema());
    expect(schema.tables.some((table) => table.name === "SecurityAlert")).toBeTrue();

    QueryResponse.parse(await client.query("SecurityAlert | count"));

    const alerts = await client.listAlerts(1);
    expect(alerts).toHaveLength(1);
    const first = SecurityAlertResource.parse(alerts[0]);
    expect(
      SecurityAlertResource.parse(await client.getAlert(first.properties.systemAlertId)),
    ).toEqual(first);

    const error = await client
      .query("SecurityAlert | project ColumnThatDoesNotExistForConnectorSmokeTest")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SentinelApiError);
    expect(error).toMatchObject({ code: "query_error" });
    expect(String(error).length).toBeGreaterThan(20);
  });
});
