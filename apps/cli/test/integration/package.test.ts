import { describe, expect, test } from "bun:test";
import { mkdtemp, stat } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import rootPackageJson from "../../../../package.json" with { type: "json" };
import { assertTarballClean, OUTPUT, packedFiles } from "../../../../scripts/build-package.ts";

/**
 * The package as a consumer gets it (PRD-11 Phase 2).
 *
 * Builds `dist/cli.js`, packs it, installs the tarball into an empty directory with nothing of the
 * repository on the path, and runs the bin from there. Slow — one `bun add` of the real externals —
 * and it needs the network for them, so it lives under `test/integration/` like every other suite
 * that probes a live dependency. The lab-dependent half at the end skips itself without the lab
 * and a provider key, with a printed reason.
 */
const ROOT = resolve(import.meta.dir, "../../../..");

async function sh(cmd: string[], cwd: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Bare package names the bundle imports: externals, with subpaths folded to their package. */
function externalsOf(bundle: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    // `[^;]` rather than `[^;\n]`: Bun writes multi-name imports across lines.
    /^(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gm,
    /^import\s+"([^"]+)"/gm,
    /\bimport\(\s*"([^"]+)"\s*\)/g,
    /\brequire\(\s*"([^"]+)"\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of bundle.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.add(specifier);
    }
  }
  const builtins = new Set(builtinModules);
  return [...specifiers]
    .filter((s) => !s.startsWith(".") && !s.startsWith("/") && !s.startsWith("node:"))
    .filter((s) => !builtins.has(s))
    .map((s) => (s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : (s.split("/")[0] ?? s)))
    .toSorted()
    .filter((name, index, all) => all.indexOf(name) === index);
}

// `bun run build` as a program, which is what AC11 names — and because `Bun.build` called from
// inside the test runner does not resolve the workspace's `@soc/*` packages the way the CLI does.
const built = await sh(["bun", "scripts/build-package.ts"], ROOT);
const bundlePath = resolve(ROOT, OUTPUT);
const bundle = built.code === 0 ? await Bun.file(bundlePath).text() : "";
const files = await packedFiles(ROOT);

/**
 * AC11 — Given `bun run build`, When it completes, Then `dist/cli.js` exists, imports no path under
 * `apps/` or `packages/`, and its externals are exactly the root `dependencies`.
 */
describe("AC11 — the bundle", () => {
  test("dist/cli.js exists, is executable, and starts with the Bun shebang", async () => {
    expect(built.stderr).toBe("");
    expect(built.code).toBe(0);
    expect(await Bun.file(bundlePath).exists()).toBe(true);
    expect(bundle.startsWith("#!/usr/bin/env bun\n")).toBe(true);
  });

  test("imports no path under apps/ or packages/ — the workspace is inlined", () => {
    const imported = [...bundle.matchAll(/\bfrom\s+"([^"]+)"|import\(\s*"([^"]+)"\s*\)/g)]
      .map((m) => m[1] ?? m[2] ?? "")
      .filter((s) => /(^|\/)(apps|packages)\//.test(s) || s.startsWith("@soc/"));
    expect(imported).toEqual([]);
  });

  test("its externals are exactly the root dependencies", () => {
    expect(externalsOf(bundle)).toEqual(Object.keys(rootPackageJson.dependencies).toSorted());
  });
});

/** AC3 (integration half) — the guard against what `bun pm pack --dry-run` actually lists. */
describe("AC3 — the tarball", () => {
  test("lists only the package files and passes the guard", () => {
    expect(files.toSorted()).toEqual(["LICENSE", "README.md", "dist/cli.js", "package.json"]);
    expect(() => assertTarballClean(files)).not.toThrow();
    for (const path of files) {
      expect(path).not.toMatch(/fixtures\//);
      expect(path).not.toMatch(/apps\/mock-sentinel\//);
      expect(path).not.toMatch(/\.env/);
    }
  });
});

/**
 * The Phase 2 exit, and AC4: install the tarball into an empty directory and run the bin there.
 * AC4 — Given Bun on `PATH`, When `bunx isophase help` runs from an installed tarball, Then it
 * prints every command in the §4.3 table and exits 0.
 */
const stage = await mkdtemp(join(tmpdir(), "isophase-pack-"));
const packed = await sh(["bun", "pm", "pack", "--destination", stage], ROOT);
const tarball = join(stage, "aretea-group-isophase-0.0.0.tgz");
const consumer = await mkdtemp(join(tmpdir(), "isophase-consumer-"));
await Bun.write(join(consumer, "package.json"), '{"name":"consumer","private":true}\n');
const installed = await sh(["bun", "add", tarball], consumer);

describe("the installed package (Phase 2 exit)", () => {
  test("packs and installs into an empty directory", async () => {
    expect(packed.code).toBe(0);
    expect(await Bun.file(tarball).exists()).toBe(true);
    expect(installed.code).toBe(0);
    expect(await Bun.file(join(consumer, "node_modules/.bin/isophase")).exists()).toBe(true);
  });

  test("AC4 — bunx isophase help prints every command and exits 0", async () => {
    const result = await sh(["bunx", "isophase", "help"], consumer);
    expect(result.code).toBe(0);
    for (const name of ["init", "investigate", "console", "probe", "help"]) {
      expect(result.stdout).toMatch(new RegExp(`^  ${name}\\s`, "m"));
    }
  });

  test("bunx isophase --version prints the manifest version", async () => {
    const result = await sh(["bunx", "isophase", "--version"], consumer);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("0.0.0");
  });

  test("bunx isophase init --track defender writes .env and .data/runs with no repository", async () => {
    const result = await sh(["bunx", "isophase", "init", "--track", "defender"], consumer);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(await Bun.file(join(consumer, ".env")).exists()).toBe(true);
    expect((await stat(join(consumer, ".data/runs"))).isDirectory()).toBe(true);
    expect((await stat(join(consumer, ".data/runs/traces"))).isDirectory()).toBe(true);
    expect(result.stdout.trim().split("\n").at(-1)?.trim()).toBe("isophase probe");
  });

  test("help works from the installed package even with a broken environment", async () => {
    const result = await sh(["bunx", "isophase", "help", "investigate"], consumer, {
      INVESTIGATOR_THINKING_LEVEL: "bogus",
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("isophase investigate");
  });
});

/**
 * AC28 — Given a packed tarball and a machine state that has only Bun, When a scripted new-person
 * flow installs the tarball into an empty directory, runs `init --track defender`, `help`,
 * `--version`, and one `investigate --alert` against the lab, Then every step exits 0, `.env` and
 * `.data/runs` exist, and the run artifact appears under `.data/runs`.
 *
 * The first four steps are the suite above; this is the investigation, which needs the lab and a
 * provider key and costs a cent. The `.env` `init` wrote names Defender; the mock lab is selected
 * for this one process through the environment, which `.env` does not override.
 */
const labUrl = process.env["SENTINEL_BASE_URL"] ?? "http://localhost:8787";
const labUp = await fetch(`${labUrl}/health`, { signal: AbortSignal.timeout(2_000) })
  .then((r) => r.ok)
  .catch(() => false);
const hasKey = process.env["OPENAI_API_KEY"] !== undefined;
if (!labUp || !hasKey) {
  const reasons = [
    ...(labUp ? [] : ["Mock Sentinel is not reachable"]),
    ...(hasKey ? [] : ["OPENAI_API_KEY is not set"]),
  ];
  console.info(`[package] AC28 investigation skipped — ${reasons.join("; ")}.`);
}

describe.skipIf(!labUp || !hasKey)("AC28 — a new person's first investigation", () => {
  test("install, init, help, --version, then one investigation — every step exits 0", async () => {
    // Self-contained, so it holds when run alone: the steps above are repeated here in order.
    expect(installed.code).toBe(0);
    const initialised = await sh(
      ["bunx", "isophase", "init", "--track", "defender", "--force"],
      consumer,
    );
    expect(initialised.code).toBe(0);
    expect(await Bun.file(join(consumer, ".env")).exists()).toBe(true);
    expect((await stat(join(consumer, ".data/runs"))).isDirectory()).toBe(true);
    expect((await sh(["bunx", "isophase", "help"], consumer)).code).toBe(0);
    expect((await sh(["bunx", "isophase", "--version"], consumer)).stdout.trim()).toBe("0.0.0");

    const alerts = (await (await fetch(`${labUrl}/alerts`)).json()) as {
      value: { properties: { systemAlertId: string } }[];
    };
    const alertId = alerts.value[0]?.properties.systemAlertId;
    expect(alertId).toBeDefined();
    const result = await sh(
      ["bunx", "isophase", "investigate", "--alert", alertId ?? ""],
      consumer,
      {
        SECURITY_SOURCES: "sentinel",
        SENTINEL_CONNECTOR: "mock",
        SENTINEL_BASE_URL: labUrl,
      },
    );
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/1\/1 completed — wrote \.data\/runs\//);
    const glob = new Bun.Glob("*.json");
    const artifacts = [...glob.scanSync({ cwd: join(consumer, ".data/runs") })];
    expect(artifacts.length).toBe(1);
    const artifact = (await Bun.file(join(consumer, ".data/runs", artifacts[0] ?? "")).json()) as {
      status: string;
      provenance: { packageVersion?: string };
    };
    expect(artifact.status).toBe("completed");
    expect(artifact.provenance.packageVersion).toBe("0.0.0");
  }, 600_000);
});
