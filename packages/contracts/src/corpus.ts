import { z } from "zod";

/**
 * `GET /corpus` — which data the loaded environment actually holds (PRD-6 §6.8).
 *
 * Deliberately not part of `/health`, which `health.ts` records as operational only and which the
 * Sentinel Client does not expose as an investigation primitive. This is neither: it is a fact
 * about the corpus, read by evaluation tooling through the run artifact rather than by the agent.
 *
 * Every field is recorded on the artifact; only some are hashed into a condition key. `anchorUtc`
 * and `offsetMs` move on every `bun run data:bootstrap` while shifting the whole dataset by one
 * constant delta (ADR 001), so hashing them would mint a fresh condition each time and no two runs
 * either side of a bootstrap would share a cell. `alertSetHash` is what catches the change that
 * genuinely breaks the join.
 */
export const CorpusIdentity = z.object({
  /** Where the newest event was shifted to. One delta for the whole dataset (ADR 001). */
  anchorUtc: z.iso.datetime(),
  /** The delta itself, previously computed by bootstrap and discarded. */
  offsetMs: z.number().int(),
  /** The pinned upstream Training Lab revision the CSVs were vendored from. */
  telemetryRevision: z.string().min(1),
  /**
   * sha256/12 over the sorted `SystemAlertId`s the corpus generated.
   *
   * Alert ids are content-addressed over the rule id and the projected row (ADR 004), so a `|
   * project` reorder re-pins them and orphans every prior run for that alert. This is the number
   * that makes such a change loud instead of a silently empty report.
   */
  alertSetHash: z.string().min(1),
  /** The row cap `POST /query` applied. A different cap is a different environment. */
  queryMaxRows: z.number().int().positive(),
  /** When the manifest was written — that is, when the database was last built. */
  generatedAt: z.iso.datetime(),
});
export type CorpusIdentity = z.infer<typeof CorpusIdentity>;
