import {
  Agent,
  type AgentEvent,
  type StreamFn,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SecurityAlertResource } from "@soc/contracts";
import type { SentinelApiClient } from "@soc/sentinel-client";

import type { WebSearchClient } from "./clients/brave.ts";
import type { WebFetchClient } from "./clients/fetch.ts";
import { buildInitialContext } from "./context.ts";
import type { InvestigationSummary } from "./contracts/summary.ts";
import {
  InvestigationAbortedError,
  InvestigationIncompleteError,
  InvestigationModelError,
  InvestigationStepLimitError,
  InvestigationTimeoutError,
} from "./errors.ts";
import { createInvestigationTools } from "./tools/index.ts";

export interface InvestigateOptions {
  /**
   * Observer for this investigation's Pi events. Off by default: the run artifact is the durable
   * output and a transcript is a debugging aid (PRD-2 §19). Passed per call rather than per
   * harness so a trace belongs to exactly one investigation.
   */
  onEvent?: (event: AgentEvent) => void;
  /**
   * Stop this investigation from outside (PRD-5 §6).
   *
   * The CLI never passes one — it stops by dying, which is what `SIGINT` does today. A caller that
   * shares a process with the agent has no process to kill, so cancellation has to be a signal.
   */
  signal?: AbortSignal;
  /**
   * An operator premise for turn 0 (PRD-5 §9).
   *
   * It arrives as part of the user message, not as a sixth tool — the agent's capability surface is
   * unchanged. `buildInitialContext` owns the envelope and its sanitisation.
   */
  analystContext?: string;
}

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
  /** Character budget for a single query result (ADR 002, "result-size limits"). */
  resultMaxChars?: number;
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

  async investigate(
    alert: SecurityAlertResource,
    options: InvestigateOptions = {},
  ): Promise<InvestigationSummary> {
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
    let aborted = false;

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
      ...(this.#options.resultMaxChars === undefined
        ? {}
        : { resultMaxChars: this.#options.resultMaxChars }),
      // First valid submission wins. A second one cannot overwrite an assessment already made.
      onSubmit: (summary) => {
        submission ??= summary;
      },
    });

    const unsubscribe =
      options.onEvent === undefined ? undefined : agent.subscribe(options.onEvent);

    // An Agent owns its AbortSignal and will not accept one, so both the timeout and the caller's
    // signal bridge into abort(). Each sets its own flag first, because abort() alone is
    // indistinguishable afterwards — see the error ladder below.
    const timer = setTimeout(() => {
      timedOut = true;
      agent.abort();
    }, timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      agent.abort();
    };
    // Already-aborted signals never fire the event, so the flag is set from the current state.
    if (options.signal?.aborted === true) aborted = true;
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      if (aborted) throw new InvestigationAbortedError();
      await agent.prompt(buildInitialContext(alert, [...tables.keys()], options.analystContext));
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      unsubscribe?.();
    }

    if (submission) return submission;

    // Order matters below. Timeout and caller-abort are checked first because abort() sets an
    // "aborted" stop reason and populates errorMessage, which would otherwise be misreported as a
    // provider failure — the whole reason both keep their own flag.
    if (timedOut) throw new InvestigationTimeoutError(timeoutMs);
    if (aborted) throw new InvestigationAbortedError();

    // pi-ai's StreamFn contract forbids throwing for request or runtime failures: they arrive as a
    // stop reason plus errorMessage on a normally-resolved prompt(). Without this branch every
    // provider outage would be misreported as the agent simply declining to submit.
    const errorMessage = agent.state.errorMessage;
    if (errorMessage !== undefined) throw new InvestigationModelError(errorMessage);

    if (turns >= maxTurns) throw new InvestigationStepLimitError(maxTurns);

    throw new InvestigationIncompleteError();
  }
}
