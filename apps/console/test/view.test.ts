import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { RunArtifact, RunResult } from "../src/data/runs.ts";
import { readRun } from "../src/data/runs.ts";
import { indexTrace, type TraceIndex } from "../src/data/trace-index.ts";
import { env } from "../src/env.ts";
import { verdictBody } from "../src/ui/panes/main.ts";
import { leadingTable, toActivityView } from "../src/view/activity.ts";
import { alertFactsFromResult, enrichWithAlertJson } from "../src/view/alert.ts";
import { toConfigRows } from "../src/view/config.ts";
import { duration, tokens, tpBar, truncate, verdictBand } from "../src/view/format.ts";
import { lineText } from "../src/view/format.ts";
import {
  classifyRun,
  pendingResults,
  resultsWithPending,
  runLabel,
  toResultRow,
} from "../src/view/run-list.ts";
import { toVerdictView } from "../src/view/verdict.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

function run(partial: Partial<RunArtifact>): RunArtifact {
  return { runId: "01a00000-0000-7000-0000-000000000000", results: [], ...partial };
}

describe("format", () => {
  test("durations, tokens and truncation", () => {
    expect(duration(41_887)).toBe("41.9s");
    expect(duration(72_000)).toBe("1m12s");
    expect(duration(undefined)).toBe("—");
    expect(tokens(24_930)).toBe("24.9k");
    expect(truncate("Multiple failed logon attempts", 12)).toBe("Multiple fa…");
    expect(truncate("short", 12)).toBe("short");
  });

  test("the TP bar fills proportionally and fits its width", () => {
    expect(tpBar(50, 10)).toBe("█████░░░░░");
    expect(tpBar(94, 10)).toHaveLength(10);
    expect(tpBar(undefined, 10)).toBe("");
  });

  test("the inconclusive band matches the one evaluate-runs scores against", () => {
    expect(verdictBand(94)).toBe("true-positive");
    expect(verdictBand(15)).toBe("false-positive");
    expect(verdictBand(50)).toBe("inconclusive");
    expect(verdictBand(70)).toBe("inconclusive");
    expect(verdictBand(71)).toBe("true-positive");
    expect(verdictBand(undefined)).toBe("unknown");
  });
});

describe("configuration", () => {
  test("shows configured endpoint settings beside the values recorded on the run", () => {
    const rows = toConfigRows(
      run({
        config: {
          thinkingLevel: "off",
          resultMaxChars: 40_000,
          source: {
            kind: "microsoft-sentinel",
            connector: "mock-sentinel-rest",
            target: "http://localhost:8787",
            queryLanguage: "kql",
          },
          webSearchConfigured: false,
          modelBaseUrl: "https://recorded.example/v1",
          modelContextWindow: 32_768,
          modelMaxTokens: 2_048,
        },
      }),
      {
        ...env,
        LLAMA_SERVER_BASE_URL: "https://current.example/v1",
        LLAMA_SERVER_MODEL: "local-model",
        LLAMA_SERVER_CONTEXT_WINDOW: 65_536,
        LLAMA_SERVER_MAX_TOKENS: 4_096,
      },
    );

    expect(rows.find((row) => row.label === "model base url")).toEqual({
      label: "model base url",
      thisRun: "https://recorded.example/v1",
      currentEnv: "https://current.example/v1",
    });
    expect(rows.find((row) => row.label === "model context window")?.thisRun).toBe("32,768");
    expect(rows.find((row) => row.label === "model max tokens")?.currentEnv).toBe("4,096");
    expect(rows.find((row) => row.label === "source connector")?.thisRun).toBe(
      "mock-sentinel-rest",
    );
    expect(rows.find((row) => row.label === "source target")?.thisRun).toBe(
      "http://localhost:8787",
    );
    expect(rows.find((row) => row.label === "query language")?.thisRun).toBe("kql");
  });

  test("does not infer neutral source fields from a legacy Sentinel URL", () => {
    const rows = toConfigRows(
      run({
        config: {
          resultMaxChars: 40_000,
          sentinelBaseUrl: "http://legacy.example",
          webSearchConfigured: false,
        },
      }),
      env,
    );

    for (const label of ["source kind", "source connector", "source target", "query language"]) {
      expect(rows.find((row) => row.label === label)?.thisRun).toBe("—");
    }
  });

  test("omits endpoint rows when neither side recorded one", () => {
    expect(toConfigRows(run({}), env).some((row) => row.label === "model base url")).toBe(false);
  });
});

describe("classifyRun", () => {
  const now = Date.parse("2026-08-19T10:00:00.000Z");

  test("finished sweeps report what they recorded", () => {
    expect(classifyRun({ run: run({ status: "completed" }), now })).toBe("completed");
    expect(classifyRun({ run: run({ status: "interrupted" }), now })).toBe("interrupted");
  });

  test("a sweep between alerts is still running, not stale", () => {
    // The artifact is only flushed between alerts, and one alert may take the whole per-alert
    // ceiling. A fixed few-minute threshold would call this healthy run dead.
    const artifact = run({
      status: "running",
      completedAt: "2026-08-19T09:52:00.000Z",
      limits: { timeoutMs: 600_000 },
    });
    expect(classifyRun({ run: artifact, now })).toBe("running");
  });

  test("a sweep past its own ceiling with nothing moving is stale", () => {
    const artifact = run({
      status: "running",
      completedAt: "2026-08-19T09:40:00.000Z",
      limits: { timeoutMs: 600_000 },
    });
    expect(classifyRun({ run: artifact, now })).toBe("stale");
    // ...unless its transcript is still growing, which is direct evidence of life.
    expect(classifyRun({ run: artifact, now, traceGrowing: true })).toBe("running");
  });

  test("an artifact predating the lifecycle field is finished, not running", () => {
    expect(classifyRun({ run: run({ completedAt: "2026-08-19T08:00:00.000Z" }), now })).toBe(
      "completed",
    );
  });

  test("a run-level status is never read as a result-level one", () => {
    // `interrupted` describes a sweep and has no meaning for a single alert.
    const row = toResultRow({ alertId: "a", alertTitle: "t", status: "interrupted" } as RunResult);
    expect(row.failed).toBe(false);
  });
});

describe("alerts a sweep has not finished", () => {
  const planned = [
    { alertId: "alert-1", alertTitle: "First alert" },
    { alertId: "alert-2", alertTitle: "Second alert" },
  ];
  const finished: RunResult = {
    alertId: "alert-1",
    alertTitle: "First alert",
    status: "completed",
  };

  test("a running sweep offers a row for each alert it has not reached", () => {
    const rows = resultsWithPending(
      run({ status: "running", alertCount: 2, plannedAlerts: planned, results: [finished] }),
    );
    expect(rows.map((row) => row.alertId)).toEqual(["alert-1", "alert-2"]);
    // Planned order, so a finishing alert replaces its own row rather than shifting the selection.
    expect(rows[1]?.status).toBe("running");
  });

  test("a finished or abandoned sweep has no pending alerts", () => {
    for (const status of ["completed", "interrupted"]) {
      expect(
        pendingResults(run({ status, alertCount: 2, plannedAlerts: planned, results: [finished] })),
      ).toEqual([]);
    }
  });

  test("a pending row reads as live work, not as a passed investigation", () => {
    const row = toResultRow({ alertId: "alert-2", alertTitle: "Second alert", status: "running" });
    expect(row.pending).toBe(true);
    expect(row.failed).toBe(false);
    expect(row.glyph).toBe("●");
    expect(row.detail).toBe("investigating");
  });

  test("a run is named by the alert it is investigating, not by what has finished", () => {
    // The symptom this fixes: a single-alert run has no result for its whole lifetime.
    expect(
      runLabel(
        run({
          status: "running",
          alertCount: 1,
          plannedAlerts: [{ alertId: "alert-1", alertTitle: "Anonymous sharing" }],
        }),
      ),
    ).toBe("Anonymous sharing");
    // A sweep is sized by what it set out to cover, not by what it has got through.
    expect(runLabel(run({ status: "running", alertCount: 9, results: [finished] }))).toBe(
      "9 alerts",
    );
    // Artifacts written before the planned list existed keep the old answer.
    expect(runLabel(run({ status: "running" }))).toBe("(no alerts yet)");
  });
});

describe("toVerdictView", () => {
  test("renders the current shape and reports nothing missing", async () => {
    const artifact = await readRun(
      join(FIXTURES, "runs/01a0194c-b7c1-7000-8a3b-fe9d2b647919.json"),
    );
    if ("issue" in artifact) throw new Error("fixture unreadable");
    const view = toVerdictView(artifact.results[0]!);

    expect(view.failed).toBe(false);
    expect(view.tpPercent).toBe(99);
    expect(view.impact).toBe("confirmed-compromise");
    expect(view.absent).toHaveLength(0);
    expect(view.blocks.map((b) => b.heading)).toContain("What happened");
  });

  test("names what a legacy artifact never recorded", async () => {
    const artifact = await readRun(
      join(FIXTURES, "runs/01a01916-dfe1-7000-956c-dd5b47423a90.json"),
    );
    if ("issue" in artifact) throw new Error("fixture unreadable");
    const view = toVerdictView(artifact.results[0]!);

    // Absent, not empty — "never recorded" is a different claim from "recorded nothing".
    expect(view.absent).toContain("impact");
    expect(view.absent).toContain("researchDone");
    expect(view.blocks.some((b) => b.heading.startsWith("Next action"))).toBe(true);
  });

  test("shows the error in place of a summary when an investigation failed", async () => {
    const artifact = await readRun(join(FIXTURES, "runs/failed-run.json"));
    if ("issue" in artifact) throw new Error("fixture unreadable");
    const view = toVerdictView(artifact.results[0]!);

    expect(view.failed).toBe(true);
    expect(view.error?.name).toBe("InvestigationStepLimitError");
    expect(view.blocks).toHaveLength(0);
  });
});

describe("toActivityView", () => {
  test("summarises tables, web use and errors without opening a call", async () => {
    const index = await indexTrace(
      join(
        FIXTURES,
        "traces/01a0194a-90fd-7000-b417-5eea46721c99-cc6430ca-0fc5-b704-c048-1d5f3d8a2524.jsonl",
      ),
    );
    const view = toActivityView(index, "kql");

    expect(view.turnCount).toBe(4);
    expect(view.callCount).toBe(11);
    expect(view.errors).toBe(0);
    expect(view.tables.map((t) => t.name)).toContain("SecurityEvent");
    expect(view.searches).toHaveLength(0);
    expect(view.fetches).toHaveLength(0);
    expect(view.rows.filter((r) => r.kind === "turn")).toHaveLength(4);
  });

  test("reads the table a query opens with", () => {
    expect(leadingTable("SecurityEvent\n| where EventID == 4625")).toBe("SecurityEvent");
    expect(leadingTable("// a comment\nCommonSecurityLog | take 1")).toBe("CommonSecurityLog");
    expect(leadingTable("| where x")).toBeUndefined();
  });

  test("extracts tables only for recorded KQL and otherwise bounds raw query text", () => {
    const index: TraceIndex = {
      path: "trace.jsonl",
      runId: "run",
      alertId: "alert",
      startedAt: "2026-08-19T09:00:00.000Z",
      complete: false,
      turns: [],
      toolCalls: [
        {
          seq: 1,
          turn: 1,
          at: "2026-08-19T09:00:01.000Z",
          toolCallId: "call-1",
          toolName: "query_security_data",
          args: { query: "SecurityEvent\n| take 1" },
        },
      ],
      totals: { totalTokens: 0, cost: 0 },
      nextOffset: 0,
      unparsed: 0,
    };

    const kql = toActivityView(index, "kql");
    expect(kql.tables).toEqual([{ name: "SecurityEvent", count: 1 }]);
    expect(kql.rows.find((row) => row.kind === "call")?.summary).toBe("SecurityEvent");

    const other = toActivityView(index, "sql");
    expect(other.tables).toEqual([]);
    expect(other.rows.find((row) => row.kind === "call")?.summary).toBe("SecurityEvent | take 1");
  });
});

describe("verdict pane order", () => {
  const result: RunResult = {
    alertId: "d52663c4",
    alertTitle: "Known malicious domain resolved",
    status: "completed",
    startedAt: "2026-08-19T12:10:43.387Z",
    completedAt: "2026-08-19T12:11:29.081Z",
    durationMs: 45_694,
    alert: {
      severity: "High",
      startTimeUtc: "2020-03-20T16:52:16.153Z",
      timeGenerated: "2020-03-20T16:52:16.153Z",
      tactics: ["CommandAndControl"],
      techniques: ["T1071"],
      compromisedEntity: "17.81.146.1",
    },
    summary: {
      tpPercent: 72,
      fpPercent: 28,
      tpReason: "for",
      fpReason: "against",
      whatHappened: "narrative",
      impact: "unknown",
      keyEvidence: ["evidence"],
      researchDone: ["looked"],
    },
  };

  test("leads with the classification, then the entities it is about", () => {
    const facts = enrichWithAlertJson(alertFactsFromResult(result), {
      properties: { entities: [{ type: "ip", address: "17.81.146.1" }] },
    });
    const lines = verdictBody(result, facts, 90).map(lineText);

    const at = (needle: string): number => lines.findIndex((line) => line.includes(needle));

    expect(at("TRUE POSITIVE")).toBeGreaterThan(-1);
    // Entities sit directly under the classification row, before any prose.
    expect(at("ENTITIES")).toBe(at("TRUE POSITIVE") + 2);
    expect(at("WHAT HAPPENED")).toBeGreaterThan(at("ENTITIES"));
    // The counter-argument follows the narrative, never precedes it.
    expect(at("FOR — TRUE POSITIVE")).toBeGreaterThan(at("WHAT HAPPENED"));
    expect(at("AGAINST — FALSE POSITIVE")).toBeGreaterThan(at("FOR — TRUE POSITIVE"));
    expect(at("WHERE IT LOOKED")).toBeGreaterThan(at("KEY EVIDENCE"));
  });

  test("does not render impact, which lives in the alert list", () => {
    const lines = verdictBody(result, alertFactsFromResult(result), 90).map(lineText).join("\n");
    expect(lines).not.toContain("IMPACT");
    // ...but the artifact still records it, so `absent` must not start claiming otherwise.
    expect(toVerdictView(result).absent).not.toContain("impact");
  });
});
