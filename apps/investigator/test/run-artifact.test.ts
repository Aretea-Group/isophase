import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InvestigationRun } from "../src/contracts/run.ts";
import { writeRunArtifact } from "../src/run-artifact.ts";

const base = {
  runId: "01a0195f-0000-7000-0000-000000000001",
  startedAt: "2026-08-19T10:00:00.000Z",
  completedAt: "2026-08-19T10:02:00.000Z",
  model: { provider: "openai", id: "gpt-5.6-terra" },
  limits: { maxTurns: 50, timeoutMs: 600_000 },
  results: [],
};

describe("InvestigationRun", () => {
  test("still accepts an artifact written before the lifecycle fields existed", () => {
    const parsed = InvestigationRun.parse(base);
    expect(parsed.status).toBeUndefined();
    expect(parsed.alertCount).toBeUndefined();
    expect(parsed.traceDir).toBeUndefined();
    expect(parsed.config).toBeUndefined();
  });

  test("accepts legacy lifecycle configuration", () => {
    const parsed = InvestigationRun.parse({
      ...base,
      status: "running",
      alertCount: 151,
      traceDir: "runs/traces",
      config: {
        thinkingLevel: "medium",
        resultMaxChars: 40_000,
        sentinelBaseUrl: "http://localhost:8787",
        webSearchConfigured: true,
      },
    });
    expect(parsed.status).toBe("running");
    expect(parsed.alertCount).toBe(151);
    expect(parsed.config?.thinkingLevel).toBe("medium");
  });

  test("accepts fixed-size neutral source identity", () => {
    const parsed = InvestigationRun.parse({
      ...base,
      config: {
        resultMaxChars: 40_000,
        source: {
          kind: "microsoft-sentinel",
          connector: "azure-monitor-logs",
          target: "https://api.loganalytics.io/v1/workspaces/workspace-id",
          queryLanguage: "kql",
        },
        webSearchConfigured: true,
      },
    });

    expect(parsed.config?.source?.connector).toBe("azure-monitor-logs");
    expect(parsed.config?.sentinelBaseUrl).toBeUndefined();
  });

  test("keeps FixtureQL artifact identity distinct from Sentinel KQL", () => {
    const parseLanguage = (kind: string, queryLanguage: string) =>
      InvestigationRun.parse({
        ...base,
        config: {
          resultMaxChars: 40_000,
          source: {
            kind,
            connector: "in-memory",
            target: "fixture-corpus",
            queryLanguage,
          },
          webSearchConfigured: false,
        },
      }).config?.source;

    const fixture = parseLanguage("fixture-siem", "fixtureql");
    const sentinel = parseLanguage("microsoft-sentinel", "kql");
    expect(fixture?.queryLanguage).toBe("fixtureql");
    expect(fixture).not.toEqual(sentinel);
  });

  test("records which alerts the sweep set out to investigate, not only how many", () => {
    // Without the ids a reader cannot name — or find the transcript of — the alert being
    // investigated right now, because `results` holds only alerts that have finished.
    const parsed = InvestigationRun.parse({
      ...base,
      status: "running",
      alertCount: 2,
      plannedAlerts: [
        { alertId: "cccccccc-0000-0000-0000-000000000009", alertTitle: "Anonymous sharing" },
        { alertId: "cccccccc-0000-0000-0000-00000000000a", alertTitle: "Disabled account sign-in" },
      ],
    });
    expect(parsed.plannedAlerts?.[0]?.alertTitle).toBe("Anonymous sharing");
    expect(InvestigationRun.parse(base).plannedAlerts).toBeUndefined();
  });

  test("accepts the alert's own triage facts, and keeps them optional", () => {
    const withAlert = InvestigationRun.parse({
      ...base,
      results: [
        {
          alertId: "cccccccc-0000-0000-0000-000000000009",
          alertTitle: "Brute force against SOC-FW-RDP",
          status: "completed",
          startedAt: "2026-08-19T11:00:00.000Z",
          completedAt: "2026-08-19T11:00:45.000Z",
          durationMs: 45_000,
          alert: {
            severity: "Medium",
            startTimeUtc: "2021-10-23T05:26:19.626Z",
            endTimeUtc: "2021-10-23T06:25:57.674Z",
            timeGenerated: "2021-10-23T06:25:57.674Z",
            tactics: ["CredentialAccess"],
            techniques: ["T1110", "T1110.001"],
            compromisedEntity: "SOC-FW-RDP",
            alertType: "SOC-RULE-0001-RdpBruteForce",
          },
        },
      ],
    });

    const alert = withAlert.results[0]?.alert;
    expect(alert?.severity).toBe("Medium");
    // The incident predates the investigation by five years: these are unrelated clocks.
    expect(alert?.startTimeUtc).toBe("2021-10-23T05:26:19.626Z");
    expect(withAlert.results[0]?.startedAt).toBe("2026-08-19T11:00:00.000Z");

    // Absent on every artifact written before PRD-3, so it must stay optional.
    const withoutAlert = InvestigationRun.parse({
      ...base,
      results: [
        {
          alertId: "a",
          alertTitle: "b",
          status: "completed",
          startedAt: "2026-08-19T11:00:00.000Z",
          completedAt: "2026-08-19T11:00:45.000Z",
          durationMs: 1,
        },
      ],
    });
    expect(withoutAlert.results[0]?.alert).toBeUndefined();
  });

  test("does not hard-code the severity or tactic vocabularies", () => {
    // Persisted records are read back later; a new severity upstream must not make old artifacts
    // unreadable, so these are strings rather than mirrors of the @soc/contracts enums.
    const parsed = InvestigationRun.parse({
      ...base,
      results: [
        {
          alertId: "a",
          alertTitle: "b",
          status: "completed",
          startedAt: "2026-08-19T11:00:00.000Z",
          completedAt: "2026-08-19T11:00:45.000Z",
          durationMs: 1,
          alert: { severity: "Catastrophic", tactics: ["SomeFutureTactic"] },
        },
      ],
    });
    expect(parsed.results[0]?.alert?.severity).toBe("Catastrophic");
  });

  test("keeps the sweep's lifecycle separate from a single alert's outcome", () => {
    // The two enums overlap on `failed` since PRD-5 §5.2 but do not mean the same thing: a *sweep*
    // that failed never investigated anything — an unknown model, an unreachable Sentinel — while a
    // *result* that failed is one alert going wrong inside a sweep that ran. `interrupted` remains
    // sweep-only, which is the asymmetry that keeps them from being conflated.
    expect(InvestigationRun.parse({ ...base, status: "failed" }).status).toBe("failed");
    expect(() => InvestigationRun.parse({ ...base, status: "cancelled" })).toThrow();

    const withResult = {
      ...base,
      results: [
        {
          alertId: "aaaaaaaa-0000-0000-0000-000000000001",
          alertTitle: "an alert",
          status: "interrupted",
          startedAt: "2026-08-19T10:00:00.000Z",
          completedAt: "2026-08-19T10:01:00.000Z",
          durationMs: 60_000,
        },
      ],
    };
    expect(() => InvestigationRun.parse(withResult)).toThrow();
  });
});

describe("writeRunArtifact", () => {
  test("writes a parseable artifact and leaves no temporary file behind", async () => {
    const directory = await mkdtemp(join(tmpdir(), "run-artifact-"));
    try {
      const path = await writeRunArtifact(directory, { ...base, status: "running" });
      expect(await Bun.file(path).exists()).toBe(true);

      // Rewritten in place after every alert, so this happens repeatedly during one sweep.
      await writeRunArtifact(directory, { ...base, status: "completed" });

      const entries = await readdir(directory);
      expect(entries).toEqual([`${base.runId}.json`]);
      expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);

      const reread = InvestigationRun.parse(await Bun.file(path).json());
      expect(reread.status).toBe("completed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("removes the temporary file when the rename fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "run-artifact-"));
    try {
      // A directory where the artifact should go: the write succeeds, the rename cannot.
      await mkdir(join(directory, `${base.runId}.json`), { recursive: true });

      await expect(writeRunArtifact(directory, { ...base, status: "running" })).rejects.toThrow();

      const entries = await readdir(directory);
      expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  /*
   * Not tested: that a concurrent reader never observes a half-written artifact.
   *
   * The guarantee comes from `rename(2)` being atomic within a directory, not from a test. An
   * attempt to demonstrate it here was dropped because it had no teeth: a control that wrote the
   * same artifact non-atomically, read continuously by the same loop, produced zero torn reads on
   * this platform, so a passing assertion would have proved nothing. The race is real at the
   * cadence the console actually polls (PRD-3 §10.2) — it is simply not reproducible in-process.
   */
});
