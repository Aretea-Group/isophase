import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

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
/**
 * Agent-side source: every tree whose code shares a process with a running agent.
 *
 * `apps/console/src` joins the list under PRD-5. Before it the console was a separate read-only
 * program and this was hygiene; PRD-5 §5.1 executes investigations *inside* the console process, so
 * console source is agent-side source and this is load-bearing. It is also why the queue's scenario
 * mapping arrives as a generated ids-only artifact rather than a read of the fixtures (PRD-5 §7).
 */
const ROOTS = [
  "apps/investigator/src",
  "packages/sentinel-client/src",
  "apps/console/src",
] as const;

/**
 * Individual files outside those trees that still have to be scanned (PRD-8 AC14).
 *
 * `scripts/` as a whole can never be a root: `evaluate-runs.ts` reads the answer key on purpose,
 * which is the entire point of ground truth flowing one way, and .oxlintrc.json exempts the
 * directory for exactly that reason. But `scripts/probe-defender.ts` talks to a live security
 * tenant and writes what it learns to disk, so it is agent-adjacent in the way this scan cares
 * about — named here one file at a time rather than by widening the exemption.
 */
const FILES = ["scripts/probe-defender.ts"] as const;

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
  const paths = [
    ...ROOTS.flatMap((root) => Array.from(glob.scanSync({ cwd: root, absolute: true }))),
    ...FILES.map((file) => resolve(repositoryRoot, file)),
  ];
  return Promise.all(paths.map(async (path) => ({ path, text: await Bun.file(path).text() })));
}

/**
 * Comment- and string-stripped text, so a call-shape scan cannot be tripped by prose.
 *
 * The needle scans above deliberately run against raw text — a forbidden name in a comment is still
 * a leak of intent. A *call-shape* scan is the opposite: it must not fire on a sentence describing
 * the pattern it forbids, or this file could not document itself.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * The repository root, derived from this file rather than from the working directory.
 *
 * `ROOTS` are relative and `Bun.Glob` resolves them against `process.cwd()`, which is the
 * repository root under `bun test`. `FILES` must resolve the same way whether the suite is run from
 * the root or from a package directory, and a scan that silently found nothing would pass every
 * assertion below.
 */
const repositoryRoot = resolve(import.meta.dir, "../../..");

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

  /**
   * The needle scan above only fires when "scenarios" appears literally inside the call, so it
   * cannot see `Bun.file(userSuppliedPath)`. Today no agent-side code reads a file by a path it was
   * handed, and this keeps it that way: PRD-5 adds an analyst free-text field, and the obvious
   * next request — "let me point it at a file" — would put an arbitrary read into the one tree
   * whose entire security property is that it cannot reach the answer key (PRD-5 §9).
   *
   * Scoped to `apps/investigator/src`: see the comment in the body for why the console is exempt.
   */
  test("the investigator reads no file by a caller-supplied path", () => {
    // Scoped to the investigator, not to every root. The console reads run artifacts and
    // transcripts by paths it computes from its own configuration — that is its entire job, and
    // those paths come from the console's env, never from a model or an operator. The investigator
    // is the tree where a handed-in path would reach the agent, so it is the tree that is scanned.
    const pattern = /(?:Bun\.file|readFileSync|readFile)\s*\(\s*(?!["'`)])/;
    const offenders = files
      .filter((f) => f.path.includes("/apps/investigator/src/"))
      .filter((f) => pattern.test(stripComments(f.text)))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
