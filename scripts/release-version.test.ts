import { describe, expect, test } from "bun:test";

import { distTagFor, publishFlags, releaseVersion } from "./release-version.ts";

/**
 * The publish step's two decisions (PRD-11 §4.1 D4 as amended by §11 A2). release-please owns the
 * version; this only reads it back, refuses nonsense, and picks the dist-tag.
 */
describe("the version the publish step reads", () => {
  test.each([
    ["a release", "0.1.1", "0.1.1"],
    ["a pre-release", "0.2.0-rc.1", "0.2.0-rc.1"],
  ])("%s is accepted", (_label, manifest, version) => {
    expect(releaseVersion(manifest)).toBe(version);
    expect(releaseVersion(manifest, `v${version}`)).toBe(version);
  });

  test.each([
    ["a v prefix", "v0.1.1"],
    ["two components", "0.1"],
    ["an empty pre-release", "0.1.1-"],
    ["a build suffix", "0.1.1+build.5"],
    ["a word", "latest"],
    ["nothing", undefined],
  ])("%s is refused before anything is published", (_label, manifest) => {
    expect(() => releaseVersion(manifest)).toThrow("refusing to publish");
  });

  test("a tag that disagrees with package.json is refused", () => {
    expect(() => releaseVersion("0.1.1", "v0.1.2")).toThrow("does not match");
  });

  test("the program reads the real manifest and exits zero", async () => {
    const proc = Bun.spawn(["bun", `${import.meta.dir}/release-version.ts`], {
      cwd: `${import.meta.dir}/..`,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(stdout).toContain("[release] publishing ");
  });

  test("the program refuses a tag that disagrees with the manifest", async () => {
    const proc = Bun.spawn(["bun", `${import.meta.dir}/release-version.ts`, "v99.0.0"], {
      cwd: `${import.meta.dir}/..`,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("does not match");
  });
});

/**
 * AC16 — Given a pre-release tag, When the publish step runs, Then it passes `--tag next`; given a
 * release tag, it passes no dist-tag.
 */
describe("AC16 — pre-releases go to next, releases to the default", () => {
  const cases: [string, "next" | undefined, string[]][] = [
    ["0.1.1", undefined, []],
    ["1.0.0", undefined, []],
    ["0.2.0-rc.1", "next", ["--tag", "next"]],
    ["0.2.0-beta", "next", ["--tag", "next"]],
    ["0.2.0-alpha.3.x", "next", ["--tag", "next"]],
  ];
  test.each(cases)("%s", (version, distTag, flags) => {
    expect(distTagFor(version)).toBe(distTag);
    expect(publishFlags(version)).toEqual(flags);
  });
});
