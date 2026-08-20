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
