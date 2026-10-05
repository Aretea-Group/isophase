#!/usr/bin/env bun
/**
 * The version the release publishes, and the dist-tag it gets (PRD-11 §4.1 D4, §11 A2).
 *
 *     bun scripts/release-version.ts            # reads package.json; writes $GITHUB_OUTPUT
 *
 * release-please owns the version: its release pull request bumps `package.json`, and the tag it
 * creates on merge is `v<that version>`. This script no longer stamps anything — it reads the
 * version back, refuses one that is not a semantic version, confirms it matches the tag when one
 * is given, and emits `dist_tag_flag` for `npm publish`: `--tag next` for a pre-release so
 * `bunx @aretea-group/isophase` never resolves to one (AC16), nothing for a release.
 *
 * The dispatcher and the investigator's provenance read the same `package.json` through a static
 * import, so the bundle built after this carries the same string `--version` prints.
 */
import { resolve } from "node:path";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** The version `package.json` carries, or a throw naming what was found. */
export function releaseVersion(manifestVersion: unknown, tag?: string): string {
  const version = typeof manifestVersion === "string" ? manifestVersion.trim() : "";
  const match = SEMVER.exec(version);
  if (match === null || match[4] === "") {
    throw new Error(
      `package.json version "${String(manifestVersion)}" is not X.Y.Z or X.Y.Z-<pre>; refusing to publish.`,
    );
  }
  if (tag !== undefined && tag !== "" && tag !== `v${version}`) {
    throw new Error(
      `Tag "${tag}" does not match package.json version ${version}; refusing to publish.`,
    );
  }
  return version;
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

if (import.meta.main) {
  try {
    const manifest = (await Bun.file(resolve(import.meta.dir, "../package.json")).json()) as {
      version?: unknown;
    };
    const version = releaseVersion(manifest.version, Bun.argv[2] ?? process.env["GITHUB_REF_NAME"]);
    const flags = publishFlags(version).join(" ");
    console.info(`[release] publishing ${version}${flags === "" ? "" : ` (${flags})`}`);
    const output = process.env["GITHUB_OUTPUT"];
    if (output !== undefined) {
      const existing = await Bun.file(output)
        .text()
        .catch(() => "");
      await Bun.write(output, `${existing}version=${version}\ndist_tag_flag=${flags}\n`);
    }
  } catch (error) {
    console.error(`[release] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
