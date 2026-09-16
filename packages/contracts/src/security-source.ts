import { z } from "zod";

import { SchemaTable } from "./schema.ts";

/**
 * Source-neutral alert presented to investigation control flow (ADR 010 §2).
 *
 * Common fields are only what current triage consumes. Source taxonomies remain strings and the
 * validated native evidence stays available to the model instead of being discarded by mapping.
 */
export const SecurityAlert = z.object({
  /** Stable within the selected source; used for fetches, artifacts and evaluation joins. */
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  severity: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  alertType: z.string().min(1).optional(),
  startTimeUtc: z.iso.datetime().optional(),
  endTimeUtc: z.iso.datetime().optional(),
  timeGenerated: z.iso.datetime().optional(),
  tactics: z.array(z.string()),
  techniques: z.array(z.string()),
  compromisedEntity: z.string().optional(),
  /**
   * The grouping this alert belongs to in its own product (PRD-9, ADR 012 §6).
   *
   * Defender calls it an incident and Sentinel calls it an incident; the name here is deliberately
   * neither, because this contract is source-neutral and a field called `incidentId` would invite
   * investigation code to reason about incidents. Nothing reads it except the findings publisher,
   * which needs somewhere to write to and must not go digging in `native` to find it — that would
   * be a branch on source shape in the one place `AGENTS.md` §3 forbids one.
   *
   * Optional: a source with no grouping concept simply omits it, and publication falls back to the
   * local publisher rather than inventing a destination.
   */
  caseId: z.string().min(1).optional(),
  /** Source entity objects stay opaque; no cross-product entity taxonomy is invented here. */
  entities: z.array(z.json()),
  /** Connector-validated source evidence, excluding transport and authentication metadata. */
  native: z.json(),
});
export type SecurityAlert = z.infer<typeof SecurityAlert>;

/** Queryable tables only. Engine/database identity belongs to the selected source profile. */
export const SecuritySchema = z.object({ tables: z.array(SchemaTable) });
export type SecuritySchema = z.infer<typeof SecuritySchema>;
