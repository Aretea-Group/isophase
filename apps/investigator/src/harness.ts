import { Agent, type StreamFn, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SecurityAlertResource } from "@soc/contracts";
import type { SentinelApiClient } from "@soc/sentinel-client";

import type { WebSearchClient } from "./clients/brave.ts";
import type { WebFetchClient } from "./clients/fetch.ts";
import { buildInitialContext } from "./context.ts";
import type { InvestigationSummary } from "./contracts/summary.ts";
import {
  InvestigationIncompleteError,
  InvestigationModelError,
  InvestigationStepLimitError,
  InvestigationTimeoutError,
} from "./errors.ts";
import { createInvestigationTools } from "./tools/index.ts";

export interface InvestigationHarnessOptions {
  sentinel: SentinelApiClient;
  webSearch: WebSearchClient;
  webFetch: WebFetchClient;
  model: Model<Api>;
  streamFn: StreamFn;
  /** Stable system prompt. Injected here so replacing it is a constructor argument (PRD-2 §8). */
  instructions: string;
  thinkingLevel?: ThinkingLevel;
  /** Ceiling on completed agent turns (PRD-2 §17). */
  maxTurns?: number;
  /** Ceiling on elapsed time for one investigation (PRD-2 §17). */
  timeoutMs?: number;
  log?: (message: string) => void;
}

/**
 * Prepares, executes, constrains and completes one autonomous SOC investigation.
 *
 * The harness owns the run environment — dependencies, startup context, capabilities, limits and
 * completion semantics — and nothing about security. It never decides how an alert should be
 * investigated; that is the model's job, and encoding a playbook here would defeat the experiment
 * (PRD-2 §3.2).
 *
 * This is the only file in the repository that imports Pi. ADR 002 asks for Pi to sit behind one
 * replaceable boundary, and PRD-2 §24 rules out building a generic agent framework to get it — so
 * the boundary is this class rather than a wrapper package (ADR 005).
 *
 * Instance state is immutable dependencies only. Everything that changes during a run is local to
 * `investigate()`, which is what will let the same harness run investigations concurrently later
 * even though PRD-2 processes alerts sequentially (PRD-2 §5.1).
 */
export class InvestigationHarness {
  readonly #options: InvestigationHarnessOptions;

  constructor(options: InvestigationHarnessOptions) {
    this.#options = options;
  }

  async investigate(alert: SecurityAlertResource): Promise<InvestigationSummary> {
    const { sentinel, webSearch, webFetch, model, streamFn, instructions } = this.#options;
    const maxTurns = this.#options.maxTurns ?? 50;
    const timeoutMs = this.#options.timeoutMs ?? 600_000;

    // Fetched once per investigation, and deliberately not placed into model context. The agent
    // gets table names and pulls the schemas it decides are relevant (PRD-2 §7).
    const schema = await sentinel.getSchema();
    const tables = new Map(schema.tables.map((table) => [table.name, table]));

    let submission: InvestigationSummary | undefined;
    let turns = 0;
    let timedOut = false;

    const agent = new Agent({
      initialState: {
        systemPrompt: instructions,
        model,
        ...(this.#options.thinkingLevel === undefined
          ? {}
          : { thinkingLevel: this.#options.thinkingLevel }),
      },
      streamFn,
      // Pi has no built-in turn limit, so the ceiling is ours to enforce. This is also the
      // authoritative stop on submission: a tool's `terminate` flag only halts the loop when every
      // result in the batch sets it, so a submission issued alongside a parallel query would
      // otherwise be ignored and the agent would keep going after it had finished.
      shouldStopAfterTurn: () => {
        turns += 1;
        return submission !== undefined || turns >= maxTurns;
      },
    });

    agent.state.tools = createInvestigationTools({
      tables,
      sentinel,
      webSearch,
      webFetch,
      // First valid submission wins. A second one cannot overwrite an assessment already made.
      onSubmit: (summary) => {
        submission ??= summary;
      },
    });

    // An Agent owns its AbortSignal and will not accept one, so the timeout bridges into abort().
    const timer = setTimeout(() => {
      timedOut = true;
      agent.abort();
    }, timeoutMs);

    try {
      await agent.prompt(buildInitialContext(alert, [...tables.keys()]));
    } finally {
      clearTimeout(timer);
    }

    if (submission) return submission;

    // Order matters below. Timeout is checked first because abort() sets an "aborted" stop reason
    // and populates errorMessage, which would otherwise be misreported as a provider failure.
    if (timedOut) throw new InvestigationTimeoutError(timeoutMs);

    // pi-ai's StreamFn contract forbids throwing for request or runtime failures: they arrive as a
    // stop reason plus errorMessage on a normally-resolved prompt(). Without this branch every
    // provider outage would be misreported as the agent simply declining to submit.
    const errorMessage = agent.state.errorMessage;
    if (errorMessage !== undefined) throw new InvestigationModelError(errorMessage);

    if (turns >= maxTurns) throw new InvestigationStepLimitError(maxTurns);

    throw new InvestigationIncompleteError();
  }
}
