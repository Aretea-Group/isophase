import { describe, expect, test } from "bun:test";

import type { SecurityAlert } from "@soc/contracts";
import type { SecurityDataSource } from "@soc/sentinel-client";

import type { InvestigationRun } from "../src/contracts/run.ts";
import { InvestigationAbortedError } from "../src/errors.ts";
import { executeRun, type InvestigatorConfig, type InvestigatorDeps } from "../src/execute-run.ts";
import type { ResolvedModel } from "../src/model.ts";
import { testSourceBundle } from "./fixtures/source.ts";

/**
 * `executeRun` was `main()` until PRD-5 §5.2, and `main()` had no test — its flush ordering, its
 * startup-failure behaviour and its cancellation semantics were only reachable by running the CLI
 * and watching a directory. That is the point of the extraction as much as the console is.
 *
 * These tests never reach a model: `deps.resolveModel` is the seam, and every case here either
 * fails before resolution or is cancelled before a prompt is sent.
 */

const CONFIG: InvestigatorConfig = {
  provider: "openai",
  modelId: "gpt-5.6-luna",
  thinkingLevel: "medium",
  maxTurns: 50,
  timeoutMs: 600_000,
  resultMaxChars: 40_000,
  sentinelBaseUrl: "http://localhost:8787",
  webSearchConfigured: false,
  runsDir: "runs",
  trace: false,
  traceDir: "runs/traces",
  traceStream: false,
};

function alert(id: string, title = "Suspicious sign-in"): SecurityAlert {
  return {
    id,
    title,
    description: "d",
    severity: "High",
    status: "New",
    startTimeUtc: "2026-08-01T00:00:00.000Z",
    endTimeUtc: "2026-08-01T00:10:00.000Z",
    timeGenerated: "2026-08-01T00:10:00.000Z",
    alertType: "Test",
    tactics: [],
    techniques: [],
    entities: [],
    native: { id },
  };
}

/** Captures every artifact write instead of touching the filesystem. */
function recorder(): { writes: InvestigationRun[]; write: NonNullable<InvestigatorDeps["write"]> } {
  const writes: InvestigationRun[] = [];
  return {
    writes,
    write: (_directory, run) => {
      // Structured-cloned so a later mutation of `collected` cannot rewrite history, which is
      // exactly the bug an in-place artifact would hide.
      writes.push(JSON.parse(JSON.stringify(run)) as InvestigationRun);
      return Promise.resolve(`runs/${run.runId}.json`);
    },
  };
}

function sourceStub(alerts: SecurityAlert[]): InvestigatorDeps["source"] {
  return testSourceBundle({
    listAlerts: () => Promise.resolve(alerts),
    getAlert: (id: string) => {
      const found = alerts.find((candidate) => candidate.id === id);
      if (!found) throw new Error(`Alert "${id}" was not found.`);
      return Promise.resolve(found);
    },
    getSchema: () => Promise.resolve({ tables: [] }),
    // Degrades to `undefined` on a Mock Sentinel with no corpus manifest, which is the shape a
    // pre-PRD-6 service presents and the one `executeRun` must not break on.
    getCorpus: () => Promise.resolve(undefined),
  } as unknown as SecurityDataSource);
}

describe("executeRun — startup failure is recorded (PRD-5 §5.2)", () => {
  test("an unknown model writes a failed artifact under the supplied runId, then rethrows", async () => {
    const { writes, write } = recorder();
    const deps: InvestigatorDeps = {
      source: sourceStub([alert("a1")]),
      webSearch: { search: () => Promise.resolve([]) } as unknown as InvestigatorDeps["webSearch"],
      webFetch: { fetch: () => Promise.resolve("") } as unknown as InvestigatorDeps["webFetch"],
      write,
      resolveModel: () => Promise.reject(new Error('Unknown model "openai/nope".')),
    };

    const attempt = executeRun({ ...CONFIG, modelId: "nope" }, deps, { runId: "run-1" });
    await expect(attempt).rejects.toThrow('Unknown model "openai/nope".');

    // The whole point: previously this produced stderr and exit 1 with no file at all.
    expect(writes).toHaveLength(1);
    const written = writes[0];
    expect(written?.runId).toBe("run-1");
    expect(written?.status).toBe("failed");
    expect(written?.error?.message).toContain("Unknown model");
    expect(written?.results).toEqual([]);
    // It still records what it was asked to do, so the failure is attributable.
    expect(written?.model).toEqual({ provider: "openai", id: "nope" });
  });

  test("an unreachable Sentinel is recorded the same way", async () => {
    const { writes, write } = recorder();
    const deps: InvestigatorDeps = {
      source: testSourceBundle({
        listAlerts: () => Promise.reject(new Error("Sentinel is unreachable at localhost:8787")),
      } as unknown as SecurityDataSource),
      webSearch: {} as unknown as InvestigatorDeps["webSearch"],
      webFetch: {} as unknown as InvestigatorDeps["webFetch"],
      write,
      resolveModel: () =>
        Promise.resolve({ model: {}, streamFn: () => undefined } as unknown as ResolvedModel),
    };

    await expect(executeRun(CONFIG, deps, { runId: "run-2" })).rejects.toThrow("unreachable");
    expect(writes[0]?.status).toBe("failed");
    expect(writes[0]?.error?.message).toContain("unreachable");
  });

  test("a write failure during startup does not mask the real error", async () => {
    const deps: InvestigatorDeps = {
      source: sourceStub([]),
      webSearch: {} as unknown as InvestigatorDeps["webSearch"],
      webFetch: {} as unknown as InvestigatorDeps["webFetch"],
      write: () => Promise.reject(new Error("disk full")),
      resolveModel: () => Promise.reject(new Error("the actual cause")),
    };
    await expect(executeRun(CONFIG, deps, { runId: "run-3" })).rejects.toThrow("the actual cause");
  });
});

describe("executeRun — cancellation (PRD-5 §6)", () => {
  test("an already-aborted signal stops before any alert is investigated", async () => {
    const { writes, write } = recorder();
    const controller = new AbortController();
    controller.abort();

    const deps: InvestigatorDeps = {
      source: sourceStub([alert("a1"), alert("a2")]),
      webSearch: {} as unknown as InvestigatorDeps["webSearch"],
      webFetch: {} as unknown as InvestigatorDeps["webFetch"],
      write,
      resolveModel: () =>
        Promise.resolve({ model: {}, streamFn: () => undefined } as unknown as ResolvedModel),
    };

    const run = await executeRun(CONFIG, deps, { runId: "run-4", signal: controller.signal });

    // `interrupted`, never `completed` — the run did not cover what it set out to cover.
    expect(run.status).toBe("interrupted");
    expect(run.results).toEqual([]);
    // It still planned both, so a reader can see what was skipped.
    expect(run.plannedAlerts?.map((a) => a.alertId)).toEqual(["a1", "a2"]);
    expect(writes.at(-1)?.status).toBe("interrupted");
  });

  test("the artifact exists before the first alert finishes", async () => {
    const { writes, write } = recorder();
    const controller = new AbortController();
    controller.abort();
    const deps: InvestigatorDeps = {
      source: sourceStub([alert("a1")]),
      webSearch: {} as unknown as InvestigatorDeps["webSearch"],
      webFetch: {} as unknown as InvestigatorDeps["webFetch"],
      write,
      resolveModel: () =>
        Promise.resolve({ model: {}, streamFn: () => undefined } as unknown as ResolvedModel),
    };

    await executeRun(CONFIG, deps, { runId: "run-5", signal: controller.signal });

    // Two writes: `running` before the loop, then the terminal status (PRD-3 §7).
    expect(writes.map((w) => w.status)).toEqual(["running", "interrupted"]);
    expect(writes[0]?.alertCount).toBe(1);
  });
});

describe("executeRun — the artifact records the configuration that applied (PRD-5 §9)", () => {
  test("model and limits come from config, so they cannot disagree with what ran", async () => {
    const { write } = recorder();
    const controller = new AbortController();
    controller.abort();
    const seen: { provider: string; id: string }[] = [];

    const deps: InvestigatorDeps = {
      source: sourceStub([]),
      webSearch: {} as unknown as InvestigatorDeps["webSearch"],
      webFetch: {} as unknown as InvestigatorDeps["webFetch"],
      write,
      resolveModel: (provider, id) => {
        seen.push({ provider, id });
        return Promise.resolve({
          model: {},
          streamFn: () => undefined,
        } as unknown as ResolvedModel);
      },
    };

    const config = { ...CONFIG, provider: "anthropic", modelId: "claude-x", maxTurns: 7 };
    const run = await executeRun(config, deps, { runId: "run-6", signal: controller.signal });

    expect(seen).toEqual([{ provider: "anthropic", id: "claude-x" }]);
    expect(run.model).toEqual({ provider: "anthropic", id: "claude-x" });
    expect(run.limits.maxTurns).toBe(7);
  });

  test("the resolver and artifact receive the same safe endpoint configuration", async () => {
    const { write } = recorder();
    const controller = new AbortController();
    controller.abort();
    const llamaServer = {
      baseUrl: "https://host.example/v1",
      modelId: "local-model",
      contextWindow: 65_536,
      maxTokens: 4_096,
      reasoningProfile: "off" as const,
    };
    const llamaServerAuth = { bearerToken: "test-bearer-token" };
    const seen: unknown[] = [];
    const deps: InvestigatorDeps = {
      source: sourceStub([]),
      webSearch: {} as unknown as InvestigatorDeps["webSearch"],
      webFetch: {} as unknown as InvestigatorDeps["webFetch"],
      write,
      resolveModel: (_provider, _id, endpoint, auth) => {
        seen.push({ endpoint, auth });
        return Promise.resolve({
          model: {},
          streamFn: () => undefined,
        } as unknown as ResolvedModel);
      },
    };

    const run = await executeRun(
      {
        ...CONFIG,
        provider: "llamacpp",
        modelId: "local-model",
        thinkingLevel: "off",
        llamaServer,
        llamaServerAuth,
      },
      deps,
      { runId: "run-local", signal: controller.signal },
    );

    expect(seen).toEqual([{ endpoint: llamaServer, auth: llamaServerAuth }]);
    expect(run.config).toMatchObject({
      modelBaseUrl: llamaServer.baseUrl,
      modelContextWindow: llamaServer.contextWindow,
      modelMaxTokens: llamaServer.maxTokens,
      modelReasoningProfile: llamaServer.reasoningProfile,
    });
    expect(JSON.stringify(run)).not.toContain(llamaServerAuth.bearerToken);
  });

  test("an unconfigured thinking level is absent, never fabricated (PRD-6 D12)", async () => {
    const { write } = recorder();
    const controller = new AbortController();
    controller.abort();

    const deps: InvestigatorDeps = {
      source: sourceStub([]),
      webSearch: {} as unknown as InvestigatorDeps["webSearch"],
      webFetch: {} as unknown as InvestigatorDeps["webFetch"],
      write,
      resolveModel: () =>
        Promise.resolve({ model: {}, streamFn: () => undefined } as unknown as ResolvedModel),
    };

    const { thinkingLevel: _omitted, ...withoutThinking } = CONFIG;
    const run = await executeRun(withoutThinking, deps, {
      runId: "run-7",
      signal: controller.signal,
    });

    // It used to write "medium" here while omitting the key from the harness options, so
    // pi-agent-core fell back to `off` and the artifact claimed a level that never applied.
    expect(run.config?.thinkingLevel).toBeUndefined();
    expect(Object.keys(run.config ?? {})).not.toContain("thinkingLevel");
  });

  test("the artifact records what produced it (PRD-6 §6.6)", async () => {
    const { write } = recorder();
    const controller = new AbortController();
    controller.abort();

    const deps: InvestigatorDeps = {
      source: sourceStub([]),
      webSearch: {} as unknown as InvestigatorDeps["webSearch"],
      webFetch: {} as unknown as InvestigatorDeps["webFetch"],
      write,
      resolveModel: () =>
        Promise.resolve({ model: {}, streamFn: () => undefined } as unknown as ResolvedModel),
    };

    const run = await executeRun(CONFIG, deps, { runId: "run-8", signal: controller.signal });

    expect(run.provenance?.promptHash).toMatch(/^[\da-f]{12}$/);
    expect(run.provenance?.submissionHash).toMatch(/^[\da-f]{12}$/);
    expect(run.provenance?.piVersion).toMatch(/^core@/);
    // No investigation ran, so nothing reported a tally and capability-versus-use is unknown.
    expect(run.config?.webSearchUsed).toBeUndefined();
  });
});

describe("InvestigationAbortedError", () => {
  test("is distinguishable from a provider failure", () => {
    const error = new InvestigationAbortedError();
    expect(error.name).toBe("InvestigationAbortedError");
    expect(error.message).toContain("cancelled");
  });
});
