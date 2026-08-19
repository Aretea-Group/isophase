import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestRenderer } from "@opentui/core/testing";

import { env } from "../src/env.ts";
import { runApp } from "../src/ui/app.ts";

let available = true;
try {
  const probe = await createTestRenderer({ width: 20, height: 5 });
  probe.renderer.destroy();
} catch {
  available = false;
}

const when = available ? describe : describe.skip;

const RUN_ID = "01a0195f-1111-7000-1111-000000000001";
const ALERT_ID = "bbbbbbbb-1111-1111-1111-111111111111";

function artifact(status: string, results: unknown[]): string {
  return JSON.stringify(
    {
      runId: RUN_ID,
      startedAt: "2026-08-19T10:00:00.000Z",
      completedAt: new Date().toISOString(),
      status,
      alertCount: 2,
      model: { provider: "openai", id: "gpt-5.6-terra" },
      limits: { maxTurns: 50, timeoutMs: 600_000 },
      results,
    },
    undefined,
    2,
  );
}

const finishedResult = {
  alertId: ALERT_ID,
  alertTitle: "Live sweep alert",
  status: "completed",
  startedAt: "2026-08-19T10:00:00.000Z",
  completedAt: "2026-08-19T10:00:30.000Z",
  durationMs: 30_000,
  summary: {
    tpPercent: 77,
    tpReason: "reason tp",
    fpPercent: 23,
    fpReason: "reason fp",
    whatHappened: "something happened",
    impact: "contained",
    keyEvidence: ["evidence one"],
    researchDone: ["looked here"],
  },
};

/**
 * The live path, end to end, against the real pollers.
 *
 * PRD-3 §10.2 is the one behaviour that cannot be checked by indexing a file on disk: it only
 * exists while something else is writing. This drives the artifact and transcript exactly as the
 * investigator does — artifact first, results appended, transcript grown — and watches the panes
 * follow without a restart.
 */
when("following a run in progress", () => {
  test("picks up a sweep, its finished alerts and its growing transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "console-live-"));
    const runsDir = join(root, "runs");
    const tracesDir = join(root, "traces");
    const tracePath = join(tracesDir, `${RUN_ID}-${ALERT_ID}.jsonl`);
    const artifactPath = join(runsDir, `${RUN_ID}.json`);

    const setup = await createTestRenderer({ width: 120, height: 32 });
    const settle = async (ms: number) => {
      await Bun.sleep(ms);
      await setup.renderOnce();
    };

    try {
      // 1. The investigator writes the artifact before its first alert finishes.
      await Bun.write(artifactPath, artifact("running", []));

      const app = await runApp({
        runsDir,
        tracesDir,
        env,
        renderer: setup.renderer,
        exit: () => undefined,
      });
      await app.ready;
      await setup.renderOnce();

      // In flight, with nothing finished yet: shown as running, and honest about what is left.
      expect(setup.captureCharFrame()).toContain("●");
      expect(setup.captureCharFrame()).toContain("2 alerts pending");

      // 2. One alert finishes and the artifact is flushed again.
      await Bun.write(artifactPath, artifact("running", [finishedResult]));
      await settle(1_400);
      expect(setup.captureCharFrame()).toContain("Live sweep alert");
      expect(setup.captureCharFrame()).toContain("TP  77");
      expect(setup.captureCharFrame()).toContain("1 alert pending");
      expect(setup.captureCharFrame()).toContain("[1] Alert");

      // 3. Its transcript starts arriving. The console must follow it without a restart.
      await Bun.write(
        tracePath,
        [
          JSON.stringify({ at: "2026-08-19T10:00:01.000Z", type: "agent_start" }),
          JSON.stringify({ at: "2026-08-19T10:00:01.000Z", type: "turn_start" }),
          "",
        ].join("\n"),
      );
      await settle(1_400);

      // verdict -> activity -> transcript -> stream
      setup.mockInput.pressKey("4");
      setup.mockInput.pressKey("]");
      setup.mockInput.pressKey("]");
      setup.mockInput.pressKey("]");
      await settle(300);
      expect(setup.captureCharFrame()).toContain("agent start");

      // 4. A tool call lands, mid-file, exactly as appendFileSync would leave it.
      const appended = [
        JSON.stringify({
          at: "2026-08-19T10:00:02.000Z",
          type: "tool_execution_start",
          toolCallId: "call_live_1",
          toolName: "query_security_data",
          args: { kql: "SecurityEvent | take 1" },
        }),
        JSON.stringify({
          at: "2026-08-19T10:00:03.000Z",
          type: "tool_execution_end",
          toolCallId: "call_live_1",
          toolName: "query_security_data",
          isError: false,
          result: { content: [{ type: "text", text: "rows" }] },
        }),
        "",
      ].join("\n");
      await Bun.write(tracePath, (await Bun.file(tracePath).text()) + appended);
      await settle(1_400);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("query_security_data");
      expect(frame).toContain("SecurityEvent");

      app.stop();
    } finally {
      setup.renderer.destroy();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
