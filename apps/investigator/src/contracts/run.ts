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
  keyEvidence: z.array(z.string()),
  nextAction: z.string(),
});

export const InvestigationResult = z.object({
  /** The alert's systemAlertId — the same key the scenario fixtures use as startingAlertId. */
  alertId: z.string().min(1),
  alertTitle: z.string(),
  status: z.enum(["completed", "failed"]),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  durationMs: z.number().nonnegative(),
  summary: InvestigationSummaryRecord.optional(),
  error: z.object({ name: z.string(), message: z.string() }).optional(),
});

export const InvestigationRun = z.object({
  runId: z.string().min(1),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  /** Which model produced these results. Without it two artifacts are not comparable. */
  model: z.object({ provider: z.string(), id: z.string() }),
  limits: z.object({
    maxTurns: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
  }),
  results: z.array(InvestigationResult),
});

export type InvestigationResult = z.infer<typeof InvestigationResult>;
export type InvestigationRun = z.infer<typeof InvestigationRun>;
