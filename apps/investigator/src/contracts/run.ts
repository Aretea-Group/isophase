import { z } from "zod";

/**
 * The durable output of one invocation (PRD-2 §19).
 *
 * Zod rather than TypeBox: this is a persisted boundary that evaluation tooling will read back
 * later, which is exactly ADR 003's case for Zod, and nothing here crosses into a Pi tool schema.
 *
 * Deliberately not a tracing system. No transcript, no token counts, no tool trace, no raw query or
 * web results — only what a later comparison against the hidden scenario metadata needs. Those can
 * be added if evaluation shows a concrete need for them.
 */
export const InvestigationSummaryRecord = z.object({
  tpPercent: z.number().int().min(0).max(100),
  tpReason: z.string(),
  fpPercent: z.number().int().min(0).max(100),
  fpReason: z.string(),
  whatHappened: z.string(),
  impact: z.enum(["none", "contained", "confirmed-compromise", "unknown"]).optional(),
  keyEvidence: z.array(z.string()),
  researchDone: z.array(z.string()).optional(),
  /** Present only on artifacts written before `researchDone` replaced it. */
  nextAction: z.string().optional(),
});

/**
 * The triage facts of the alert that was investigated (PRD-3 §6.1).
 *
 * The artifact previously recorded only `alertId` and `alertTitle`, so `startedAt`/`completedAt`
 * described when the *agent* ran and nothing described when the *incident* happened. On this
 * corpus those differ by five years — the telemetry is historical Training Lab data — which makes
 * a verdict impossible to place in time and a list of runs impossible to order by anything an
 * analyst cares about.
 *
 * Deliberately a small subset, not a mirror of `SecurityAlertResource`. Copying the whole alert
 * would duplicate Mock Sentinel's contract into a durable artifact and make every future alert
 * field a migration. These are the fields triage needs at a glance: when, how bad, what kind, and
 * which asset. Everything else stays in the transcript, which carries the alert verbatim.
 *
 * Types are deliberately looser than `@soc/contracts` (plain strings rather than the `AlertSeverity`
 * and `AttackTactic` enums): this is a persisted record read back by later tooling, and a new
 * severity or tactic upstream should not make old artifacts unreadable.
 */
export const AlertContext = z.object({
  severity: z.string().min(1).optional(),
  /** When the activity happened — not when it was investigated. */
  startTimeUtc: z.iso.datetime().optional(),
  endTimeUtc: z.iso.datetime().optional(),
  /** When the detection fired. */
  timeGenerated: z.iso.datetime().optional(),
  tactics: z.array(z.string()).optional(),
  techniques: z.array(z.string()).optional(),
  compromisedEntity: z.string().optional(),
  alertType: z.string().optional(),
});

export const InvestigationResult = z.object({
  /** The alert's systemAlertId. Evaluation tooling joins on this, outside the agent (PRD-2 §20). */
  alertId: z.string().min(1),
  alertTitle: z.string(),
  status: z.enum(["completed", "failed"]),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  durationMs: z.number().nonnegative(),
  /** Triage facts about the alert itself. Absent on artifacts written before PRD-3. */
  alert: AlertContext.optional(),
  summary: InvestigationSummaryRecord.optional(),
  error: z.object({ name: z.string(), message: z.string() }).optional(),
  /**
   * Where this investigation's findings went, and whether they arrived (PRD-9 §4.2).
   *
   * Fixed-size: a publisher id, an outcome, a reference, and a failure if there was one. Never the
   * comment body — that is derived from `summary`, which is already here, and storing both would
   * let an artifact disagree with itself about what was published.
   *
   * Optional, so every artifact written before PRD-9 keeps parsing. A completed result with no
   * publication block is one that predates the write path, not one that failed to publish: a
   * failure is recorded as `status: "failed"` with its error, because losing the distinction would
   * make an unpublished finding indistinguishable from an unattempted one.
   */
  publication: z
    .object({
      publisher: z.string().min(1),
      status: z.enum(["published", "alreadyPresent", "failed"]),
      at: z.iso.datetime(),
      caseRef: z.string().min(1).optional(),
      error: z.object({ name: z.string(), message: z.string() }).optional(),
    })
    .optional(),
  /**
   * What this investigation cost, in effort and in money (PRD-6 §6.7, ADR 008 §1).
   *
   * Fixed-size and bounded by construction: a count of turns, a tally over the five closed tool
   * names, and one usage object. **Nothing here may grow with the length of an investigation** —
   * no per-event records, no tool arguments, no query text, no results. A count of `query_security_data`
   * calls is a number; the queries themselves are a trace, and traces stay in `runs/traces/`,
   * optional and off by default.
   *
   * Recorded for failed investigations too. A run that burned its whole budget and timed out is the
   * most expensive kind there is, and it was previously the one kind that recorded nothing.
   */
  turns: z.number().int().nonnegative().optional(),
  /** Keyed by tool name, never by table: naming tables is the first step to grading the path. */
  toolCalls: z.record(z.string(), z.number().int().nonnegative()).optional(),
  usage: z
    .object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      cacheRead: z.number().int().nonnegative(),
      cacheWrite: z.number().int().nonnegative(),
      totalTokens: z.number().int().nonnegative(),
      costUsd: z.number().nonnegative(),
    })
    /** `reasoning` is deliberately excluded — pi-ai documents it as a subset of `output`. */
    .optional(),
});

/** Fixed-size operational identity for the selected tabular security source (ADR 010 §5). */
export const RunSecuritySource = z.object({
  kind: z.string().min(1),
  connector: z.string().min(1),
  target: z.string().min(1),
  queryLanguage: z.string().min(1),
});

export type RunSecuritySource = z.infer<typeof RunSecuritySource>;

export const RunSecuritySourceEntry = RunSecuritySource.extend({ id: z.string().min(1) });

/**
 * How a run was configured beyond model and limits (PRD-3 §7).
 *
 * Present for the same reason `model` is: two runs are not comparable without knowing how each was
 * configured, and the console shows this beside the environment it is running in so drift between
 * them is visible rather than mysterious.
 */
export const InvestigationRunConfig = z.object({
  /**
   * Optional because it is genuinely unknown on some runs (PRD-6 §7 item 3, **D12**).
   *
   * `execute-run.ts` used to write `?? "medium"` here while omitting the key from the harness
   * options when unset, so `pi-agent-core` fell back to `off` and the artifact claimed `medium`.
   * That was the one place the artifact lied, and it lied about the one knob no condition on disk
   * had ever varied. Absent now means absent, and `evaluate` renders it `?` — which never merges
   * with a recorded `medium` (PRD-6 §5.2).
   */
  thinkingLevel: z.string().min(1).optional(),
  resultMaxChars: z.number().int().positive(),
  source: RunSecuritySource.optional(),
  /** Ordered active set. Absent on artifacts written before PRD-8 Phase 2. */
  sources: z.array(RunSecuritySourceEntry).min(1).optional(),
  /**
   * The time window a Defender primary drew its alert queue from (PRD-8 §4.1 D14).
   *
   * `alerts_v2` supports no `$orderby`, so "the newest 500" is not expressible and the window is
   * the only selection criterion the API can state. Two runs that drew from different windows saw
   * different queues, so ADR 008 §3 folds this into the derived condition key and they correctly
   * do not merge into one cell.
   *
   * Absent on every run that did not use a windowed source, and absent means absent — never
   * defaulted to `P7D` at read time, which would claim a window the run did not use.
   */
  alertWindow: z.string().min(1).optional(),
  /** Connector-side query row cap, when the selected source exposes one. */
  queryMaxRows: z.number().int().positive().optional(),
  /** Retained only so artifacts written before the neutral source boundary remain readable. */
  sentinelBaseUrl: z.string().min(1).optional(),
  modelBaseUrl: z.string().min(1).optional(),
  modelContextWindow: z.number().int().positive().optional(),
  modelMaxTokens: z.number().int().positive().optional(),
  modelReasoningProfile: z.enum(["off", "binary", "effort"]).optional(),
  webSearchConfigured: z.boolean(),
  /**
   * Whether the agent actually searched, as opposed to being able to (PRD-6 §7 item 4, **D14**).
   *
   * Derived from the tool tally, so it costs nothing now that §6.7 lands. Two runs that differ only
   * in whether the web was reached were previously indistinguishable.
   */
  webSearchUsed: z.boolean().optional(),
  /**
   * The premise an analyst supplied, stored raw (PRD-5 §9).
   *
   * Raw rather than sanitised, deliberately: the copy embedded in the prompt has its envelope
   * delimiters stripped, and keeping the original beside it is what makes that sanitisation
   * auditable after the fact. It is also how a reader — and `evaluate` — can tell a steered run
   * from a clean one, which is the whole basis of PRD-5 §4.5.
   */
  analystContext: z.string().optional(),
});

/**
 * What produced this run, beyond the model name (PRD-6 §6.6, ADR 008 §1).
 *
 * `model.id` is a moving alias and `config` says nothing about the prompt, so two artifacts can
 * agree on every recorded field and still have been produced by different software. Without this
 * the prompt axis is not merely unrecorded, it is *unrecordable* — and steering and case memory are
 * both prompt changes, so it blocks the three axes evaluation exists to compare.
 *
 * Optional, so every artifact written before it keeps parsing. Absent renders `?` in a report and
 * never merges with a recorded value (PRD-6 §5.2).
 */
export const RunCorpusIdentity = z.object({
  /** Recorded beside the hash, never inside it: it moves on every bootstrap (ADR 001). */
  anchorUtc: z.iso.datetime(),
  offsetMs: z.number().int(),
  telemetryRevision: z.string().min(1),
  /** Over the sorted alert ids the corpus generated. This is what catches a broken join. */
  alertSetHash: z.string().min(1),
  queryMaxRows: z.number().int().positive(),
});

export const RunProvenance = z.object({
  /** Over the instructions, the five tools' name/description/parameters, and the context template. */
  promptHash: z.string().min(1),
  /** Separate from `promptHash`: the submission schema is what actually split this corpus. */
  submissionHash: z.string().min(1),
  piVersion: z.string().min(1),
  /** Human-readable companion to `promptHash`. The hash is the truth. */
  instructionsLabel: z.string().min(1).optional(),
  /** What the provider actually served, when it reports one. `model.id` is only an alias. */
  servedModelId: z.string().min(1).optional(),
  corpus: RunCorpusIdentity.optional(),
});

export const InvestigationRun = z.object({
  runId: z.string().min(1),
  startedAt: z.iso.datetime(),
  /**
   * When the artifact was last written, not when the sweep ended. PRD-3 flushes after every alert,
   * so this advances during a run and the console reads it as a liveness heartbeat (PRD-3 §10.2).
   */
  completedAt: z.iso.datetime(),
  /**
   * Lifecycle of the sweep (PRD-3 §7, amended by ADR 012 §10).
   *
   * Still a different axis from `InvestigationResult.status`, which is per alert — `interrupted`
   * describes a sweep and never an alert — but the two are no longer independent at the extremes.
   * **`failed` now means the sweep has nothing to show:** either it died before investigating
   * anything, or it ran and no alert inside it succeeded.
   *
   * The old reading was that `failed` covered only the first of those. It made an all-failed sweep
   * indistinguishable from a successful one to anything reading the run alone — the console drew a
   * green tick over a timed-out investigation — so the narrower meaning was abandoned rather than
   * papered over downstream. Partial success is still `completed`: one alert failing out of five is
   * not a failed sweep. Absent on artifacts written before PRD-3.
   */
  status: z.enum(["running", "completed", "interrupted", "failed"]).optional(),
  /**
   * Why a sweep never got started (PRD-5 §5.2).
   *
   * Set only on the startup-failure path — an unknown model, an unreachable Sentinel, a bad alert
   * id. Previously those produced stderr and exit 1 with *no file at all*, so the four most likely
   * mistakes were invisible to every reader of `runs/`.
   *
   * **Absent on a sweep that ran and failed anyway** (ADR 012 §10): there the cause is per alert
   * and lives on `InvestigationResult.error`, because five alerts can fail five different ways and
   * flattening them into one run-level string would pick a winner arbitrarily.
   */
  error: z.object({ name: z.string(), message: z.string() }).optional(),
  /**
   * How many alerts the sweep set out to investigate. `results` only ever holds finished ones, so
   * without this a reader can show what completed but cannot say how much is left (PRD-3 §11).
   */
  alertCount: z.number().int().nonnegative().optional(),
  /**
   * The alerts the sweep set out to investigate, in the order it will take them (PRD-3 §7).
   *
   * `alertCount` says how many are left; this says *which*, and that is the difference between a
   * reader being able to describe an in-flight sweep and not. A transcript is named
   * `<runId>-<alertId>.jsonl`, so without the id the console cannot find the transcript of the
   * alert being investigated right now — and for a single-alert run `results` is empty for the
   * whole 600 s it may take, which made PRD-3 §13's "its turns and tool calls also stream as the
   * transcript grows" unreachable for the only alert there was.
   *
   * The title travels with the id because the artifact must stand on its own with tracing off:
   * an id names a file, and an analyst watching a sweep is looking for the alert.
   */
  plannedAlerts: z
    .array(z.object({ alertId: z.string().min(1), alertTitle: z.string() }))
    .optional(),
  /** Where this run's transcripts landed. Absent when tracing was off. */
  traceDir: z.string().min(1).optional(),
  /**
   * The investigation this one was derived from (PRD-5 §9).
   *
   * A derived run always gets a *fresh* `runId`: transcripts are named `<runId>-<alertId>.jsonl`
   * and opened with `appendFileSync`, so reusing an id would concatenate two transcripts and
   * double-count the cost of both. No `kind` field — a model swap with no analyst text is neither
   * "rerun" nor "context", and what changed is a diff of `model` and `config`, both already here.
   */
  derivedFrom: z.object({ runId: z.string().min(1), alertId: z.string().min(1) }).optional(),
  config: InvestigationRunConfig.optional(),
  provenance: RunProvenance.optional(),
  /** Which model produced these results. Without it two artifacts are not comparable. */
  model: z.object({ provider: z.string(), id: z.string() }),
  limits: z.object({
    maxTurns: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
  }),
  results: z.array(InvestigationResult),
});

export type AlertContext = z.infer<typeof AlertContext>;
export type RunCorpusIdentity = z.infer<typeof RunCorpusIdentity>;
export type RunProvenance = z.infer<typeof RunProvenance>;
export type InvestigationRunConfig = z.infer<typeof InvestigationRunConfig>;
export type InvestigationResult = z.infer<typeof InvestigationResult>;
export type InvestigationRun = z.infer<typeof InvestigationRun>;
