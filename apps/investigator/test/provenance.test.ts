import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { InvestigationRun } from "../src/contracts/run.ts";
import {
  computePiVersion,
  computePromptHash,
  computeSubmissionHash,
  INSTRUCTIONS_LABEL,
  PROVENANCE,
} from "../src/provenance.ts";
import { TOOL_NAMES, toolDescriptors } from "../src/tools/index.ts";

/**
 * What the artifact claims about the software that produced it (PRD-6 §6.6, ADR 008 §1).
 *
 * The hashes are asserted as *properties* — stable across calls, moved by the things that change
 * behaviour, unmoved by the things that do not. Pinning the literals would turn every legitimate
 * prompt edit into a failing test, which is the opposite of what they are for.
 */

describe("promptHash", () => {
  test("is stable within a process — it is a fact about the source, not about the run", () => {
    expect(computePromptHash()).toBe(computePromptHash());
    expect(PROVENANCE.promptHash).toBe(computePromptHash());
  });

  test("covers the tool surface, not only the instructions", () => {
    // An instructions-only hash would call two materially different agents the same agent: a tool
    // description is in the model's context and changes behaviour just as surely.
    const descriptors = toolDescriptors();
    expect(descriptors.length).toBe(5);
    for (const descriptor of descriptors) {
      expect(descriptor.description.length).toBeGreaterThan(0);
      expect(descriptor.parameters).toBeDefined();
    }
  });

  test("the descriptors are the whole capability surface, in a stable order", () => {
    expect(TOOL_NAMES).toEqual([
      "get_security_schema",
      "query_security_data",
      "submit_investigation",
      "web_fetch",
      "web_search",
    ]);
    // Name order, so reordering the array in `createInvestigationTools` cannot move the hash.
    expect(toolDescriptors().map((tool) => tool.name)).toEqual([...TOOL_NAMES].toSorted());
  });
});

describe("submissionHash", () => {
  test("is separate from the prompt hash", () => {
    // `summary.nextAction` becoming `summary.researchDone` is what actually split this corpus, and
    // a reader has to be able to see which of the two moved (D17).
    expect(computeSubmissionHash()).not.toBe(computePromptHash());
    expect(computeSubmissionHash()).toBe(computeSubmissionHash());
  });
});

describe("piVersion", () => {
  test("records the declared pin rather than resolving node_modules", () => {
    // A runtime resolve would trip ground-truth-isolation's caller-supplied-path scan. The accepted
    // gap is that `bun update` inside the range moves the real version without moving this string.
    expect(computePiVersion()).toMatch(/^core@[\d.]+\+ai@[\d.]+$/);
  });
});

describe("the provenance block", () => {
  test("carries a label for legibility and hashes for truth", () => {
    expect(PROVENANCE.instructionsLabel).toBe(INSTRUCTIONS_LABEL);
    expect(PROVENANCE.promptHash).toMatch(/^[\da-f]{12}$/);
    expect(PROVENANCE.submissionHash).toMatch(/^[\da-f]{12}$/);
  });

  test("parses as part of a run artifact", () => {
    const parsed = InvestigationRun.safeParse({
      runId: "r",
      startedAt: "2026-08-20T10:00:00.000Z",
      completedAt: "2026-08-20T10:00:00.000Z",
      provenance: PROVENANCE,
      model: { provider: "openai", id: "m" },
      limits: { maxTurns: 50, timeoutMs: 600_000 },
      results: [],
    });
    expect(parsed.success).toBe(true);
  });
});

/**
 * Every artifact generation still parses (PRD-6 §8.3).
 *
 * Deliberately committed fixtures rather than a sweep of the live `runs/`: a sweep is coupled to
 * whatever a developer last ran, and committing the corpus (ADR 008 §8) makes that worse rather
 * than better — it would grow without bound and fail on the first artifact an experiment leaves
 * behind. One file per generation is the thing that actually needs asserting.
 */
async function load(name: string): Promise<Record<string, unknown>> {
  return (await Bun.file(join(import.meta.dir, "fixtures", "runs", name)).json()) as Record<
    string,
    unknown
  >;
}

function summaryOf(run: Record<string, unknown>): Record<string, unknown> {
  return (run["results"] as { summary?: Record<string, unknown> }[])[0]?.summary ?? {};
}

describe("schema generations", () => {
  const generations = [
    "gen-1-next-action.json",
    "gen-2-research-done-no-config.json",
    "gen-3-prd3-lifecycle.json",
    "gen-4-prd5-failed-derived.json",
    "gen-5-prd6-provenance.json",
  ];

  test.each(generations)("%s parses under InvestigationRun", async (name) => {
    const file = join(import.meta.dir, "fixtures", "runs", name);
    const parsed = InvestigationRun.safeParse(await Bun.file(file).json());
    expect(parsed.success ? "ok" : JSON.stringify(parsed.error?.issues)).toBe("ok");
  });

  test("the generations really are different shapes", async () => {
    const nextAction = await load("gen-1-next-action.json");
    const noConfig = await load("gen-2-research-done-no-config.json");
    const lifecycle = await load("gen-3-prd3-lifecycle.json");
    const failed = await load("gen-4-prd5-failed-derived.json");
    const provenance = await load("gen-5-prd6-provenance.json");

    expect(summaryOf(nextAction)["nextAction"]).toBeDefined();
    expect(noConfig["config"]).toBeUndefined();
    expect(lifecycle["status"]).toBeDefined();
    expect(failed["status"]).toBe("failed");
    expect(failed["derivedFrom"]).toBeDefined();
    expect(provenance["provenance"]).toBeDefined();
  });

  test("nothing added to the artifact grows with the length of an investigation", async () => {
    // ADR 008 §1's bright line, asserted rather than remembered: counters yes, content no.
    const file = join(import.meta.dir, "fixtures", "runs", "gen-5-prd6-provenance.json");
    const run = (await Bun.file(file).json()) as {
      results: {
        turns?: number;
        toolCalls?: Record<string, number>;
        usage?: Record<string, number>;
      }[];
    };

    for (const result of run.results) {
      expect(typeof result.turns).toBe("number");
      for (const [name, count] of Object.entries(result.toolCalls ?? {})) {
        expect(TOOL_NAMES).toContain(name);
        expect(typeof count).toBe("number");
      }
      for (const value of Object.values(result.usage ?? {})) {
        expect(typeof value).toBe("number");
      }
    }
  });
});
