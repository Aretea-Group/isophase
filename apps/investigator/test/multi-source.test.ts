import { describe, expect, test } from "bun:test";

import type { SecurityAlert } from "@soc/contracts";

import { buildInitialContext } from "../src/context.ts";
import { executeRun } from "../src/execute-run.ts";
import { computePromptHash } from "../src/provenance.ts";
import { createSentinelSourceBundle, type SecuritySourceSet } from "../src/source-profile.ts";
import { createInvestigationTools } from "../src/tools/index.ts";
import { FixtureSecuritySource, TEST_SOURCE_PROFILE, testSourceBundle } from "./fixtures/source.ts";

/**
 * PRD-8 Phase 2 acceptance criteria — AC7, AC8, AC10, AC11, AC12.
 *
 * All five run over two in-memory fixture sources rather than a tenant. That is deliberate and not a
 * shortcut: every one of them is a claim about *routing* — which source was asked, which one was
 * allowed to produce alerts, what turn-0 said, and whether two runs are the same condition — and a
 * live tenant would add cost and flakiness without making any of those claims more true. The live
 * two-source run is a separate, gated exercise.
 */

const WEB_SEARCH_STUB = { search: async () => [] };
const WEB_FETCH_STUB = {
  fetchPage: async () => ({ url: "", title: "", content: "" }),
};

/** The shape the harness builds: clients, profiles and schemas keyed by source id. */
function buildTools(set: SecuritySourceSet, primaryId: string) {
  return createInvestigationTools({
    security: {
      sources: new Map(
        [...set.sources].map(([id, bundle]) => [
          id,
          { client: bundle.client, profile: bundle.profile, tables: new Map() },
        ]),
      ),
      primaryId,
    },
    webSearch: WEB_SEARCH_STUB,
    webFetch: WEB_FETCH_STUB,
    onSubmit: () => undefined,
  });
}

/** A second fixture source, distinguishable from the first in every field a test reads. */
const SECOND_PROFILE = Object.freeze({
  ...TEST_SOURCE_PROFILE,
  kind: "contract-fixture-b",
  connector: "in-memory-b",
  target: "fixture-corpus-b",
  queryLanguage: "fixtureql-b",
  initialContext: Object.freeze({
    alertIntroduction: "Investigate the following Second Fixture alert.",
    tablesIntroduction: "These are the second fixture's tables.",
  }),
});

class SecondFixtureSource extends FixtureSecuritySource {
  override async listAlerts(limit?: number): Promise<SecurityAlert[]> {
    this.listCalls += 1;
    const alerts = await super.listAlerts(limit);
    // A distinct id, so "which source produced this alert" is answerable from the artifact alone.
    return alerts.map((alert) => Object.assign({}, alert, { id: `second-${alert.id}` }));
  }
  listCalls = 0;
}

class CountingFixtureSource extends FixtureSecuritySource {
  listCalls = 0;
  override async listAlerts(limit?: number): Promise<SecurityAlert[]> {
    this.listCalls += 1;
    return super.listAlerts(limit);
  }
}

function twoSourceSet(primaryId: "alpha" | "beta"): {
  set: SecuritySourceSet;
  alpha: CountingFixtureSource;
  beta: SecondFixtureSource;
} {
  const alpha = new CountingFixtureSource();
  const beta = new SecondFixtureSource();
  const alphaBundle = testSourceBundle(alpha);
  const betaBundle = Object.freeze({ client: beta, profile: SECOND_PROFILE });
  const sources = new Map([
    ["alpha", alphaBundle],
    ["beta", betaBundle],
  ]);
  const primary = primaryId === "alpha" ? alphaBundle : betaBundle;
  return { set: Object.freeze({ sources, primary }), alpha, beta };
}

/** AC10 — turn-0 carries one labelled block per source, in order, with one alert framing. */
describe("AC10 — turn-0 context with several sources", () => {
  test("one labelled table block per source in SECURITY_SOURCES order", () => {
    const { set } = twoSourceSet("alpha");
    const context = buildInitialContext(
      set.primary.profile,
      {
        id: "a-1",
        title: "Alert",
        description: "",
        tactics: [],
        techniques: [],
        entities: [],
        native: null,
      },
      [
        { id: "alpha", profile: set.sources.get("alpha")!.profile, tableNames: ["AlphaTable"] },
        { id: "beta", profile: set.sources.get("beta")!.profile, tableNames: ["BetaTable"] },
      ],
      undefined,
    );

    expect(context).toContain('<available_tables source="alpha">');
    expect(context).toContain('<available_tables source="beta">');
    expect(context.indexOf('source="alpha"')).toBeLessThan(context.indexOf('source="beta"'));
    expect(context).toContain("AlphaTable");
    expect(context).toContain("BetaTable");

    // Each block is introduced by its own profile's framing — that is what makes the source ids
    // learnable from the same place the table names are.
    expect(context).toContain(TEST_SOURCE_PROFILE.initialContext.tablesIntroduction);
    expect(context).toContain(SECOND_PROFILE.initialContext.tablesIntroduction);
  });

  test("the alert is introduced once, by the primary's framing", () => {
    const { set } = twoSourceSet("beta");
    const context = buildInitialContext(
      set.primary.profile,
      {
        id: "b-1",
        title: "Alert",
        description: "",
        tactics: [],
        techniques: [],
        entities: [],
        native: null,
      },
      [
        { id: "alpha", profile: set.sources.get("alpha")!.profile, tableNames: [] },
        { id: "beta", profile: set.sources.get("beta")!.profile, tableNames: [] },
      ],
      undefined,
    );

    expect(context).toContain(SECOND_PROFILE.initialContext.alertIntroduction);
    expect(context).not.toContain(TEST_SOURCE_PROFILE.initialContext.alertIntroduction);
    // Exactly one alert envelope, whatever the source count.
    expect(context.match(/<alert>/g) ?? []).toHaveLength(1);
  });
});

/** AC8 — an unknown `source` is a correctable tool error, not a crashed investigation. */
describe("AC8 — the source parameter", () => {
  test("an inactive source id returns an error naming the active ids", async () => {
    const { set } = twoSourceSet("alpha");
    const query = buildTools(set, "alpha").find((tool) => tool.name === "query_security_data");
    const error = await query!
      .execute("call-1", { query: "MATCH x RETURN y", source: "splunk" }, {} as never)
      .catch((caught: unknown) => caught);

    expect(String(error)).toContain("splunk");
    expect(String(error)).toContain("alpha");
    expect(String(error)).toContain("beta");
  });

  test("an omitted source routes to the primary", async () => {
    const { set } = twoSourceSet("beta");
    const query = buildTools(set, "beta").find((tool) => tool.name === "query_security_data");
    await query!.execute("call-2", { query: "MATCH x RETURN y" }, {} as never);

    const beta = set.sources.get("beta")!.client as FixtureSecuritySource;
    const alpha = set.sources.get("alpha")!.client as FixtureSecuritySource;
    expect(beta.queries).toHaveLength(1);
    expect(alpha.queries).toHaveLength(0);
  });

  test("a named secondary is reachable while the primary is untouched", async () => {
    const { set } = twoSourceSet("alpha");
    const query = buildTools(set, "alpha").find((tool) => tool.name === "query_security_data");
    await query!.execute("call-3", { query: "MATCH x RETURN y", source: "beta" }, {} as never);

    expect((set.sources.get("beta")!.client as FixtureSecuritySource).queries).toHaveLength(1);
    expect((set.sources.get("alpha")!.client as FixtureSecuritySource).queries).toHaveLength(0);
  });
});

/**
 * Drive `executeRun` far enough to list alerts, then stop.
 *
 * `resolveModel` throwing would abort *before* listing and make every assertion below vacuous, so
 * it resolves successfully and the run is stopped by an already-aborted signal instead. That
 * ordering is the whole point of the test: alert listing has to have actually happened.
 */
const listAlertsVia = async (primaryId: "alpha" | "beta") => {
  const { set, alpha, beta } = twoSourceSet(primaryId);
  const aborted = AbortSignal.abort();
  let written: unknown;

  await executeRun(
    {
      provider: "test",
      modelId: "test-model",
      maxTurns: 1,
      timeoutMs: 1_000,
      resultMaxChars: 1_000,
      webSearchConfigured: false,
      runsDir: ".data/test-runs",
      trace: false,
      traceDir: ".data/test-runs/traces",
      traceStream: false,
    },
    {
      securitySources: set,
      webSearch: WEB_SEARCH_STUB,
      webFetch: WEB_FETCH_STUB,
      // Captured rather than written: the artifact is the evidence, and no test may write into
      // the repository's runs directory.
      write: async (_dir, run) => {
        written = run;
        return "";
      },
      resolveModel: async () =>
        ({
          model: { id: "test-model", api: "openai" },
          streamFn: () => {
            throw new Error("no model turn should be reached");
          },
        }) as never,
    },
    { runId: "01a00000-0000-7000-0000-00000000000a", signal: aborted },
  ).catch(() => undefined);

  return {
    alpha,
    beta,
    written: written as { plannedAlerts?: { alertId: string }[] } | undefined,
  };
};

/**
 * AC11 — primacy is a role, not a property of a connector.
 *
 * The second half is the one that matters and the one a weaker test would skip: the *same* two
 * connectors, with only `PRIMARY_ALERT_SOURCE` moved, must swap which of them produces alerts. A
 * test that only checked "the primary produced the alerts" would pass just as well if the connector
 * itself decided.
 */
describe("AC11 — only the primary produces alerts", () => {
  test("with alpha primary, alpha is asked and beta is never asked", async () => {
    const { alpha, beta, written } = await listAlertsVia("alpha");

    expect(alpha.listCalls).toBe(1);
    expect(beta.listCalls).toBe(0);
    // The artifact carries alpha's id shape, so the producer is answerable from the run alone.
    expect(written?.plannedAlerts?.[0]?.alertId).toBe("fixture-alert-1");
  });

  /**
   * The half a weaker test would skip.
   *
   * Same two connectors, same order, only the role moved. If primacy were a property of the
   * connector rather than a configured role, this would fail — and D5 rests on it being a role.
   */
  test("moving PRIMARY_ALERT_SOURCE moves the sole producer", async () => {
    const { alpha, beta, written } = await listAlertsVia("beta");

    expect(beta.listCalls).toBe(1);
    expect(alpha.listCalls).toBe(0);
    expect(written?.plannedAlerts?.[0]?.alertId).toBe("second-fixture-alert-1");
  });

  test("alert ids from two products never coexist in one run", async () => {
    const { written } = await listAlertsVia("alpha");
    const ids = (written?.plannedAlerts ?? []).map((alert) => alert.alertId);

    // What keeps the evaluation join and the console queue safe without either knowing that more
    // than one source exists.
    expect(ids.every((id) => !id.startsWith("second-"))).toBeTrue();
  });
});

/**
 * AC12 — a multi-source run is a different condition from a single-source one.
 *
 * ADR 008 §3 hashes the whole of `config`, so this is what stops two runs against different product
 * sets merging into one cell of a comparison. The prompt hash carries the same distinction from the
 * other direction: it hashes every active profile's prompt-visible content.
 */
describe("AC12 — provenance and the condition key", () => {
  test("the prompt hash differs between one active source and two", () => {
    const { set: two } = twoSourceSet("alpha");
    const single = computePromptHash({
      sources: new Map([["alpha", TEST_SOURCE_PROFILE]]),
      primaryId: "alpha",
    });
    const both = computePromptHash({
      sources: new Map([
        ["alpha", two.sources.get("alpha")!.profile],
        ["beta", two.sources.get("beta")!.profile],
      ]),
      primaryId: "alpha",
    });

    expect(both).not.toBe(single);
  });

  test("the prompt hash differs when only the primary moves", () => {
    const { set } = twoSourceSet("alpha");
    const sources = new Map([
      ["alpha", set.sources.get("alpha")!.profile],
      ["beta", set.sources.get("beta")!.profile],
    ]);

    // Same two profiles, same order — only the role moves. Turn-0's alert framing comes from the
    // primary, so this must be a different prompt.
    expect(computePromptHash({ sources, primaryId: "alpha" })).not.toBe(
      computePromptHash({ sources, primaryId: "beta" }),
    );
  });

  /**
   * The Phase 1 hash is pinned rather than reasoned about.
   *
   * It moved from `a70f3066b376` when Phase 2 made the labelled turn-0 block and the `source` tool
   * property unconditional. ADR 011 §14 records that as a deliberate deviation from PRD-8 AC2 and
   * accepts the corpus split it causes. Pinning the new value is what makes the *next* move
   * deliberate too — this test failing means someone changed what the agent is told.
   */
  test("the single-source Sentinel prompt hash is pinned", () => {
    const sentinel = createSentinelSourceBundle({
      connector: "mock",
      baseUrl: "http://localhost:8787",
    }).profile;

    expect(computePromptHash(sentinel)).toBe("5c385038af3e");
  });
});
