import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

/**
 * The release workflow's shape (PRD-11 §4.1 D4), read back from the file rather than asserted
 * about — like the ruleset, it is configuration that decides what can reach npm, and a drive-by
 * edit to it should fail here before it fails on a Release.
 */
const ROOT = resolve(import.meta.dir, "..");
const WORKFLOWS = join(ROOT, ".github/workflows");

interface Workflow {
  /** YAML reads a bare `on` as the boolean `true`, so the trigger map lands under that key. */
  true: Record<string, { types?: string[] } | null>;
  permissions: Record<string, string>;
  jobs: Record<
    string,
    { permissions?: Record<string, string>; steps: { run?: string; uses?: string }[] }
  >;
}

const text = await Bun.file(join(WORKFLOWS, "release.yml")).text();
const workflow = Bun.YAML.parse(text) as Workflow;
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
const runs = steps.map((step) => step.run ?? "").filter((run) => run !== "");

/**
 * AC14 — Given `release.yml`, When read, Then it triggers only on `release: published`, declares
 * `id-token: write` and `contents: read` and nothing more, and runs `bun run check` before
 * `bun run build`.
 */
describe("AC14 — release.yml", () => {
  test("triggers only on a published Release", () => {
    expect(Object.keys(workflow.true)).toEqual(["release"]);
    expect(workflow.true["release"]?.types).toEqual(["published"]);
  });

  test("declares contents: read and id-token: write and nothing more", () => {
    expect(workflow.permissions).toEqual({ contents: "read", "id-token": "write" });
    for (const job of Object.values(workflow.jobs)) expect(job.permissions).toBeUndefined();
  });

  test("runs bun run check before the stamp, the build, and the publish — in that order", () => {
    const at = (needle: string): number => runs.findIndex((run) => run.includes(needle));
    expect(at("bun run check")).toBeGreaterThanOrEqual(0);
    expect(at("bun run check")).toBeLessThan(at("scripts/release-version.ts"));
    expect(at("scripts/release-version.ts")).toBeLessThan(at("bun run build"));
    expect(at("bun run build")).toBeLessThan(at("npm publish"));
  });

  test("publishes with npm, publicly, with the stamp's dist-tag flag", () => {
    const publish = runs.find((run) => run.includes("npm publish"));
    expect(publish).toContain("--access public");
    expect(publish).toContain("steps.version.outputs.dist_tag_flag");
    expect(runs.some((run) => run.includes("bun publish"))).toBe(false);
  });

  test("checks out the Release's tag and is named release.yml for the trusted publisher", () => {
    expect(text).toContain("ref: ${{ github.event.release.tag_name }}");
    expect(text).toContain("npm install -g npm@11");
  });
});

/**
 * AC17 — Given the repository's secrets and every workflow file, When scanned, Then no `NPM_TOKEN`
 * or `NODE_AUTH_TOKEN` is referenced. The secrets half is `gh secret list`, recorded in the PRD;
 * this is the files half, over every workflow and not only the release.
 */
describe("AC17 — no npm token anywhere", () => {
  test("no workflow references NPM_TOKEN or NODE_AUTH_TOKEN", async () => {
    const glob = new Bun.Glob("*.yml");
    const files = [...glob.scanSync({ cwd: WORKFLOWS })];
    expect(files).toContain("release.yml");
    const offenders: string[] = [];
    await Promise.all(
      files.map(async (file) => {
        const body = await Bun.file(join(WORKFLOWS, file)).text();
        // Comments stripped: the release file is allowed to say what it does not use.
        const code = body.replace(/^\s*#.*$/gm, "");
        if (/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./.test(code)) offenders.push(file);
      }),
    );
    expect(offenders).toEqual([]);
  });
});
