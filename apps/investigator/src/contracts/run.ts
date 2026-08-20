import { z } from "zod";

/**
 * The durable output of one invocation (PRD-2 §19).
 *
 * Zod rather than TypeBox: this is a persisted boundary that evaluation tooling will read back
 * later, which is exactly ADR 003's case for Zod, and nothing here crosses into a Pi tool schema.
 *
 * Deliberately not a tracing system. No transcript, no token counts, no tool trace, no raw KQL or
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
});

/**
 * How a run was configured beyond model and limits (PRD-3 §7).
 *
 * Present for the same reason `model` is: two runs are not comparable without knowing how each was
 * configured, and the console shows this beside the environment it is running in so drift between
 * them is visible rather than mysterious.
 */
export const InvestigationRunConfig = z.object({
  thinkingLevel: z.string().min(1),
  resultMaxChars: z.number().int().positive(),
  sentinelBaseUrl: z.string().min(1),
  webSearchConfigured: z.boolean(),
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

export const InvestigationRun = z.object({
  runId: z.string().min(1),
  startedAt: z.iso.datetime(),
  /**
   * When the artifact was last written, not when the sweep ended. PRD-3 flushes after every alert,
   * so this advances during a run and the console reads it as a liveness heartbeat (PRD-3 §10.2).
   */
  completedAt: z.iso.datetime(),
  /**
   * Lifecycle of the sweep (PRD-3 §7). Deliberately a different axis from
   * `InvestigationResult.status`, which is per alert and has its own `completed | failed` enum —
   * `interrupted` describes a sweep, never an alert. Absent on artifacts written before PRD-3.
   */
  status: z.enum(["running", "completed", "interrupted", "failed"]).optional(),
  /**
   * Why a sweep never got started (PRD-5 §5.2).
   *
   * `failed` is the sweep that died before it could investigate anything — an unknown model, an
   * unreachable Sentinel, a bad alert id. Previously those produced stderr and exit 1 with *no
   * file at all*, so the four most likely mistakes were invisible to every reader of `runs/`.
   * Distinct from `InvestigationResult.error`, which is one alert failing inside a sweep that ran.
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
  /** Which model produced these results. Without it two artifacts are not comparable. */
  model: z.object({ provider: z.string(), id: z.string() }),
  limits: z.object({
    maxTurns: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
  }),
  results: z.array(InvestigationResult),
});

export type AlertContext = z.infer<typeof AlertContext>;
export type InvestigationRunConfig = z.infer<typeof InvestigationRunConfig>;
export type InvestigationResult = z.infer<typeof InvestigationResult>;
export type InvestigationRun = z.infer<typeof InvestigationRun>;
