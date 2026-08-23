import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { InvestigationRun } from "../src/contracts/run.ts";
import {
  computePiVersion,
  computePromptHash,
  computeSubmissionHash,
  INSTRUCTIONS_LABEL,
  provenanceForProfile,
} from "../src/provenance.ts";
import { createSentinelSourceBundle } from "../src/source-profile.ts";
import { INVESTIGATION_TOOL_NAMES, toolDescriptors } from "../src/tools/index.ts";
import { TEST_SOURCE_PROFILE } from "./fixtures/source.ts";

const PROVENANCE = provenanceForProfile(TEST_SOURCE_PROFILE);

/**
 * What the artifact claims about the software that produced it (PRD-6 §6.6, ADR 008 §1).
 *
 * The hashes are asserted as *properties* — stable across calls, moved by the things that change
 * behaviour, unmoved by the things that do not. Pinning the literals would turn every legitimate
 * prompt edit into a failing test, which is the opposite of what they are for.
 */

describe("promptHash", () => {
  test("is stable within a process — it is a fact about the source, not about the run", () => {
    expect(computePromptHash(TEST_SOURCE_PROFILE)).toBe(computePromptHash(TEST_SOURCE_PROFILE));
    expect(PROVENANCE.promptHash).toBe(computePromptHash(TEST_SOURCE_PROFILE));
  });

  test("covers the tool surface, not only the instructions", () => {
    // An instructions-only hash would call two materially different agents the same agent: a tool
    // description is in the model's context and changes behaviour just as surely.
    const descriptors = toolDescriptors(TEST_SOURCE_PROFILE);
    expect(descriptors.length).toBe(5);
    for (const descriptor of descriptors) {
      expect(descriptor.description.length).toBeGreaterThan(0);
      expect(descriptor.parameters).toBeDefined();
    }
  });

  test("the descriptors are the whole capability surface, in a stable order", () => {
    // Factory order: this is what the console renders, and it is read by a person.
    expect(INVESTIGATION_TOOL_NAMES).toEqual([
      "get_security_schema",
      "query_security_data",
      "web_search",
      "web_fetch",
      "submit_investigation",
    ]);
    // Name order for the hash, so reordering the factory cannot move it.
    expect(toolDescriptors(TEST_SOURCE_PROFILE).map((tool) => tool.name)).toEqual(
      [...INVESTIGATION_TOOL_NAMES].toSorted(),
    );
  });

  test("moves with active profile prompt content and not operational identity", () => {
    const base = computePromptHash(TEST_SOURCE_PROFILE);
    expect(
      computePromptHash({ ...TEST_SOURCE_PROFILE, queryGuidance: "Changed query guidance." }),
    ).not.toBe(base);
    expect(
      computePromptHash({
        ...TEST_SOURCE_PROFILE,
        guidanceActivationTools: ["query_security_data"],
      }),
    ).not.toBe(base);
    expect(
      computePromptHash({
        ...TEST_SOURCE_PROFILE,
        queryToolDescription: "Changed active query tool description.",
      }),
    ).not.toBe(base);
    expect(
      computePromptHash({
        ...TEST_SOURCE_PROFILE,
        initialContext: {
          ...TEST_SOURCE_PROFILE.initialContext,
          alertIntroduction: "Changed alert framing.",
        },
      }),
    ).not.toBe(base);

    expect(
      computePromptHash({
        ...TEST_SOURCE_PROFILE,
        kind: "other-kind",
        connector: "other-connector",
        target: "other-target",
        queryLanguage: "other-language",
      }),
    ).toBe(base);
  });

  test("distinguishes FixtureQL prompt behavior from the Sentinel KQL profile", () => {
    const sentinel = createSentinelSourceBundle({
      connector: "mock",
      baseUrl: "http://localhost:8787",
    }).profile;

    expect(TEST_SOURCE_PROFILE.queryLanguage).toBe("fixtureql");
    expect(sentinel.queryLanguage).toBe("kql");
    expect(computePromptHash(TEST_SOURCE_PROFILE)).not.toBe(computePromptHash(sentinel));
  });
});

describe("submissionHash", () => {
  test("is separate from the prompt hash", () => {
    // `summary.nextAction` becoming `summary.researchDone` is what actually split this corpus, and
    // a reader has to be able to see which of the two moved (D17).
    expect(computeSubmissionHash()).not.toBe(computePromptHash(TEST_SOURCE_PROFILE));
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

    // Widened deliberately: the export carries a literal union so the console can rely on it, and
    // the keys read back off an artifact are plain strings.
    const names: readonly string[] = INVESTIGATION_TOOL_NAMES;

    for (const result of run.results) {
      expect(typeof result.turns).toBe("number");
      for (const [name, count] of Object.entries(result.toolCalls ?? {})) {
        expect(names).toContain(name);
        expect(typeof count).toBe("number");
      }
      for (const value of Object.values(result.usage ?? {})) {
        expect(typeof value).toBe("number");
      }
    }
  });
});
