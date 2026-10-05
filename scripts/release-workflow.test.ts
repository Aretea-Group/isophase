import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

/**
 * The release workflow's shape (PRD-11 §4.1 D4 as amended by §11 A2, ADR 014 §6), read back from
 * the file rather than asserted about — it is the configuration that decides what reaches npm, and
 * a drive-by edit to it should fail here before it fails on a release.
 */
const ROOT = resolve(import.meta.dir, "..");
const WORKFLOWS = join(ROOT, ".github/workflows");

interface Step {
  id?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}
interface Job {
  needs?: string;
  if?: string;
  permissions?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  /** YAML reads a bare `on` as the boolean `true`, so the trigger map lands under that key. */
  true: Record<string, { branches?: string[] } | null>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
}

const text = await Bun.file(join(WORKFLOWS, "release.yml")).text();
const workflow = Bun.YAML.parse(text) as Workflow;
const releasePlease = workflow.jobs["release-please"];
const publish = workflow.jobs["publish"];
const runs = (publish?.steps ?? []).map((step) => step.run ?? "").filter((run) => run !== "");

/**
 * AC29 — Given `release.yml`, When read, Then it triggers only on pushes to `main`; a
 * `release-please` job with `contents: write` and `pull-requests: write` is the only job that can
 * write to the repository; `publish` runs only when that job reports `release_created`, checks out
 * the tag it names, runs `bun run check` before `bun run build` before `npm publish`, and the
 * `NPM_TOKEN` secret reaches the publish step alone, as `NODE_AUTH_TOKEN`, with `--provenance`.
 */
describe("AC29 — release.yml", () => {
  test("triggers only on pushes to main", () => {
    expect(Object.keys(workflow.true)).toEqual(["push"]);
    expect(workflow.true["push"]?.branches).toEqual(["main"]);
  });

  test("the workflow default is read-only; only release-please can write", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(releasePlease?.permissions).toEqual({ contents: "write", "pull-requests": "write" });
    expect(publish?.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(Object.keys(workflow.jobs)).toEqual(["release-please", "publish"]);
  });

  test("release-please is the pinned action over the committed config and manifest", () => {
    const step = releasePlease?.steps.find((s) =>
      s.uses?.startsWith("googleapis/release-please-action@"),
    );
    expect(step).toBeDefined();
    expect(step?.with?.["config-file"]).toBe("release-please-config.json");
    expect(step?.with?.["manifest-file"]).toBe(".release-please-manifest.json");
  });

  test("publish waits for release-please and runs only when a release was created", () => {
    expect(publish?.needs).toBe("release-please");
    expect(publish?.if).toBe("needs.release-please.outputs.release_created == 'true'");
    const checkout = publish?.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["ref"]).toBe("${{ needs.release-please.outputs.tag_name }}");
  });

  test("runs bun run check before the version read, the build, and the publish — in that order", () => {
    const at = (needle: string): number => runs.findIndex((run) => run.includes(needle));
    expect(at("bun run check")).toBeGreaterThanOrEqual(0);
    expect(at("bun run check")).toBeLessThan(at("scripts/release-version.ts"));
    expect(at("scripts/release-version.ts")).toBeLessThan(at("bun run build"));
    expect(runs[at("scripts/release-version.ts")]).toContain(
      "${{ needs.release-please.outputs.tag_name }}",
    );
    expect(at("bun run build")).toBeLessThan(at("npm publish"));
  });

  test("publishes with npm, publicly, with provenance and the dist-tag flag", () => {
    const step = publish?.steps.find((s) => s.run?.includes("npm publish"));
    expect(step?.run).toContain("--access public");
    expect(step?.run).toContain("--provenance");
    expect(step?.run).toContain("steps.version.outputs.dist_tag_flag");
    expect(runs.some((run) => run.includes("bun publish"))).toBe(false);
  });

  test("the token reaches the publish step alone, as NODE_AUTH_TOKEN (ADR 014 §6)", async () => {
    const step = publish?.steps.find((s) => s.run?.includes("npm publish"));
    expect(step?.env).toEqual({ NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}" });
    // Nowhere else: not on another step, not at job level, not in any other workflow.
    const others = Object.values(workflow.jobs)
      .flatMap((job) => job.steps)
      .filter((s) => s !== step)
      .filter((s) => JSON.stringify(s).includes("secrets."));
    expect(others).toEqual([]);
    const glob = new Bun.Glob("*.yml");
    const otherFiles = [...glob.scanSync({ cwd: WORKFLOWS })].filter((f) => f !== "release.yml");
    const bodies = await Promise.all(
      otherFiles.map(async (file) =>
        (await Bun.file(join(WORKFLOWS, file)).text()).replace(/^\s*#.*$/gm, ""),
      ),
    );
    for (const code of bodies) expect(code).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);
  });
});

describe("release-please's committed state", () => {
  test("the manifest's version is package.json's", async () => {
    const manifest = (await Bun.file(join(ROOT, ".release-please-manifest.json")).json()) as Record<
      string,
      string
    >;
    const pkg = (await Bun.file(join(ROOT, "package.json")).json()) as { version: string };
    expect(manifest["."]).toBe(pkg.version);
  });

  test("tags are v<version> with no component, and the pre-1.0 bump flags are gone", async () => {
    const config = (await Bun.file(join(ROOT, "release-please-config.json")).json()) as Record<
      string,
      unknown
    >;
    expect(config["release-type"]).toBe("node");
    expect(config["include-v-in-tag"]).toBe(true);
    expect(config["include-component-in-tag"]).toBe(false);
    // Removed with the 1.0.0 release: after a major they have no effect and would only mislead.
    expect(config["bump-minor-pre-major"]).toBeUndefined();
    expect(config["bump-patch-for-minor-pre-major"]).toBeUndefined();
  });
});
