/** Base for every way one investigation can fail to produce a summary. */
export class InvestigationError extends Error {}

/** The whole-investigation clock ran out (PRD-2 §17). */
export class InvestigationTimeoutError extends InvestigationError {
  override readonly name = "InvestigationTimeoutError";
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Investigation exceeded its ${timeoutMs}ms timeout without a valid submission.`);
    this.timeoutMs = timeoutMs;
  }
}

/** The max-turn ceiling was reached without a valid submission (PRD-2 §17). */
export class InvestigationStepLimitError extends InvestigationError {
  override readonly name = "InvestigationStepLimitError";
  readonly maxTurns: number;

  constructor(maxTurns: number) {
    super(`Investigation reached the ${maxTurns}-turn ceiling without a valid submission.`);
    this.maxTurns = maxTurns;
  }
}

/** A fatal model or provider failure (PRD-2 §18). */
export class InvestigationModelError extends InvestigationError {
  override readonly name = "InvestigationModelError";

  constructor(detail: string) {
    super(`Model runtime failure: ${detail}`);
  }
}

/**
 * The agent stopped of its own accord without submitting.
 *
 * Deliberately a failure. The harness must never turn a final assistant message into a result
 * (PRD-2 §16), however complete that message reads.
 */
export class InvestigationIncompleteError extends InvestigationError {
  override readonly name = "InvestigationIncompleteError";

  constructor() {
    super("Agent stopped without calling submit_investigation.");
  }
}

/**
 * The caller stopped this investigation (PRD-5 §6).
 *
 * Distinct from `InvestigationTimeoutError` because the cause is different and an operator needs to
 * see which one happened. It is also the reason the harness tracks its own abort flag: `agent.abort()`
 * populates `state.errorMessage`, so without this an analyst pressing a key would be recorded as a
 * provider outage.
 */
export class InvestigationAbortedError extends InvestigationError {
  override readonly name = "InvestigationAbortedError";

  constructor() {
    super("Investigation was cancelled by the caller.");
  }
}
