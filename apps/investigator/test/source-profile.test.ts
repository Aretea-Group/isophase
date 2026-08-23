import { describe, expect, test } from "bun:test";

import { createSentinelSourceBundle } from "../src/source-profile.ts";

describe("selected Sentinel source profile", () => {
  test("bundles immutable Mock identity, framing, descriptions and lazy guidance", () => {
    const bundle = createSentinelSourceBundle({
      connector: "mock",
      baseUrl: "http://localhost:8787",
    });

    expect(bundle.profile).toMatchObject({
      kind: "microsoft-sentinel",
      connector: "mock-sentinel-rest",
      target: "http://localhost:8787",
      queryLanguage: "kql",
    });
    expect(bundle.profile.schemaToolDescription).toContain("Microsoft Sentinel");
    expect(bundle.profile.queryToolDescription).toContain("read-only KQL");
    expect(bundle.profile.queryParameterDescription).toContain("Read-only KQL");
    expect(bundle.profile.initialContext.alertIntroduction).toContain("Microsoft Sentinel alert");
    expect(bundle.profile.initialContext.tablesIntroduction).toContain("Microsoft Sentinel tables");
    expect(bundle.profile.queryGuidance).toContain("## Querying Sentinel");
    expect(bundle.profile.guidanceActivationTools).toEqual([
      "get_security_schema",
      "query_security_data",
    ]);
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.profile)).toBe(true);
    expect(Object.isFrozen(bundle.profile.initialContext)).toBe(true);
    expect(Object.isFrozen(bundle.profile.guidanceActivationTools)).toBe(true);
  });

  test("selects Azure transport identity with the same Sentinel/KQL query behavior", () => {
    const mock = createSentinelSourceBundle({
      connector: "mock",
      baseUrl: "http://localhost:8787",
    });
    const azure = createSentinelSourceBundle({
      connector: "azure",
      workspaceId: "workspace-id",
      authentication: { kind: "developer" },
    });

    expect(azure.profile).toMatchObject({
      kind: "microsoft-sentinel",
      connector: "azure-monitor-logs",
      target: "https://api.loganalytics.azure.com/v1/workspaces/workspace-id",
      queryLanguage: "kql",
    });
    expect({
      schema: azure.profile.schemaToolDescription,
      query: azure.profile.queryToolDescription,
      parameter: azure.profile.queryParameterDescription,
      context: azure.profile.initialContext,
      guidance: azure.profile.queryGuidance,
      activation: azure.profile.guidanceActivationTools,
    }).toEqual({
      schema: mock.profile.schemaToolDescription,
      query: mock.profile.queryToolDescription,
      parameter: mock.profile.queryParameterDescription,
      context: mock.profile.initialContext,
      guidance: mock.profile.queryGuidance,
      activation: mock.profile.guidanceActivationTools,
    });
  });
});
