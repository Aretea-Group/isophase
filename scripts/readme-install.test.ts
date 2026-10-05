import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { COMMANDS } from "../apps/cli/src/commands.ts";

/**
 * AC23 (PRD-11) — Given the README, When read from the top, Then the Install section precedes
 * "Choose your path", and every `isophase` command it shows is in the §4.3 table.
 *
 * A document scan in the spirit of `run-artifacts-ignored.test.ts`: the README is the canonical
 * setup guide, and the one thing it must not do is name a command the bin does not have. The table
 * is read from the dispatcher's own `COMMANDS`, so the README and the bin cannot drift apart.
 */
const readme = await Bun.file(resolve(import.meta.dir, "../README.md")).text();

describe("the README's install path (PRD-11 §4.1 D7)", () => {
  test("Install precedes Choose your path, and both precede any git clone", () => {
    const install = readme.indexOf("\n## Install\n");
    const choose = readme.indexOf("\n## Choose your path\n");
    const clone = readme.search(/git clone/);
    expect(install).toBeGreaterThan(0);
    expect(choose).toBeGreaterThan(install);
    expect(clone).toBeGreaterThan(install);
  });

  test("the first screen shows the bunx line before any other install instruction", () => {
    const install = readme.indexOf("\n## Install\n");
    const choose = readme.indexOf("\n## Choose your path\n");
    const section = readme.slice(install, choose);
    expect(section).toContain("bunx @aretea-group/isophase init");
    expect(section).not.toContain("bun install");
  });

  test("every isophase command the README shows is in the command table", () => {
    const table = new Set(COMMANDS.map((command) => command.name));
    const shown = [
      ...readme.matchAll(/\bisophase (?:init|investigate|console|probe|help|[a-z][a-z-]*)\b/g),
    ]
      .map((m) => m[0].slice("isophase ".length))
      .filter((name) => !name.startsWith("-"));
    expect(shown.length).toBeGreaterThan(5);
    const unknown = shown.filter((name) => !table.has(name));
    expect(unknown).toEqual([]);
  });

  test("the Install section lists every command in the table", () => {
    const install = readme.indexOf("\n## Install\n");
    const choose = readme.indexOf("\n## Choose your path\n");
    const section = readme.slice(install, choose);
    for (const command of COMMANDS) expect(section).toContain(`\`isophase ${command.name}\``);
  });
});
