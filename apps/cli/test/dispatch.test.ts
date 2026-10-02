import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import rootPackageJson from "../../../package.json" with { type: "json" };
import { COMMANDS } from "../src/commands.ts";
import { commandList, describe as describeCommand } from "../src/help.ts";
import { dispatch, PACKAGE_VERSION } from "../src/index.ts";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const DISPATCHER = resolve(repositoryRoot, "apps/cli/src/index.ts");

/** Run the dispatcher as a program: exit code, stdout and stderr, from the repository root. */
async function run(argv: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", DISPATCHER, ...argv], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** The §4.3 command table, as the PRD lists it. */
const TABLE: string[] = ["init", "investigate", "console", "probe", "help"];

describe("the command table (PRD-11 §4.1 D3)", () => {
  test("holds exactly the §4.3 commands, in that order", () => {
    expect(COMMANDS.map((command) => command.name)).toEqual(TABLE);
  });

  test("help lists every one of them, and --version prints the root package version", async () => {
    const listing = commandList();
    for (const name of TABLE) expect(listing).toMatch(new RegExp(`^  ${name}\\s`, "m"));
    expect(listing).toContain("--version");

    const help = await run(["help"]);
    expect(help.code).toBe(0);
    expect(help.stdout.trim()).toBe(listing);

    expect(PACKAGE_VERSION).toBe(rootPackageJson.version);
    const version = await run(["--version"]);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toBe("0.0.0");
  });
});

/**
 * AC5 — Given the command table, When `help <command>` and `<command> --help` are run for each
 * entry, Then both print the same usage text, and an unknown command exits non-zero naming `help`.
 */
describe("AC5 — one usage text per command", () => {
  test.each(TABLE)("help %s and %s --help print the same text", async (name) => {
    const viaHelp = await run(["help", name]);
    const viaFlag = await run([name, "--help"]);
    expect(viaHelp.code).toBe(0);
    expect(viaFlag.code).toBe(0);
    expect(viaHelp.stdout).toBe(viaFlag.stdout);
    expect(viaHelp.stdout.trim()).toBe(await describeCommand(name));
    // Usage, not an empty string: the module's text must have reached stdout.
    expect(viaHelp.stdout).toContain(`isophase ${name}`);
  });

  test("an unknown command exits non-zero and names help", async () => {
    const result = await run(["frobnicate"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Unknown command "frobnicate"');
    expect(result.stderr).toContain("isophase help");
    expect(result.stdout).toBe("");

    // In-process too, so the exit code is the dispatcher's and not a crash.
    expect(await dispatch(["frobnicate"])).toBe(2);
  });

  test("help <unknown> says the same thing", async () => {
    const result = await run(["help", "frobnicate"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("isophase help");
  });
});

/**
 * AC8 — Given `init`'s source and the dispatcher's, When scanned, Then neither imports
 * `@azure/identity`, calls `fetch`, or references an Entra, ARM or Graph endpoint — `init`
 * performs no network call.
 *
 * Scanned as text, like `ground-truth-isolation.test.ts`: an import rule would catch the first
 * leak and not the other two. The template is included because `init` writes what it says.
 */
describe("AC8 — init and the dispatcher reach no tenant", () => {
  const FILES = [
    "apps/cli/src/index.ts",
    "apps/cli/src/commands.ts",
    "apps/cli/src/help.ts",
    "apps/cli/src/init.ts",
    "apps/cli/src/env-template.ts",
    "apps/cli/src/command-module.ts",
  ];
  const FORBIDDEN: [string, RegExp][] = [
    ["an @azure/identity import", /@azure\/identity/],
    ["a fetch call", /\bfetch\s*\(/],
    ["the Entra token endpoint", /login\.microsoftonline\.com/i],
    ["the ARM endpoint", /management\.azure\.com/i],
    ["the Graph endpoint", /graph\.microsoft\.com/i],
    ["a Bun.serve or Bun.connect", /\bBun\.(?:serve|connect|listen)\s*\(/],
  ];

  test.each(FORBIDDEN)("none of the files contains %s", async (_label, pattern) => {
    const texts = await Promise.all(
      FILES.map(async (file) => ({
        file,
        text: await Bun.file(resolve(repositoryRoot, file)).text(),
      })),
    );
    expect(texts.filter(({ text }) => pattern.test(text)).map(({ file }) => file)).toEqual([]);
  });

  test("the scan is not vacuous — the probe, which does talk to Graph, would fail it", async () => {
    const probe = await Bun.file(resolve(repositoryRoot, "apps/cli/src/probe.ts")).text();
    expect(FORBIDDEN.some(([, pattern]) => pattern.test(probe))).toBe(true);
  });
});

/**
 * AC13 — Given the root `package.json` after Phase 1, When `bun run investigate`,
 * `bun run console`, `bun run console:live defender` and `bun run probe:defender` are invoked,
 * Then each reaches the dispatcher and behaves as before.
 *
 * "Behaves as before" is proven at the seam the scripts share: each one is the dispatcher plus the
 * command name, and each command's usage comes back through `bun run`. The commands' own parsers
 * are unchanged and have their own tests.
 */
describe("AC13 — the bun run scripts reach the dispatcher", () => {
  const scripts = rootPackageJson.scripts as Record<string, string>;

  test.each([
    ["investigate", "investigate"],
    ["console", "console"],
    ["console:live", "console --live"],
    ["probe:defender", "probe"],
  ])("bun run %s is the dispatcher's %s", (script, command) => {
    expect(scripts[script]).toBe(`bun apps/cli/src/index.ts ${command}`);
  });

  test.each([
    [["investigate", "--help"], "isophase investigate"],
    [["console", "--help"], "isophase console"],
    [["console:live", "defender", "--help"], "isophase console"],
    [["probe:defender", "--help"], "isophase probe"],
  ])("bun run %s reaches its command", async (argv, expected) => {
    const proc = Bun.spawn(["bun", "run", ...argv], {
      cwd: repositoryRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(stdout).toContain(expected);
  });

  test("console --live applies its overlay before the console reads the environment", async () => {
    // The regression this guards: importing the console for its usage text before `run` applied
    // the overlay validated the inherited environment, so `console --live defender` with no
    // credentials opened happily against the mock queue instead of refusing as the launcher did.
    const proc = Bun.spawn(["bun", "run", "console:live", "defender"], {
      cwd: repositoryRoot,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: {
        ...process.env,
        DEFENDER_TENANT_ID: "",
        DEFENDER_CLIENT_ID: "",
        DEFENDER_CLIENT_SECRET: "",
      },
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("SECURITY_SOURCES=defender requires DEFENDER_TENANT_ID");
  });

  test("queue:reset stays in scripts/ — its --scenarios path reads the answer key", () => {
    expect(scripts["queue:reset"]).toBe("bun scripts/reset-queue.ts");
  });
});
