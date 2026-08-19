import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { readRun, readRuns } from "../src/data/runs.ts";

const FIXTURES = join(import.meta.dir, "fixtures/runs");

describe("readRuns", () => {
  test("lists runs newest first and quarantines the unreadable one", async () => {
    const snapshot = await readRuns(FIXTURES);

    expect(snapshot.runs.length).toBeGreaterThanOrEqual(3);
    expect(snapshot.unreadable).toHaveLength(1);
    expect(snapshot.unreadable[0]?.path).toContain("corrupt.json");

    // A single malformed file must never cost the rest of the list (PRD-3 §11).
    const ids = snapshot.runs.map((run) => run.runId);
    expect(ids).toContain("01a0194c-b7c1-7000-8a3b-fe9d2b647919");
    expect([...ids]).toEqual([...ids].toSorted().toReversed());
  });

  test("names a missing directory rather than throwing or reading as empty", async () => {
    const missing = join(FIXTURES, "does-not-exist");
    const snapshot = await readRuns(missing);

    expect(snapshot.runs).toHaveLength(0);
    // Reported, not swallowed: a mistyped `--runs` used to look exactly like a machine that had
    // never run an investigation.
    expect(snapshot.unreadable).toHaveLength(1);
    expect(snapshot.unreadable[0]?.path).toBe(missing);
  });
});

describe("artifact shapes", () => {
  test("reads the current shape, with impact and researchDone", async () => {
    const run = await readRun(join(FIXTURES, "01a0194c-b7c1-7000-8a3b-fe9d2b647919.json"));
    expect("issue" in run).toBe(false);
    if ("issue" in run) return;

    const summary = run.results[0]?.summary;
    expect(summary?.impact).toBe("confirmed-compromise");
    expect(summary?.researchDone?.length).toBeGreaterThan(0);
    expect(summary?.nextAction).toBeUndefined();
  });

  test("reads the legacy shape, with nextAction and neither of the newer fields", async () => {
    const run = await readRun(join(FIXTURES, "01a01916-dfe1-7000-956c-dd5b47423a90.json"));
    expect("issue" in run).toBe(false);
    if ("issue" in run) return;

    const summary = run.results[0]?.summary;
    expect(summary?.nextAction).toBeDefined();
    expect(summary?.impact).toBeUndefined();
    expect(summary?.researchDone).toBeUndefined();
    // Read field by field, so an artifact that carried both would still be read correctly.
    expect(summary?.tpPercent).toBe(99);
  });

  test("reads a failed result and the sweep lifecycle fields", async () => {
    const run = await readRun(join(FIXTURES, "failed-run.json"));
    expect("issue" in run).toBe(false);
    if ("issue" in run) return;

    expect(run.status).toBe("interrupted");
    expect(run.alertCount).toBe(3);
    const result = run.results[0];
    expect(result?.status).toBe("failed");
    expect(result?.summary).toBeUndefined();
    expect(result?.error?.name).toBe("InvestigationStepLimitError");
  });

  test("names the file and the problem when one will not parse", async () => {
    const run = await readRun(join(FIXTURES, "corrupt.json"));
    expect("issue" in run).toBe(true);
    if (!("issue" in run)) return;
    expect(run.issue.length).toBeGreaterThan(0);
  });
});
