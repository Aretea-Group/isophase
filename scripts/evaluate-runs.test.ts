import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadScenarios } from "../apps/mock-sentinel/src/scenarios/scenarios.ts";
import { conditionOf, labelsFor } from "./evaluate/condition.ts";

/**
 * The scoring binary, driven end to end against synthetic corpora in a temp directory.
 *
 * Nothing under the real `runs/` is read or written: every case builds exactly the artifacts it
 * needs and points `--runs` at them, which is what lets a test assert "the archive is scored"
 * without depending on whether anyone has archived anything today.
 *
 * Alert ids come from the fixtures at run time rather than being hard-coded. They are
 * content-addressed (ADR 004), so a rule edit re-pins them — and a test carrying a stale literal
 * would fail for a reason that has nothing to do with what it is testing. `scripts/` is the one
 * tree exempt from both ground-truth guards, which is why this join is legal here and nowhere else.
 */

const scenarios = await loadScenarios();
const truePositive = scenarios.find((scenario) => scenario.verdict === "true-positive");
const falsePositive = scenarios.find((scenario) => scenario.verdict === "false-positive");
if (truePositive === undefined || falsePositive === undefined) {
  throw new Error("The corpus must hold at least one true positive and one false positive.");
}

interface DrawSpec {
  alertId: string;
  tpPercent?: number;
  status?: "completed" | "failed";
  errorName?: string;
}

interface RunSpec {
  runId: string;
  model?: string;
  thinkingLevel?: string;
  modelBaseUrl?: string;
  modelContextWindow?: number;
  modelMaxTokens?: number;
  analystContext?: string;
  status?: "running" | "completed" | "interrupted" | "failed";
  error?: { name: string; message: string };
  derivedFrom?: { runId: string; alertId: string };
  promptHash?: string;
  /** `null` produces a legacy artifact with no neutral source block. */
  source?: {
    kind: string;
    connector: string;
    target: string;
    queryLanguage: string;
  } | null;
  draws?: DrawSpec[];
}

const DEFAULT_SOURCE = {
  kind: "microsoft-sentinel",
  connector: "mock-sentinel-rest",
  target: "http://localhost:8787",
  queryLanguage: "kql",
} as const;

function result(draw: DrawSpec, at: string): Record<string, unknown> {
  const outcome =
    draw.status === "failed"
      ? { error: { name: draw.errorName ?? "InvestigationTimeoutError", message: "synthetic" } }
      : {
          summary: {
            tpPercent: draw.tpPercent ?? 50,
            tpReason: "synthetic",
            fpPercent: 100 - (draw.tpPercent ?? 50),
            fpReason: "synthetic",
            whatHappened: "synthetic",
            keyEvidence: ["synthetic"],
            researchDone: ["synthetic"],
          },
        };
  return {
    alertId: draw.alertId,
    alertTitle: "synthetic",
    status: draw.status ?? "completed",
    startedAt: at,
    completedAt: at,
    durationMs: 1_000,
    ...outcome,
  };
}

function artifact(spec: RunSpec): string {
  const at = "2026-08-20T10:00:00.000Z";
  const source = spec.source === undefined ? DEFAULT_SOURCE : spec.source;
  return JSON.stringify({
    runId: spec.runId,
    startedAt: at,
    completedAt: at,
    ...(spec.status === undefined ? {} : { status: spec.status }),
    ...(spec.error === undefined ? {} : { error: spec.error }),
    config: {
      thinkingLevel: spec.thinkingLevel ?? "medium",
      resultMaxChars: 40_000,
      ...(source === null ? { sentinelBaseUrl: "http://localhost:8787" } : { source }),
      webSearchConfigured: true,
      ...(spec.modelBaseUrl === undefined ? {} : { modelBaseUrl: spec.modelBaseUrl }),
      ...(spec.modelContextWindow === undefined
        ? {}
        : { modelContextWindow: spec.modelContextWindow }),
      ...(spec.modelMaxTokens === undefined ? {} : { modelMaxTokens: spec.modelMaxTokens }),
      ...(spec.analystContext === undefined ? {} : { analystContext: spec.analystContext }),
    },
    ...(spec.derivedFrom === undefined ? {} : { derivedFrom: spec.derivedFrom }),
    ...(spec.promptHash === undefined
      ? {}
      : {
          provenance: {
            promptHash: spec.promptHash,
            submissionHash: "aaaaaaaaaaaa",
            piVersion: "core@0.84.2+ai@0.84.2",
          },
        }),
    model: { provider: "openai", id: spec.model ?? "test-model" },
    limits: { maxTurns: 50, timeoutMs: 600_000 },
    results: (spec.draws ?? []).map((draw) => result(draw, at)),
  });
}

interface Corpus {
  dir: string;
  runsDir: string;
}

async function withCorpus(
  live: RunSpec[],
  archived: RunSpec[] = [],
  extraFiles: Record<string, string> = {},
): Promise<Corpus> {
  const dir = await mkdtemp(join(tmpdir(), "evaluate-runs-"));
  const runsDir = join(dir, "runs");
  await Promise.all(
    live.map((spec) => Bun.write(join(runsDir, `${spec.runId}.json`), artifact(spec))),
  );
  await Promise.all(
    archived.map((spec) =>
      Bun.write(join(runsDir, ".archive", `${spec.runId}.json`), artifact(spec)),
    ),
  );
  await Promise.all(
    Object.entries(extraFiles).map(([name, body]) => Bun.write(join(runsDir, name), body)),
  );
  return { dir, runsDir };
}

async function evaluate(
  runsDir: string,
  args: string[] = [],
): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(["bun", "scripts/evaluate-runs.ts", "--runs", runsDir, ...args], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out: stdout + stderr, code };
}

async function tree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.map((entry) => join(entry.parentPath, entry.name)).toSorted();
}

describe("evaluate — the archive is scored", () => {
  test("an archived run appears in the report and never silently leaves the set", async () => {
    const corpus = await withCorpus(
      [{ runId: "live-1", draws: [{ alertId: truePositive.startingAlertId, tpPercent: 99 }] }],
      [{ runId: "archived-1", draws: [{ alertId: falsePositive.startingAlertId, tpPercent: 5 }] }],
    );
    try {
      const withArchive = await evaluate(corpus.runsDir);
      expect(withArchive.out).toContain("2 artifacts");
      expect(withArchive.out).toContain(falsePositive.id);

      // `--exclude-archive` reproduces what the console sees, and the header says which set it was.
      const without = await evaluate(corpus.runsDir, ["--exclude-archive"]);
      expect(without.out).toContain("1 artifacts");
      expect(without.out).not.toContain(falsePositive.id);
    } finally {
      await rm(corpus.dir, { recursive: true, force: true });
    }
  });

  test("the fingerprint changes when the scored set does", async () => {
    const corpus = await withCorpus(
      [{ runId: "live-1", draws: [{ alertId: truePositive.startingAlertId, tpPercent: 99 }] }],
      [{ runId: "archived-1", draws: [{ alertId: falsePositive.startingAlertId, tpPercent: 5 }] }],
    );
    try {
      const fingerprint = async (args: string[]): Promise<string> =>
        /fingerprint (\w+)/.exec((await evaluate(corpus.runsDir, args)).out)?.[1] ?? "";
      expect(await fingerprint([])).not.toBe(await fingerprint(["--exclude-archive"]));
    } finally {
      await rm(corpus.dir, { recursive: true, force: true });
    }
  });

  test("a run id present in both directories is counted once", async () => {
    const draws = [{ alertId: truePositive.startingAlertId, tpPercent: 99 }];
    const corpus = await withCorpus([{ runId: "same", draws }], [{ runId: "same", draws }]);
    try {
      const report = await evaluate(corpus.runsDir);
      expect(report.out).toContain("counted once");
      // One draw, not two: a --restore that copied rather than moved must not double-count.
      expect(report.out).toMatch(/draws 1\b/);
    } finally {
      await rm(corpus.dir, { recursive: true, force: true });
    }
  });
});

describe("evaluate — every draw is kept", () => {
  test("three runs of one scenario are one cell at n=3, not the last one", async () => {
    const corpus = await withCorpus(
      [10, 50, 90].map((tpPercent, index) => ({
        runId: `repeat-${index}`,
        draws: [{ alertId: truePositive.startingAlertId, tpPercent }],
      })),
    );
    try {
      const report = await evaluate(corpus.runsDir);
      expect(report.out).toContain("10, 50, 90");
      expect(report.out).toMatch(/draws 3\b/);
      // Spread is what makes an unstable cell legible; last-wins destroyed it.
      expect(report.out).toContain("80");
      expect(report.out).not.toContain(`insufficient data`);
    } finally {
      await rm(corpus.dir, { recursive: true, force: true });
    }
  });

  test("a cell below three draws says so in words", async () => {
    const corpus = await withCorpus([
      { runId: "single", draws: [{ alertId: truePositive.startingAlertId, tpPercent: 99 }] },
    ]);
    try {
      expect((await evaluate(corpus.runsDir)).out).toContain(
        "insufficient data: 1 of 1 cells at n<3",
      );
    } finally {
      await rm(corpus.dir, { recursive: true, force: true });
    }
  });
});

describe("evaluate — failures are scored", () => {
  test("a failed alert raises the denominator, so direction 1/1 is unreachable", async () => {
    const corpus = await withCorpus([
      {
        runId: "mostly-failed",
        draws: [
          { alertId: truePositive.startingAlertId, tpPercent: 99 },
          {
            alertId: falsePositive.startingAlertId,
            status: "failed",
            errorName: "InvestigationTimeoutError",
          },
        ],
      },
    ]);
    try {
      const report = await evaluate(corpus.runsDir);
      expect(report.out).toContain("covered  2/");
      expect(report.out).toMatch(/failed 1\b/);
      // The failed draw prints as ✗ rather than vanishing from the row.
      expect(report.out).toContain("✗");
    } finally {
      await rm(corpus.dir, { recursive: true, force: true });
    }
  });

  test("a run that died before investigating anything is a condition with no draws", async () => {
    const corpus = await withCorpus([
      { runId: "ok", draws: [{ alertId: truePositive.startingAlertId, tpPercent: 99 }] },
      {
        runId: "never-started",
        model: "other-model",
        status: "failed",
        error: { name: "InvestigationModelError", message: "no credentials" },
        draws: [],
      },
    ]);
    try {
      const report = await evaluate(corpus.runsDir);
      expect(report.out).toContain("no draws");
      expect(report.out).toContain("InvestigationModelError");
    } finally {
      await rm(corpus.dir, { recursive: true, force: true });
    }
  });
});

describe("evaluate — analyst context is an axis", () => {
  test("a steered run is scored and lands in its own condition", async () => {
    const draws = [{ alertId: truePositive.startingAlertId, tpPercent: 99 }];
    const corpus = await withCorpus([
      { runId: "baseline", draws },
      { runId: "steered", analystContext: "this host is a scanner", draws },
    ]);
    try {
      const report = await evaluate(corpus.runsDir);
      expect(report.out).toContain("baseline");
      expect(report.out).toMatch(/ctx=\w{6}/);
      // Two conditions, not one blended row — and the steered draw is not skipped.
      expect(report.out).toMatch(/draws 1\b/);
    } finally {
      await rm(corpus.dir, { recursive: true, force: true });
    }
  });

  test("two different premises are two conditions", () => {
    const parse = (analystContext?: string) =>
      conditionOf(
        JSON.parse(
          artifact({ runId: "r", ...(analystContext === undefined ? {} : { analystContext }) }),
        ),
      );
    const a = parse("host is a scanner");
    const b = parse("host is a jump box");
    const baseline = parse();
    expect(new Set([a.id, b.id, baseline.id]).size).toBe(3);
    expect(baseline.fields.analystContext).toBe("baseline");
  });
});

describe("evaluate — the condition key", () => {
  test("an absent field is a value and never merges with a recorded one", () => {
    const withThinking = conditionOf(JSON.parse(artifact({ runId: "a", thinkingLevel: "medium" })));
    // A pre-PRD-3 artifact: no `config` at all, which is how the fabricated `medium` of D12 hid.
    const legacy = JSON.parse(artifact({ runId: "b" })) as Record<string, unknown>;
    delete legacy["config"];
    const without = conditionOf(legacy as never);
    expect(without.fields.thinkingLevel).toBe("?");
    expect(without.id).not.toBe(withThinking.id);
  });

  test("an outcome never fragments the key — only settings do", () => {
    // `webSearchUsed` records whether the agent actually searched. Two runs configured identically
    // must land in the same cell whether or not it happened to, or a result would decide which runs
    // are comparable and the cell could never average over the thing it exists to average over.
    const withUse = JSON.parse(artifact({ runId: "a" })) as { config: Record<string, unknown> };
    withUse.config["webSearchUsed"] = true;
    const withoutUse = JSON.parse(artifact({ runId: "b" })) as { config: Record<string, unknown> };
    withoutUse.config["webSearchUsed"] = false;

    expect(conditionOf(withUse as never).id).toBe(conditionOf(withoutUse as never).id);
    // And a genuine setting still splits them.
    expect(conditionOf(JSON.parse(artifact({ runId: "c", thinkingLevel: "high" }))).id).not.toBe(
      conditionOf(withUse as never).id,
    );
  });

  test("each configured model endpoint setting partitions the condition", () => {
    const configured = {
      modelBaseUrl: "https://host.example/v1",
      modelContextWindow: 65_536,
      modelMaxTokens: 4_096,
    };
    const base = conditionOf(JSON.parse(artifact({ runId: "base", ...configured })));
    const variants = [
      conditionOf(
        JSON.parse(
          artifact({ ...configured, runId: "url", modelBaseUrl: "https://other.example/v1" }),
        ),
      ),
      conditionOf(
        JSON.parse(artifact({ ...configured, runId: "context", modelContextWindow: 32_768 })),
      ),
      conditionOf(JSON.parse(artifact({ ...configured, runId: "output", modelMaxTokens: 2_048 }))),
    ];

    expect(variants.every((variant) => variant.id !== base.id)).toBe(true);
  });

  test("each source field partitions the condition and legacy identity stays unknown", () => {
    const base = conditionOf(JSON.parse(artifact({ runId: "base" })));
    const variants = [
      { ...DEFAULT_SOURCE, kind: "other-source" },
      { ...DEFAULT_SOURCE, connector: "azure-monitor-logs" },
      { ...DEFAULT_SOURCE, target: "https://workspace.example" },
      { ...DEFAULT_SOURCE, queryLanguage: "sql" },
    ].map((source, index) =>
      conditionOf(JSON.parse(artifact({ runId: `variant-${index}`, source }))),
    );
    const legacy = conditionOf(JSON.parse(artifact({ runId: "legacy", source: null })));

    expect(variants.every((variant) => variant.id !== base.id)).toBe(true);
    expect(legacy.id).not.toBe(base.id);
    expect(legacy.fields.sourceKind).toBe("?");
    expect(legacy.fields.sourceConnector).toBe("?");
    expect(legacy.fields.sourceTarget).toBe("?");
    expect(legacy.fields.queryLanguage).toBe("?");
    expect(legacy.fields.legacySentinelBaseUrl).toBe("http://localhost:8787");
  });

  test("a label never collapses two condition ids", () => {
    const runs = [
      artifact({ runId: "a", model: "m1" }),
      artifact({ runId: "b", model: "m2" }),
      artifact({ runId: "c", model: "m1", thinkingLevel: "high" }),
      artifact({ runId: "d", model: "m1", analystContext: "premise" }),
    ].map((raw) => conditionOf(JSON.parse(raw)));
    const labels = labelsFor(runs);
    expect(new Set(labels.values()).size).toBe(new Set(runs.map((run) => run.id)).size);
  });
});

describe("evaluate — hostile and empty inputs", () => {
  test("a JSON-valid artifact of the wrong shape is skipped, and the rest still score", async () => {
    const corpus = await withCorpus(
      [{ runId: "good", draws: [{ alertId: truePositive.startingAlertId, tpPercent: 99 }] }],
      [],
      {
        "no-results.json": JSON.stringify({
          runId: "broken",
          startedAt: "2026-08-20T10:00:00.000Z",
        }),
        "not-json.json": "{{{",
      },
    );
    try {
      const report = await evaluate(corpus.runsDir);
      expect(report.out).toContain("skipping");
      expect(report.out).toContain("no-results.json");
      expect(report.out).toContain("not-json.json");
      expect(report.code).toBe(0);
      expect(report.out).toMatch(/draws 1\b/);
    } finally {
      await rm(corpus.dir, { recursive: true, force: true });
    }
  });

  test("runs that join to nothing exit 1 and name the unjoined alert ids", async () => {
    const corpus = await withCorpus([
      { runId: "orphan", draws: [{ alertId: "no-such-alert", tpPercent: 99 }] },
    ]);
    try {
      const report = await evaluate(corpus.runsDir);
      expect(report.code).toBe(1);
      expect(report.out).toContain("no-such-alert");
      expect(report.out).toContain("content-addressed");
    } finally {
      await rm(corpus.dir, { recursive: true, force: true });
    }
  });

  test("an empty directory exits 1 rather than printing an empty report", async () => {
    const corpus = await withCorpus([]);
    try {
      await Bun.write(join(corpus.runsDir, ".keep"), "");
      expect((await evaluate(corpus.runsDir)).code).toBe(1);
    } finally {
      await rm(corpus.dir, { recursive: true, force: true });
    }
  });
});

describe("evaluate — the scored report is never written to disk", () => {
  test("scoring creates no file (PRD-6 §5.5, ADR 008 §2)", async () => {
    const corpus = await withCorpus([
      { runId: "one", draws: [{ alertId: truePositive.startingAlertId, tpPercent: 99 }] },
    ]);
    try {
      const before = await tree(corpus.dir);
      await evaluate(corpus.runsDir);
      await evaluate(corpus.runsDir, ["--gaps"]);
      await evaluate(corpus.runsDir, ["--run", "one"]);
      expect(await tree(corpus.dir)).toEqual(before);
    } finally {
      await rm(corpus.dir, { recursive: true, force: true });
    }
  });
});

describe("evaluate — gaps", () => {
  test("names the shortfall per condition and totals the investigations that close it", async () => {
    const corpus = await withCorpus([
      { runId: "one", draws: [{ alertId: truePositive.startingAlertId, tpPercent: 99 }] },
    ]);
    try {
      const report = await evaluate(corpus.runsDir, ["--gaps", "--json"]);
      const parsed = JSON.parse(report.out) as {
        readyAt: number;
        gaps: { scenarioId: string; have: number; need: number }[];
      };
      expect(parsed.readyAt).toBe(3);
      // Every scenario is short, and the one with a draw needs two more rather than three.
      expect(parsed.gaps.length).toBe(scenarios.length);
      const covered = parsed.gaps.find((gap) => gap.scenarioId === truePositive.id);
      expect(covered?.have).toBe(1);
      expect(covered?.need).toBe(2);
    } finally {
      await rm(corpus.dir, { recursive: true, force: true });
    }
  });

  test("--condition narrows it to the conditions actually being re-baselined", async () => {
    const draws = [{ alertId: truePositive.startingAlertId, tpPercent: 99 }];
    const corpus = await withCorpus([
      { runId: "current", draws },
      // A pre-config generation: real, scored, and not something anyone would backfill.
      { runId: "legacy", model: "old-model", draws },
    ]);
    try {
      const wide = JSON.parse((await evaluate(corpus.runsDir, ["--gaps", "--json"])).out) as {
        total: number;
        gaps: { conditionId: string }[];
      };
      const target = wide.gaps[0]?.conditionId ?? "";
      const narrow = JSON.parse(
        (await evaluate(corpus.runsDir, ["--gaps", "--json", "--condition", target])).out,
      ) as { total: number; conditions: string[] };

      expect(narrow.conditions).toEqual([target]);
      // A work list has to be work somebody intends to do, or the total is true and useless.
      expect(narrow.total).toBeLessThan(wide.total);
    } finally {
      await rm(corpus.dir, { recursive: true, force: true });
    }
  });
});

describe("evaluate — compare", () => {
  test("names both conditions, diffs the fields, and refuses a difference it cannot support", async () => {
    const draws = [{ alertId: truePositive.startingAlertId, tpPercent: 99 }];
    const corpus = await withCorpus([
      { runId: "left", model: "model-a", draws },
      { runId: "right", model: "model-b", draws },
    ]);
    try {
      const report = await evaluate(corpus.runsDir, ["--compare", "left", "right"]);
      expect(report.out).toContain("what differs: model model-a → model-b");
      expect(report.out).toContain("sign test p = 1.000");
      // Neither side has a repeat, so there is no measured floor to judge the delta against.
      expect(report.out).toContain("no measured noise floor");
    } finally {
      await rm(corpus.dir, { recursive: true, force: true });
    }
  });

  test("renders model endpoint differences instead of hiding them behind condition ids", async () => {
    const draws = [{ alertId: truePositive.startingAlertId, tpPercent: 99 }];
    const corpus = await withCorpus([
      {
        runId: "left",
        modelBaseUrl: "https://host.example/v1",
        modelContextWindow: 65_536,
        modelMaxTokens: 4_096,
        draws,
      },
      {
        runId: "right",
        modelBaseUrl: "https://other.example/v1",
        modelContextWindow: 32_768,
        modelMaxTokens: 2_048,
        draws,
      },
    ]);
    try {
      const report = await evaluate(corpus.runsDir, ["--compare", "left", "right"]);
      expect(report.out).toContain("modelBaseUrl");
      expect(report.out).toContain("modelContextWindow");
      expect(report.out).toContain("modelMaxTokens");
    } finally {
      await rm(corpus.dir, { recursive: true, force: true });
    }
  });
});

describe("evaluate — the legend", () => {
  test("names every recorded field, and marks an inferred submission shape", async () => {
    const corpus = await withCorpus([
      { runId: "one", draws: [{ alertId: truePositive.startingAlertId, tpPercent: 99 }] },
    ]);
    try {
      const report = await evaluate(corpus.runsDir);
      expect(report.out).toContain("LEGEND");
      // The axes a label omits because they happen to agree today are exactly the ones a reader
      // needs when they stop agreeing.
      expect(report.out).toContain("sourceKind");
      expect(report.out).toContain("sourceConnector");
      expect(report.out).toContain("sourceTarget");
      expect(report.out).toContain("queryLanguage");
      expect(report.out).toContain("modelBaseUrl");
      expect(report.out).toContain("modelContextWindow");
      expect(report.out).toContain("modelMaxTokens");
      expect(report.out).toContain("timeoutMs");
      // Pre-provenance artifacts have their submission shape inferred from field presence.
      expect(report.out).toContain("(inferred)");
    } finally {
      await rm(corpus.dir, { recursive: true, force: true });
    }
  });

  test("a run carrying derivedFrom still scores, and nothing pairs on it", async () => {
    // The field stays on the artifact — PRD-5 records which run a re-run came from — but the
    // benchmark does not read it. Sequential runs are tracked; they are not a measurement here.
    const alertId = truePositive.startingAlertId;
    const corpus = await withCorpus([
      { runId: "parent", draws: [{ alertId, tpPercent: 90 }] },
      {
        runId: "child",
        analystContext: "a premise",
        derivedFrom: { runId: "parent", alertId },
        draws: [{ alertId, tpPercent: 20 }],
      },
    ]);
    try {
      const report = await evaluate(corpus.runsDir);
      expect(report.out).not.toContain("DERIVED PAIRS");
      // Both runs are scored, in their own conditions, on the outcome alone.
      expect(report.out).toContain("baseline");
      expect(report.out).toMatch(/ctx=\w{6}/);
    } finally {
      await rm(corpus.dir, { recursive: true, force: true });
    }
  });

  test("two runs differing only in promptHash are two conditions", () => {
    const a = conditionOf(JSON.parse(artifact({ runId: "a", promptHash: "111111111111" })));
    const b = conditionOf(JSON.parse(artifact({ runId: "b", promptHash: "222222222222" })));
    // The prompt axis is the one steering and case memory both arrive on (PRD-6 §6.6).
    expect(a.id).not.toBe(b.id);
    expect(a.fields.promptHash).toBe("111111111111");
  });
});
