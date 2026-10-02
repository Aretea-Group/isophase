import { describe, expect, test } from "bun:test";

import { assertTarballClean, parsePackOutput } from "./build-package.ts";

/**
 * AC3 (unit half) — Given the packed tarball, When its file list is read, Then it contains no path
 * under `fixtures/`, `apps/mock-sentinel/` or any `.env`, and the build fails if it would.
 *
 * The guard itself, against lists it must refuse and the one it must accept. The integration half —
 * the guard against what `bun pm pack --dry-run` actually lists — is in
 * `apps/cli/test/integration/package.test.ts`.
 */
describe("the tarball guard", () => {
  test("the intended four files pass", () => {
    expect(() =>
      assertTarballClean(["package.json", "LICENSE", "README.md", "dist/cli.js"]),
    ).not.toThrow();
  });

  test.each([
    ["a scenario fixture", "fixtures/scenarios/scenarios.ts"],
    ["telemetry", "fixtures/telemetry/SecurityAlert.csv"],
    ["Mock Sentinel source", "apps/mock-sentinel/src/index.ts"],
    ["the .env", ".env"],
    ["a nested .env", "apps/console/.env"],
    ["an .env variant", ".env.local"],
    ["tenant data", ".data/defender-runs/x.json"],
    ["a run artifact", "runs/01a0.json"],
  ])("%s is refused and named", (_label, path) => {
    expect(() => assertTarballClean(["package.json", "dist/cli.js", path])).toThrow(path);
  });

  test("the example template and similarly named files are not confused with secrets", () => {
    // `.env.example` is a template and is still not shipped — `files` excludes it — but the guard
    // is about credentials and tenant data, so a near-name must not be a false positive either way.
    expect(() => assertTarballClean(["dist/environment.js", "docs/dotenv.md"])).not.toThrow();
  });

  test("parsePackOutput reads bun pm pack's listing and ignores the rest", () => {
    const output = [
      "bun pack v1.3.4",
      "",
      "packed 1.1KB LICENSE",
      "packed 29.69KB README.md",
      "packed 0.43MB dist/cli.js",
      "packed 452B package.json",
      "",
      "aretea-group-isophase-0.0.0.tgz",
      "",
      "Total files: 4",
    ].join("\n");
    expect(parsePackOutput(output)).toEqual([
      "LICENSE",
      "README.md",
      "dist/cli.js",
      "package.json",
    ]);
  });
});
