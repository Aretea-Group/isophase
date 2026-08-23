import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { SecurityAlert } from "@soc/contracts";

import type { WebSearchClient } from "./clients/brave.ts";
import type { WebFetchClient } from "./clients/fetch.ts";
import type { InvestigationResult, InvestigationRun, RunCorpusIdentity } from "./contracts/run.ts";
import { InvestigationSupervisorError } from "./errors.ts";
import { InvestigationHarness } from "./harness.ts";
import { DEFAULT_INSTRUCTIONS } from "./instructions.ts";
import { investigateAlerts } from "./investigate-alerts.ts";
import type { LlamaServerAuth, LlamaServerConfig, ResolvedModel } from "./model.ts";
import { resolveModel as resolveModelDefault } from "./model.ts";
import { provenanceForProfile } from "./provenance.ts";
import { writeRunArtifact } from "./run-artifact.ts";
import type { SecuritySourceBundle } from "./source-profile.ts";
import { createTracer } from "./trace.ts";

/** The run's lifecycle, distinct from the per-alert `InvestigationResult.status` (PRD-3 §7). */
export type RunStatus = NonNullable<InvestigationRun["status"]>;

/**
 * The investigator's standing setup — model, limits, directories, tracing.
 *
 * Standing rather than per-run, which is why it is named for the investigator and not for a run:
 * `InProcessControl` builds one of these and reuses it for the process lifetime, layering only a
 * per-run model override on top. The per-invocation inputs live in `RunOptions`.
 *
 * The CLI fills this from `env`; the console fills it from its own configuration. Both the harness
 * and the run artifact are built from *this* object and from nothing else, which is what makes it
 * impossible for the artifact to claim a model or a limit that did not apply (PRD-5 §9).
 */
export interface InvestigatorConfig {
  provider: string;
  modelId: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  maxTurns: number;
  timeoutMs: number;
  resultMaxChars: number;
  webSearchConfigured: boolean;
  runsDir: string;
  trace: boolean;
  traceDir: string;
  traceStream: boolean;
  llamaServer?: LlamaServerConfig;
  /** In-memory request credential. Never copy this into an artifact or configuration view. */
  llamaServerAuth?: LlamaServerAuth;
}

export interface InvestigatorDeps {
  source: SecuritySourceBundle;
  webSearch: WebSearchClient;
  webFetch: WebFetchClient;
  /**
   * Where the artifact lands. Injected so a later store is a parameter rather than a rewrite —
   * deliberately a function and not a `RunStore` interface, which would be an empty
   * future-capability abstraction with exactly one implementation (PRD-5 §5.2).
   */
  write?: (directory: string, run: InvestigationRun) => Promise<string>;
  /**
   * Resolved in here rather than handed in, so `config.modelId` is the single source for both the
   * model that executes and the model the artifact records. Overridden only by tests.
   */
  resolveModel?: (
    provider: string,
    id: string,
    llamaServer?: LlamaServerConfig,
    llamaServerAuth?: LlamaServerAuth,
  ) => Promise<ResolvedModel>;
}

/** Everything that varies per invocation. The standing half is `InvestigatorConfig`. */
export interface RunOptions {
  /**
   * Supplied by the caller, never generated here (PRD-5 §5.2).
   *
   * A queue, a console or a CLI all need to know the id *before* the work starts: it is how a
   * caller finds the artifact, routes a cancellation, and — the reason this matters most — how a
   * run that dies during startup can be recorded at all.
   */
  runId: string;
  /** Investigate one alert. Omitted, the run covers every alert `listAlerts()` returns. */
  alertId?: string;
  /** An operator premise, carried into turn 0 and recorded raw on the artifact (PRD-5 §9). */
  analystContext?: string;
  /** The run this one derives from. Always a fresh `runId`, never the parent's (PRD-5 §9). */
  derivedFrom?: { runId: string; alertId: string };
  onResult?: (result: InvestigationResult) => void;
  /** Fired after every artifact write, so a caller can follow a run without polling the disk. */
  onProgress?: (run: InvestigationRun) => void;
  onEvent?: (alert: SecurityAlert, event: AgentEvent) => void;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

function describe(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "UnknownError", message: String(error) };
}

/**
 * Carry out one run: prepare, investigate each alert in turn, keep the artifact current throughout.
 *
 * This is `main()`'s body with argv, `env`, `SIGINT` and `console.info` lifted out — those stay in
 * `index.ts`, which is now an adapter over this. The behaviour of `bun run investigate` is
 * unchanged; what is new is that anything else can call it (PRD-5 §5.2).
 *
 * Returns the final artifact. Throws only when the run could not start — and writes a `failed`
 * artifact before it does, so a startup mistake leaves a record rather than nothing.
 */
export async function executeRun(
  config: InvestigatorConfig,
  deps: InvestigatorDeps,
  options: RunOptions,
): Promise<InvestigationRun> {
  const write = deps.write ?? writeRunArtifact;
  const resolve = deps.resolveModel ?? resolveModelDefault;
  const log = options.log ?? ((): undefined => undefined);
  const { runId } = options;
  const startedAt = new Date().toISOString();
  const provenance = provenanceForProfile(deps.source.profile);

  const collected: InvestigationResult[] = [];
  let alerts: SecurityAlert[] = [];
  let servedModelId: string | undefined;
  let corpus: RunCorpusIdentity | undefined;

  const build = (
    status: RunStatus,
    error?: { name: string; message: string },
  ): InvestigationRun => {
    // Recomputed on every flush rather than at the end, so an in-flight artifact is as true as a
    // finished one — which is the property PRD-3 §7 flushes for.
    const tallied = collected.filter((result) => result.toolCalls !== undefined);
    const webSearchUsed =
      tallied.length === 0
        ? undefined
        : tallied.some((result) => (result.toolCalls?.["web_search"] ?? 0) > 0);

    return {
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      status,
      ...(error === undefined ? {} : { error }),
      // Written before the first alert so a reader can say how much of the run is left, and which
      // alert each remaining slot is; `results` only ever holds finished alerts (PRD-3 §7, §11).
      alertCount: alerts.length,
      plannedAlerts: alerts.map((alert) => ({
        alertId: alert.id,
        alertTitle: alert.title,
      })),
      ...(config.trace ? { traceDir: config.traceDir } : {}),
      ...(options.derivedFrom === undefined ? {} : { derivedFrom: options.derivedFrom }),
      // `servedModelId` is what the provider actually served, reported per assistant message and
      // identical across a run (**D16**). A provider re-pointing an alias is otherwise invisible and
      // reads as agent regression.
      provenance: {
        ...provenance,
        ...(servedModelId === undefined ? {} : { servedModelId }),
        ...(corpus === undefined ? {} : { corpus }),
      },
      config: {
        // No `?? "medium"`: an unset thinking level is omitted from the harness options too, so
        // pi-agent-core falls back to `off` and writing "medium" here was a lie (**D12**).
        ...(config.thinkingLevel === undefined ? {} : { thinkingLevel: config.thinkingLevel }),
        resultMaxChars: config.resultMaxChars,
        source: {
          kind: deps.source.profile.kind,
          connector: deps.source.profile.connector,
          target: deps.source.profile.target,
          queryLanguage: deps.source.profile.queryLanguage,
        },
        webSearchConfigured: config.webSearchConfigured,
        // Capability is not use. Derived from the tally rather than declared, so it costs nothing and
        // cannot disagree with what happened (**D14**). Absent until a result carries a tally at all.
        ...(webSearchUsed === undefined ? {} : { webSearchUsed }),
        // Raw, not the sanitised copy that reached the model — that is what makes the
        // sanitisation auditable, and what lets `evaluate` recognise a steered run.
        ...(options.analystContext === undefined ? {} : { analystContext: options.analystContext }),
        ...(config.provider !== "llamacpp" || config.llamaServer === undefined
          ? {}
          : {
              modelBaseUrl: config.llamaServer.baseUrl,
              modelContextWindow: config.llamaServer.contextWindow,
              modelMaxTokens: config.llamaServer.maxTokens,
              modelReasoningProfile: config.llamaServer.reasoningProfile,
            }),
      },
      model: { provider: config.provider, id: config.modelId },
      limits: { maxTurns: config.maxTurns, timeoutMs: config.timeoutMs },
      results: collected,
    };
  };

  /**
   * Serialise the flushes.
   *
   * `investigateAlerts` calls `onResult` synchronously while a write is async, so firing and forgetting
   * would let two writes interleave and would let a cancellation flush race one already in flight
   * (PRD-3 §7). Chaining makes the last write win in call order.
   *
   * A failed flush is reported and swallowed rather than breaking the chain: losing one
   * intermediate artifact write is survivable, losing the rest of the run to it is not.
   */
  let queue: Promise<string | undefined> = Promise.resolve(undefined);
  const flushQueued = (
    status: RunStatus,
    runError?: { name: string; message: string },
  ): Promise<string | undefined> => {
    queue = queue.then(async () => {
      const run = build(status, runError);
      try {
        const path = await write(config.runsDir, run);
        options.onProgress?.(run);
        return path;
      } catch (error) {
        log(`[investigator] could not write the run artifact — ${describe(error).message}`);
        return undefined;
      }
    });
    return queue;
  };

  let harness: InvestigationHarness;
  try {
    const { model, streamFn } = await resolve(
      config.provider,
      config.modelId,
      config.llamaServer,
      config.llamaServerAuth,
    );

    harness = new InvestigationHarness({
      source: deps.source,
      webSearch: deps.webSearch,
      webFetch: deps.webFetch,
      model,
      streamFn,
      instructions: DEFAULT_INSTRUCTIONS,
      ...(config.thinkingLevel === undefined ? {} : { thinkingLevel: config.thinkingLevel }),
      maxTurns: config.maxTurns,
      timeoutMs: config.timeoutMs,
      resultMaxChars: config.resultMaxChars,
    });

    alerts =
      options.alertId === undefined
        ? await deps.source.client.listAlerts()
        : [await deps.source.client.getAlert(options.alertId)];

    // Which data this run was actually scored against (PRD-6 §6.8). `undefined` on an older Mock
    // Sentinel, and that is the point: the artifact records no corpus rather than a fabricated one,
    // and a bootstrap that re-pins the content-addressed alert ids becomes a visible hash change
    // instead of a silently empty evaluation report.
    corpus = await deps.source.client.getCorpus().catch(() => undefined);
  } catch (error) {
    // Everything above happens before a single alert is investigated, and each step can fail on an
    // ordinary mistake — a typo'd model, a Sentinel that is not running, an alert id that does not
    // exist. Recording it is the whole reason `runId` is an input (PRD-5 §5.2).
    const failed = build("failed", describe(error));
    try {
      await write(config.runsDir, failed);
      options.onProgress?.(failed);
    } catch {
      // The run already failed; losing the record of *why* must not replace the real error.
    }
    throw error;
  }

  log(
    `[investigator] run ${runId} — ${alerts.length} alert(s) via ` +
      `${config.provider}/${config.modelId}`,
  );

  // The artifact exists from the first moment, so an in-flight run is visible to a reader before
  // its first alert finishes (PRD-3 §7).
  await flushQueued("running");

  if (config.trace) log(`[investigator] tracing enabled — transcripts in ${config.traceDir}/`);

  await investigateAlerts({
    harness,
    alerts,
    log,
    ...(options.analystContext === undefined ? {} : { analystContext: options.analystContext }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onMetrics: (_alert, metrics) => {
      servedModelId ??= metrics.servedModelId;
    },
    onResult: (result) => {
      collected.push(result);
      options.onResult?.(result);
      void flushQueued("running");
    },
    ...(config.trace
      ? {
          createEventSink: (alert: SecurityAlert) => {
            const tracer = createTracer({
              runId,
              alertId: alert.id,
              dir: config.traceDir,
              // Narration goes wherever the caller's `log` goes. The CLI sends it to stdout; a
              // caller sharing a terminal with a renderer must not have it written underneath.
              console: true,
              streamDeltas: config.traceStream,
              log,
            });
            const forward = options.onEvent;
            if (forward === undefined) return tracer.onEvent;
            return (event: AgentEvent): void => {
              tracer.onEvent(event);
              forward(alert, event);
            };
          },
        }
      : options.onEvent === undefined
        ? {}
        : {
            createEventSink: (alert: SecurityAlert) => {
              const forward = options.onEvent;
              if (forward === undefined) return undefined;
              return (event: AgentEvent): void => forward(alert, event);
            },
          }),
  });

  // A cancelled run is `interrupted`, not `completed` — the same word the CLI's SIGINT path has
  // always written, because it describes the same thing: stopped part-way, with usable data.
  const supervisorFault =
    options.signal?.reason instanceof InvestigationSupervisorError
      ? options.signal.reason.fault
      : undefined;
  const finalStatus: RunStatus =
    supervisorFault !== undefined
      ? "failed"
      : options.signal?.aborted === true
        ? "interrupted"
        : "completed";
  await flushQueued(finalStatus, supervisorFault);
  return build(finalStatus, supervisorFault);
}
