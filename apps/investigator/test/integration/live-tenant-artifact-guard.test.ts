import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * PRD-9 AC23 — the guarantee the README states (ADR 011 §13, ADR 012).
 *
 * Any run with a live-tenant source active may carry tenant data in its artifacts, so the
 * investigator refuses to *start* when an artifact directory sits outside ignored `.data/`. This
 * drives the real entrypoint rather than the guard function, because "refuses to start" is a claim
 * about the program: the check runs inside `configFromEnv` before any client is built, so no
 * credential below is ever presented to a tenant and no model is called.
 */

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const ENTRYPOINT = join(ROOT, "apps", "investigator", "src", "index.ts");

async function investigate(env: Record<string, string>): Promise<{ code: number; err: string }> {
  const proc = Bun.spawn(["bun", ENTRYPOINT], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, err };
}

const DEFENDER = {
  SECURITY_SOURCES: "defender",
  DEFENDER_TENANT_ID: "00000000-0000-0000-0000-000000000001",
  DEFENDER_CLIENT_ID: "00000000-0000-0000-0000-000000000002",
  DEFENDER_CLIENT_SECRET: "not-a-real-secret",
  OPENAI_API_KEY: "not-a-real-key",
  INVESTIGATOR_TRACE: "false",
};

describe("investigator startup with a live source", () => {
  test("AC23 — artifact directories outside .data/ are refused before anything starts", async () => {
    // Given the investigator configured with a live source and the default runs/ directory
    const { code, err } = await investigate({ ...DEFENDER, RUNS_DIR: "runs" });
    // Then it refuses to start, names the source and the rule, and writes nothing
    expect(code).toBe(1);
    expect(err).toContain("defender reads a live tenant");
    expect(err).toContain("must be inside .data/");
  });
});
