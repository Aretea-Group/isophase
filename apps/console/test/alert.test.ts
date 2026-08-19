import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { readRun } from "../src/data/runs.ts";
import { readAlert } from "../src/data/trace-detail.ts";
import { indexTrace } from "../src/data/trace-index.ts";
import {
  alertFactsFromResult,
  alertLines,
  enrichWithAlertJson,
  entityLabel,
  entityPairs,
  remediationLines,
} from "../src/view/alert.ts";
import {
  incidentDate,
  incidentTime,
  incidentWindow,
  lineText,
  severityTag,
} from "../src/view/format.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const TRACE = join(
  FIXTURES,
  "traces/01a0194a-90fd-7000-b417-5eea46721c99-cc6430ca-0fc5-b704-c048-1d5f3d8a2524.jsonl",
);

describe("incident time", () => {
  test("is formatted so it cannot be read as investigation time", () => {
    // The alert fired in 2021; the investigation ran in 2026. Incident times are date-first and
    // explicitly UTC; investigation timing is only ever a clock time or a duration.
    expect(incidentTime("2021-10-23T05:26:19.626Z")).toBe("2021-10-23 05:26Z");
    expect(incidentDate("2021-10-23T05:26:19.626Z")).toBe("2021-10-23");
    expect(incidentTime(undefined)).toBe("—");
  });

  test("collapses a window that starts and ends on the same day", () => {
    expect(incidentWindow("2021-10-23T05:26:19Z", "2021-10-23T06:25:57Z")).toBe(
      "2021-10-23 05:26→06:25Z",
    );
    expect(incidentWindow("2021-10-23T23:50:00Z", "2021-10-24T00:10:00Z")).toBe(
      "2021-10-23 23:50Z → 2021-10-24 00:10Z",
    );
    expect(incidentWindow("2021-10-23T05:26:19Z", undefined)).toBe("2021-10-23 05:26Z");
  });

  test("severity is blank when never recorded, but flagged when unrecognised", () => {
    // Most artifacts on disk predate the alert block; blanks read as "not applicable", `???` reads
    // as a data problem.
    expect(severityTag(undefined)).toBe("    ");
    expect(severityTag("High")).toBe("HIGH");
    expect(severityTag("Catastrophic")).toBe("??? ");
  });
});

describe("alert facts", () => {
  test("come from the artifact when it carries them", async () => {
    const run = await readRun(join(FIXTURES, "runs/with-alert.json"));
    if ("issue" in run) throw new Error("fixture unreadable");
    const facts = alertFactsFromResult(run.results[0]!);

    expect(facts.source).toBe("artifact");
    expect(facts.severity).toBe("Medium");
    expect(facts.window).toBe("2021-10-23 05:26→06:25Z");
    expect(facts.compromisedEntity).toBe("SOC-FW-RDP");
    expect(facts.tactics).toEqual(["CredentialAccess"]);
    expect(facts.techniques).toEqual(["T1110", "T1110.001"]);
    expect(facts.hasTime).toBe(true);
  });

  test("are recovered from the transcript for artifacts written before the alert block", async () => {
    const run = await readRun(join(FIXTURES, "runs/01a0194a-90fd-7000-b417-5eea46721c99.json"));
    if ("issue" in run) throw new Error("fixture unreadable");

    const before = alertFactsFromResult(run.results[0]!);
    expect(before.source).toBe("none");
    expect(before.hasTime).toBe(false);

    const index = await indexTrace(TRACE);
    const after = enrichWithAlertJson(before, await readAlert(TRACE, index.alertMessage!));

    expect(after.source).toBe("transcript");
    expect(after.severity).toBe("Medium");
    expect(after.window).toBe("2021-10-23 05:26→06:25Z");
    expect(after.compromisedEntity).toBe("SOC-FW-RDP");
    expect(after.entities.length).toBeGreaterThan(0);
    expect(after.description).toBeDefined();
  });

  test("the artifact wins over the transcript, and both are recorded", async () => {
    const run = await readRun(join(FIXTURES, "runs/with-alert.json"));
    if ("issue" in run) throw new Error("fixture unreadable");
    const index = await indexTrace(TRACE);
    const merged = enrichWithAlertJson(
      alertFactsFromResult(run.results[0]!),
      await readAlert(TRACE, index.alertMessage!),
    );

    expect(merged.source).toBe("both");
    // The durable record is not overwritten by whatever transcript happened to be alongside it.
    expect(merged.window).toBe("2021-10-23 05:26→06:25Z");
    expect(merged.tactics).toEqual(["CredentialAccess"]);
    // ...but the transcript still contributes what the artifact never carried.
    expect(merged.entities.length).toBeGreaterThan(0);
  });

  test("reads a label out of each entity shape", () => {
    expect(entityLabel({ type: "host", hostName: "SOC-FW-RDP" })).toBe("SOC-FW-RDP");
    expect(entityLabel({ type: "account", name: "ADMINISTRATOR" })).toBe("ADMINISTRATOR");
    expect(entityLabel({ type: "ip", address: "10.0.0.4" })).toBe("10.0.0.4");
    expect(entityLabel({ type: "mystery" })).toBe("—");
  });

  test("renders the triage pane inside its width", async () => {
    const run = await readRun(join(FIXTURES, "runs/with-alert.json"));
    if ("issue" in run) throw new Error("fixture unreadable");
    const lines = alertLines(alertFactsFromResult(run.results[0]!), 43).map(lineText);

    expect(lines.some((line) => line.includes("2021-10-23"))).toBe(true);
    expect(lines.some((line) => line.includes("SOC-FW-RDP"))).toBe(true);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(43);
  });

  test("lists entity identifiers rather than counting their types", async () => {
    const run = await readRun(join(FIXTURES, "runs/with-alert.json"));
    if ("issue" in run) throw new Error("fixture unreadable");
    const facts = enrichWithAlertJson(alertFactsFromResult(run.results[0]!), {
      properties: {
        entities: [
          { type: "host", hostName: "SOC-FW-RDP" },
          { type: "ip", address: "203.0.113.47" },
          { type: "account", name: "jsmith" },
        ],
        remediationSteps: ["Isolate the host pending triage."],
        additionalData: { Action: "Allowed", Nested: { ignored: true } },
      },
    });

    expect(entityPairs(facts)).toEqual(["host SOC-FW-RDP", "ip 203.0.113.47", "account jsmith"]);
    // The pivot values reach the pane; the old roll-up ("3 host, 1 account") does not.
    const rendered = alertLines(facts, 60).map(lineText).join("\n");
    expect(rendered).toContain("203.0.113.47");
    expect(rendered).toContain("jsmith");

    // Only scalars survive from additionalData.
    expect(facts.additionalData).toEqual([["Action", "Allowed"]]);
    expect(rendered).toContain("Allowed");

    expect(remediationLines(facts, 60).map(lineText).join("\n")).toContain(
      "Isolate the host pending triage.",
    );
  });

  test("omits remediation entirely when the alert carries none", () => {
    const facts = alertFactsFromResult({
      alertId: "a",
      alertTitle: "t",
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
    });
    expect(remediationLines(facts, 60)).toEqual([]);
  });
});
