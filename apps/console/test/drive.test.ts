import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestRenderer } from "@opentui/core/testing";
import type { SecurityAlertResource } from "@soc/contracts";
import type {
  ControlEvent,
  InvestigationControl,
  LiveRun,
  StartRequest,
} from "@soc/investigator/control";

import { env } from "../src/env.ts";
import { COMPOSE_TAB_STOP_PROPAGATION_EXCEPTIONS, runApp } from "../src/ui/app.ts";

/**
 * The four flows, driven by actual keypresses (PRD-5 §8–§10, §12).
 *
 * Everything here goes through `onKey`, because that is where the console's real behaviour lives
 * and where a mistake is invisible until someone is holding the keyboard. The control is a fake:
 * `n` on a real one calls a paid provider, and a test suite is not a place to spend money.
 */

const ALERT_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const ALERT_TITLE = "Brute force against SOC-FW-RDP";

function alertResource(): SecurityAlertResource {
  return {
    id: `/x/${ALERT_ID}`,
    name: ALERT_ID,
    type: "Microsoft.SecurityInsights/Entities",
    kind: "SecurityAlert",
    properties: {
      systemAlertId: ALERT_ID,
      alertDisplayName: ALERT_TITLE,
      description: "d",
      severity: "High",
      status: "New",
      startTimeUtc: "2026-08-01T00:00:00.000Z",
      endTimeUtc: "2026-08-01T00:10:00.000Z",
      timeGenerated: "2026-08-01T00:10:00.000Z",
      vendorName: "Microsoft",
      productName: "Azure Sentinel",
      alertType: "Test",
      tactics: ["CredentialAccess", "Persistence"],
      techniques: ["T1110", "T1098"],
      entities: [
        { type: "host", hostName: "server-01" },
        { type: "account", name: "analyst@example.test" },
        { type: "ip", address: "192.0.2.10" },
      ],
      additionalData: { source: "integration-test", action: "allowed" },
    },
  } as unknown as SecurityAlertResource;
}

/** Records what the console asked for, and lets a test push events back. */
function fakeControl(): InvestigationControl & {
  started: StartRequest[];
  cancelled: string[];
  emit: (event: ControlEvent) => void;
} {
  const listeners = new Set<(event: ControlEvent) => void>();
  const started: StartRequest[] = [];
  const cancelled: string[] = [];
  const running: LiveRun[] = [];

  return {
    started,
    cancelled,
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    listAlerts: () => Promise.resolve([alertResource()]),
    listTools: () => ["get_security_schema", "query_security_data", "submit_investigation"],
    listModels: () =>
      Promise.resolve([
        { provider: "openai", id: "gpt-5.6-luna" },
        { provider: "openai", id: "gpt-5.6-terra" },
      ]),
    start: (request) => {
      started.push(request);
      running.push({
        runId: request.runId,
        alertId: request.alertId,
        startedAt: new Date().toISOString(),
      });
      return { runId: request.runId, settled: Promise.resolve() };
    },
    cancel: (runId) => {
      cancelled.push(runId);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    live: () => [...running],
    shutdown: () => undefined,
  };
}

let scratch: string | undefined;

async function mount(height = 34) {
  scratch = await mkdtemp(join(tmpdir(), "console-drive-"));
  const runsDir = join(scratch, "runs");
  const control = fakeControl();
  const setup = await createTestRenderer({ width: 130, height });
  const app = await runApp({
    runsDir,
    tracesDir: join(scratch, "traces"),
    env: { ...env, FEEDBACK_DIR: join(scratch, "feedback") },
    renderer: setup.renderer,
    exit: () => undefined,
    control,
  });
  await app.ready;

  // The alert fetch is async and deliberately not awaited by `ready`.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- polling for a condition
    await setup.renderOnce();
    if (!setup.captureCharFrame().includes("press R to load alerts")) break;
    // eslint-disable-next-line no-await-in-loop -- polling for a condition
    await Bun.sleep(20);
  }
  return { setup, app, control, frame: () => setup.captureCharFrame() };
}

/**
 * Confirm an overlay whose focus is still on the strip, which is where it opens.
 *
 * Two keystrokes, and that is the point: starting the selected alert on the configured model is
 * the common case, and it must not cost a walk through every optional field.
 */
async function confirmOverlay(setup: Awaited<ReturnType<typeof mount>>["setup"]): Promise<void> {
  setup.mockInput.pressArrow("right");
  await setup.renderOnce();
  setup.mockInput.pressEnter();
  await setup.renderOnce();
}

/**
 * Put focus on field `index`, counting from the strip the overlay opens on.
 *
 * `⇥` from the strip reaches field 0, so this is `index + 1` presses. Expressed relative to the
 * strip rather than as a literal key count so that a test reads as "focus the model row" instead
 * of as an arithmetic claim about the form's shape.
 */
async function toField(
  setup: Awaited<ReturnType<typeof mount>>["setup"],
  index: number,
): Promise<void> {
  for (let at = 0; at <= index; at += 1) {
    setup.mockInput.pressTab();
    // eslint-disable-next-line no-await-in-loop -- one frame per keystroke, as the analyst types
    await setup.renderOnce();
  }
}

afterEach(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe("starting an investigation with `n` (PRD-5 §8)", () => {
  test("opens a confirm overlay that names the alert, the model and the cost", async () => {
    const { setup, app, frame } = await mount();
    setup.mockInput.pressKey("n");
    await setup.renderOnce();

    const output = frame();
    expect(output).toContain("Start an investigation");
    expect(output).toContain(ALERT_TITLE);
    // The analyst is about to spend money and should be told so before confirming.
    expect(output).toContain("paid provider");
    expect(output).toContain(env.INVESTIGATOR_MODEL);
    app.stop();
    setup.renderer.destroy();
  });

  test("defaults to Cancel, so ⏎ alone starts nothing", async () => {
    // A modal dismissed by whatever key the analyst was already holding is theatre (§12.4).
    const { setup, app, control } = await mount();
    setup.mockInput.pressKey("n");
    await setup.renderOnce();
    setup.mockInput.pressEnter();
    await setup.renderOnce();

    expect(control.started).toEqual([]);
    app.stop();
    setup.renderer.destroy();
  });

  test("→ then ⏎ starts exactly one run, for the selected alert", async () => {
    const { setup, app, control, frame } = await mount();
    setup.mockInput.pressKey("n");
    await setup.renderOnce();
    await confirmOverlay(setup);

    expect(control.started).toHaveLength(1);
    expect(control.started[0]?.alertId).toBe(ALERT_ID);
    // The durable status line must actually reach the screen. It was set in five places and
    // rendered in none, so every one of those messages was silently discarded.
    expect(frame()).toContain("started");
    // A caller-supplied id, which is what lets the console find the artifact and route a cancel.
    expect(control.started[0]?.runId).toBeTruthy();
    // The overlay closes on confirm rather than lingering over the run it just started.
    expect(frame()).not.toContain("Start an investigation");
    app.stop();
    setup.renderer.destroy();
  });
});

describe("a started alert leaves the queue (PRD-5 §7)", () => {
  test("moves from [1] to [2] once a run exists, and `a` brings it back into view", async () => {
    const { setup, app, frame } = await mount();
    expect(frame()).toContain(ALERT_TITLE.slice(0, 18));

    setup.mockInput.pressKey("n");
    await setup.renderOnce();
    await confirmOverlay(setup);

    // The alert is now the run's business. Keeping it in the queue asks the analyst to track one
    // item in two panes.
    // Only the rows inside [1], not its header — the pane border carries no alert text, but the
    // [4] title does, and this is a claim about the queue's contents.
    const queueRowText = (): string =>
      frame()
        .split("\n")
        .filter((line) => line.startsWith("│"))
        .map((line) => line.slice(0, 46))
        .join("\n");
    expect(queueRowText()).not.toContain(ALERT_TITLE.slice(0, 18));
    expect(frame()).toContain("[2] Runs");

    // `a` is the way back to it without resetting anything.
    setup.mockInput.pressKey("1");
    await setup.renderOnce();
    setup.mockInput.pressKey("a");
    await setup.renderOnce();
    expect(queueRowText()).toContain(ALERT_TITLE.slice(0, 18));

    app.stop();
    setup.renderer.destroy();
  });

  test("[4] shows the alert's own facts while the queue has focus", async () => {
    const { setup, app, frame } = await mount();
    const main = (): string =>
      frame()
        .split("\n")
        .map((line) => line.slice(46))
        .join("\n");

    // What the API says, parsed — not a run's verdict, which a queue alert does not have.
    expect(main()).toContain("Brute force against SOC-FW-RDP");
    expect(main()).toContain("n starts an investigation");
    // No verdict vocabulary: there is nothing to have a verdict about yet.
    expect(main()).not.toContain("TRUE POSITIVE");
    expect(main()).not.toContain("VERDICT  ·");

    app.stop();
    setup.renderer.destroy();
  });
});

describe("regressions found by using it", () => {
  test("j/k scroll the focused Case pane", async () => {
    const { setup, app, frame } = await mount(24);
    const casePane = (): string => {
      const lines = frame().split("\n");
      const start = lines.findIndex((line) => line.includes("[3] Case"));
      const end = lines.findIndex((line, index) => index > start && line.startsWith("╰"));
      return lines
        .slice(start, end === -1 ? undefined : end + 1)
        .map((line) => line.slice(0, 46))
        .join("\n");
    };

    setup.mockInput.pressKey("3");
    await setup.renderOnce();
    const top = casePane();

    setup.mockInput.pressKey("j");
    await setup.renderOnce();
    expect(casePane()).not.toBe(top);

    setup.mockInput.pressKey("k");
    await setup.renderOnce();
    expect(casePane()).toBe(top);

    app.stop();
    setup.renderer.destroy();
  });

  test("`4` focuses the main pane without changing what it is about", async () => {
    const { setup, app, frame } = await mount();
    const main = (): string =>
      frame()
        .split("\n")
        .map((line) => line.slice(46))
        .join("\n");

    // Reading an alert in [1], then pressing `4` to scroll it. The pane used to swap to the
    // selected run, so the analyst landed on a finished investigation they had not asked for.
    expect(main()).toContain(ALERT_TITLE);
    setup.mockInput.pressKey("4");
    await setup.renderOnce();
    expect(main()).toContain(ALERT_TITLE);
    expect(main()).not.toContain("VERDICT  ·");

    app.stop();
    setup.renderer.destroy();
  });

  test("the status line gives the key bar back", async () => {
    const { setup, app, frame } = await mount();
    setup.mockInput.pressKey("n");
    await setup.renderOnce();
    await confirmOverlay(setup);

    // `.at(-1)` is the empty string after the frame's trailing newline — the key bar is the line
    // before it. Reading the wrong one is why an earlier manual probe reported a blank status.
    const bar = (): string => frame().split("\n").at(-2) ?? "";
    expect(bar()).toContain("started");
    // The keys are gone while it shows, which is the whole reason it must expire.
    expect(bar()).not.toContain("q quit");
    app.stop();
    setup.renderer.destroy();
  });

  test("`n` offers context and a model, not just the defaults", async () => {
    const { setup, app, control, frame } = await mount();
    setup.mockInput.pressKey("n");
    await setup.renderOnce();
    expect(frame()).toContain("context");
    expect(frame()).toContain(env.INVESTIGATOR_MODEL);

    // Both fields are optional, so reaching them is deliberate: ⇥ off the strip onto `context`.
    await toField(setup, 0);
    await setup.mockInput.typeText("known maintenance window");
    await setup.renderOnce();
    setup.mockInput.pressTab();
    await setup.renderOnce();
    setup.mockInput.pressArrow("down");
    await setup.renderOnce();
    setup.mockInput.pressTab();
    await setup.renderOnce();
    await confirmOverlay(setup);

    // The first investigation of an alert can be steered and re-pointed without running it once
    // with the defaults first.
    expect(control.started).toHaveLength(1);
    expect(control.started[0]?.analystContext).toBe("known maintenance window");
    expect(control.started[0]?.model).toEqual({ provider: "openai", id: "gpt-5.6-terra" });
    // Only a re-run carries lineage.
    expect(control.started[0]?.derivedFrom).toBeUndefined();

    app.stop();
    setup.renderer.destroy();
  });
});

describe("each action belongs to one subject", () => {
  test("`f` from the queue refuses instead of filing against some other run", async () => {
    const { setup, app, frame } = await mount();
    // Start a run so there *is* something in [2] to mis-target, then go back to reading an alert.
    setup.mockInput.pressKey("n");
    await setup.renderOnce();
    await confirmOverlay(setup);
    setup.mockInput.pressKey("1");
    await setup.renderOnce();
    setup.mockInput.pressKey("a");
    await setup.renderOnce();

    setup.mockInput.pressKey("f");
    await setup.renderOnce();

    // It used to open the feedback overlay for the run selected in [2] — a verdict recorded
    // against an investigation the analyst was not looking at.
    expect(frame()).not.toContain("Your feedback");
    expect(frame().split("\n").at(-2) ?? "").toContain("select one in [2]");

    app.stop();
    setup.renderer.destroy();
  });

  test("`r` from the queue refuses the same way", async () => {
    const { setup, app, frame } = await mount();
    setup.mockInput.pressKey("n");
    await setup.renderOnce();
    await confirmOverlay(setup);
    setup.mockInput.pressKey("1");
    await setup.renderOnce();
    setup.mockInput.pressKey("a");
    await setup.renderOnce();

    setup.mockInput.pressKey("r");
    await setup.renderOnce();
    expect(frame()).not.toContain("Re-run —");
    expect(frame().split("\n").at(-2) ?? "").toContain("r re-runs");

    app.stop();
    setup.renderer.destroy();
  });

  test("`n` from the run list points at [1] rather than starting the queue's cursor", async () => {
    const { setup, app, control, frame } = await mount();
    setup.mockInput.pressKey("2");
    await setup.renderOnce();
    setup.mockInput.pressKey("n");
    await setup.renderOnce();

    expect(control.started).toEqual([]);
    expect(frame()).not.toContain("Start an investigation");
    expect(frame().split("\n").at(-2) ?? "").toContain("select one in [1]");

    app.stop();
    setup.renderer.destroy();
  });

  test("`f` refuses on an investigation that is still running", async () => {
    const { setup, app, frame } = await mount();
    setup.mockInput.pressKey("n");
    await setup.renderOnce();
    await confirmOverlay(setup);

    // The run is in flight: there is no verdict yet to agree or disagree with, and
    // `agentAssessment` would freeze an empty one.
    setup.mockInput.pressKey("f");
    await setup.renderOnce();
    expect(frame()).not.toContain("Your feedback");
    expect(frame().split("\n").at(-2) ?? "").toContain("still running");

    app.stop();
    setup.renderer.destroy();
  });
});

describe("the focus trap (PRD-5 §12.5)", () => {
  test("the exported Tab exceptions traverse forward and backward", async () => {
    expect(COMPOSE_TAB_STOP_PROPAGATION_EXCEPTIONS).toEqual(["tab", "shift+tab"]);
    const { setup, app, frame } = await mount();
    setup.mockInput.pressKey("n");
    await setup.renderOnce();

    // From the strip, Shift-Tab wraps backwards onto the model row — where the list is open,
    // because focus is what opens it.
    setup.mockInput.pressTab({ shift: true });
    await setup.renderOnce();
    setup.mockInput.pressArrow("down");
    await setup.renderOnce();
    expect(frame()).toContain("openai/gpt-5.6-terra");

    // Forward Tab returns to the confirmation strip, where Right selects Confirm.
    setup.mockInput.pressTab();
    await setup.renderOnce();
    await confirmOverlay(setup);
    expect(frame()).not.toContain("Start an investigation");

    app.stop();
    setup.renderer.destroy();
  });

  /**
   * The regression guard for the whole class.
   *
   * `set visible` blurs only the renderable it is called on, so a keymap guarded on renderer focus
   * stays true after the overlay is hidden: `q`, `1`-`4`, `j` and `k` never reach their handlers
   * again and every key is typed into an invisible buffer. `state.mode` is authoritative precisely
   * so this cannot happen — and this test is what proves it stayed that way.
   */
  test("after ⎋ closes the overlay, `q` still reaches the quit handler", async () => {
    const { setup, app } = await mount();
    let exited: number | undefined;
    // Re-mount with a capturing exit, since `mount` swallows it.
    app.stop();
    setup.renderer.destroy();

    const scratch2 = await mkdtemp(join(tmpdir(), "console-trap-"));
    const control = fakeControl();
    const setup2 = await createTestRenderer({ width: 130, height: 34 });
    const app2 = await runApp({
      runsDir: join(scratch2, "runs"),
      tracesDir: join(scratch2, "traces"),
      env,
      renderer: setup2.renderer,
      exit: (code) => {
        exited = code;
      },
      control,
    });
    await app2.ready;
    await setup2.renderOnce();

    setup2.mockInput.pressKey("n");
    await setup2.renderOnce();
    setup2.mockInput.pressEscape();
    await Bun.sleep(60);
    await setup2.renderOnce();
    expect(setup2.captureCharFrame()).not.toContain("Start an investigation");

    setup2.mockInput.pressKey("q");
    await setup2.renderOnce();
    expect(exited).toBe(0);

    app2.stop();
    setup2.renderer.destroy();
    await rm(scratch2, { recursive: true, force: true });
  });

  test("navigation keys still move the selection after the overlay closes", async () => {
    const { setup, app, frame } = await mount();
    setup.mockInput.pressKey("n");
    await setup.renderOnce();
    setup.mockInput.pressEscape();
    await Bun.sleep(60);
    await setup.renderOnce();

    // `2` must still reach the pane handler rather than being typed into a hidden field.
    setup.mockInput.pressKey("2");
    await setup.renderOnce();
    expect(frame()).toContain("[2] Runs");
    app.stop();
    setup.renderer.destroy();
  });
});

describe("re-running with `r` (PRD-5 §9)", () => {
  test("takes typed context and a model off the list, then starts a derived run", async () => {
    const { setup, app, control, frame } = await mount();
    // Start one run so there is something to derive from.
    setup.mockInput.pressKey("n");
    await setup.renderOnce();
    await confirmOverlay(setup);

    setup.mockInput.pressKey("r");
    await setup.renderOnce();
    expect(frame()).toContain("Re-run —");
    // Opens on the model the run being re-run used, not on the head of the list. Defaulting to the
    // first offer meant confirming without touching the field silently switched model.
    expect(frame()).toContain(env.INVESTIGATOR_MODEL);

    await toField(setup, 0);
    await setup.mockInput.typeText("scanner");
    await setup.renderOnce();
    expect(frame()).toContain("scanner");

    // ⇥ to the model row. The list is open because focus is what opens it, and ↓ moves the cursor
    // — which *is* the selection, so no separate accept is needed.
    setup.mockInput.pressTab();
    await setup.renderOnce();
    expect(frame()).toContain("openai/gpt-5.6-luna");
    setup.mockInput.pressArrow("down");
    await setup.renderOnce();
    expect(frame()).toContain("gpt-5.6-terra");

    setup.mockInput.pressTab();
    await setup.renderOnce();
    await confirmOverlay(setup);

    expect(control.started).toHaveLength(2);
    const derived = control.started[1];
    expect(derived?.analystContext).toBe("scanner");
    expect(derived?.model).toEqual({ provider: "openai", id: "gpt-5.6-terra" });
    // A derived run must get a fresh id: transcripts are keyed <runId>-<alertId> and appended to.
    expect(derived?.runId).not.toBe(control.started[0]?.runId);
    app.stop();
    setup.renderer.destroy();
  });

  test("typing on the model row filters, and the selection follows the filter", async () => {
    const { setup, app, control, frame } = await mount();
    setup.mockInput.pressKey("n");
    await setup.renderOnce();
    await toField(setup, 1);

    // Both offers are visible before the filter narrows them.
    expect(frame()).toContain("openai/gpt-5.6-luna");
    expect(frame()).toContain("openai/gpt-5.6-terra");

    await setup.mockInput.typeText("terra");
    await setup.renderOnce();
    expect(frame()).not.toContain("gpt-5.6-luna");

    // The selection followed the narrowing. Without that it would still point at luna, and
    // confirming would run a model the filter had taken off the screen.
    setup.mockInput.pressTab();
    await setup.renderOnce();
    await confirmOverlay(setup);
    expect(control.started[0]?.model).toEqual({ provider: "openai", id: "gpt-5.6-terra" });

    app.stop();
    setup.renderer.destroy();
  });

  test("⏎ on a text field advances instead of discarding what was typed", async () => {
    // It used to call `confirmCompose()` from anywhere; with the strip on Cancel that fell through
    // to `closeCompose()` and threw the text away with no prompt and no way back.
    const { setup, app, control, frame } = await mount();
    setup.mockInput.pressKey("n");
    await setup.renderOnce();
    await toField(setup, 0);
    await setup.mockInput.typeText("do not lose this");
    await setup.renderOnce();

    setup.mockInput.pressEnter();
    await setup.renderOnce();

    expect(frame()).toContain("Start an investigation");
    expect(frame()).toContain("do not lose this");
    expect(control.started).toEqual([]);

    app.stop();
    setup.renderer.destroy();
  });

  test("a first run carrying context says it will not be a baseline", async () => {
    const { setup, app, frame } = await mount();
    setup.mockInput.pressKey("n");
    await setup.renderOnce();
    expect(frame()).not.toContain("Not a baseline");

    await toField(setup, 0);
    await setup.mockInput.typeText("known scanner");
    await setup.renderOnce();

    // `evaluate` skips runs carrying analyst context (AC18) and coverage marks the alert `✓·`, so
    // steering the first investigation leaves it looking investigated with nothing scoreable.
    expect(frame()).toContain("Not a baseline");

    app.stop();
    setup.renderer.destroy();
  });
});

describe("the model picker offers only what can run (PRD-5 §9)", () => {
  test("says so when no provider credential is configured, instead of an empty picker", async () => {
    scratch = await mkdtemp(join(tmpdir(), "console-nomodel-"));
    const control = fakeControl();
    // What `listAvailableModels()` returns on a machine with no provider key at all.
    control.listModels = () => Promise.resolve([]);

    const setup = await createTestRenderer({ width: 130, height: 34 });
    const app = await runApp({
      runsDir: join(scratch, "runs"),
      tracesDir: join(scratch, "traces"),
      env,
      renderer: setup.renderer,
      exit: () => undefined,
      control,
    });
    await app.ready;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- polling for a condition
      await setup.renderOnce();
      if (!setup.captureCharFrame().includes("press R to load alerts")) break;
      // eslint-disable-next-line no-await-in-loop -- polling for a condition
      await Bun.sleep(20);
    }

    setup.mockInput.pressKey("n");
    await setup.renderOnce();
    await confirmOverlay(setup);
    setup.mockInput.pressKey("r");
    await setup.renderOnce();
    await toField(setup, 1);

    // The overlay must name the problem. Offering a blank field, or silently falling back to some
    // provider there is no key for, is how a run dies at `resolveModel` having spent a start.
    expect(setup.captureCharFrame()).toContain("no provider credential configured");
    setup.mockInput.pressEscape();
    // The escape parser waits ~40 ms before it can rule out a longer sequence, which is exactly
    // why §12.4 says ⎋ must never be the only way to cancel (`render.test.ts:407`).
    await Bun.sleep(60);
    await setup.renderOnce();

    // `n` must warn too — it is the flow that spends money on the configured model. `a` first:
    // the alert left the queue when the run started, which is the behaviour under test elsewhere.
    setup.mockInput.pressKey("1");
    await setup.renderOnce();
    setup.mockInput.pressKey("a");
    await setup.renderOnce();
    setup.mockInput.pressKey("n");
    await setup.renderOnce();
    const start = setup.captureCharFrame();
    expect(start).toContain("No provider credential configured");
    expect(start).toContain("this run would fail");
    expect(start).not.toContain("This calls a paid provider");

    app.stop();
    setup.renderer.destroy();
  });

  test("↓ off the end of the list leaves the field instead of running past it", async () => {
    const { setup, app, control, frame } = await mount();
    setup.mockInput.pressKey("n");
    await setup.renderOnce();
    await toField(setup, 1);

    // Two models offered, cursor on the first. The second ↓ has nowhere to go inside the list, so
    // it hands focus to the confirm strip rather than clamping — a traversal that silently stops
    // is indistinguishable from a dropped keypress.
    for (let i = 0; i < 2; i += 1) {
      setup.mockInput.pressArrow("down");
      // eslint-disable-next-line no-await-in-loop -- one render per keypress, in order
      await setup.renderOnce();
    }
    expect(frame()).toContain("gpt-5.6-terra");

    // Focus is on the strip: → picks Confirm and ⏎ acts on it.
    await confirmOverlay(setup);
    expect(control.started).toHaveLength(1);
    expect(control.started[0]?.model).toEqual({ provider: "openai", id: "gpt-5.6-terra" });
    app.stop();
    setup.renderer.destroy();
  });
});

describe("cancelling with `x` (PRD-5 §8)", () => {
  test("cancels the selected run, and is not bound to `c`", async () => {
    const { setup, app, control, frame } = await mount();
    setup.mockInput.pressKey("n");
    await setup.renderOnce();
    await confirmOverlay(setup);

    setup.mockInput.pressKey("x");
    await setup.renderOnce();
    expect(control.cancelled).toEqual([control.started[0]?.runId ?? ""]);

    const runId = control.started[0]?.runId;
    if (runId === undefined) throw new Error("expected a started run");
    control.emit({ type: "run_cancelled", runId, alertId: ALERT_ID });
    await setup.renderOnce();
    expect(frame().split("\n").at(-2) ?? "").toContain("cancelled");

    // `c` still opens configuration — this PRD must not silently rebind a key already in use.
    setup.mockInput.pressKey("c");
    await setup.renderOnce();
    expect(frame()).toContain("Configuration");
    app.stop();
    setup.renderer.destroy();
  });
});

describe("recording feedback with `f` (PRD-5 §10)", () => {
  test("writes feedback/<runId>-<alertId>.json outside runs/, with a frozen assessment", async () => {
    scratch = await mkdtemp(join(tmpdir(), "console-disp-"));
    const runsDir = join(scratch, "runs");
    const feedbackDir = join(scratch, "feedback");
    const runId = "01a01111-0000-7000-0000-00000000000a";

    // A finished run to disagree with.
    await Bun.write(
      join(runsDir, `${runId}.json`),
      JSON.stringify({
        runId,
        startedAt: "2026-08-20T00:00:00.000Z",
        completedAt: "2026-08-20T00:01:00.000Z",
        status: "completed",
        model: { provider: "openai", id: "gpt-5.6-luna" },
        results: [
          {
            alertId: ALERT_ID,
            alertTitle: ALERT_TITLE,
            status: "completed",
            summary: { tpPercent: 94, fpPercent: 6, impact: "none" },
          },
        ],
      }),
    );

    const setup = await createTestRenderer({ width: 130, height: 34 });
    const app = await runApp({
      runsDir,
      tracesDir: join(scratch, "traces"),
      env: { ...env, FEEDBACK_DIR: feedbackDir },
      renderer: setup.renderer,
      exit: () => undefined,
      control: fakeControl(),
    });
    await app.ready;
    setup.mockInput.pressKey("2");
    await setup.renderOnce();

    setup.mockInput.pressKey("f");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Your feedback");

    // ⇥ onto the verdict, which → cycles off the default; ⇥ again to the comment, then confirm.
    await toField(setup, 0);
    setup.mockInput.pressArrow("right");
    await setup.renderOnce();
    setup.mockInput.pressTab();
    await setup.renderOnce();
    await setup.mockInput.typeText("host is a scanner");
    await setup.renderOnce();
    setup.mockInput.pressTab();
    await setup.renderOnce();
    await confirmOverlay(setup);
    await Bun.sleep(60);
    await setup.renderOnce();

    const written = Bun.file(join(feedbackDir, `${runId}-${ALERT_ID}.json`));
    expect(await written.exists()).toBe(true);
    const record = (await written.json()) as Record<string, unknown>;
    expect(record["schemaVersion"]).toBe(1);
    expect(record["runId"]).toBe(runId);
    expect(record["alertId"]).toBe(ALERT_ID);
    // Frozen: the record must not point at a file that gets rewritten in place, or six months from
    // now it says the analyst disagreed with a verdict that is no longer there.
    expect(record["agentAssessment"]).toEqual({ tpPercent: 94, model: "gpt-5.6-luna" });

    // The console never writes under runs/ — the investigator stays its sole writer.
    const runArtifact = (await Bun.file(join(runsDir, `${runId}.json`)).json()) as {
      results: unknown[];
    };
    expect(runArtifact.results).toHaveLength(1);
    expect(Object.keys(runArtifact)).not.toContain("feedback");

    app.stop();
    setup.renderer.destroy();
  });
});
