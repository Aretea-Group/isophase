#!/usr/bin/env bun
/**
 * The release build: `bun run build` (PRD-11 §4.1 D1, ADR 014).
 *
 * Bundles the dispatcher and everything it reaches into `dist/cli.js` with the four workspace
 * members inlined and every third-party package external, prepends the Bun shebang, and then
 * refuses to leave a `dist/` behind if the tarball `bun pm pack` would produce lists anything from
 * the lab or a secret. CI-only by design: `dist/` is ignored and never committed, and nothing in
 * development reads it — the `bun run` scripts and the published bin share one dispatcher.
 *
 * Two facts measured in PRD-11 Phase 0 shape this file. Bun's `--packages external` also
 * externalises `workspace:*` members, so the externals are named explicitly; and `--banner`
 * emits the shebang after Bun's own preamble, which fails with a syntax error, so it is prepended
 * after the build.
 *
 * The version is whatever `package.json` carries: release-please bumps it in its release pull
 * request (PRD-11 §11 A2), and `apps/cli/src/index.ts` and the investigator's provenance read it
 * through a static import, so the bundle built at the release tag carries the released version.
 */
import { chmod } from "node:fs/promises";
import { resolve } from "node:path";

/** Every third-party package the bundle may import; everything else is inlined. */
export const EXTERNALS = [
  "@earendil-works/*",
  "@opentui/*",
  "@azure/*",
  "@t3-oss/*",
  "zod",
] as const;

export const ENTRYPOINT = "apps/cli/src/index.ts";
export const OUTPUT = "dist/cli.js";
const SHEBANG = "#!/usr/bin/env bun\n";

/**
 * What must never be in the tarball (AC3). The lab — fixtures and Mock Sentinel — because the
 * package is Track A only and the fixtures carry the answer key; any `.env` because it carries
 * credentials; `.data/` and `runs/` because they carry tenant data and measurements. `files` in
 * `package.json` already excludes them; this is the check that `files` was not edited into
 * including them.
 */
const FORBIDDEN_PATHS: readonly { label: string; test: (path: string) => boolean }[] = [
  { label: "fixtures/", test: (path) => /(^|\/)fixtures\//.test(path) },
  { label: "apps/mock-sentinel/", test: (path) => /(^|\/)apps\/mock-sentinel\//.test(path) },
  { label: "a .env file", test: (path) => /(^|\/)\.env(\.|$)/.test(path) },
  { label: ".data/", test: (path) => /(^|\/)\.data\//.test(path) },
  { label: "runs/", test: (path) => /(^|\/)runs\//.test(path) },
];

/** Throws naming every offending path, so a failed build says what it refused and why. */
export function assertTarballClean(paths: readonly string[]): void {
  const offenders = paths.flatMap((path) =>
    FORBIDDEN_PATHS.filter(({ test }) => test(path)).map(({ label }) => `${path} (${label})`),
  );
  if (offenders.length > 0) {
    throw new Error(
      `The tarball would ship files that must never be published:\n  ${offenders.join("\n  ")}`,
    );
  }
}

/** The file list from `bun pm pack --dry-run`'s output: one `packed <size> <path>` line per file. */
export function parsePackOutput(output: string): string[] {
  return output
    .split("\n")
    .map((line) => /^packed\s+\S+\s+(.+?)\s*$/.exec(line)?.[1])
    .filter((path): path is string => path !== undefined);
}

export async function packedFiles(root: string): Promise<string[]> {
  const proc = Bun.spawn(["bun", "pm", "pack", "--dry-run"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`bun pm pack --dry-run failed:\n${stderr}`);
  const files = parsePackOutput(stdout);
  if (files.length === 0) throw new Error(`bun pm pack --dry-run listed no files:\n${stdout}`);
  return files;
}

export async function buildBundle(root: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [resolve(root, ENTRYPOINT)],
    outdir: resolve(root, "dist"),
    naming: "cli.js",
    target: "bun",
    external: [...EXTERNALS],
  });
  if (!result.success) {
    throw new Error(`bundle failed:\n${result.logs.map((log) => String(log)).join("\n")}`);
  }
  const path = resolve(root, OUTPUT);
  const bundled = await Bun.file(path).text();
  await Bun.write(path, bundled.startsWith(SHEBANG) ? bundled : SHEBANG + bundled);
  await chmod(path, 0o755);
  return path;
}

export async function buildPackage(root: string, log = console.info): Promise<void> {
  const path = await buildBundle(root);
  log(`[build] wrote ${OUTPUT} (${(Bun.file(path).size / 1024).toFixed(0)} KB)`);
  const files = await packedFiles(root);
  assertTarballClean(files);
  log(`[build] tarball would carry ${files.length} file(s): ${files.join(", ")}`);
}

if (import.meta.main) {
  try {
    await buildPackage(resolve(import.meta.dir, ".."));
  } catch (error) {
    console.error(`[build] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
