import { describe, expect, test } from "bun:test";

/**
 * The load-bearing test for PRD-2 §20.
 *
 * The scenario fixtures hold the answer key — each one's verdict, the KQL that settles it, and the
 * wrong conclusion it was built to catch. An agent that can read them does not have to investigate,
 * and every result produced afterwards would be worthless without anyone noticing. Mock Sentinel
 * carries the same guard for its REST surface (`apps/mock-sentinel/test/scenarios.test.ts`); this is
 * the investigator's half.
 *
 * The oxlint `no-restricted-imports` rule blocks a static import of either the fixtures or the
 * loader. That is necessary and not sufficient: the realistic leak is a runtime read —
 * `Bun.file("fixtures/scenarios/…")` or a path assembled at runtime — which no import rule can see.
 * So this scans source text instead, which catches both.
 */
const ROOTS = ["apps/investigator/src", "packages/sentinel-client/src"] as const;

/** Anything naming the answer key, however it is reached. */
const FORBIDDEN: string[] = [
  "fixtures/scenarios",
  "scenarios/scenarios.ts",
  "loadScenarios",
  "discriminatingEvidence",
  "startingAlertId",
  "evaluatorNotes",
];

function sourceFiles(): Promise<{ path: string; text: string }[]> {
  const glob = new Bun.Glob("**/*.ts");
  const paths = ROOTS.flatMap((root) => Array.from(glob.scanSync({ cwd: root, absolute: true })));
  return Promise.all(paths.map(async (path) => ({ path, text: await Bun.file(path).text() })));
}

const files = await sourceFiles();

describe("ground-truth isolation", () => {
  test("the scan covers a non-trivial number of files", () => {
    // Guards the guard: a glob that silently matched nothing would pass every assertion below.
    expect(files.length).toBeGreaterThan(10);
  });

  test.each(FORBIDDEN)("no agent-side source references %s", (needle) => {
    const offenders = files.filter((f) => f.text.includes(needle)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  test("no agent-side source reads the fixtures directory at runtime", () => {
    // Catches Bun.file / readFile / import() against a scenarios path, however it is spelled.
    const pattern = /(?:Bun\.file|readFile|readFileSync|import)\s*\(\s*[^)]*scenarios/i;
    const offenders = files.filter((f) => pattern.test(f.text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
