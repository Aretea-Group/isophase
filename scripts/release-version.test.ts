import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { distTagFor, publishFlags, stampVersion, versionFromTag } from "./release-version.ts";

/**
 * AC15 — Given a release tag that is not `vX.Y.Z` or `vX.Y.Z-<pre>`, When the version stamp step
 * runs, Then the job fails before publishing.
 */
describe("AC15 — the stamp refuses a malformed tag", () => {
  test.each([
    ["no v prefix", "0.1.1"],
    ["two components", "v0.1"],
    ["four components", "v0.1.1.1"],
    ["a branch name", "main"],
    ["a word", "release"],
    ["an empty pre-release", "v0.1.1-"],
    ["a build suffix", "v0.1.1+build.5"],
    ["leading garbage", "tag-v0.1.1"],
  ])("%s (%s) throws naming the tag", (_label, tag) => {
    expect(() => versionFromTag(tag)).toThrow(`"${tag}"`);
  });

  test("the stamp step fails as a program, before anything is written", async () => {
    const root = await mkdtemp(join(tmpdir(), "isophase-stamp-"));
    await Bun.write(join(root, "package.json"), '{"name":"x","version":"0.0.0"}\n');
    await expect(stampVersion(root, "v1")).rejects.toThrow("not vX.Y.Z");
    expect(
      ((await Bun.file(join(root, "package.json")).json()) as { version: string }).version,
    ).toBe("0.0.0");

    const proc = Bun.spawn(["bun", join(import.meta.dir, "release-version.ts"), "v1"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("refusing to stamp or publish");
  });

  test("a well-formed tag stamps package.json and a committed version is refused", async () => {
    const root = await mkdtemp(join(tmpdir(), "isophase-stamp-"));
    await Bun.write(join(root, "package.json"), '{"name":"x","version":"0.0.0"}\n');
    expect(await stampVersion(root, "v0.1.1")).toBe("0.1.1");
    expect(
      ((await Bun.file(join(root, "package.json")).json()) as { version: string }).version,
    ).toBe("0.1.1");
    // Stamping again finds 0.1.1, not 0.0.0: the guard that git never carries a version.
    await expect(stampVersion(root, "v0.1.2")).rejects.toThrow("not 0.0.0");
  });
});

/**
 * AC16 — Given a pre-release tag, When the publish step runs, Then it passes `--tag next`; given a
 * release tag, it passes no dist-tag.
 */
describe("AC16 — pre-releases go to next, releases to the default", () => {
  const cases: [string, string, "next" | undefined, string[]][] = [
    ["v0.1.1", "0.1.1", undefined, []],
    ["v1.0.0", "1.0.0", undefined, []],
    ["v0.2.0-rc.1", "0.2.0-rc.1", "next", ["--tag", "next"]],
    ["v0.2.0-beta", "0.2.0-beta", "next", ["--tag", "next"]],
    ["v0.2.0-alpha.3.x", "0.2.0-alpha.3.x", "next", ["--tag", "next"]],
  ];
  test.each(cases)("%s", (tag, version, distTag, flags) => {
    expect(versionFromTag(tag)).toBe(version);
    expect(distTagFor(version)).toBe(distTag);
    expect(publishFlags(version)).toEqual(flags);
  });
});
