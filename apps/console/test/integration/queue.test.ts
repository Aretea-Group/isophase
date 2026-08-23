import { describe, expect, test } from "bun:test";

import { createTestRenderer } from "@opentui/core/testing";
import { createSentinelSourceBundle, InProcessControl } from "@soc/investigator/control";

import { env } from "../../src/env.ts";
import { runApp } from "../../src/ui/app.ts";

/**
 * The console driving the real thing (PRD-5 §7, §8).
 *
 * Probes for Mock Sentinel and skips itself with a printed reason when it is absent, as every other
 * integration suite here does — `bun test` stays green without Docker and proves nothing about
 * this. To actually exercise it:
 *
 *   bun run infra:up && bun run data:bootstrap && bun run dev:mock-sentinel
 *
 * It deliberately does **not** start an investigation. That calls a paid provider, and a test suite
 * is not a place to spend money; the start path is covered by `render.test.ts` against an injected
 * fake control. What this proves is the half that needs the live corpus: that the queue fetches,
 * folds against `runs/`, and marks the alerts that have ground truth behind them.
 */

const BASE_URL = env.SENTINEL_BASE_URL;

const reachable = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2_000) })
  .then((response) => response.ok)
  .catch(() => false);

if (!reachable) {
  console.info(`[skip] console queue integration — no Mock Sentinel at ${BASE_URL}`);
}

describe.skipIf(!reachable)("the alert queue against a live Mock Sentinel", () => {
  test("fetches the corpus, folds coverage, and marks ground truth", async () => {
    const control = new InProcessControl({
      config: {
        provider: env.INVESTIGATOR_PROVIDER,
        modelId: env.INVESTIGATOR_MODEL,
        maxTurns: env.INVESTIGATOR_MAX_TURNS,
        timeoutMs: env.INVESTIGATOR_TIMEOUT_MS,
        resultMaxChars: env.INVESTIGATOR_RESULT_MAX_CHARS,
        webSearchConfigured: false,
        runsDir: env.RUNS_DIR,
        trace: false,
        traceDir: env.INVESTIGATOR_TRACE_DIR,
        traceStream: false,
      },
      deps: {
        source: createSentinelSourceBundle({ connector: "mock", baseUrl: BASE_URL }),
      },
    });

    const alerts = await control.listAlerts();
    // The corpus is generated from pinned telemetry, so this is a floor rather than an equality —
    // PRD-4 added rules, and a later PRD may add more.
    expect(alerts.length).toBeGreaterThan(100);

    const setup = await createTestRenderer({ width: 140, height: 40 });
    const app = await runApp({
      runsDir: env.RUNS_DIR,
      tracesDir: env.INVESTIGATOR_TRACE_DIR,
      env,
      renderer: setup.renderer,
      exit: () => undefined,
      control,
    });
    await app.ready;

    // The fetch is async and deliberately not awaited by `ready` — the console must open before the
    // corpus arrives, since it opens fine with no Sentinel at all.
    // Sequential by nature: this is polling for a condition, which is the one shape `Promise.all`
    // cannot express.
    /* eslint-disable no-await-in-loop */
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await setup.renderOnce();
      // Wait for rows, not for the pane title — the title is present from the first frame, so
      // breaking on it means never waiting at all.
      if (!setup.captureCharFrame().includes("press r to load alerts")) break;
      await Bun.sleep(50);
    }
    /* eslint-enable no-await-in-loop */
    await setup.renderOnce();

    const frame = setup.captureCharFrame();
    expect(frame).toContain("[1] Alerts");
    // No degraded banner: Sentinel is up, so the pane holds rows rather than a reason it cannot.
    expect(frame).not.toContain("not reachable");
    expect(frame).not.toContain("press r to load alerts");

    // `s` narrows to the alerts that have ground truth behind them — the loop this PRD exists for.
    setup.mockInput.pressKey("s");
    await setup.renderOnce();
    const filtered = setup.captureCharFrame();
    // The title carries the scope compactly: `[1] Alerts ◆ outstanding (n/m)`.
    expect(filtered).toContain("[1] Alerts ◆");
    expect(filtered).toContain("◆");

    /**
     * The marker says an answer exists; it must never say what the answer is.
     *
     * Checked as "no scenario id appears in the queue pane", not as a substring sweep of the whole
     * frame: words like "backdoor" legitimately occur in an alert's own display name — the corpus
     * really does contain an account called `backdoor-svc` — and pane [4] renders the agent's
     * prose. Only the *id* is the leak, because most ids encode the verdict outright.
     */
    const queuePane = filtered
      .split("\n")
      .map((line) => line.slice(0, 46))
      .join("\n");
    const ids = (await Bun.file(env.BENCHMARK_MAP_PATH).json()) as { scenarioId: string }[];
    expect(ids.length).toBeGreaterThan(0);
    const leaked = ids.map((entry) => entry.scenarioId).filter((id) => queuePane.includes(id));
    expect(leaked).toEqual([]);

    app.stop();
    setup.renderer.destroy();
  }, 20_000);
});
