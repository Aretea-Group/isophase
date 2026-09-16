import { describe, expect, test } from "bun:test";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import type { SecurityAlert } from "@soc/contracts";
import {
  findingsMarker,
  type FindingsPublisher,
  type SecurityDataSource,
} from "@soc/sentinel-client";

import type { InvestigationRun } from "../src/contracts/run.ts";
import { executeRun, type InvestigatorConfig, type InvestigatorDeps } from "../src/execute-run.ts";
import { findingsComment, renderFindings } from "../src/publish.ts";
import { testSourceSet } from "./fixtures/source.ts";

/**
 * PRD-9 AC3 and AC4 — findings reach a publisher, and a publisher that fails does not take the
 * investigation with it.
 *
 * These drive a real `executeRun` to a completed result through `pi-ai`'s faux provider, because
 * publication only happens on a completed result carrying a summary and a stub that skipped the
 * agent would prove nothing about the wiring that matters.
 */

const SUMMARY = {
  tpPercent: 90,
  tpReason: "Observed malicious activity.",
  fpPercent: 10,
  fpReason: "Limited benign uncertainty remains.",
  whatHappened: "The account performed malicious activity after the alert.",
  impact: "confirmed-compromise" as const,
  keyEvidence: ["A decisive telemetry finding."],
  researchDone: ["Checked the relevant telemetry."],
};

const CONFIG: InvestigatorConfig = {
  provider: "openai",
  modelId: "faux",
  maxTurns: 10,
  timeoutMs: 60_000,
  resultMaxChars: 40_000,
  webSearchConfigured: false,
  runsDir: "runs",
  trace: false,
  traceDir: "runs/traces",
  traceStream: false,
};

function alert(id: string): SecurityAlert {
  return {
    id,
    title: `alert ${id}`,
    description: "d",
    tactics: [],
    techniques: [],
    entities: [],
    native: { id },
  };
}

/** A provider that submits immediately, so every run reaches a completed result with a summary. */
function submittingDeps(
  publisher?: FindingsPublisher,
  options: { submits?: boolean } = {},
): {
  deps: InvestigatorDeps;
  writes: InvestigationRun[];
} {
  const faux = fauxProvider();
  // No responses at all means `prompt()` resolves without a submission, and the harness throws —
  // which is how a real investigation failure reaches `investigate-alerts.ts`.
  faux.setResponses(
    options.submits === false
      ? []
      : [
          () =>
            fauxAssistantMessage(fauxToolCall("submit_investigation", SUMMARY), {
              stopReason: "toolUse",
            }),
        ],
  );
  const writes: InvestigationRun[] = [];
  const alerts = [alert("a1")];
  return {
    writes,
    deps: {
      securitySources: testSourceSet({
        listAlerts: () => Promise.resolve(alerts),
        getAlert: () => Promise.resolve(alerts[0] as SecurityAlert),
        getSchema: () => Promise.resolve({ tables: [] }),
        getCorpus: () => Promise.resolve(undefined),
      } as unknown as SecurityDataSource),
      webSearch: { search: () => Promise.resolve([]) } as unknown as InvestigatorDeps["webSearch"],
      webFetch: {
        fetchPage: () => Promise.resolve({ url: "", title: "", content: "" }),
      } as unknown as InvestigatorDeps["webFetch"],
      write: (_directory, run) => {
        writes.push(JSON.parse(JSON.stringify(run)) as InvestigationRun);
        return Promise.resolve(`runs/${run.runId}.json`);
      },
      resolveModel: () =>
        Promise.resolve({
          model: faux.getModel() as unknown as Model<Api>,
          streamFn: faux.provider.streamSimple,
        } as unknown as Awaited<ReturnType<NonNullable<InvestigatorDeps["resolveModel"]>>>),
      ...(publisher === undefined ? {} : { publisher }),
    },
  };
}

function lastPublication(
  writes: InvestigationRun[],
): InvestigationRun["results"][number]["publication"] {
  return writes.at(-1)?.results[0]?.publication;
}

describe("publication (PRD-9 §4.2)", () => {
  test("AC3 — Given a completed investigation with the local publisher, When the artifact is written, Then it records the publisher and a caseRef", async () => {
    const { deps, writes } = submittingDeps();

    const run = await executeRun(CONFIG, deps, { runId: "run-pub-1" });

    expect(run.results[0]?.status).toBe("completed");
    const published = lastPublication(writes);
    expect(published?.publisher).toBe("local");
    expect(published?.status).toBe("published");
    expect(published?.caseRef).toContain(findingsMarker("a1"));
    expect(published?.error).toBeUndefined();
  });

  test("AC4 — Given a publisher that throws, When the investigation completes, Then the artifact is still written and records the failure", async () => {
    const exploding: FindingsPublisher = {
      id: "exploding",
      publishFindings: () => Promise.reject(new Error("the portal said no")),
    };
    const { deps, writes } = submittingDeps(exploding);

    const run = await executeRun(CONFIG, deps, { runId: "run-pub-2" });

    // The investigation is the durable output; the comment is a copy. Losing the copy must not
    // lose the finding, which is the whole reason publication is not allowed to throw upward.
    expect(run.status).toBe("completed");
    expect(run.results[0]?.summary?.tpPercent).toBe(90);
    const published = lastPublication(writes);
    expect(published?.publisher).toBe("exploding");
    expect(published?.status).toBe("failed");
    expect(published?.error?.message).toBe("the portal said no");
    expect(published?.caseRef).toBeUndefined();
  });

  test("a sweep whose only investigation failed reports `failed`, not `completed`", async () => {
    /**
     * ADR 012 §10. Before this, `finalStatus` never inspected results: a timed-out investigation
     * produced `status: "completed"`, the console drew a green tick over it, and the watch loop
     * credited the alert as seen — so `maxFailuresPerAlert` could never fire for the commonest
     * failure there is.
     *
     * The faux provider is given no responses, so `agent.prompt()` resolves with no submission and
     * the harness throws. That is a real failure through the real path, not an injected status.
     */
    const { deps, writes } = submittingDeps(undefined, { submits: false });

    const run = await executeRun(CONFIG, deps, { runId: "run-fail-1" });

    expect(run.results[0]?.status).toBe("failed");
    expect(run.status).toBe("failed");
    expect(writes.at(-1)?.status).toBe("failed");
    // The cause stays per-result: five alerts can fail five different ways, so flattening them into
    // one run-level error would pick a winner arbitrarily (contracts/run.ts).
    expect(run.error).toBeUndefined();
    expect(run.results[0]?.error?.name).toBeDefined();
  });

  test("a slow publisher does not leave the artifact saying `running`", async () => {
    /**
     * Regression, found by review against real artifacts rather than by a test.
     *
     * `publishThenFlush` fires from `onResult` and its first `await` is the network, so its own
     * flush used to land *after* the terminal one and last-write-wins left `status: "running"` on
     * disk forever. Both live Defender runs ended that way; both local-publisher runs did not,
     * because the local publisher is fast enough to lose the race. A delay is therefore the whole
     * fixture — with a synchronous publisher this test passes either way.
     */
    const slow: FindingsPublisher = {
      id: "slow",
      publishFindings: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { status: "published", caseRef: "somewhere" };
      },
    };
    const { deps, writes } = submittingDeps(slow);

    const run = await executeRun(CONFIG, deps, { runId: "run-pub-3" });

    expect(run.status).toBe("completed");
    // The assertion the original test was missing: what the *last write* says, not what the
    // returned object says. Those disagreed, and only the file survives the process.
    expect(writes.at(-1)?.status).toBe("completed");
    expect(writes.at(-1)?.results[0]?.publication?.status).toBe("published");
  });

  test("a destination with a 1,000-character limit gets a shorter render, not a cut one", () => {
    // Graph rejected 2,913 characters on a live incident with
    // `Maximum comment length is 1000 characters` (ADR 012 §8). Truncating the full body would have
    // dropped its tail — the evidence and the disclaimer — leaving the confident opening alone.
    //
    // Sized like a real submission rather than like the fixture above: the live body that was
    // rejected had a ~900-character `whatHappened` and six pieces of evidence, which is what the
    // schema's own limits permit and what the agent actually writes.
    const long = {
      ...SUMMARY,
      whatHappened: `On 2026-08-28 the service principal made repeated failed token requests. ${"Detail. ".repeat(100)}`,
      keyEvidence: Array.from(
        { length: 6 },
        (_, index) => `Evidence ${index}: ${"finding. ".repeat(20)}`,
      ),
      researchDone: Array.from(
        { length: 6 },
        (_, index) => `Checked line ${index}: ${"query. ".repeat(15)}`,
      ),
    };

    const full = findingsComment("a1", long);
    const brief = findingsComment("a1", long, 1_000);

    expect(full.length).toBeGreaterThan(1_000);
    expect(brief.length).toBeLessThanOrEqual(1_000);
    expect(brief).toContain(findingsMarker("a1"));
    expect(brief).toContain("90% true positive");
    // The sentence that stops a reader assuming the case was actioned survives the shortening.
    expect(brief).toContain("status and classification are unchanged");
    expect(brief).not.toEndWith("[truncated]");
  });

  test("an unbounded destination still gets the full render", () => {
    const body = findingsComment("a1", SUMMARY);

    expect(body).toContain("Supporting a false positive:");
    expect(body).toContain("Lines of enquiry checked:");
  });

  test("the rendered comment states a likelihood and sets no classification (D5)", () => {
    const body = renderFindings(SUMMARY);

    expect(body).toContain("90% true positive");
    expect(body).toContain("Impact: confirmed-compromise.");
    expect(body).toContain("has not changed this alert's status or classification");
    // The fence in §3, asserted rather than trusted: this renderer is where "and set the
    // classification while we're here" would actually land.
    for (const forbidden of [
      "TruePositive",
      "BenignPositive",
      "determination",
      "Recommended action",
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });
});
