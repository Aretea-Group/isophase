import { describe, expect, test } from "bun:test";

import { SentinelApiError, securitySourceConfigSetFromEnv } from "@soc/sentinel-client";

import { describeStartupError } from "../src/index.ts";

const MOCK = securitySourceConfigSetFromEnv({
  SENTINEL_CONNECTOR: "mock",
  SENTINEL_BASE_URL: "http://localhost:8787/",
  SENTINEL_TIMEOUT_MS: 30_000,
});

/**
 * AC12 (investigator half) — Given `SENTINEL_CONNECTOR=mock` and nothing listening on
 * `SENTINEL_BASE_URL`, When `investigate` starts, Then the message names the mock connector, says
 * it needs the local lab, and names `isophase init` — and does not mention
 * `bun run dev:mock-sentinel`. The console half is in `apps/console/test/connector.test.ts`.
 */
describe("AC12 — the mock connector fails loudly (PRD-11 §4.1 D5)", () => {
  const unreachable = new SentinelApiError(
    "unreachable",
    0,
    "GET http://localhost:8787/alerts failed: Unable to connect",
  );

  test("an unreachable mock connector gets the loud message", () => {
    const message = describeStartupError(unreachable, MOCK);
    expect(message).toContain("mock Sentinel connector is selected (SENTINEL_CONNECTOR=mock)");
    expect(message).toContain("nothing answers on http://localhost:8787");
    expect(message).toContain("needs the local lab");
    expect(message).toContain("isophase init");
    expect(message).not.toContain("dev:mock-sentinel");
    expect(message).not.toContain("bun run");
  });

  test("any other error is printed as it was raised", () => {
    const other = new SentinelApiError("authorization_error", 403, "denied");
    expect(describeStartupError(other, MOCK)).toBe("denied");
    expect(describeStartupError(new Error("boom"), MOCK)).toBe("boom");
    expect(describeStartupError("string", undefined)).toBe("string");
  });

  test("an unreachable live source is not blamed on the mock connector", () => {
    const defender = securitySourceConfigSetFromEnv({
      SENTINEL_CONNECTOR: "mock",
      SENTINEL_BASE_URL: "http://localhost:8787",
      SENTINEL_TIMEOUT_MS: 30_000,
      SECURITY_SOURCES: "defender",
      DEFENDER_TENANT_ID: "t",
      DEFENDER_CLIENT_ID: "c",
      DEFENDER_CLIENT_SECRET: "s",
    });
    expect(describeStartupError(unreachable, defender)).toBe(unreachable.message);
  });
});
