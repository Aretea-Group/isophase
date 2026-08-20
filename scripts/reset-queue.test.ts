import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseArgs, resetQueue, within } from "./reset-queue.ts";

/**
 * The reset command's two dangerous parts: what it selects, and where it is allowed to point.
 *
 * A reset command that can be pointed at an arbitrary directory is a delete command, so `within`
 * gets the same hostile-input treatment as the feedback path helper (PRD-5 §11, §14).
 */

describe("queue:reset — argument parsing", () => {
  test("requires a selection", () => {
    expect(() => parseArgs([])).toThrow("Nothing selected");
  });

  test("--all is guarded by --yes", () => {
    expect(() => parseArgs(["--all"])).toThrow("--yes");
    expect(parseArgs(["--all", "--yes"]).all).toBe(true);
    // A dry run changes nothing, so it needs no confirmation.
    expect(parseArgs(["--all", "--dry-run"]).all).toBe(true);
  });

  test("--restore and --purge cannot be combined", () => {
    expect(() => parseArgs(["--run", "r1", "--restore", "--purge"])).toThrow("mutually exclusive");
  });

  test("collects repeated selectors", () => {
    const args = parseArgs(["--alert", "a1", "--alert", "a2", "--run", "r1", "--include-feedback"]);
    expect(args.alertIds).toEqual(["a1", "a2"]);
    expect(args.runIds).toEqual(["r1"]);
    expect(args.includeFeedback).toBe(true);
  });

  test("a flag missing its value is an error, not a silent skip", () => {
    expect(() => parseArgs(["--alert"])).toThrow("requires a value");
    expect(() => parseArgs(["--alert", "--run"])).toThrow("requires a value");
  });

  test("an unknown option is an error", () => {
    expect(() => parseArgs(["--nope"])).toThrow('Unknown option "--nope"');
  });
});

describe("queue:reset — explicit feedback inclusion", () => {
  test("leaves feedback alone by default and moves it only with --include-feedback", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "queue-reset-feedback-"));
    const runsDir = join(scratch, "runs");
    const tracesDir = join(runsDir, "traces");
    const feedbackDir = join(scratch, "feedback");
    const runId = "run-1";
    const alertId = "alert-1";
    const runPath = join(runsDir, `${runId}.json`);
    const feedbackPath = join(feedbackDir, `${runId}-${alertId}.json`);

    try {
      await Bun.write(
        runPath,
        JSON.stringify({ runId, results: [{ alertId }], plannedAlerts: [] }),
      );
      await Bun.write(
        feedbackPath,
        JSON.stringify({
          schemaVersion: 1,
          runId,
          alertId,
          at: "2026-08-20T00:00:00.000Z",
          classification: "TruePositive",
          agentAssessment: {},
        }),
      );

      const base = {
        ...parseArgs(["--run", runId]),
        runsDir,
        tracesDir,
        feedbackDir,
      };
      await resetQueue(base, () => undefined);
      expect(await Bun.file(feedbackPath).exists()).toBe(true);

      await resetQueue({ ...base, restore: true }, () => undefined);
      await resetQueue({ ...base, includeFeedback: true }, () => undefined);
      expect(await Bun.file(feedbackPath).exists()).toBe(false);
      expect(
        await Bun.file(join(feedbackDir, ".archive", `${runId}-${alertId}.json`)).exists(),
      ).toBe(true);

      await resetQueue({ ...base, restore: true, includeFeedback: true }, () => undefined);
      expect(await Bun.file(feedbackPath).exists()).toBe(true);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

describe("queue:reset — path containment", () => {
  test("resolves inside its root", () => {
    expect(within("runs", "a.json")).toBe(`${process.cwd()}/runs/a.json`);
    expect(within("runs", ".archive", "a.json")).toBe(`${process.cwd()}/runs/.archive/a.json`);
  });

  test("refuses to escape its root", () => {
    expect(() => within("runs", "../etc/passwd")).toThrow("Refusing");
    expect(() => within("runs", "..", "..", "x")).toThrow("Refusing");
    expect(() => within("runs", "a/../../b")).toThrow("Refusing");
  });

  test("an absolute segment is contained rather than honoured", () => {
    // `join` folds a leading slash into the root, so this lands *inside* runs/ rather than at the
    // filesystem root. Containment is the property that matters, and it is worth asserting
    // explicitly: a reader could reasonably expect this to throw, and a future switch to `resolve`
    // in place of `join` would silently turn it into a real escape.
    expect(within("runs", "/etc/passwd")).toBe(`${process.cwd()}/runs/etc/passwd`);
  });
});
