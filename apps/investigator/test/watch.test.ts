import { describe, expect, test } from "bun:test";

import type { SecurityAlert } from "@soc/contracts";

import type { InvestigationRun } from "../src/contracts/run.ts";
import type { ControlEvent, InvestigationControl, StartRequest } from "../src/control.ts";
import {
  assertWatchWindow,
  runWatch,
  WatchConfigurationError,
  type WatchOptions,
} from "../src/watch.ts";

/**
 * PRD-10 Phase 3 — the unattended loop.
 *
 * Every dependency is injected, so these run without a clock, a source or a model: `sleep` is a
 * no-op, `control` is a stub, and `maxCycles` bounds a loop that otherwise never returns.
 */

const OPTIONS: WatchOptions = {
  pollIntervalMs: 60_000,
  alertWindow: "PT1H",
  windowIntervalRatio: 3,
  maxFailuresPerAlert: 2,
  skipStatuses: new Set(),
  listLimit: 500,
  // Well inside PT1H ÷ 3, so the window invariant passes and the backoff tests below can move it.
  backoffMaxMs: 60_000,
  maxCycles: 1,
};

function alert(id: string, status = "new"): SecurityAlert {
  return {
    id,
    title: `alert ${id}`,
    description: "d",
    status,
    tactics: [],
    techniques: [],
    entities: [],
    native: { id },
  };
}

function completedRun(runId: string, alertId: string, costUsd: number): InvestigationRun {
  return {
    runId,
    startedAt: "2026-09-16T00:00:00.000Z",
    completedAt: "2026-09-16T00:01:00.000Z",
    alertCount: 1,
    model: { provider: "openai", id: "faux" },
    limits: { maxTurns: 10, timeoutMs: 1000 },
    results: [
      {
        alertId,
        alertTitle: `alert ${alertId}`,
        status: "completed",
        startedAt: "2026-09-16T00:00:00.000Z",
        completedAt: "2026-09-16T00:01:00.000Z",
        durationMs: 60_000,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          costUsd,
        },
      },
    ],
  } as InvestigationRun;
}

/** A control whose first `n` polls throw, then behaves normally. */
function failingControl(
  failures: number,
  error: unknown,
  alerts: SecurityAlert[] = [alert("a1")],
): { control: Parameters<typeof runWatch>[1]["control"]; pollCount: () => number } {
  const base = stubControl(alerts, completes());
  let polls = 0;
  const control = {
    ...base.control,
    listAlerts: () => {
      polls += 1;
      return polls <= failures ? Promise.reject(error) : Promise.resolve(alerts);
    },
  } as Parameters<typeof runWatch>[1]["control"];
  return { control, pollCount: () => polls };
}

/** A control that completes every run it is given, at a fixed cost, and records what it started. */
function stubControl(
  alerts: SecurityAlert[],
  outcome: (alertId: string) => ControlEvent,
): { control: Parameters<typeof runWatch>[1]["control"]; started: string[] } {
  const listeners: ((event: ControlEvent) => void)[] = [];
  const started: string[] = [];
  return {
    started,
    control: {
      listAlerts: () => Promise.resolve(alerts),
      subscribe: (listener) => {
        listeners.push(listener);
        return () => listeners.splice(listeners.indexOf(listener), 1);
      },
      start: (request: StartRequest) => {
        started.push(request.alertId);
        const event = outcome(request.alertId);
        // A copy, because a listener may unsubscribe while this is iterating.
        const current = listeners.slice();
        for (const listener of current) listener(event);
        return { runId: request.runId, settled: Promise.resolve() };
      },
      shutdown: () => undefined,
    } as Pick<InvestigationControl, "listAlerts" | "start" | "subscribe" | "shutdown">,
  };
}

function completes(costUsd = 0): (alertId: string) => ControlEvent {
  return (alertId) => ({
    type: "run_completed",
    runId: `run-${alertId}`,
    alertId,
    run: completedRun(`run-${alertId}`, alertId, costUsd),
  });
}

function fails(alertId: string): ControlEvent {
  return {
    type: "run_failed",
    runId: `run-${alertId}`,
    alertId,
    error: { name: "Error", message: "boom" },
  };
}

function deps(control: Parameters<typeof runWatch>[1]["control"], seen: string[] = []) {
  const logs: string[] = [];
  return {
    logs,
    deps: {
      control,
      seenAlertIds: new Set(seen),
      sleep: () => Promise.resolve(),
      log: (message: string) => logs.push(message),
    },
  };
}

describe("the unattended loop (PRD-10 §4.2)", () => {
  test("AC7 — Given n alerts and no runs, When one sweep completes, Then exactly n runs exist, one per alert", async () => {
    const alerts = [alert("a1"), alert("a2"), alert("a3")];
    const { control, started } = stubControl(alerts, completes());
    const { deps: d } = deps(control);

    const [report] = await runWatch(OPTIONS, d);

    expect(started).toEqual(["a1", "a2", "a3"]);
    expect(new Set(started).size).toBe(3);
    expect(report?.started).toEqual(["a1", "a2", "a3"]);
  });

  test("AC8 — Given an alert that already has a run artifact, When the loop polls, Then it is not investigated again", async () => {
    const alerts = [alert("a1"), alert("a2")];
    const { control, started } = stubControl(alerts, completes());
    const { deps: d } = deps(control, ["a1"]);

    const [report] = await runWatch(OPTIONS, d);

    expect(started).toEqual(["a2"]);
    expect(report?.skippedAlreadyRun).toBe(1);
  });

  test("AC8 — across cycles, a completed alert is not started twice", async () => {
    const alerts = [alert("a1")];
    const { control, started } = stubControl(alerts, completes());
    const { deps: d } = deps(control);

    await runWatch({ ...OPTIONS, maxCycles: 3 }, d);

    expect(started).toEqual(["a1"]);
  });

  test("AC9 — Given the spend ceiling is reached mid-sweep, When the loop considers the next alert, Then it halts and reports", async () => {
    const alerts = [alert("a1"), alert("a2"), alert("a3")];
    const { control, started } = stubControl(alerts, completes(0.4));
    const { deps: d, logs } = deps(control);

    const [report] = await runWatch({ ...OPTIONS, spendCeilingUsd: 0.5 }, d);

    // a1 costs 0.4 (under), a2 pushes to 0.8 (over), so a3 is never started.
    expect(started).toEqual(["a1", "a2"]);
    expect(report?.haltedOnSpend).toBe(true);
    expect(logs.some((line) => line.includes("spend ceiling reached"))).toBe(true);
  });

  test("AC10 — Given an alert that keeps failing, When it reaches the limit, Then it is parked, named, and not retried", async () => {
    const alerts = [alert("a1")];
    const { control, started } = stubControl(alerts, fails);
    const { deps: d, logs } = deps(control);

    const reports = await runWatch({ ...OPTIONS, maxCycles: 5 }, d);

    // Each failure removes the claim, so it is retried until the limit parks it: two attempts.
    expect(started).toEqual(["a1", "a1"]);
    expect(logs.some((line) => line.includes("parked a1"))).toBe(true);
    expect(reports.at(-1)?.skippedParked).toBe(1);
  });

  test("a transient poll failure backs off, reports why, and the next cycle succeeds", async () => {
    // ADR 013 §11. Before this, `listAlerts()` was bare and one Graph hiccup ended the daemon.
    const flaky = failingControl(
      1,
      Object.assign(new Error("socket hang up"), {
        code: "unreachable",
        status: 0,
      }),
    );
    const { deps: d, logs } = deps(flaky.control);

    const reports = await runWatch({ ...OPTIONS, maxCycles: 2 }, d);

    expect(flaky.pollCount()).toBe(2);
    expect(reports[0]?.backoffMs).toBeGreaterThan(0);
    expect(logs.some((line) => line.includes("backoff entered — transient"))).toBe(true);
    expect(logs.some((line) => line.includes("backoff left"))).toBe(true);
    // The recovered cycle did real work rather than just surviving.
    expect(reports.at(-1)?.started).toEqual(["a1"]);
  });

  test("a throttled poll waits the full ceiling rather than a short exponential step", async () => {
    // Graph's hunting quota resets on a documented 15-minute cycle, so a shorter wait spends a
    // request that cannot succeed against an allowance that is already exhausted.
    const throttled = failingControl(
      1,
      Object.assign(new Error("too many requests"), {
        code: "rate_limited",
        status: 429,
      }),
    );
    const { deps: d, logs } = deps(throttled.control);

    const reports = await runWatch({ ...OPTIONS, maxCycles: 2, backoffMaxMs: 60_000 }, d);

    expect(reports[0]?.backoffMs).toBe(60_000);
    expect(logs.some((line) => line.includes("backoff entered — throttled"))).toBe(true);
  });

  test("a permanent poll failure stops the loop instead of retrying it forever", async () => {
    // An expired secret does not heal. A loop that keeps polling through one looks alive while
    // doing nothing, which is worse than stopping because nobody investigates a healthy process.
    const denied = Object.assign(new Error("Forbidden"), {
      code: "authorization_error",
      status: 403,
    });
    const permanent = failingControl(99, denied);
    const { deps: d, logs } = deps(permanent.control);

    await expect(runWatch({ ...OPTIONS, maxCycles: 5 }, d)).rejects.toThrow("Forbidden");

    expect(permanent.pollCount()).toBe(1);
    expect(logs.some((line) => line.includes("stopping — the source rejected the poll"))).toBe(
      true,
    );
    expect(logs.some((line) => line.includes("defender-setup.md"))).toBe(true);
  });

  test("AC18 — a backoff ceiling wider than the window is refused, even when the interval alone is safe", () => {
    // The invariant guards the *effective* gap between polls. Checking the interval alone passed a
    // loop that was safe while healthy and lossy the moment it backed off.
    const safeInterval = { ...OPTIONS, pollIntervalMs: 60_000, alertWindow: "PT1H" };
    expect(() => assertWatchWindow(safeInterval)).not.toThrow();

    const wideBackoff = { ...safeInterval, backoffMaxMs: 30 * 60_000 };
    expect(() => assertWatchWindow(wideBackoff)).toThrow(WatchConfigurationError);
    expect(() => assertWatchWindow(wideBackoff)).toThrow("backoff ceiling");
  });

  test("AC18 — Given a window shorter than k poll intervals, When the loop starts, Then it refuses and names both values", () => {
    const attempt = (): void =>
      assertWatchWindow({ ...OPTIONS, alertWindow: "PT1M", pollIntervalMs: 60_000 });

    expect(attempt).toThrow(WatchConfigurationError);
    expect(attempt).toThrow("PT1M");
    expect(attempt).toThrow("60000 ms");
  });

  test("AC18 — a window that clears the ratio starts", () => {
    expect(() => assertWatchWindow(OPTIONS)).not.toThrow();
  });

  test("AC19 — Given a source returning the requested cap, When a cycle completes, Then truncation is reported", async () => {
    const alerts = [alert("a1"), alert("a2")];
    const { control } = stubControl(alerts, completes());
    const { deps: d, logs } = deps(control);

    const [report] = await runWatch({ ...OPTIONS, listLimit: 2 }, d);

    expect(report?.truncated).toBe(true);
    expect(logs.some((line) => line.includes("which is the requested cap of 2"))).toBe(true);
  });

  test("AC19 — under the cap, nothing is reported", async () => {
    const { control } = stubControl([alert("a1")], completes());
    const { deps: d, logs } = deps(control);

    const [report] = await runWatch({ ...OPTIONS, listLimit: 500 }, d);

    expect(report?.truncated).toBe(false);
    expect(logs.some((line) => line.includes("requested cap"))).toBe(false);
  });

  test("AC20 — Given WATCH_SKIP_STATUSES names a status, Then alerts carrying it are skipped; Given it is empty, Then none are", async () => {
    const alerts = [alert("a1", "new"), alert("a2", "resolved")];

    const filtered = stubControl(alerts, completes());
    const [withSkip] = await runWatch(
      { ...OPTIONS, skipStatuses: new Set(["resolved"]) },
      deps(filtered.control).deps,
    );
    expect(filtered.started).toEqual(["a1"]);
    expect(withSkip?.skippedByStatus).toBe(1);

    const unfiltered = stubControl(alerts, completes());
    const [withoutSkip] = await runWatch(OPTIONS, deps(unfiltered.control).deps);
    expect(unfiltered.started).toEqual(["a1", "a2"]);
    expect(withoutSkip?.skippedByStatus).toBe(0);
  });

  test("AC21 — Given an investigated alert whose status has since changed, When the loop polls, Then it is not investigated again", async () => {
    // The same alert id, now carrying a different vendor status — re-opened, reassigned, whatever
    // the product calls it. D11: the loop acts on creation only, so nothing re-triggers.
    const { control, started } = stubControl([alert("a1", "resolved")], completes());
    const { deps: d } = deps(control, ["a1"]);

    const [report] = await runWatch(OPTIONS, d);

    expect(started).toEqual([]);
    expect(report?.skippedAlreadyRun).toBe(1);
  });

  test("AC23 — Given a first cycle, When it completes, Then the distinct status values are reported", async () => {
    const alerts = [alert("a1", "new"), alert("a2", "resolved"), alert("a3", "new")];
    const { control } = stubControl(alerts, completes());
    const { deps: d, logs } = deps(control);

    const [report] = await runWatch(OPTIONS, d);

    expect(report?.statusValues).toEqual(["new", "resolved"]);
    expect(
      logs.some((line) => line.includes("alert status values in this source: new, resolved")),
    ).toBe(true);
  });

  test("AC11 — Given runs in flight, When the signal aborts, Then the control is shut down so they are cancelled", async () => {
    const controller = new AbortController();
    let shutdowns = 0;
    const { control, started } = stubControl([alert("a1"), alert("a2")], (alertId) => {
      controller.abort();
      return completes()(alertId);
    });
    const withShutdown = { ...control, shutdown: () => void (shutdowns += 1) };
    const { deps: base, logs } = deps(withShutdown);

    await runWatch({ ...OPTIONS, maxCycles: 5 }, { ...base, signal: controller.signal });

    // Breaking the loop stops it starting more; only `shutdown` stops what is already running.
    // `executeRun` then records those as `interrupted` — proven in execute-run.test.ts.
    expect(started).toEqual(["a1"]);
    expect(shutdowns).toBe(1);
    expect(logs.some((line) => line.includes("cancelling investigations still in flight"))).toBe(
      true,
    );
  });

  test("a loop that finishes its cycles normally does not shut the control down", async () => {
    let shutdowns = 0;
    const { control } = stubControl([alert("a1")], completes());
    const withShutdown = { ...control, shutdown: () => void (shutdowns += 1) };

    await runWatch(OPTIONS, deps(withShutdown).deps);

    expect(shutdowns).toBe(0);
  });

  test("an aborted signal stops the loop without starting the next alert", async () => {
    const controller = new AbortController();
    const alerts = [alert("a1"), alert("a2")];
    const { control, started } = stubControl(alerts, (alertId) => {
      controller.abort();
      return completes()(alertId);
    });
    const { deps: base } = deps(control);

    await runWatch({ ...OPTIONS, maxCycles: 5 }, { ...base, signal: controller.signal });

    expect(started).toEqual(["a1"]);
  });
});
