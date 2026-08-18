import { z } from "zod";

/**
 * Error codes that may cross the Mock Sentinel REST boundary.
 *
 * Kept deliberately small: the Sentinel Client maps these onto application
 * errors, and the future agent tool surfaces them as actionable feedback
 * rather than silently retrying (PRD-1 §4.4).
 */
export const ApiErrorCode = z.enum([
  "bad_request",
  "not_found",
  "query_error",
  "upstream_unavailable",
  "internal_error",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

/**
 * The single error envelope returned by every non-2xx Mock Sentinel response.
 *
 * `details` carries backend-specific diagnostics (for example a raw Kusto
 * error payload) verbatim. It is intentionally unstructured: the point is to
 * hand a real error back to the caller, not to normalise it away.
 */
export const ApiError = z.object({
  error: z.object({
    code: ApiErrorCode,
    message: z.string().min(1),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

export function apiError(code: ApiErrorCode, message: string, details?: unknown): ApiError {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}
