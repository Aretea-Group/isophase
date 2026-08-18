import { z } from "zod";

/** Status of a dependency the service needs in order to serve investigations. */
export const DependencyStatus = z.enum(["up", "down", "unknown"]);
export type DependencyStatus = z.infer<typeof DependencyStatus>;

/**
 * `GET /health` response.
 *
 * Operational only — this is not part of the Sentinel domain capability
 * (PRD-1 §4.5) and the Sentinel Client does not expose it as an investigation
 * primitive.
 */
export const HealthResponse = z.object({
  status: z.enum(["ok", "degraded"]),
  service: z.literal("mock-sentinel"),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  dependencies: z.record(z.string(), DependencyStatus),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
