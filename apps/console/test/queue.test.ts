import { describe, expect, test } from "bun:test";

import type { QueueAlert } from "../src/data/alerts.ts";
import type { RunArtifact } from "../src/data/runs.ts";
import { coverageByAlert, duplicateSpend, queueRows } from "../src/view/coverage.ts";

/**
 * The pure half of PRD-5: the coverage fold, and the one path helper in the write seam.
 *
 * Gate 4 in §14 exists precisely because gate 1 must exclude `drive/**` from its scan — the one
 * directory that can do harm is the one directory the isolation test cannot check, so it is
 * checked here on its hostile inputs instead.
 */

function run(over: Partial<RunArtifact>): RunArtifact {
  return {
    runId: "r1",
    startedAt: "2026-08-20T00:00:00.000Z",
    completedAt: "2026-08-20T00:01:00.000Z",
    status: "completed",
    results: [],
    ...over,
  } as RunArtifact;
}

function alert(alertId: string, scenarioId?: string): QueueAlert {
  return {
    alertId,
    title: `alert ${alertId}`,
    severity: "High",
    vendorStatus: "New",
    startTimeUtc: "2026-08-20T00:00:00.000Z",
    ...(scenarioId === undefined ? {} : { scenarioId }),
    resource: {} as QueueAlert["resource"],
  };
}

describe("coverage — derived, never stored (PRD-5 §4.2)", () => {
  test("an alert nobody has run is no-run", () => {
    const coverage = coverageByAlert([]);
    expect(coverage.get("a1")).toBeUndefined();
    expect(queueRows([alert("a1")], [])[0]?.coverage.state).toBe("no-run");
  });

  test("an alert whose every run failed is attempted, not investigated", () => {
    // The load-bearing case: hiding a crashed investigation is the one outcome that silently
    // loses work, so it must not read the same as an alert nobody has tried.
    const artifact = run({
      results: [{ alertId: "a1", alertTitle: "t", status: "failed" }],
    } as Partial<RunArtifact>);
    expect(coverageByAlert([artifact]).get("a1")?.state).toBe("attempted");
  });

  test("a running sweep marks its planned alerts in flight before any result exists", () => {
    const artifact = run({
      status: "running",
      results: [],
      plannedAlerts: [{ alertId: "a1", alertTitle: "t" }],
    } as Partial<RunArtifact>);
    expect(coverageByAlert([artifact]).get("a1")?.state).toBe("in-flight");
  });

  test("a finished sweep never leaves an alert looking live", () => {
    // Gated on `status === "running"`: otherwise every completed single-alert run would keep
    // showing a phantom pending row for the alert it already finished.
    const artifact = run({
      status: "completed",
      results: [],
      plannedAlerts: [{ alertId: "a1", alertTitle: "t" }],
    } as Partial<RunArtifact>);
    expect(coverageByAlert([artifact]).get("a1")?.state ?? "no-run").toBe("no-run");
  });

  test("an alert covered only by steered runs is investigated but not baseline", () => {
    const steered = run({
      config: { analystContext: "this host is a scanner" },
      results: [{ alertId: "a1", alertTitle: "t", status: "completed" }],
    } as Partial<RunArtifact>);
    const coverage = coverageByAlert([steered]).get("a1");
    expect(coverage?.state).toBe("investigated");
    // Queue honesty: the pane must not report this as handled in the ordinary sense.
    expect(coverage?.baseline).toBe(false);
    expect(queueRows([alert("a1")], [steered])[0]?.glyph).toBe("✓·");
  });

  test("one honest run is enough to make an alert baseline again", () => {
    const steered = run({
      runId: "r1",
      config: { analystContext: "premise" },
      results: [{ alertId: "a1", alertTitle: "t", status: "completed" }],
    } as Partial<RunArtifact>);
    const honest = run({
      runId: "r2",
      results: [{ alertId: "a1", alertTitle: "t", status: "completed" }],
    } as Partial<RunArtifact>);
    expect(coverageByAlert([steered, honest]).get("a1")?.baseline).toBe(true);
  });

  test("`s` narrows the queue to alerts that have ground truth", () => {
    const alerts = [alert("a1", "ransomware-srv-dc01"), alert("a2")];
    expect(queueRows(alerts, []).length).toBe(2);
    const filtered = queueRows(alerts, [], { groundTruthOnly: true });
    expect(filtered.length).toBe(1);
    expect(filtered[0]?.groundTruth).toBe("ransomware-srv-dc01");
  });

  test("the ground-truth column carries an id and never a verdict", () => {
    const rows = queueRows([alert("a1", "phishing-quarantined")], []);
    const row = rows[0];
    expect(row?.groundTruth).toBe("phishing-quarantined");
    // Nothing that could stand in for an answer reaches this layer at all.
    expect(JSON.stringify(row)).not.toContain("true-positive");
    expect(JSON.stringify(row)).not.toContain("verdict");
  });
});

/** A queue alert with an explicit start time and, optionally, a compromised entity. */
const withEntity = (
  alertId: string,
  startTimeUtc: string,
  compromisedEntity?: string,
): QueueAlert => ({
  ...alert(alertId),
  startTimeUtc,
  ...(compromisedEntity === undefined ? {} : { compromisedEntity }),
});

describe("duplicate-spend warning (PRD-5 §8)", () => {
  test("counts exact-entity matches within ±1 second and how many already have a run", () => {
    const selected = withEntity("a1", "2026-08-20T00:00:01.000Z", "host-1");
    const alerts = [
      selected,
      withEntity("a2", "2026-08-20T00:00:00.000Z", "host-1"),
      withEntity("a3", "2026-08-20T00:00:02.000Z", "host-1"),
      withEntity("a4", "2026-08-20T00:00:02.001Z", "host-1"),
      withEntity("a5", "2026-08-20T00:00:01.000Z", "HOST-1"),
    ];
    const runs = [run({ results: [{ alertId: "a2", alertTitle: "t", status: "completed" }] })];

    expect(duplicateSpend(selected, alerts, runs)).toEqual({ otherAlerts: 2, withRun: 1 });
  });
});
