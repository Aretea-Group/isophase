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
    expect(describeAlertError(error, "azure")).toBe(
      "Azure Sentinel returned authorization_error: workspace access denied",
    );
    expect(describeAlertError(error, "mock")).toContain("Mock Sentinel returned");
  });
});
