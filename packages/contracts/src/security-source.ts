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
  /** Source entity objects stay opaque; no cross-product entity taxonomy is invented here. */
  entities: z.array(z.json()),
  /** Connector-validated source evidence, excluding transport and authentication metadata. */
  native: z.json(),
});
export type SecurityAlert = z.infer<typeof SecurityAlert>;

/** Queryable tables only. Engine/database identity belongs to the selected source profile. */
export const SecuritySchema = z.object({ tables: z.array(SchemaTable) });
export type SecuritySchema = z.infer<typeof SecuritySchema>;
