import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { SecurityAlertResource } from "@soc/contracts";

import { BraveSearchClient } from "./clients/brave.ts";
import { HttpWebFetchClient } from "./clients/fetch.ts";
import type { InvestigationRun } from "./contracts/run.ts";
import { executeRun, type InvestigatorConfig, type InvestigatorDeps } from "./execute-run.ts";
import { listAvailableModels, type ModelChoice } from "./model.ts";

/**
 * The surface an operator interface drives the investigator through (PRD-5 §5.3).
 *
 * The console depends on *this*, never on `executeRun` directly, and that is the decision that keeps
 * a later API or worker cheap: in-process execution is one implementation of this interface, and a
 * spawned child or a queue worker is another, swappable without the caller changing.
 */
export interface InvestigationControl {
  listAlerts(): Promise<SecurityAlertResource[]>;
  /** Only models this machine holds a credential for — never the full registered catalogue. */
  listModels(): Promise<ModelChoice[]>;
  /** Returns immediately. The run proceeds in the background and reports through `subscribe`. */
  start(request: StartRequest): RunHandle;
  cancel(runId: string): void;
  subscribe(listener: (event: ControlEvent) => void): () => void;
  live(): LiveRun[];
  /** Cancel everything still running. Called on quit. */
  shutdown(): void;
}

export interface StartRequest {
  runId: string;
  alertId: string;
  alertTitle?: string;
  /** Overrides the configured model for this run only (PRD-5 §9). */
  model?: { provider: string; id: string };
  analystContext?: string;
  derivedFrom?: { runId: string; alertId: string };
}

export interface RunHandle {
  runId: string;
  /** Resolves when the run settles, either way. Never rejects — faults arrive as `run_failed`. */
  settled: Promise<void>;
}

export interface LiveRun {
  runId: string;
  alertId: string;
  alertTitle?: string;
  startedAt: string;
  /** The most recent thing the agent did, for a one-line progress display. */
  activity?: string;
}

/**
 * What a caller sees, in the caller's own vocabulary.
 *
 * Deliberately *not* Pi's `AgentEvent`. `harness.ts` is the only file in the repository that
 * imports Pi (ADR 002, ADR 005) and handing its event type to the console would make the console
 * the second — and would put a pre-1.0 dependency's types into what is meant to become an API
 * surface. The mapping below is the whole cost of keeping that boundary.
 */
export type ControlEvent =
  | { type: "run_started"; runId: string; alertId: string }
  | { type: "turn"; runId: string; alertId: string; turn: number }
  | { type: "tool_call"; runId: string; alertId: string; tool: string; args: string }
  | {
      type: "tool_result";
      runId: string;
      alertId: string;
      tool: string;
      chars: number;
      isError: boolean;
    }
  | { type: "assistant_text"; runId: string; alertId: string; text: string }
  | { type: "run_completed"; runId: string; alertId: string; run: InvestigationRun }
  | { type: "run_failed"; runId: string; alertId: string; error: { name: string; message: string } }
  | { type: "run_cancelled"; runId: string; alertId: string };

export interface InProcessControlOptions {
  config: InvestigatorConfig;
  /**
   * Sentinel, and the web tools, and the artifact writer.
   *
   * `webSearch` and `webFetch` default to the real clients built from `config`, so a caller does
   * not construct the agent's own tool clients — those are the investigator's business, and a
   * console reaching for them is a wider seam than this boundary is meant to be (PRD-5 §5.5).
   */
  deps: Omit<InvestigatorDeps, "webSearch" | "webFetch"> &
    Partial<Pick<InvestigatorDeps, "webSearch" | "webFetch">>;
  /** Web-tool settings, used only to build the defaults above. */
  web?: {
    braveApiKey?: string;
    braveTimeoutMs?: number;
    braveResultCount?: number;
    webFetchTimeoutMs?: number;
  };
  /** Ceiling on concurrent runs. There is no other cost ceiling in the repository (PRD-5 §8). */
  maxConcurrent?: number;
}

function describe(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "UnknownError", message: String(error) };
}

function textOf(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" && part !== null && (part as { type?: string }).type === "text",
    )
    .map((part) => part.text)
    .join("");
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

interface Running {
  controller: AbortController;
  live: LiveRun;
  turn: number;
}

/**
 * Runs investigations inside the caller's process, behind a supervisor.
 *
 * The supervisor is what makes this safe to host in a TUI. Every run's promise is caught here, and
 * a fault marks *that run* failed rather than escaping into the host's `uncaughtException` handler —
 * which, in the console's case, destroys the renderer and exits (PRD-5 §5.4).
 *
 * This is best-effort and the PRD says so on screen: an out-of-memory or a native crash still takes
 * the process. What it does eliminate is the ordinary case — a tool throwing, a provider hanging up,
 * a schema surprise — taking a terminal down with it.
 */
export class InProcessControl implements InvestigationControl {
  readonly #config: InvestigatorConfig;
  readonly #deps: InvestigatorDeps;
  readonly #maxConcurrent: number;
  readonly #running = new Map<string, Running>();
  readonly #listeners = new Set<(event: ControlEvent) => void>();

  constructor(options: InProcessControlOptions) {
    this.#config = options.config;
    this.#deps = {
      ...options.deps,
      webSearch:
        options.deps.webSearch ??
        new BraveSearchClient({
          apiKey: options.web?.braveApiKey ?? "",
          ...(options.web?.braveTimeoutMs === undefined
            ? {}
            : { timeoutMs: options.web.braveTimeoutMs }),
          ...(options.web?.braveResultCount === undefined
            ? {}
            : { count: options.web.braveResultCount }),
        }),
      webFetch:
        options.deps.webFetch ??
        new HttpWebFetchClient(
          options.web?.webFetchTimeoutMs === undefined
            ? {}
            : { timeoutMs: options.web.webFetchTimeoutMs },
        ),
    };
    this.#maxConcurrent = options.maxConcurrent ?? 2;
  }

  listAlerts(): Promise<SecurityAlertResource[]> {
    return this.#deps.sentinel.listAlerts();
  }

  listModels(): Promise<ModelChoice[]> {
    return listAvailableModels();
  }

  subscribe(listener: (event: ControlEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  live(): LiveRun[] {
    return [...this.#running.values()].map((entry) => structuredClone(entry.live));
  }

  cancel(runId: string): void {
    this.#running.get(runId)?.controller.abort();
  }

  shutdown(): void {
    for (const entry of this.#running.values()) entry.controller.abort();
  }

  /**
   * A listener that throws must not break the run that emitted the event, nor the other listeners.
   * This is the same containment argument as the supervisor, one level down.
   */
  #emit(event: ControlEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A display fault is never allowed to affect an investigation.
      }
    }
  }

  start(request: StartRequest): RunHandle {
    const { runId, alertId } = request;

    if (this.#running.size >= this.#maxConcurrent) {
      const error = {
        name: "ConcurrencyLimitError",
        message: `Already running ${this.#running.size} investigation(s); the ceiling is ${this.#maxConcurrent}.`,
      };
      this.#emit({ type: "run_failed", runId, alertId, error });
      return { runId, settled: Promise.resolve() };
    }

    const controller = new AbortController();
    const entry: Running = {
      controller,
      turn: 0,
      live: {
        runId,
        alertId,
        ...(request.alertTitle === undefined ? {} : { alertTitle: request.alertTitle }),
        startedAt: new Date().toISOString(),
      },
    };
    this.#running.set(runId, entry);
    this.#emit({ type: "run_started", runId, alertId });

    const config: InvestigatorConfig =
      request.model === undefined
        ? this.#config
        : { ...this.#config, provider: request.model.provider, modelId: request.model.id };

    const settled = executeRun(config, this.#deps, {
      runId,
      alertId,
      ...(request.analystContext === undefined ? {} : { analystContext: request.analystContext }),
      ...(request.derivedFrom === undefined ? {} : { derivedFrom: request.derivedFrom }),
      signal: controller.signal,
      onEvent: (_alert, event) => {
        this.#forward(runId, alertId, entry, event);
      },
    })
      .then((run) => {
        if (controller.signal.aborted) this.#emit({ type: "run_cancelled", runId, alertId });
        else this.#emit({ type: "run_completed", runId, alertId, run });
        return undefined;
      })
      .catch((error: unknown) => {
        // The supervisor. Nothing from a run reaches the host's unhandled-rejection path.
        this.#emit({ type: "run_failed", runId, alertId, error: describe(error) });
      })
      .finally(() => {
        this.#running.delete(runId);
      });

    return { runId, settled };
  }

  /** Pi's vocabulary in, ours out. The only place that translation happens. */
  #forward(runId: string, alertId: string, entry: Running, event: AgentEvent): void {
    switch (event.type) {
      case "turn_start": {
        entry.turn += 1;
        entry.live.activity = `turn ${entry.turn}`;
        this.#emit({ type: "turn", runId, alertId, turn: entry.turn });
        break;
      }
      case "message_end": {
        if ((event.message as { role?: string }).role !== "assistant") break;
        const text = textOf(event.message);
        if (text.trim() === "") break;
        entry.live.activity = clip(text, 80);
        this.#emit({ type: "assistant_text", runId, alertId, text });
        break;
      }
      case "tool_execution_start": {
        const args = clip(JSON.stringify(event.args ?? {}), 400);
        entry.live.activity = `${event.toolName}`;
        this.#emit({ type: "tool_call", runId, alertId, tool: event.toolName, args });
        break;
      }
      case "tool_execution_end": {
        const text = textOf(event.result);
        this.#emit({
          type: "tool_result",
          runId,
          alertId,
          tool: event.toolName,
          chars: text.length,
          isError: event.isError === true,
        });
        break;
      }
      default:
        break;
    }
  }
}
