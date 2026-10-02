import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  assertLiveTenantArtifactDirectories,
  securitySourceConfigSetFromEnv,
  type SecuritySourceEnvironment,
} from "@soc/sentinel-client";

import { ARTIFACT_DIRECTORIES, renderEnvTemplate } from "../src/env-template.ts";
import { bunVersionSatisfies, init, parseArgs, parseDotenv } from "../src/init.ts";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const DISPATCHER = resolve(repositoryRoot, "apps/cli/src/index.ts");

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "isophase-init-"));
}

async function runInit(cwd: string, argv: string[]) {
  const proc = Bun.spawn(["bun", DISPATCHER, "init", ...argv], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/**
 * AC6 — Given an empty directory, When `isophase init --track defender` runs, Then `.env` exists
 * with the `DEFENDER_*` and `SECURITY_SOURCES=defender` lines uncommented and `RUNS_DIR`,
 * `INVESTIGATOR_TRACE_DIR` and `WATCH_CONTROL_SOCKET` pointing under `.data/`, `.data/runs` and
 * `.data/runs/traces` exist, and the next command printed is `isophase probe`.
 */
describe("AC6 — init --track defender in an empty directory", () => {
  test("writes .env, creates the directories, and names isophase probe last", async () => {
    const cwd = await scratch();
    const result = await runInit(cwd, ["--track", "defender"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    const env = parseDotenv(await readFile(join(cwd, ".env"), "utf8"));
    // Uncommented: present as keys, blank for the operator to fill in.
    expect(Object.keys(env)).toEqual(
      expect.arrayContaining([
        "DEFENDER_TENANT_ID",
        "DEFENDER_CLIENT_ID",
        "DEFENDER_CLIENT_SECRET",
      ]),
    );
    expect(env["SECURITY_SOURCES"]).toBe("defender");
    expect(env["RUNS_DIR"]).toBe(".data/runs");
    expect(env["INVESTIGATOR_TRACE_DIR"]).toBe(".data/runs/traces");
    expect(env["WATCH_CONTROL_SOCKET"]).toBe(".data/runs/control.sock");
    for (const key of ["RUNS_DIR", "INVESTIGATOR_TRACE_DIR", "WATCH_CONTROL_SOCKET"]) {
      expect(env[key]?.startsWith(".data/")).toBe(true);
    }
    // The Sentinel track's lines stay commented.
    expect(env["SENTINEL_CONNECTOR"]).toBeUndefined();
    expect(env["AZURE_LOG_ANALYTICS_WORKSPACE_ID"]).toBeUndefined();

    expect(await Bun.file(join(cwd, ".data/runs")).exists()).toBe(false); // a directory, not a file
    const { stat } = await import("node:fs/promises");
    expect((await stat(join(cwd, ".data/runs"))).isDirectory()).toBe(true);
    expect((await stat(join(cwd, ".data/runs/traces"))).isDirectory()).toBe(true);

    const lines = result.stdout.trim().split("\n");
    expect(lines.at(-1)?.trim()).toBe("isophase probe");
  });

  test("the sentinel track uncomments its own group and points at the watch loop", async () => {
    const cwd = await scratch();
    const result = await runInit(cwd, ["--track=sentinel"]);
    expect(result.code).toBe(0);
    const env = parseDotenv(await readFile(join(cwd, ".env"), "utf8"));
    expect(env["SECURITY_SOURCES"]).toBe("sentinel");
    expect(env["SENTINEL_CONNECTOR"]).toBe("azure");
    expect(Object.keys(env)).toContain("AZURE_LOG_ANALYTICS_WORKSPACE_ID");
    expect(env["DEFENDER_TENANT_ID"]).toBeUndefined();
    expect(result.stdout.trim().split("\n").at(-1)?.trim()).toBe("isophase investigate --watch");
  });

  test("without --track and without a terminal, it refuses rather than guessing", async () => {
    const cwd = await scratch();
    const result = await runInit(cwd, []);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--track");
    expect(await Bun.file(join(cwd, ".env")).exists()).toBe(false);
  });
});

/**
 * AC7 — Given a directory where `.env` already exists, When `init` runs without `--force`, Then it
 * refuses, leaves the file byte-identical, and exits non-zero.
 */
describe("AC7 — an existing .env is never overwritten by accident", () => {
  test("refuses, byte-identical, non-zero", async () => {
    const cwd = await scratch();
    const original = "# mine\nOPENAI_API_KEY=keep-this\n";
    await Bun.write(join(cwd, ".env"), original);

    const logged: string[] = [];
    await expect(
      init({ track: "defender", force: false }, { cwd, log: (line) => logged.push(line) }),
    ).rejects.toThrow("--force");
    expect(await readFile(join(cwd, ".env"), "utf8")).toBe(original);
    expect(logged).toEqual([]);

    const viaProgram = await runInit(cwd, ["--track", "defender"]);
    expect(viaProgram.code).not.toBe(0);
    expect(await readFile(join(cwd, ".env"), "utf8")).toBe(original);
  });

  test("--force overwrites", async () => {
    const cwd = await scratch();
    await Bun.write(join(cwd, ".env"), "OLD=1\n");
    const result = await runInit(cwd, ["--track", "defender", "--force"]);
    expect(result.code).toBe(0);
    expect(parseDotenv(await readFile(join(cwd, ".env"), "utf8"))["OLD"]).toBeUndefined();
  });
});

/**
 * AC27 — Given the `.env` that `init --track defender` wrote, When `investigate --watch` starts
 * with valid credentials, Then `assertLiveTenantArtifactDirectories` passes without the operator
 * editing any directory variable.
 *
 * The template against the assertion, with stub credentials standing in for the operator's: the
 * factory resolves the same set the investigator would, and the guard sees the same directories.
 */
describe("AC27 — the template satisfies the live-tenant guard", () => {
  const STUB = {
    DEFENDER_TENANT_ID: "stub-tenant",
    DEFENDER_CLIENT_ID: "stub-client",
    DEFENDER_CLIENT_SECRET: "stub-secret",
    AZURE_LOG_ANALYTICS_WORKSPACE_ID: "00000000-0000-0000-0000-000000000000",
    AZURE_TENANT_ID: "stub-tenant",
    AZURE_CLIENT_ID: "stub-client",
    AZURE_CLIENT_SECRET: "stub-secret",
  };

  function environmentOf(track: "defender" | "sentinel"): SecuritySourceEnvironment {
    const env = parseDotenv(renderEnvTemplate(track, new Date("2026-10-02T00:00:00Z")));
    return {
      SENTINEL_CONNECTOR: (env["SENTINEL_CONNECTOR"] as "mock" | "azure" | undefined) ?? "mock",
      SENTINEL_BASE_URL: "http://localhost:8787",
      SENTINEL_TIMEOUT_MS: 30_000,
      ...(env["SECURITY_SOURCES"] === undefined
        ? {}
        : { SECURITY_SOURCES: env["SECURITY_SOURCES"] }),
      ...STUB,
    };
  }

  test.each(["defender", "sentinel"] as const)("%s: both directories pass", (track) => {
    const env = parseDotenv(renderEnvTemplate(track, new Date()));
    const set = securitySourceConfigSetFromEnv(environmentOf(track));
    expect(set.primary.id).toBe(track);
    expect(() =>
      assertLiveTenantArtifactDirectories(set.sources, [
        env["RUNS_DIR"] ?? "",
        env["INVESTIGATOR_TRACE_DIR"] ?? "",
        env["WATCH_CONTROL_SOCKET"] ?? "",
      ]),
    ).not.toThrow();
  });

  test("the guard is not vacuous for this set", () => {
    const set = securitySourceConfigSetFromEnv(environmentOf("defender"));
    expect(() => assertLiveTenantArtifactDirectories(set.sources, ["runs"])).toThrow(
      "must be inside .data/",
    );
  });

  test("the template's directories are the ones init creates", () => {
    const env = parseDotenv(renderEnvTemplate("defender", new Date()));
    expect(env["RUNS_DIR"]).toBe(ARTIFACT_DIRECTORIES.RUNS_DIR);
    expect(env["INVESTIGATOR_TRACE_DIR"]).toBe(ARTIFACT_DIRECTORIES.INVESTIGATOR_TRACE_DIR);
  });
});

describe("init's arguments and checks", () => {
  test("--track takes only the two tracks; anything else is refused", () => {
    expect(parseArgs(["--track", "defender"]).track).toBe("defender");
    expect(parseArgs(["--track=sentinel", "--force"])).toEqual({ track: "sentinel", force: true });
    expect(() => parseArgs(["--track", "splunk"])).toThrow("defender, sentinel");
    expect(() => parseArgs(["--tack", "defender"])).toThrow("Unknown option");
  });

  test("the Bun floor is compared numerically", () => {
    expect(bunVersionSatisfies("1.3.4", "1.3.0")).toBe(true);
    expect(bunVersionSatisfies("1.10.0", "1.3.0")).toBe(true);
    expect(bunVersionSatisfies("1.2.19", "1.3.0")).toBe(false);
    expect(bunVersionSatisfies("2.0.0-canary", "1.3.0")).toBe(true);
  });

  test("parseDotenv reads what init writes and ignores comments and quotes", () => {
    expect(parseDotenv('# c\nA=1\nB="two"\n\nC=\n#D=4\n')).toEqual({ A: "1", B: "two", C: "" });
  });
});
