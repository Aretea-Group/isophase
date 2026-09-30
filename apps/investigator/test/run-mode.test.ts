import { describe, expect, test } from "bun:test";

import { securitySourceConfigSetFromEnv } from "@soc/sentinel-client";

/**
 * PRD-10 AC17 — run mode needs a tenant credential and nothing else.
 *
 * The claim in §2 is that the Kusto Emulator, the fixtures and the bootstrap are develop-mode only,
 * and that a reader with a Defender tenant and Bun has a path through the README. This asserts the
 * half a test can hold: that configuring Defender alone resolves to Defender alone, with no Mock
 * Sentinel base URL, no fixture path and no Kusto anything in the resolved configuration.
 *
 * The other half — that the README's numbered list actually works on a machine with no Docker — is
 * AC16, which is an e2e against a real portal and cannot be asserted here.
 */

const DEFENDER_ONLY = {
  SECURITY_SOURCES: "defender",
  DEFENDER_TENANT_ID: "tenant",
  DEFENDER_CLIENT_ID: "client",
  DEFENDER_CLIENT_SECRET: "secret",
  DEFENDER_TIMEOUT_MS: 30_000,
  DEFENDER_QUERY_MAX_ROWS: 500,
  DEFENDER_ALERT_WINDOW: "P7D",
  // Present, and deliberately so: these carry defaults in `env.ts` whatever the operator sets, and
  // the point of the test is that a Defender-only run ignores them rather than that they are absent.
  SENTINEL_CONNECTOR: "mock" as const,
  SENTINEL_BASE_URL: "http://localhost:8787",
  SENTINEL_TIMEOUT_MS: 30_000,
};

describe("run mode (PRD-10 §2, AC17)", () => {
  test("Given tenant credentials only, When sources resolve, Then Defender is the only one and it is primary", () => {
    const set = securitySourceConfigSetFromEnv(DEFENDER_ONLY);

    expect(set.sources.map((source) => source.id)).toEqual(["defender"]);
    expect(set.primary.id).toBe("defender");
  });

  test("Given tenant credentials only, When sources resolve, Then no Mock Sentinel URL reaches the configuration", () => {
    const set = securitySourceConfigSetFromEnv(DEFENDER_ONLY);

    // The mock base URL is set in the environment above and must not survive into what the run
    // actually uses — that is the difference between "the emulator is optional" and "the emulator
    // is unused", and only the second one lets someone run this without Docker.
    const serialised = JSON.stringify(set.sources);
    expect(serialised).not.toContain("localhost:8787");
    expect(serialised).not.toContain("fixtures");
    expect(serialised.toLowerCase()).not.toContain("kusto");
  });

  test("Given Sentinel is selected instead, Then the mock connector is what resolves", () => {
    // The inverse, so the assertion above cannot pass by resolving nothing at all.
    const set = securitySourceConfigSetFromEnv({ ...DEFENDER_ONLY, SECURITY_SOURCES: "sentinel" });

    expect(set.sources.map((source) => source.id)).toEqual(["sentinel"]);
    expect(JSON.stringify(set.sources)).toContain("localhost:8787");
  });
});
