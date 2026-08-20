import { expect, test } from "bun:test";

import type { SecurityAlertResource } from "@soc/contracts";

import { InvestigationAbortedError } from "../src/errors.ts";
import type { InvestigationHarness } from "../src/harness.ts";
import { investigateAlerts } from "../src/investigate-alerts.ts";

function alert(id: string): SecurityAlertResource {
  return {
    id: `/alerts/${id}`,
    name: id,
    type: "Microsoft.SecurityInsights/Entities",
    properties: {
      systemAlertId: id,
      alertDisplayName: `alert ${id}`,
      description: "test",
      severity: "High",
      status: "New",
      startTimeUtc: "2026-08-20T00:00:00.000Z",
      endTimeUtc: "2026-08-20T00:01:00.000Z",
      timeGenerated: "2026-08-20T00:01:00.000Z",
      vendorName: "Microsoft",
      productName: "Azure Sentinel",
      alertType: "Test",
      tactics: [],
      techniques: [],
      entities: [],
    } as unknown as SecurityAlertResource["properties"],
  } as SecurityAlertResource;
}

test("cancellation records the in-flight alert and never starts the next one", async () => {
  const controller = new AbortController();
  const started: string[] = [];
  const harness = {
    investigate(current: SecurityAlertResource) {
      started.push(current.properties.systemAlertId);
      controller.abort();
      return Promise.reject(new InvestigationAbortedError());
    },
  } satisfies Pick<InvestigationHarness, "investigate">;

  const results = await investigateAlerts({
    harness,
    alerts: [alert("a1"), alert("a2")],
    signal: controller.signal,
  });

  expect(started).toEqual(["a1"]);
  expect(results).toHaveLength(1);
  expect(results[0]?.status).toBe("failed");
  expect(results[0]?.error?.name).toBe("InvestigationAbortedError");
});

/**
 * Cost and effort survive the paths that matter (PRD-6 §6.7, ADR 008 §1).
 *
 * The harness fires `onMetrics` from the `finally` around `agent.prompt()`, *before* the ladder of
 * throws below it. A widened return type would have lost exactly the most expensive runs — the
 * timeout that burned its whole budget is the one a cost comparison most needs — so these tests
 * assert the failed branch as carefully as the completed one.
 */

const METRICS = {
  turns: 9,
  toolCalls: {
    get_security_schema: 2,
    query_security_data: 6,
    submit_investigation: 1,
    web_fetch: 0,
    web_search: 0,
  },
  usage: {
    input: 180_000,
    output: 12_000,
    cacheRead: 140_000,
    cacheWrite: 20_000,
    totalTokens: 214_000,
    costUsd: 0.31,
  },
  servedModelId: "gpt-5.6-terra-2026-07-01",
};

test("a completed investigation records its turns, tool calls and cost", async () => {
  const harness = {
    investigate(_current: SecurityAlertResource, options: { onMetrics?: (m: unknown) => void }) {
      options.onMetrics?.(METRICS);
      return Promise.resolve({
        tpPercent: 90,
        fpPercent: 10,
        tpReason: "t",
        fpReason: "f",
        whatHappened: "w",
        keyEvidence: ["e"],
        researchDone: ["r"],
      });
    },
  } as unknown as Pick<InvestigationHarness, "investigate">;

  const [result] = await investigateAlerts({ harness, alerts: [alert("a1")] });

  expect(result?.turns).toBe(9);
  expect(result?.toolCalls?.["query_security_data"]).toBe(6);
  expect(result?.usage?.costUsd).toBeCloseTo(0.31, 6);
});

test("a failed investigation records what it spent before it died", async () => {
  const harness = {
    investigate(_current: SecurityAlertResource, options: { onMetrics?: (m: unknown) => void }) {
      // The harness reports from its `finally`, then the error ladder throws. Order is the point.
      options.onMetrics?.(METRICS);
      return Promise.reject(new Error("timed out after 600000ms"));
    },
  } as unknown as Pick<InvestigationHarness, "investigate">;

  const [result] = await investigateAlerts({ harness, alerts: [alert("a1")] });

  expect(result?.status).toBe("failed");
  expect(result?.usage?.costUsd).toBeCloseTo(0.31, 6);
  expect(result?.turns).toBe(9);
});

test("a harness that reports nothing leaves the fields absent rather than zero", async () => {
  const harness = {
    investigate() {
      return Promise.reject(new Error("died before the first turn"));
    },
  } as unknown as Pick<InvestigationHarness, "investigate">;

  const [result] = await investigateAlerts({ harness, alerts: [alert("a1")] });

  // Absent and zero are different facts, and only one of them is true here (PRD-6 §5.2).
  expect(result?.turns).toBeUndefined();
  expect(result?.usage).toBeUndefined();
});

test("run-level facts reach the caller without being repeated on every result", async () => {
  const harness = {
    investigate(_current: SecurityAlertResource, options: { onMetrics?: (m: unknown) => void }) {
      options.onMetrics?.(METRICS);
      return Promise.reject(new Error("boom"));
    },
  } as unknown as Pick<InvestigationHarness, "investigate">;

  const served: string[] = [];
  const results = await investigateAlerts({
    harness,
    alerts: [alert("a1"), alert("a2")],
    onMetrics: (_alert, metrics) => {
      if (metrics.servedModelId !== undefined) served.push(metrics.servedModelId);
    },
  });

  expect(served).toEqual(["gpt-5.6-terra-2026-07-01", "gpt-5.6-terra-2026-07-01"]);
  // The served id belongs in `provenance`, once — not on each result, where it would be a string
  // the artifact grows by alert count (ADR 008 §1).
  for (const result of results) {
    expect(Object.keys(result)).not.toContain("servedModelId");
  }
});
