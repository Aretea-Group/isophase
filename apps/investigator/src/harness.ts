import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type StreamFn,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SecurityAlertResource } from "@soc/contracts";
import type { SentinelClient } from "@soc/sentinel-client";

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
import { createInvestigationTools, INVESTIGATION_TOOL_NAMES } from "./tools/index.ts";

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
  /**
   * What this investigation cost, in effort and in money (PRD-6 §6.7).
   *
   * A callback rather than a widened return type, and that is load-bearing: every failure path
   * below throws, so a return value would lose exactly the most expensive runs — the timeout that
   * burned its whole budget is the one a cost comparison most needs. This fires from the `finally`
   * that wraps `agent.prompt()`, before any of them.
   */
  onMetrics?: (metrics: InvestigationMetrics) => void;
}

/**
 * Fixed-size counters, never a trace (ADR 008 §1).
 *
 * `toolCalls` is a record over the five closed tool names and nothing else — not a per-table tally,
 * because once the artifact says which tables were touched the next patch scores whether they were
 * the right ones, and PRD-2 §23's rule is gone without anyone deciding to remove it.
 * `toolCalls.query_security_data` answers *did it do less work for the same answer*, which is the
 * question a memory experiment actually asks, without naming a table.
 */
export interface InvestigationMetrics {
  turns: number;
  toolCalls: Record<string, number>;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    costUsd: number;
  };
  /** What the provider actually served, when it says. `model.id` is only an alias (**D16**). */
  servedModelId?: string;
}

export interface InvestigationHarnessOptions {
  sentinel: SentinelClient;
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
 * Fold the transcript's assistant messages into one set of counters.
 *
 * Reads `agent.state.messages` rather than `prompt()`'s return value, for the same reason
 * `onMetrics` is a callback: the return value does not exist on the paths that matter.
 */
function collectMetrics(
  messages: readonly AgentMessage[],
  turns: number,
  toolCalls: Record<string, number>,
): InvestigationMetrics {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 };
  let servedModelId: string | undefined;

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    servedModelId ??= message.responseModel;
    usage.input += message.usage.input;
    usage.output += message.usage.output;
    usage.cacheRead += message.usage.cacheRead;
    usage.cacheWrite += message.usage.cacheWrite;
    usage.totalTokens += message.usage.totalTokens;
    usage.costUsd += message.usage.cost.total;
  }

  // `reasoning` is deliberately not summed: pi-ai documents it as a subset of `output`, so adding
  // it would double-count the most expensive tokens in the run.
  return {
    turns,
    toolCalls,
    usage,
    ...(servedModelId === undefined ? {} : { servedModelId }),
  };
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
    const timeoutMs = this.#options.timeoutMs ?? 1_200_000;

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

    // Fixed keys from the start, so "searched zero times" and "not recorded" are different facts.
    const toolCalls: Record<string, number> = Object.fromEntries(
      INVESTIGATION_TOOL_NAMES.map((name) => [name, 0]),
    );

    const unsubscribe =
      options.onEvent === undefined ? undefined : agent.subscribe(options.onEvent);

    // A second subscriber, always on. Tracing writes 0.16-23 MB per investigation and is off by
    // default; a count of tool calls is a number and belongs on the artifact regardless (PRD-6 §6.7).
    const unsubscribeMetrics = agent.subscribe((event) => {
      if (event.type !== "tool_execution_start") return;
      // Only the closed set: an unknown name would make the record grow with what the agent did.
      const seen = toolCalls[event.toolName];
      if (seen !== undefined) toolCalls[event.toolName] = seen + 1;
    });

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
      unsubscribeMetrics();
      // Inside the `finally`, so the ladder of throws below cannot skip it. The aggregate is
      // already in process — `agent.state` is public and assistant messages carry `usage` — so this
      // recovers a number the harness used to discard rather than reconstructing it from a JSONL.
      options.onMetrics?.(collectMetrics(agent.state.messages, turns, toolCalls));
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
