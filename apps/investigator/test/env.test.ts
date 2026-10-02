import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { parseInvestigatorEnv } from "../src/env.ts";

const ENV_MODULE = resolve(import.meta.dir, "../src/env.ts");

/** Import `env.ts` in a fresh process with this environment; the import is the whole program. */
async function importEnv(env: Record<string, string>) {
  const proc = Bun.spawn(["bun", "-e", `await import(${JSON.stringify(ENV_MODULE)})`], {
    cwd: resolve(import.meta.dir, "../../.."),
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...env },
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, stderr };
}

/**
 * AC26 — Given no `.env` and no provider key, When `apps/investigator/src/env.ts` is imported,
 * Then it still throws at import as before, and `parseInvestigatorEnv` rejects the same input with
 * the same error.
 *
 * "As before" is the property PRD-11 §4.1 D6 promises to keep: the extraction of
 * `parseInvestigatorEnv` must not turn import-time validation into a call somebody has to remember
 * to make (ADR 005 §6). The schema has no required key — a provider key is the model library's
 * concern, checked in `model.ts` — so what throws at import is an invalid value, and that is what
 * both halves are shown rejecting identically.
 */
describe("AC26 — env.ts validates at import, through parseInvestigatorEnv", () => {
  const INVALID = { INVESTIGATOR_THINKING_LEVEL: "bogus" };

  test("an invalid environment stops the import", async () => {
    const result = await importEnv(INVALID);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("INVESTIGATOR_THINKING_LEVEL");
  });

  test("parseInvestigatorEnv rejects the same input with the same error", async () => {
    // `createEnv` throws a fixed message and prints the issues to stderr; the thrown message is
    // what both halves share, and the import's stderr carries the key as well.
    let direct: string | undefined;
    try {
      parseInvestigatorEnv(INVALID);
    } catch (error) {
      direct = error instanceof Error ? error.message : String(error);
    }
    expect(direct).toBe("Invalid environment variables");
    const atImport = await importEnv(INVALID);
    expect(atImport.stderr).toContain(direct ?? "<no error>");
    expect(atImport.stderr).toContain("INVESTIGATOR_THINKING_LEVEL");
  });

  test("with no .env and no provider key the import succeeds — the key is model.ts's to check", async () => {
    const result = await importEnv({});
    expect(result.code).toBe(0);
    expect(() => parseInvestigatorEnv({})).not.toThrow();
  });

  test("the singleton is the function applied to process.env — same defaults", () => {
    const fresh = parseInvestigatorEnv({});
    expect(fresh.RUNS_DIR).toBe("runs");
    expect(fresh.SENTINEL_CONNECTOR).toBe("mock");
    expect(parseInvestigatorEnv({ RUNS_DIR: ".data/x" }).RUNS_DIR).toBe(".data/x");
  });
});
