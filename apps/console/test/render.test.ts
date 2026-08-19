import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";

import { env } from "../src/env.ts";
import { runApp, type AppHandle } from "../src/ui/app.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

/**
 * These render for real, through OpenTUI's native core, and therefore need its platform binary.
 * Guarded rather than assumed, in the style of `apps/mock-sentinel/test/integration/*` skipping
 * when Kusto is absent, so `bun test` stays green where it is unavailable (PRD-3 §12).
 */
let available = true;
try {
  const probe = await createTestRenderer({ width: 20, height: 5 });
  probe.renderer.destroy();
} catch {
  available = false;
}

const when = available ? describe : describe.skip;
if (!available) {
  console.info("[console] skipping render tests — the OpenTUI native binary is unavailable here.");
}

async function mount(
  width = 120,
  height = 32,
): Promise<{ setup: TestRendererSetup; app: AppHandle; frame: () => string }> {
  const setup = await createTestRenderer({ width, height });
  const app = await runApp({
    runsDir: join(FIXTURES, "runs"),
    tracesDir: join(FIXTURES, "traces"),
    env,
    renderer: setup.renderer,
    exit: () => undefined,
  });
  await app.ready;
  await setup.renderOnce();
  return { setup, app, frame: () => setup.captureCharFrame() };
}

/**
 * Walk the run list until the main panel is showing a given alert.
 *
 * Selection is checked against the main panel's title rather than the list row: run rows lead with
 * severity and incident date now, and carry the run id on their second line (PRD-3 §8.1).
 */
async function selectRun(
  setup: TestRendererSetup,
  frame: () => string,
  alertIdPrefix: string,
): Promise<void> {
  setup.mockInput.pressKey("2");
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (frame().includes(`[4] ${alertIdPrefix}`)) return;
    setup.mockInput.pressArrow("down");
    // eslint-disable-next-line no-await-in-loop
    await setup.renderOnce();
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(30);
    // eslint-disable-next-line no-await-in-loop
    await setup.renderOnce();
  }
}

function unmount(setup: TestRendererSetup, app: AppHandle): void {
  app.stop();
  setup.renderer.destroy();
}

when("dashboard", () => {
  test("draws the panels, the run list and a verdict", async () => {
    const { setup, app, frame } = await mount();
    const output = frame();

    expect(output).toContain("[3] Case");
    expect(output).toContain("[2] Runs");
    expect(output).toContain("SOC ANALYST CONSOLE");
    expect(output).toContain("read-only");
    // Real data from the fixtures, not placeholders. The run id is no longer in the list — it
    // identifies a file, and carrying it cost every run a second row (PRD-3 §8.1).
    expect(output).toContain("Privilege escalat");
    expect(output).toContain("TP");
    expect(output).not.toContain("01a0194c");

    // The newest fixture run carries alert context, so triage facts lead: severity and the date
    // the incident happened — five years before the investigation ran (PRD-3 §6.1).
    expect(output).toContain("MED");
    expect(output).toContain("2021-10-23");
    expect(output).toContain("SOC-FW-RDP");
    expect(output).toContain("CredentialAccess");

    // Pane [3] is always present. Hiding it for single-alert runs made `1-4` a lie on almost
    // every run in the corpus and left ⏎ walking to a pane that was not there.
    expect(output).toContain("[1] Alert");

    // The console describes the queue, not the machine. Provider, model and tracing belong to the
    // `c` screen; the header used to carry all three.
    expect(output).not.toContain("trace ON");
    expect(output).not.toContain("gpt-");
    unmount(setup, app);
  });

  test("names the verdict band, not just the split", async () => {
    const { setup, app, frame } = await mount();
    const output = frame();

    // `verdictBand` has classified 30-70 as inconclusive since PRD-3 and rendered it nowhere; a
    // reader of "TP 94%" should not have to work out which side of the band that falls.
    expect(output).toContain("TRUE POSITIVE");
    // The counter-argument is named as one rather than stacked as a second fact.
    expect(output).toContain("FOR — TRUE POSITIVE");
    expect(output).toContain("AGAINST — FALSE POSITIVE");
    // Impact is no longer rendered here; it survives as a column in the alert list.
    expect(output).not.toContain("IMPACT ");
    unmount(setup, app);
  });

  test("reports what a running sweep still has left in the alert pane title", async () => {
    const { setup, app, frame } = await mount();
    await selectRun(setup, frame, "aaaaaaaa");

    // Pending alerts are the one progress indicator a mid-sweep run has (PRD-3 §13).
    expect(frame()).toContain("[1] Alert");
    expect(frame()).toContain("pending of");
    unmount(setup, app);
  });

  test("never lets a list row outgrow its pane", async () => {
    const { readRuns } = await import("../src/data/runs.ts");
    const snapshot = await readRuns(join(FIXTURES, "runs"));
    const { runRows, resultRows } = await import("../src/ui/panes/lists.ts");
    const { lineText } = await import("../src/view/format.ts");

    // A row one character over its pane wraps, and a wrapped row is a two-line row again — which
    // is what an unbounded `last written 12:04:33` did to a stale run.
    for (const width of [30, 44, 60]) {
      for (const row of runRows(snapshot.runs, Date.now(), new Set(), 0, width)) {
        expect(lineText(row).length).toBeLessThanOrEqual(width);
      }
      for (const run of snapshot.runs) {
        for (const row of resultRows(run.results, 0, width)) {
          expect(lineText(row).length).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  test("gives each run one row, not two", async () => {
    const { setup, app, frame } = await mount();
    const rows = frame()
      .split("\n")
      .filter((line) => /│\s*[▶ ]\s*[✓⚠●◌]/.test(line));

    // Five fixture runs, five rows. The second line per run carried the run id and the model, and
    // halved how many runs fitted on screen to do it.
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) expect(row).toMatch(/TP \d+%|done|m\d\ds|last written/);
    unmount(setup, app);
  });

  test("an interrupted sweep shows its failure and what is still pending", async () => {
    const { setup, app, frame } = await mount();
    await selectRun(setup, frame, "aaaaaaaa");

    const output = frame();
    expect(output).toContain("FAILED — InvestigationStepLimitError");
    expect(output).toContain("2 alerts pending");
    unmount(setup, app);
  });

  test("a corrupt artifact is reported without costing the rest of the list", async () => {
    const { setup, app, frame } = await mount();
    expect(frame()).toContain("unreadable");
    // The other four runs are still listed; one bad file costs only itself.
    expect(frame()).toContain("Privilege escalat");
    expect(frame()).toContain("Brute force");
    unmount(setup, app);
  });
});

when("selection", () => {
  test("moving on before a transcript has loaded never leaves the previous alert on screen", async () => {
    const { setup, app, frame } = await mount();

    // The newest fixture carries alert context; the next one down carries none. Moving between
    // them without waiting used to leave the first alert's facts rendered under the second's
    // title, because a second load joined the first rather than replacing it.
    expect(frame()).toContain("SOC-FW-RDP");

    setup.mockInput.pressKey("2");
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressArrow("down");
    await setup.renderOnce();
    await Bun.sleep(200);
    await setup.renderOnce();

    const output = frame();
    const title = output.split("\n")[1] ?? "";
    // Whatever is selected, panes [3] and [4] must be describing the same investigation.
    if (title.includes("aaaaaaaa")) {
      expect(output).not.toContain("SOC-RULE-0001-RdpBruteForce");
    }
    unmount(setup, app);
  });
});

when("tabs", () => {
  test("Activity lists the tool calls and summarises the tables queried", async () => {
    const { setup, app, frame } = await mount();
    // cc6430ca is the alert whose transcript the fixtures carry.
    await selectRun(setup, frame, "cc6430ca");
    expect(frame()).toContain("[4] cc6430ca");

    setup.mockInput.pressKey("]");
    await setup.renderOnce();

    const output = frame();
    expect(output).toContain("query_security_data");
    expect(output).toContain("get_security_schema");
    expect(output).toContain("submit_investigation");
    // The aggregate answer, without opening a single call.
    expect(output).toContain("SecurityEvent");
    expect(output).toContain("no web_search / web_fetch calls");
    unmount(setup, app);
  });

  test("Transcript reads the investigation as a conversation and expands a block", async () => {
    const { setup, app, frame } = await mount();
    await selectRun(setup, frame, "cc6430ca");
    setup.mockInput.pressKey("]");
    setup.mockInput.pressKey("]");
    await setup.renderOnce();

    const collapsed = frame();
    expect(collapsed).toContain("Context given to the agent");
    expect(collapsed).toContain("reasoning");
    expect(collapsed).toContain("get_security_schema");

    // Move onto a block that has more behind it, then load it.
    setup.mockInput.pressKey("4");
    setup.mockInput.pressKey("j");
    await setup.renderOnce();
    expect(frame()).toContain("load the full text");

    setup.mockInput.pressEnter();
    await setup.renderOnce();
    await Bun.sleep(120);
    await setup.renderOnce();

    // The preview's own prompt is gone once the full text has been read back from disk.
    expect(frame()).not.toContain("load the full text");
    unmount(setup, app);
  });

  test("Stream renders the live feed shape trace.ts already narrates", async () => {
    const { setup, app, frame } = await mount();
    await selectRun(setup, frame, "cc6430ca");
    setup.mockInput.pressKey("]");
    setup.mockInput.pressKey("]");
    setup.mockInput.pressKey("]");
    await setup.renderOnce();

    const output = frame();
    expect(output).toContain("agent start");
    expect(output).toContain("turn 1");
    // One line per turn and one per tool call — the shape trace.ts prints to stdout.
    expect(output).toContain("→ get_security_schema");
    expect(output).toContain("← query_security_data");
    unmount(setup, app);
  });

  test("configuration shows this run beside the current environment", async () => {
    const { setup, app, frame } = await mount();
    setup.mockInput.pressKey("c");
    await setup.renderOnce();

    const output = frame();
    expect(output).toContain("THIS RUN");
    expect(output).toContain("CURRENT ENV");
    expect(output).toContain("provider / model");
    expect(output).toContain("tracing");
    unmount(setup, app);
  });

  test("the help overlay lists the keys and says the console is read-only", async () => {
    const { setup, app, frame } = await mount();
    setup.mockInput.pressKey("?");
    await setup.renderOnce();

    const output = frame();
    expect(output).toContain("focus Alerts, Runs, Case, Main");
    expect(output).toContain("read-only");
    unmount(setup, app);
  });
});

when("moving through the run list", () => {
  test("does not move the panes under the selection", async () => {
    const { setup, app, frame } = await mount();
    setup.mockInput.pressKey("2");
    await setup.renderOnce();

    // Only the row borders: pane titles legitimately change as the selection does.
    const borders = (): string =>
      frame()
        .split("\n")
        .map((line, at) => (/^[┌└]/.test(line) ? String(at) : ""))
        .filter(Boolean)
        .join(",");

    const before = borders();
    for (let step = 0; step < 6; step += 1) {
      setup.mockInput.pressArrow("down");
      // eslint-disable-next-line no-await-in-loop
      await setup.renderOnce();
      // Sizing pane [1] to its contents made every run a different height, so the run list moved
      // under the analyst's own keypress.
      expect(borders()).toBe(before);
    }
    unmount(setup, app);
  });
});

when("colour", () => {
  test("carries meaning beyond the verdict band", async () => {
    const setup = await createTestRenderer({ width: 130, height: 38 });
    const app = await runApp({
      runsDir: join(FIXTURES, "runs"),
      tracesDir: join(FIXTURES, "traces"),
      env,
      renderer: setup.renderer,
      exit: () => undefined,
    });
    await app.ready;
    await setup.renderOnce();

    const colours = new Set<string>();
    for (const line of setup.captureSpans().lines) {
      for (const span of line.spans) {
        if (span.text.trim() !== "") colours.add(String(span.fg));
      }
    }

    // The palette was fully written for PRD-3 §9.8 and imported by nothing; every pane rendered
    // flat. Headings, labels, severity, run state and the band are all distinct now.
    expect(colours.size).toBeGreaterThanOrEqual(6);
    unmount(setup, app);
  });
});

when("filtering and copying", () => {
  test("/ narrows the run list and reports how much it is hiding", async () => {
    const { setup, app, frame } = await mount();
    expect(frame()).toContain("Privilege escalat");

    setup.mockInput.pressKey("/");
    await setup.mockInput.typeText("brute");
    await setup.renderOnce();

    const output = frame();
    // The match count travels with the filter: a filter that hides everything must not look like
    // an empty runs directory.
    expect(output).toContain("/brute");
    expect(output).toContain("1/5");
    expect(output).toContain("Brute force");
    expect(output).not.toContain("Privilege escalat");
    unmount(setup, app);
  });

  test("q types rather than quits while the filter is open", async () => {
    let exited = false;
    const setup = await createTestRenderer({ width: 120, height: 32 });
    const app = await runApp({
      runsDir: join(FIXTURES, "runs"),
      tracesDir: join(FIXTURES, "traces"),
      env,
      renderer: setup.renderer,
      exit: () => {
        exited = true;
      },
    });
    await app.ready;

    setup.mockInput.pressKey("/");
    await setup.mockInput.typeText("q");
    await setup.renderOnce();

    expect(exited).toBe(false);
    expect(setup.captureCharFrame()).toContain("/q");
    unmount(setup, app);
  });

  test("escape clears the filter and brings the hidden runs back", async () => {
    const { setup, app, frame } = await mount();

    setup.mockInput.pressKey("/");
    await setup.mockInput.typeText("brute");
    await setup.renderOnce();
    expect(frame()).not.toContain("Privilege escalat");

    // Once to leave the input, once to clear what it left behind. A bare ESC is held by the key
    // parser until it can rule out an escape sequence, so each one needs a beat to arrive.
    setup.mockInput.pressEscape();
    await Bun.sleep(40);
    await setup.renderOnce();
    setup.mockInput.pressEscape();
    await Bun.sleep(40);
    await setup.renderOnce();

    const output = frame();
    expect(output).toContain("Privilege escalat");
    expect(output).not.toContain("/brute");
    unmount(setup, app);
  });

  test("y reports what it put on the clipboard", async () => {
    const { setup, app, frame } = await mount();
    setup.mockInput.pressKey("4");
    await setup.renderOnce();
    setup.mockInput.pressKey("y");
    await setup.renderOnce();

    // Either outcome is a real answer; silence would not be.
    expect(frame()).toMatch(/copied|refused the copy/);
    unmount(setup, app);
  });
});

when("responsive behaviour", () => {
  test("collapses to a single column on a narrow terminal", async () => {
    const { setup, app, frame } = await mount();
    setup.resize(80, 24);
    await setup.renderOnce();

    const output = frame();
    expect(output).toContain("[2] Runs");
    // The status panel is dropped rather than squeezed; the run list survives.
    expect(output).not.toContain("[1] Status");
    expect(output.split("\n")[0]?.length).toBeLessThanOrEqual(81);
    unmount(setup, app);
  });

  test("says so rather than drawing corrupted boxes when far too narrow", async () => {
    const { setup, app, frame } = await mount();
    setup.resize(48, 20);
    await setup.renderOnce();

    const output = frame();
    expect(output).toContain("Terminal too narrow");
    expect(output).not.toContain("[2] Runs");
    unmount(setup, app);
  });
});
