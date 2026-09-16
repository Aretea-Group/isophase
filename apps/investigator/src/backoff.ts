/**
 * How the unattended loop reacts to a source that will not answer (ADR 012 §11).
 *
 * **This is not a retry, and the distinction is load-bearing.** ADR 011 §9 forbids the *connector*
 * re-issuing a request — "a `429` becomes `rate_limited` and is never retried… a retry deepens the
 * outage for every other consumer in the tenant" — and nothing here changes that. What this does is
 * delay the loop's *next scheduled poll*, which issues strictly **fewer** requests than the
 * configured cadence would have. PRD-9 §4.2 asked for exactly that and it was never built.
 *
 * Pure and clock-free: `nextDelayMs` returns a number and `classifyPollError` reads an error. The
 * waiting is the caller's, through the injected `sleep` seam, so the loop stays testable without a
 * real clock.
 */

/** What a failed poll means for the loop's next move. */
export type PollErrorKind = "transient" | "throttled" | "permanent";

/**
 * Codes that mean the operator must do something before this can work again.
 *
 * An expired client secret does not heal on its own, and a loop that keeps polling through one
 * looks alive while doing nothing — which is worse than stopping, because nobody investigates a
 * process that appears healthy.
 */
const PERMANENT_CODES = new Set([
  "authentication_error",
  "authorization_error",
  "not_found",
  "bad_request",
  "query_error",
]);

/** Codes that are worth waiting out. `internal_error` is mock-sentinel's own 5xx. */
const TRANSIENT_CODES = new Set(["unreachable", "upstream_unavailable", "internal_error"]);

/**
 * Classify a poll failure **structurally**, never with `instanceof`.
 *
 * `SentinelApiError` does not survive the control socket: `socket/server.ts` serialises a rejection
 * to `{name, message}` and the client rebuilds a plain `Error`, so a remote control's failure
 * carries no `.code` at all. An `instanceof` check would silently classify every socket-delivered
 * failure as unknown, which is precisely the configuration a detached console runs in.
 *
 * **Anything unrecognised is treated as transient.** That is a judgement, and it cuts both ways: the
 * daemon is slow to surface a novel permanent fault, but it survives an error shape Microsoft adds
 * next quarter. Stopping on the unknown would make every new error message a night-time outage.
 */
export function classifyPollError(error: unknown): PollErrorKind {
  const candidate = error as { code?: unknown; status?: unknown } | null | undefined;
  const code = typeof candidate?.code === "string" ? candidate.code : undefined;
  const status = typeof candidate?.status === "number" ? candidate.status : undefined;

  if (code === "rate_limited" || status === 429) return "throttled";
  if (code !== undefined && PERMANENT_CODES.has(code)) return "permanent";
  if (code !== undefined && TRANSIENT_CODES.has(code)) return "transient";
  if (status === 401 || status === 403 || status === 404) return "permanent";
  return "transient";
}

export interface BackoffOptions {
  /** The loop's normal cadence. The first delay never exceeds it — or 30s, whichever is smaller. */
  pollIntervalMs: number;
  /** Ceiling on any single wait. Also what a throttled poll waits immediately. */
  maxMs: number;
  /** Injected only by tests, which need a delay they can predict. */
  random?: () => number;
}

const FIRST_DELAY_CEILING_MS = 30_000;

/**
 * How long to wait before polling again, after `attempt` consecutive failures.
 *
 * Exponential with **full jitter** — a uniform draw from `[0, computed]` rather than the computed
 * value. With one loop that only softens the curve; it matters when several operators run against
 * one tenant, where synchronised retries are how a recovering service gets knocked over again.
 *
 * A `throttled` poll starts **at the cap**. Graph documents the hunting quota as resetting on a
 * fifteen-minute cycle, so anything shorter is a request that cannot succeed, spent against the
 * same allowance that is already exhausted.
 */
export function nextDelayMs(attempt: number, kind: PollErrorKind, options: BackoffOptions): number {
  const random = options.random ?? Math.random;
  if (kind === "throttled") return options.maxMs;

  const base = Math.min(options.pollIntervalMs, FIRST_DELAY_CEILING_MS);
  const exponential = base * 2 ** Math.max(0, attempt - 1);
  const ceiling = Math.min(exponential, options.maxMs);
  return Math.round(random() * ceiling);
}
