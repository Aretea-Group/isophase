import { describe, expect, test } from "bun:test";

import {
  assertLiveTenantArtifactDirectories,
  readsLiveTenant,
  securitySourceConfigSetFromEnv,
  type SecuritySourceEnvironment,
} from "@soc/sentinel-client";

import { type LaunchPlan, planLaunch } from "../src/live.ts";

/**
 * What `console --live` is for, tested as the two claims its name makes (PRD-11 §4.1 D3 moved it
 * here from `scripts/console-live.ts`; the claims are unchanged).
 *
 * "Live": every source it can name must produce a set that `readsLiveTenant` agrees reads a real
 * tenant — a launcher that quietly resolved Mock Sentinel would be the exact failure it exists to
 * prevent. "Openable": the directories it derives must satisfy
 * `assertLiveTenantArtifactDirectories`, which runs in `apps/console/src/index.ts` before the first
 * frame and exits the process rather than degrading. Both are checked through the real factory and
 * the real guard, with stub credentials, so the test neither reads `.env` nor reaches a tenant.
 */

/** Credentials the factory requires to construct a source. Never used to authenticate anything. */
const STUB: SecuritySourceEnvironment = {
  SENTINEL_CONNECTOR: "mock",
  SENTINEL_BASE_URL: "http://localhost:8787",
  SENTINEL_TIMEOUT_MS: 30_000,
  AZURE_LOG_ANALYTICS_WORKSPACE_ID: "00000000-0000-0000-0000-000000000000",
  DEFENDER_TENANT_ID: "stub-tenant",
  DEFENDER_CLIENT_ID: "stub-client",
  DEFENDER_CLIENT_SECRET: "stub-secret",
};

function configSetFor(plan: LaunchPlan) {
  return securitySourceConfigSetFromEnv({
    ...STUB,
    ...(plan.env["SENTINEL_CONNECTOR"] === undefined
      ? {}
      : { SENTINEL_CONNECTOR: plan.env["SENTINEL_CONNECTOR"] as "mock" | "azure" }),
    ...(plan.env["SECURITY_SOURCES"] === undefined
      ? {}
      : { SECURITY_SOURCES: plan.env["SECURITY_SOURCES"] }),
    ...(plan.env["PRIMARY_ALERT_SOURCE"] === undefined
      ? {}
      : { PRIMARY_ALERT_SOURCE: plan.env["PRIMARY_ALERT_SOURCE"] }),
  });
}

function directoriesOf(plan: LaunchPlan): string[] {
  return [plan.env["RUNS_DIR"] ?? "", plan.env["INVESTIGATOR_TRACE_DIR"] ?? ""];
}

describe("console --live — source selection", () => {
  test("requires a source rather than defaulting to one", () => {
    // The whole reason the flag takes a value instead of being a switch: "live" names three
    // configurations, and guessing wrong is silent.
    expect(() => planLaunch(["--live"])).toThrow("needs a source");
    expect(() => planLaunch(["--live", "--live="])).toThrow("needs a source");
  });

  test("a following flag is not a source", () => {
    // Otherwise `console --live --fresh` would read `--fresh` as a source name and report an
    // unknown source, which sends the reader looking in the wrong place.
    expect(() => planLaunch(["--live", "--fresh"])).toThrow("needs a source");
  });

  test("without --live there is no overlay and the console opens against .env", () => {
    expect(planLaunch([])).toEqual({ env: {}, consoleArgs: [] });
    expect(planLaunch(["--fresh"])).toEqual({ env: {}, consoleArgs: ["--fresh"] });
  });

  test("the flag may be given once", () => {
    expect(() => planLaunch(["--live", "defender", "--live", "sentinel"])).toThrow("once");
  });

  test("an unknown source names itself and the known set", () => {
    expect(() => planLaunch(["--live", "splunk"])).toThrow('Unknown source "splunk"');
    expect(() => planLaunch(["--live", "defender,splunk"])).toThrow('Unknown source "splunk"');
  });

  test("a duplicate is an error, not a silently deduplicated list", () => {
    // `SECURITY_SOURCES` rejects duplicates downstream; catching it here names the argument that
    // caused it rather than the environment variable the analyst never typed.
    expect(() => planLaunch(["--live", "defender,defender"])).toThrow("more than once");
  });

  test("tolerates whitespace and trailing commas in the list", () => {
    expect(planLaunch(["--live", "defender, sentinel"]).env["SECURITY_SOURCES"]).toBe(
      "defender,sentinel",
    );
    expect(planLaunch(["--live", "defender,"]).env["SECURITY_SOURCES"]).toBe("defender");
  });
});

describe("console --live — what each source resolves to", () => {
  test("defender leaves SENTINEL_CONNECTOR alone", () => {
    const plan = planLaunch(["--live", "defender"]);
    expect(plan.env["SECURITY_SOURCES"]).toBe("defender");
    expect(plan.env["RUNS_DIR"]).toBe(".data/defender-runs");
    expect(plan.env["INVESTIGATOR_TRACE_DIR"]).toBe(".data/defender-runs/traces");
    // Load-bearing: a Defender-only run on a corpus checkout must not drag Sentinel to azure.
    expect(plan.env["SENTINEL_CONNECTOR"]).toBeUndefined();
    // Single source, so the factory needs no primary and naming one would be noise.
    expect(plan.env["PRIMARY_ALERT_SOURCE"]).toBeUndefined();
  });

  test("sentinel means the workspace, not the corpus", () => {
    const plan = planLaunch(["--live", "sentinel"]);
    expect(plan.env["SECURITY_SOURCES"]).toBe("sentinel");
    expect(plan.env["SENTINEL_CONNECTOR"]).toBe("azure");
    expect(plan.env["RUNS_DIR"]).toBe(".data/azure-runs");
  });

  test("a mixed run gets its own root and an explicit primary", () => {
    const plan = planLaunch(["--live", "defender,sentinel"]);
    expect(plan.env["SECURITY_SOURCES"]).toBe("defender,sentinel");
    expect(plan.env["SENTINEL_CONNECTOR"]).toBe("azure");
    expect(plan.env["PRIMARY_ALERT_SOURCE"]).toBe("defender");
    // Neither single-source corpus owns a run that drew on both.
    expect(plan.env["RUNS_DIR"]).toBe(".data/live-runs");
  });

  test("the written order chooses the queue", () => {
    expect(planLaunch(["--live", "sentinel,defender"]).env["PRIMARY_ALERT_SOURCE"]).toBe(
      "sentinel",
    );
  });

  test("never sets DEFENDER_ALERT_WINDOW", () => {
    // Deliberate. The window is a fact about a tenant's detection cadence that goes stale on its
    // own — a quiet week empties one that worked yesterday — so it lives in `.env`, not in a repo
    // script that would then be wrong for every other checkout.
    for (const argv of [
      ["--live", "defender"],
      ["--live", "sentinel"],
      ["--live", "defender,sentinel"],
    ]) {
      expect(planLaunch(argv).env["DEFENDER_ALERT_WINDOW"]).toBeUndefined();
    }
  });
});

describe("console --live — the console actually opens", () => {
  test("every source reads a live tenant", () => {
    for (const argv of [
      ["--live", "defender"],
      ["--live", "sentinel"],
      ["--live", "defender,sentinel"],
    ]) {
      const set = configSetFor(planLaunch(argv));
      expect(set.sources.length).toBeGreaterThan(0);
      expect(set.sources.every(readsLiveTenant)).toBe(true);
    }
  });

  test("the primary is the source named first", () => {
    expect(configSetFor(planLaunch(["--live", "defender,sentinel"])).primary.id).toBe("defender");
    expect(configSetFor(planLaunch(["--live", "sentinel,defender"])).primary.id).toBe("sentinel");
  });

  test("the derived directories satisfy the startup guard", () => {
    for (const argv of [
      ["--live", "defender"],
      ["--live", "sentinel"],
      ["--live", "defender,sentinel"],
    ]) {
      const plan = planLaunch(argv);
      const set = configSetFor(plan);
      expect(() =>
        assertLiveTenantArtifactDirectories(set.sources, directoriesOf(plan)),
      ).not.toThrow();
    }
  });

  test("the guard the previous test relies on is not vacuous", () => {
    // Negative control. Without this, moving the launcher's directories back to `runs/` would keep
    // the suite green while the console exited before drawing a frame — the original bug.
    const set = configSetFor(planLaunch(["--live", "defender"]));
    expect(() => assertLiveTenantArtifactDirectories(set.sources, ["runs", "runs/traces"])).toThrow(
      "must be inside .data/",
    );
  });
});

describe("console --live — forwarding", () => {
  test("everything but the flag reaches the console untouched", () => {
    const plan = planLaunch(["--live", "defender", "--fresh", "--runs", ".data/scratch"]);
    expect(plan.consoleArgs).toEqual(["--fresh", "--runs", ".data/scratch"]);
  });

  test("a source with no flags forwards nothing", () => {
    expect(planLaunch(["--live", "defender"]).consoleArgs).toEqual([]);
  });

  test("the flag may sit anywhere among the console's own flags", () => {
    const plan = planLaunch(["--fresh", "--live=sentinel", "--runs", ".data/scratch"]);
    expect(plan.consoleArgs).toEqual(["--fresh", "--runs", ".data/scratch"]);
    expect(plan.env["SECURITY_SOURCES"]).toBe("sentinel");
  });

  test("forwarded values are not re-parsed as sources", () => {
    // `--runs sentinel` is a directory named sentinel, not a second source.
    expect(planLaunch(["--live", "defender", "--runs", "sentinel"]).consoleArgs).toEqual([
      "--runs",
      "sentinel",
    ]);
    expect(planLaunch(["--live", "defender", "--runs", "sentinel"]).env["SECURITY_SOURCES"]).toBe(
      "defender",
    );
  });
});
