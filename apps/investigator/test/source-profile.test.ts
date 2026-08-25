import { describe, expect, test } from "bun:test";

import { computePromptHash } from "../src/provenance.ts";
import {
  alertWindowOf,
  createDefenderSourceBundle,
  createSecuritySourceBundle,
  createSentinelSourceBundle,
  queryMaxRowsOf,
} from "../src/source-profile.ts";

const DEFENDER_CONFIG = {
  id: "defender",
  connector: "graph",
  tenantId: "tenant",
  clientId: "client",
  clientSecret: "secret",
} as const;

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

describe("selected Defender source profile", () => {
  test("bundles Defender identity, advanced-hunting framing and its own overlay", () => {
    const bundle = createDefenderSourceBundle(DEFENDER_CONFIG);

    expect(bundle.profile).toMatchObject({
      kind: "microsoft-defender-xdr",
      connector: "microsoft-graph-security",
      target: "https://graph.microsoft.com/v1.0/security",
      // The same language as Sentinel, deliberately: the console's leading-table summary is
      // correct for both, and claiming a different language would break it for no gain.
      queryLanguage: "kql",
    });
    expect(bundle.profile.target).not.toContain("tenant");
    expect(bundle.profile.initialContext.alertIntroduction).toContain("Microsoft Defender XDR");
    expect(bundle.profile.initialContext.tablesIntroduction).toContain("advanced hunting");
    expect(bundle.profile.queryGuidance).toContain(
      "## Querying Microsoft Defender advanced hunting",
    );
    expect(Object.isFrozen(bundle.profile)).toBe(true);
  });

  /**
   * The overlay is a prompt decision, so it has to move the prompt hash.
   *
   * ADR 008 §3 makes the derived condition key depend on this. Two runs against different products
   * with the same hash would merge into one cell of the comparison, and the thing the whole
   * evaluation exists to compare would be silently wrong.
   */
  test("its prompt hash differs from Sentinel's", () => {
    const sentinel = createSentinelSourceBundle({
      connector: "mock",
      baseUrl: "http://localhost:8787",
    });
    const defender = createDefenderSourceBundle(DEFENDER_CONFIG);

    expect(computePromptHash(defender.profile)).not.toBe(computePromptHash(sentinel.profile));
  });

  test("the Defender overlay carries what the probe measured, not Sentinel's vocabulary", () => {
    const guidance = createDefenderSourceBundle(DEFENDER_CONFIG).profile.queryGuidance;

    // The trap an agent arriving with Sentinel's vocabulary falls into first.
    expect(guidance).toContain("Timestamp");
    expect(guidance).toContain("There is no 'TimeGenerated' here");
    expect(guidance).toContain("AlertId");
    expect(guidance).toContain("30 days");
    // Measured: an unresolvable table is a licence fact, not a spelling mistake, and an agent that
    // reads it as a typo retries the same query.
    expect(guidance).toContain("not licensed for that workload");
    expect(guidance).toContain("scoped to named tables");
  });

  test("the Defender overlay states the configured row cap", () => {
    const guidance = createDefenderSourceBundle({
      ...DEFENDER_CONFIG,
      queryMaxRows: 1_234,
    }).profile.queryGuidance;

    expect(guidance).toContain("at most 1234 rows");
    expect(guidance).not.toContain("at most 500 rows");
  });
});

describe("the static source-id map", () => {
  test("routes each id to its own bundle without branching on kind", () => {
    const sentinel = createSecuritySourceBundle({
      id: "sentinel",
      connector: "mock",
      baseUrl: "http://localhost:8787",
    });
    const defender = createSecuritySourceBundle(DEFENDER_CONFIG);

    expect(sentinel.profile.kind).toBe("microsoft-sentinel");
    expect(defender.profile.kind).toBe("microsoft-defender-xdr");
  });

  /**
   * D13: Defender standalone is a first-class deployment, not a degraded mode. Nothing in the
   * bundle may assume a Sentinel profile exists beside it.
   */
  test("a Defender bundle stands alone, with no Sentinel anything", () => {
    const defender = createSecuritySourceBundle(DEFENDER_CONFIG);

    expect(defender.profile.queryGuidance).not.toContain("Querying Sentinel");
    expect(defender.profile.schemaToolDescription).not.toContain("Sentinel");
    expect(defender.profile.queryToolDescription).not.toContain("Sentinel");
    expect(defender.profile.initialContext.tablesIntroduction).not.toContain("Sentinel");
  });
});

/**
 * AC15's second half, and D14's reason for existing.
 *
 * The window is what a Defender queue was drawn from, so ADR 008 §3 folds it into the derived
 * condition key: two runs over different windows saw different queues and must not merge into one
 * cell of a comparison. Recording it costs one optional field; not recording it leaves the two runs
 * indistinguishable.
 */
describe("the alert window that reaches the artifact", () => {
  test("a Defender source reports its window, defaulting to the connector's own", () => {
    expect(alertWindowOf([DEFENDER_CONFIG])).toBe("P7D");
    expect(alertWindowOf([{ ...DEFENDER_CONFIG, alertWindow: "P30D" }])).toBe("P30D");
  });

  test("a source with no window records none, rather than borrowing a default", () => {
    // Absent means absent. Defaulting here would claim a window the run did not use, and a reader
    // comparing a Sentinel run to a Defender one would see them agree on a field only one of them
    // measured.
    expect(
      alertWindowOf([{ id: "sentinel", connector: "mock", baseUrl: "http://localhost:8787" }]),
    ).toBeUndefined();
  });
});

describe("the query row cap that reaches the artifact", () => {
  test("a Defender source reports its resolved cap", () => {
    expect(queryMaxRowsOf([DEFENDER_CONFIG])).toBe(500);
    expect(queryMaxRowsOf([{ ...DEFENDER_CONFIG, queryMaxRows: 1_234 }])).toBe(1_234);
  });

  test("a source without a connector-side cap records none", () => {
    expect(
      queryMaxRowsOf([{ id: "sentinel", connector: "mock", baseUrl: "http://localhost:8787" }]),
    ).toBeUndefined();
  });
});
