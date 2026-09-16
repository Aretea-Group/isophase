/**
 * The write half of the security data-source boundary (PRD-9 §4.1 D1).
 *
 * Symmetric with `SecurityDataSource` in `client.ts`, and in the same package for the same reason:
 * a capability whose implementations are connectors belongs beside the connectors. PRD-9 §4.2 says
 * `@soc/contracts`; ADR 012 §2 records why that would put the first capability interface in a
 * package holding only Zod data schemas, and why the signature takes rendered text rather than an
 * `InvestigationSummary` — that type is TypeBox and lives in `apps/investigator`, so naming it here
 * would point this package at the app that consumes it.
 *
 * Two implementations, and the interface exists for *that* split rather than for a future Sentinel
 * one — onboarded Sentinel alerts are returned by `alerts_v2` and need no second publisher (D8).
 * `LocalFindingsPublisher` is what lets the whole loop run with no tenant, which is what makes the
 * open-source on-ramp work.
 */
export interface FindingsPublisher {
  /** Names this publisher in the run artifact. Stable: `evaluate` and the console read it. */
  readonly id: string;
  /**
   * The longest body this destination accepts, when it has a limit worth knowing about.
   *
   * Declared by the publisher because only it knows: Graph caps an incident comment at 1,000
   * characters while Sentinel documents 30,000 for an alert, and the caller discovering that from a
   * rejected write on a live tenant is how PRD-9 found it (ADR 012 §8).
   */
  readonly maxBodyChars?: number;
  /**
   * Put findings on the alert's case, additively.
   *
   * `body` is already rendered prose — composing it from a summary is the investigator's work, not
   * a connector's, and keeping it out of here is what lets this package stay unaware of TypeBox,
   * Pi and the agent's own contracts. Never sets status, classification or determination (D5).
   */
  publishFindings(alert: PublishTarget, body: string): Promise<PublishOutcome>;
}

/** The alert to publish against, in its own source's vocabulary (PRD-9 §4.2). */
export interface PublishTarget {
  id: string;
  title: string;
  /**
   * The grouping the source puts this alert in — `SecurityAlert.caseId` (ADR 012 §6).
   *
   * Optional here because the local publisher has no use for it and a source may have no grouping
   * concept. A remote publisher that needs one and does not get one should say so rather than
   * inventing a destination.
   */
  caseId?: string;
}

/**
 * What the publisher did, never a bare success.
 *
 * `alreadyPresent` is its own outcome rather than a silent success because AC22 asks the loop to
 * *report* the skip: a publisher that quietly did nothing and one that wrote are indistinguishable
 * from a boolean, and the difference is the whole point of the marker.
 */
export type PublishOutcome =
  | { status: "published"; caseRef: string }
  | { status: "alreadyPresent"; caseRef: string };

/**
 * The marker that makes publication idempotent (PRD-9 §4.2).
 *
 * Carried in the comment body and matched on read-back, because a retry after a partial failure has
 * nothing else to recognise its own previous write by — the API assigns the comment id, so the
 * publisher cannot remember one it never chose. Derived from the alert rather than the run: a
 * re-run of the same alert is the case AC22 names, and keying on `runId` would let every re-run
 * write another comment.
 */
export function findingsMarker(alertId: string): string {
  return `[soc-agent:${alertId}]`;
}

/** The body as it reaches the case, marker first so a human sees what wrote it. */
export function markedBody(alertId: string, body: string): string {
  return `${findingsMarker(alertId)}\n\n${body}`;
}

/**
 * Records the publication and writes nothing external (PRD-9 §4.1 D1).
 *
 * The default, so a clone with no credentials still exercises the entire path rather than skipping
 * the last hop. It is not a null object: it returns a real `caseRef` naming where the finding
 * actually lives, which is the run artifact itself.
 *
 * Idempotency is the caller's here — `executeRun` publishes a completed result exactly once — so
 * this never reports `alreadyPresent`. The Graph publisher, which can be retried against a case it
 * already wrote to, is where the marker earns its keep.
 */
export class LocalFindingsPublisher implements FindingsPublisher {
  readonly id = "local";
  /** No limit: the destination is the run artifact, which already holds the summary in full. */
  readonly maxBodyChars: number | undefined = undefined;

  // The body is unused — the artifact already holds the summary — but the parameter stays so the
  // class matches the interface it implements when called through a concrete reference.
  // eslint-disable-next-line @typescript-eslint/require-await
  async publishFindings(alert: PublishTarget, _body?: string): Promise<PublishOutcome> {
    return { status: "published", caseRef: `runs/#${findingsMarker(alert.id)}` };
  }
}
