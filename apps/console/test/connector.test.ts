import { describe, expect, test } from "bun:test";

import { SentinelApiError } from "@soc/sentinel-client";

import { describeAlertError } from "../src/data/alerts.ts";
import { env, type ConsoleEnv } from "../src/env.ts";
import { toConfigRows } from "../src/view/config.ts";

describe("Azure connector console behavior", () => {
  test("read-only configuration display does not require Azure credentials", () => {
    const azureEnv: ConsoleEnv = {
      ...env,
      SENTINEL_CONNECTOR: "azure",
      AZURE_TENANT_ID: undefined,
      AZURE_CLIENT_ID: undefined,
      AZURE_CLIENT_SECRET: undefined,
      AZURE_LOG_ANALYTICS_WORKSPACE_ID: undefined,
    };

    expect(toConfigRows(undefined, azureEnv)).toContainEqual({
      label: "source target",
      thisRun: "—",
      currentEnv: "Azure workspace not configured",
    });
    expect(toConfigRows(undefined, azureEnv)).toContainEqual({
      label: "source connector",
      thisRun: "—",
      currentEnv: "azure-monitor-logs",
    });
  });

  test("uses connector-aware alert errors", () => {
    const error = new SentinelApiError("authorization_error", 403, "workspace access denied");
    expect(describeAlertError(error, { id: "sentinel", connector: "azure" })).toBe(
      "Azure Sentinel returned authorization_error: workspace access denied",
    );
    expect(describeAlertError(error, { id: "sentinel", connector: "mock" })).toContain(
      "Mock Sentinel returned",
    );
  });
});

/**
 * The message names the product that actually failed.
 *
 * `DefenderClient` throws the same `SentinelApiError` with the same `unreachable` code as the mock
 * client, so nothing in the error distinguishes them — only the source the console queried does.
 */
describe("Defender connector console behavior", () => {
  test("an unreachable Defender does not send the analyst to start Mock Sentinel", () => {
    const error = new SentinelApiError("unreachable", 503, "socket hang up");
    const message = describeAlertError(error, { id: "defender", connector: "mock" });

    // `connector` is deliberately "mock" here: that is exactly what `SENTINEL_CONNECTOR` reads on a
    // Defender-only run started from a corpus checkout, and it is what produced the wrong message.
    expect(message).not.toContain("Mock Sentinel");
    expect(message).not.toContain("dev:mock-sentinel");
    expect(message).toContain("Microsoft Graph is not reachable");
    expect(message).toContain("DEFENDER_*");
  });

  test("other Defender failures name Defender and carry the code through", () => {
    const error = new SentinelApiError("authorization_error", 403, "insufficient privileges");
    expect(describeAlertError(error, { id: "defender", connector: "mock" })).toBe(
      "Defender returned authorization_error: insufficient privileges",
    );
  });

  test("an unknown source names itself rather than borrowing a remedy", () => {
    const error = new SentinelApiError("unreachable", 503, "socket hang up");
    expect(describeAlertError(error, { id: "splunk", connector: "mock" })).toBe(
      "splunk returned unreachable: socket hang up",
    );
  });
});
