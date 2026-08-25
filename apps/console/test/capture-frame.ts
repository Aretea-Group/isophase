/**
 * Print one frame of the console as text, at a size you choose.
 *
 * A TUI's failures are geometric — a border drawn over the key bar, a pane allotted zero rows, a
 * line that soft-wraps under its own frame — and none of them are visible from the source. This
 * mounts the real app on the test fixtures through OpenTUI's headless renderer and dumps
 * `captureCharFrame()`, so a layout claim can be checked rather than argued about.
 *
 *   bun run apps/console/test/capture-frame.ts 120 40
 *   bun run apps/console/test/capture-frame.ts 90 30 2,down,down,]
 *   bun run apps/console/test/capture-frame.ts 120 40 '?'
 *   TUI_RUNS=.data/defender-runs TUI_TRACES=.data/defender-runs/traces \\
 *     bun run apps/console/test/capture-frame.ts 120 40
 *
 * Keys are comma-separated. `up`/`down`/`left`/`right` are sent as arrows; everything else is sent
 * as a keypress. Not a test file — the name keeps it out of `bun test`'s glob.
 */
import { join } from "node:path";

import { createTestRenderer } from "@opentui/core/testing";

import { env } from "../src/env.ts";
import { runApp } from "../src/ui/app.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const ARROWS = new Set(["up", "down", "left", "right"]);

const width = Number(process.argv[2] ?? 120);
const height = Number(process.argv[3] ?? 40);
const keys = (process.argv[4] ?? "").split(",").filter((key) => key !== "");

const setup = await createTestRenderer({ width, height });
const app = await runApp({
  // Overridable so a real run can be rendered without editing this file — `TUI_RUNS=.data/my-runs
  // bun run apps/console/test/capture-frame.ts 120 40`. That is how the Defender severity and
  // `let`-as-a-table defects were found: both were invisible in the fixtures, which are Sentinel.
  runsDir: process.env["TUI_RUNS"] ?? join(FIXTURES, "runs"),
  tracesDir: process.env["TUI_TRACES"] ?? join(FIXTURES, "traces"),
  env,
  renderer: setup.renderer,
  exit: () => undefined,
});
await app.ready;
await setup.renderOnce();

for (const key of keys) {
  if (ARROWS.has(key)) setup.mockInput.pressArrow(key as "up" | "down" | "left" | "right");
  else setup.mockInput.pressKey(key);
  // Transcripts load off the main thread, so a frame taken immediately shows the pane mid-load.
  // eslint-disable-next-line no-await-in-loop
  await setup.renderOnce();
  // eslint-disable-next-line no-await-in-loop
  await Bun.sleep(60);
  // eslint-disable-next-line no-await-in-loop
  await setup.renderOnce();
}

await Bun.sleep(150);
await setup.renderOnce();
console.info(setup.captureCharFrame());

app.stop();
setup.renderer.destroy();
process.exit(0);
