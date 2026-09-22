import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * The `/runs/` ignore rule (PRD-9 AC4 and AC7; ADR 012).
 *
 * Run artifacts are this checkout's measurement of its own agent and, against a live tenant, may
 * carry tenant data, so `runs/` is ignored and never committed. The rule has to be anchored to the
 * repository root: unanchored, `runs` matches any directory of that name at any depth and silently
 * drops the committed test fixtures under `apps/*\/test/fixtures/runs/` — the trap PRD-3 §12 hit
 * once. Both halves are asserted against git itself rather than against a re-implementation of
 * gitignore semantics, which is the only reading that cannot drift from what a commit would do.
 */

const root = resolve(import.meta.dir, "..");

function git(...args: string[]): { out: string; code: number } {
  const proc = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return { out: proc.stdout.toString().trim(), code: proc.exitCode };
}

const FIXTURE_DIRS = ["apps/console/test/fixtures/runs", "apps/investigator/test/fixtures/runs"];

describe("run artifacts are ignored, test fixtures are not", () => {
  test("AC7 — the rule is anchored, so the committed fixture runs stay tracked", async () => {
    // Given the `/runs/` ignore rule
    const rules = (await Bun.file(join(root, ".gitignore")).text())
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    expect(rules).toContain("/runs/");
    expect(rules).not.toContain("runs/");
    expect(rules).not.toContain("runs");

    // When git is asked which fixture files it tracks and whether it would ignore them
    for (const dir of FIXTURE_DIRS) {
      const tracked = git("ls-files", "--", dir)
        .out.split("\n")
        .filter((line) => line !== "");
      // Then every fixture directory is still tracked, and none of its files is ignored
      expect(tracked.length).toBeGreaterThan(0);
      const [first] = tracked;
      expect(first).toBeDefined();
      expect(git("check-ignore", "-q", "--", first ?? "").code).toBe(1);
    }
  });

  test("AC4 — an artifact written to runs/<run-id>.json never appears as untracked", async () => {
    // Given an investigation writing an artifact into the repository's runs/ directory
    const runsDir = join(root, "runs");
    await mkdir(runsDir, { recursive: true });
    const name = `prd-9-ac4-${crypto.randomUUID()}.json`;
    await writeFile(join(runsDir, name), "{}\n");
    try {
      // When git status is consulted
      const status = git("status", "--porcelain", "--untracked-files=all", "--", "runs");
      // Then the artifact is ignored and does not appear as untracked
      expect(git("check-ignore", "-q", "--", `runs/${name}`).code).toBe(0);
      expect(status.out).not.toContain(name);
    } finally {
      await rm(join(runsDir, name), { force: true });
    }
  });
});
