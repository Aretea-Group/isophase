import type { ApiErrorCode } from "@soc/contracts";

/** Connector-neutral failures beyond the Mock Sentinel REST error contract. */
export type SentinelApiErrorCode =
  | ApiErrorCode
  | "authentication_error"
  | "authorization_error"
  | "rate_limited"
  | "unreachable";

/**
 * A failure returned by, or while reaching, a Sentinel implementation.
 *
 * `message` is deliberately verbatim. For query failures the service already puts the Kusto
 * engine's own diagnostic there (`SEM0100: Failed to resolve table or column expression named
 * 'Compter'`), and that string is what lets an agent repair its own KQL. Nothing wraps,
 * summarises or re-formats it — see PRD-1 §4.4 and PRD-2 §11.
 */
export class SentinelApiError extends Error {
  override readonly name = "SentinelApiError";
  readonly code: SentinelApiErrorCode;
  /** HTTP status, or 0 when the request never got a response. */
  readonly status: number;

  constructor(code: SentinelApiErrorCode, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
