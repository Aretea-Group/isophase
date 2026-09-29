import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { SecurityAlert } from "@soc/contracts";
import { type FindingsPublisher, LocalFindingsPublisher } from "@soc/sentinel-client";

import type { WebSearchClient } from "./clients/brave.ts";
import type { WebFetchClient } from "./clients/fetch.ts";
import type { InvestigationResult, InvestigationRun, RunCorpusIdentity } from "./contracts/run.ts";
import { InvestigationSupervisorError } from "./errors.ts";
import { InvestigationHarness } from "./harness.ts";
import { DEFAULT_INSTRUCTIONS } from "./instructions.ts";
import { investigateAlerts } from "./investigate-alerts.ts";
import type { LlamaServerAuth, LlamaServerConfig, ResolvedModel } from "./model.ts";
import { resolveModel as resolveModelDefault } from "./model.ts";
import { provenanceForProfiles } from "./provenance.ts";
import { findingsComment } from "./publish.ts";
import { writeRunArtifact } from "./run-artifact.ts";
import type { SecuritySourceSet } from "./source-profile.ts";
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
  /** The alert-queue window, when the selected source bounds its queue by one (PRD-8 D14). */
  alertWindow?: string;
  /** Connector-side query row cap, when the selected source exposes one (PRD-8 D15). */
  queryMaxRows?: number;
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
  securitySources: SecuritySourceSet;
  webSearch: WebSearchClient;
  webFetch: WebFetchClient;
  /**
   * Where the artifact lands. Injected so a later store is a parameter rather than a rewrite —
   * deliberately a function and not a `RunStore` interface, which would be an empty
   * future-capability abstraction with exactly one implementation (PRD-5 §5.2).
   */
  write?: (directory: string, run: InvestigationRun) => Promise<string>;
  /**
   * Where findings go when an investigation completes (PRD-10 §4.1 D1, D12).
   *
   * Defaults to the local publisher, so a clone with no credentials still exercises the whole path.
   * An interface rather than a function - unlike `write` above - because it has two implementations
   * rather than one, which is the test PRD-5 §5.2 actually applies.
   */
  publisher?: FindingsPublisher;
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
  const publisher = deps.publisher ?? new LocalFindingsPublisher();
  const resolve = deps.resolveModel ?? resolveModelDefault;
  const log = options.log ?? ((): undefined => undefined);
  const { runId } = options;
  const startedAt = new Date().toISOString();
  const sourceEntries = [...deps.securitySources.sources];
  const primaryEntry = sourceEntries.find(([, bundle]) => bundle === deps.securitySources.primary);
  if (primaryEntry === undefined) throw new Error("Primary security source is not active.");
  const [primaryId, primary] = primaryEntry;
  const provenance = provenanceForProfiles({
    primaryId,
    sources: new Map(sourceEntries.map(([id, bundle]) => [id, bundle.profile] as const)),
  });

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
        ...(config.alertWindow === undefined ? {} : { alertWindow: config.alertWindow }),
        ...(config.queryMaxRows === undefined ? {} : { queryMaxRows: config.queryMaxRows }),
        source: {
          kind: primary.profile.kind,
          connector: primary.profile.connector,
          target: primary.profile.target,
          queryLanguage: primary.profile.queryLanguage,
        },
        sources: sourceEntries.map(([id, bundle]) => ({
          id,
          kind: bundle.profile.kind,
          connector: bundle.profile.connector,
          target: bundle.profile.target,
          queryLanguage: bundle.profile.queryLanguage,
        })),
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

  /**
   * Publish a finished result, then flush (PRD-10 §4.1 D12).
   *
   * Every caller publishes — the loop and a console-launched run alike — because one action that
   * means two different things depending on the entry point is worse than either meaning.
   *
   * Only a completed result with a summary is published: a failed investigation produced no
   * findings, and "we tried and could not" is not something to write onto an analyst's case.
   *
   * **A publication failure never loses the investigation.** The artifact is the durable output and
   * the comment is a copy, so the error is recorded on the result and the flush proceeds. Both
   * halves go through the same `queue` as every other write, so publication cannot interleave with
   * a cancellation flush already in flight.
   */
  /**
   * Publications still in flight, so the terminal flush cannot overtake them.
   *
   * `publishThenFlush` is fired from `onResult` and its first `await` is a network round-trip, so
   * its own `flushQueued("running")` lands on the queue *after* the terminal `flushQueued(status)`
   * below — and last write wins. Against a real tenant that is deterministic, not a rare race:
   * every published run ended on disk as `status: "running"` while `run_completed` carried
   * `completed`, which the console then renders as a run that never finishes.
   */
  const publishing: Promise<void>[] = [];

  const publishThenFlush = async (result: InvestigationResult): Promise<void> => {
    const summary = result.summary;
    if (result.status !== "completed" || summary === undefined) {
      await flushQueued("running");
      return;
    }
    const at = new Date().toISOString();
    try {
      const alert = alerts.find((candidate) => candidate.id === result.alertId);
      const outcome = await publisher.publishFindings(
        {
          id: result.alertId,
          title: result.alertTitle,
          // The grouping the source put this alert in, carried source-neutrally (ADR 013 §6). The
          // publisher decides what to do with it; nothing here knows it means "incident".
          ...(alert?.caseId === undefined ? {} : { caseId: alert.caseId }),
        },
        findingsComment(result.alertId, summary, publisher.maxBodyChars),
      );
      result.publication = {
        publisher: publisher.id,
        status: outcome.status,
        at,
        caseRef: outcome.caseRef,
      };
      log(
        `[investigator] ${outcome.status === "published" ? "published" : "already published"} ` +
          `${result.alertId} via ${publisher.id} — ${outcome.caseRef}`,
      );
    } catch (error) {
      result.publication = {
        publisher: publisher.id,
        status: "failed",
        at,
        error: describe(error),
      };
      log(`[investigator] could not publish ${result.alertId} — ${describe(error).message}`);
    }
    await flushQueued("running");
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
      securitySources: deps.securitySources,
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
        ? await primary.client.listAlerts()
        : [await primary.client.getAlert(options.alertId)];

    // Which data this run was actually scored against (PRD-6 §6.8). `undefined` on an older Mock
    // Sentinel, and that is the point: the artifact records no corpus rather than a fabricated one,
    // and a bootstrap that re-pins the content-addressed alert ids becomes a visible hash change
    // instead of a silently empty evaluation report.
    corpus = await primary.client.getCorpus().catch(() => undefined);
  } catch (error) {
    // Everything above happens before a single alert is investigated, and each step can fail on an
    // ordinary mistake — a typo'd model, a Sentinel that is not running, an alert id that does not
    // exist. Recording it is the whole reason `runId` is an input (PRD-5 §5.2).
    // Name the alert this run was for. `alerts` is still empty here — the throw happened before
    // `listAlerts`/`getAlert` returned — so without this the artifact cannot say what it was trying
    // to investigate, and the console has no result row to offer a re-run against (ADR 013 §10).
    if (options.alertId !== undefined && alerts.length === 0) {
      alerts = [{ id: options.alertId, title: "(not retrieved)" } as SecurityAlert];
    }
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
      publishing.push(publishThenFlush(result));
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
  /**
   * A sweep that produced nothing usable is `failed`, not `completed` (ADR 013 §10).
   *
   * The two status axes stay distinct — a *result* failing is one alert going wrong inside a sweep
   * that ran — but a sweep in which **no** alert succeeded has nothing to show, and reporting it as
   * `completed` made the console draw a green tick over a timed-out investigation and stopped the
   * watch loop's parking machinery from ever seeing the commonest failure there is.
   *
   * Precedence is unchanged: a supervisor fault and an abort both still win, because they describe
   * *how the sweep ended* rather than what it produced. Partial success stays `completed` — one
   * alert failing out of five is not a failed sweep.
   */
  const producedNothing =
    collected.length > 0 && !collected.some((result) => result.status === "completed");
  const finalStatus: RunStatus =
    supervisorFault !== undefined
      ? "failed"
      : options.signal?.aborted === true
        ? "interrupted"
        : producedNothing
          ? "failed"
          : "completed";
  // Every publication settles before the last word on the artifact is written. `publishThenFlush`
  // never rejects — it records failures on the result — so this cannot swallow an error.
  await Promise.all(publishing);
  await flushQueued(finalStatus, supervisorFault);
  return build(finalStatus, supervisorFault);
}
