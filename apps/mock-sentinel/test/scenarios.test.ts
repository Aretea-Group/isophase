import { describe, expect, test } from "bun:test";

import { createApp } from "../src/app.ts";
import { ConfigSchema } from "../src/config.ts";
import { loadScenarios } from "../src/scenarios/scenarios.ts";

const config = ConfigSchema.parse({ SERVICE_VERSION: "test" });
const scenarios = await loadScenarios();

describe("scenario metadata", () => {
  test("loads and validates every file", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(6);
    for (const scenario of scenarios) {
      expect(scenario.discriminatingEvidence.length).toBeGreaterThan(0);
    }
  });

  test("ids are unique", () => {
    const ids = scenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("starting alerts are distinct across scenarios", () => {
    const ids = scenarios.map((s) => s.startingAlertId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("outcomes are varied enough to be discriminating", () => {
    // If every scenario resolved the same way, an agent that always guessed
    // that outcome would score perfectly while investigating nothing.
    expect(new Set(scenarios.map((s) => s.impact)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(scenarios.map((s) => s.verdict)).size).toBeGreaterThanOrEqual(2);
  });

  test("at least one scenario is not a confirmed compromise", () => {
    // The failure mode these guard against: concluding "compromised" from a
    // loud-looking alert. There has to be something to get wrong.
    expect(scenarios.some((s) => s.impact === "none")).toBe(true);
    expect(scenarios.some((s) => s.verdict === "inconclusive")).toBe(true);
  });
});

/**
 * The load-bearing test.
 *
 * Scenario metadata states the answer. If any route ever serves it, the future
 * agent can read the verdict instead of investigating, and every evaluation
 * built on these files becomes meaningless.
 */
describe("scenario metadata is not reachable over REST", () => {
  const app = createApp({ config });

  test.each([
    "/scenarios",
    "/scenario",
    "/fixtures/scenarios",
    "/alerts/scenarios",
    "/scenarios/soc-fw-rdp-brute-force",
  ])("%s is not routed", async (path) => {
    const res = await app.request(path);

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  test("no scenario verdict or trap text appears in any served response", async () => {
    // createApp without a Kusto client mounts only /health, which is the one
    // route that can answer without a database — enough to prove the answer key
    // is not leaking into a response body.
    const body = await (await app.request("/health")).text();

    for (const scenario of scenarios) {
      expect(body).not.toContain(scenario.verdict);
      expect(body).not.toContain(scenario.trap.slice(0, 40));
      expect(body).not.toContain(scenario.startingAlertId);
    }
  });
});
