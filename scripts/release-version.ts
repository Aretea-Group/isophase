#!/usr/bin/env bun
/**
 * Stamp the release tag's version into `package.json` (PRD-11 §4.1 D4).
 *
 *     bun scripts/release-version.ts v0.1.1        # package.json version becomes 0.1.1
 *     bun scripts/release-version.ts v0.2.0-rc.1   # 0.2.0-rc.1, and the dist-tag is `next`
 *
 * Git keeps `0.0.0`; the version a consumer sees comes from the tag and nowhere else, so a stale
 * committed version can never be published. The tag must be `vX.Y.Z` or `vX.Y.Z-<pre>`; anything
 * else fails here, before the build and before `npm publish` (AC15). A pre-release publishes under
 * the `next` dist-tag so `bunx @aretea-group/isophase` never resolves to one (AC16).
 *
 * Runs *before* `bun run build`: the dispatcher and the investigator's provenance read the version
 * through a static import of `package.json`, so the bundle carries whatever is stamped when it is
 * built. The dist-tag is written to `$GITHUB_OUTPUT` as `dist_tag_flag` for the publish step.
 */
import { resolve } from "node:path";

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** The version a tag names, or a throw naming the tag and the two accepted shapes. */
export function versionFromTag(tag: string): string {
  const match = RELEASE_TAG.exec(tag.trim());
  if (match === null) {
    throw new Error(
      `Release tag "${tag}" is not vX.Y.Z or vX.Y.Z-<pre>; refusing to stamp or publish.`,
    );
  }
  const [, major, minor, patch, pre] = match;
  return `${major}.${minor}.${patch}${pre === undefined ? "" : `-${pre}`}`;
}

/** `next` for a pre-release, nothing for a release — `latest` is npm's default and stays implicit. */
export function distTagFor(version: string): "next" | undefined {
  return version.includes("-") ? "next" : undefined;
}

/** The extra arguments `npm publish` gets: `--tag next` for a pre-release, none otherwise. */
export function publishFlags(version: string): string[] {
  const tag = distTagFor(version);
  return tag === undefined ? [] : ["--tag", tag];
}

export async function stampVersion(root: string, tag: string): Promise<string> {
  const version = versionFromTag(tag);
  const path = resolve(root, "package.json");
  const manifest = (await Bun.file(path).json()) as Record<string, unknown>;
  if (manifest["version"] !== "0.0.0") {
    throw new Error(
      `package.json version is "${String(manifest["version"])}", not 0.0.0 — git must not carry a version.`,
    );
  }
  manifest["version"] = version;
  await Bun.write(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return version;
}

if (import.meta.main) {
  try {
    const tag = Bun.argv[2] ?? process.env["GITHUB_REF_NAME"];
    if (tag === undefined || tag === "") throw new Error("usage: release-version.ts <tag>");
    const version = await stampVersion(resolve(import.meta.dir, ".."), tag);
    const flags = publishFlags(version).join(" ");
    console.info(
      `[release] package.json version is now ${version}${flags === "" ? "" : ` (${flags})`}`,
    );
    const output = process.env["GITHUB_OUTPUT"];
    if (output !== undefined) {
      await Bun.write(
        output,
        `${await Bun.file(output)
          .text()
          .catch(() => "")}version=${version}\ndist_tag_flag=${flags}\n`,
      );
    }
  } catch (error) {
    console.error(`[release] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
