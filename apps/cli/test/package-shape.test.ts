import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import rootPackageJson from "../../../package.json" with { type: "json" };

const repositoryRoot = resolve(import.meta.dir, "../../..");

/** The §4.3 package shape, pinned so a drive-by edit to the manifest fails here rather than on npm. */
describe("the package manifest (PRD-11 §4.3)", () => {
  test("name, bin, files, engines, and no private flag", () => {
    expect(rootPackageJson.name).toBe("@aretea-group/isophase");
    expect(rootPackageJson.bin).toEqual({ isophase: "dist/cli.js" });
    expect(rootPackageJson.files).toEqual(["dist", "README.md", "LICENSE"]);
    expect(rootPackageJson.engines.bun).toBe(">=1.3.0");
    expect("private" in rootPackageJson).toBe(false);
  });

  test("AC21 — git's package.json version is 0.0.0", () => {
    expect(rootPackageJson.version).toBe("0.0.0");
  });

  test("the lab's HTTP framework is not a published dependency", () => {
    expect(Object.keys(rootPackageJson.dependencies)).not.toContain("hono");
  });
});

/**
 * AC24 — Given `AGENTS.md` after Phase 2, When read, Then §2 lists "`init` provisions nothing in a
 * tenant" and "the lab is not published", and §5 names `dist/` as CI-only build output.
 */
describe("AC24 — AGENTS.md carries the package's rules", () => {
  test("§2 has both non-goals and §5 names dist/", async () => {
    const text = await Bun.file(resolve(repositoryRoot, "AGENTS.md")).text();
    const section2 = text.slice(text.indexOf("## 2. Current Scope"), text.indexOf("## 3."));
    expect(section2).toContain("`init` provisions nothing in a tenant");
    expect(section2).toContain("the lab is not published");
    const section5 = text.slice(text.indexOf("## 5. Repository Shape"), text.indexOf("## 6."));
    expect(section5).toMatch(/dist\/\s+CI-only build output/);
  });

  test("the build-step rule has its two halves", async () => {
    const text = await Bun.file(resolve(repositoryRoot, "AGENTS.md")).text();
    expect(text).toContain("There is no build step for development");
    expect(text).toContain("never\ncommitted");
  });
});
