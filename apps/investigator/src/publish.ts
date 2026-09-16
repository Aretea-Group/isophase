import { ALERT_COMMENT_MAX_CHARS } from "@soc/contracts";
import { markedBody, type FindingsPublisher } from "@soc/sentinel-client";
import type { z } from "zod";

import type { InvestigationSummaryRecord } from "./contracts/run.ts";

/**
 * What gets published is what the artifact recorded, not what the tool accepted.
 *
 * `InvestigationSummaryRecord` is the persisted, deliberately looser shape — `impact` and
 * `researchDone` are optional on it so artifacts written before those fields keep parsing. Taking
 * the strict TypeBox `InvestigationSummary` instead would mean the comment and the artifact could
 * describe the same run differently, and would make this unable to publish an older result at all.
 */
type SummaryRecord = z.infer<typeof InvestigationSummaryRecord>;

/**
 * The finding, as an analyst reads it on their own case (PRD-9 §4.1 D5).
 *
 * Rendering lives here rather than in `@soc/sentinel-client` because it is a judgement about how
 * this project's assessment should read, not a property of any connector — and because the summary
 * type is the investigator's, which that package deliberately does not know about (ADR 012 §2).
 *
 * Deliberately plain text. The two products render comments differently and neither documents a
 * markup contract, so anything cleverer than blank-line-separated paragraphs is a guess that fails
 * silently in someone else's portal.
 *
 * It states a likelihood and stops. **No classification, no determination, no recommended action** —
 * PRD-9 §3 fences those out permanently, and this function is where the temptation actually lands.
 */
export function renderFindings(summary: SummaryRecord): string {
  const lines = [
    `Automated investigation — ${summary.tpPercent}% true positive, ${summary.fpPercent}% false positive.`,
    ...(summary.impact === undefined ? [] : [`Impact: ${summary.impact}.`]),
    "",
    summary.whatHappened,
    "",
    `Supporting a true positive: ${summary.tpReason}`,
    `Supporting a false positive: ${summary.fpReason}`,
    "",
    "Key evidence:",
    ...summary.keyEvidence.map((item) => `- ${item}`),
    ...(summary.researchDone === undefined || summary.researchDone.length === 0
      ? []
      : ["", "Lines of enquiry checked:", ...summary.researchDone.map((item) => `- ${item}`)]),
    "",
    "Written by an automated agent. It has not changed this alert's status or classification.",
  ];
  return lines.join("\n");
}

/**
 * Which publisher a run should use (PRD-9 §4.1 D1, ADR 012 §7).
 *
 * A **capability** check, not a kind check: the question is "does this source know how to publish
 * findings", which every source answers for itself. `AGENTS.md` §3 forbids branching investigation
 * control flow on source *kind* — `if (kind === "defender")` — and this is the shape that avoids it
 * while still letting one source do something another cannot.
 *
 * **Opt-in, and the default is off.** Writing to someone's live case should not follow from
 * selecting a connector: `docs/defender-setup.md` describes the read-only permission pair as a
 * complete configuration, and a run that began commenting on a tenant because `SECURITY_SOURCES`
 * changed would make a liar of it. The permission is a second gate — without it the write fails and
 * is recorded rather than lost — but a gate you pass through twice is the right number here.
 */
export function selectPublisher(
  primaryClient: unknown,
  options: { enabled: boolean },
): FindingsPublisher | undefined {
  if (!options.enabled) return undefined;
  const candidate = primaryClient as Partial<FindingsPublisher> | undefined;
  if (typeof candidate?.publishFindings !== "function" || typeof candidate.id !== "string") {
    return undefined;
  }
  return candidate as FindingsPublisher;
}

/**
 * The body as it reaches the case, marker included and shaped to what the destination accepts.
 *
 * `maxChars` comes from the publisher, because the limit is a property of the destination and not of
 * this project: Graph takes 1,000 characters on an incident comment, Sentinel documents 30,000 on an
 * alert. Defaulting to the larger one preserves the local publisher's behaviour, which has no limit
 * at all.
 */
export function findingsComment(
  alertId: string,
  summary: SummaryRecord,
  maxChars?: number,
): string {
  const limit = maxChars ?? ALERT_COMMENT_MAX_CHARS;
  const full = markedBody(alertId, renderFindings(summary));
  if (full.length <= limit) return full;

  // Re-render short rather than cut the long one. A truncated body loses its tail, and the tail is
  // where the evidence and the disclaimer live — an analyst would be left with the confident
  // opening and none of the qualification.
  const brief = markedBody(alertId, renderBrief(summary));
  if (brief.length <= limit) return brief;

  const ellipsis = "…";
  return `${brief.slice(0, Math.max(0, limit - ellipsis.length))}${ellipsis}`;
}

/**
 * The finding in a few lines, for a destination that will not take the full one.
 *
 * Graph caps an incident comment at 1,000 characters (measured — `INCIDENT_COMMENT_MAX_CHARS`),
 * which the full render exceeds by roughly threefold. What survives is chosen rather than clipped:
 * the verdict, what happened, the single strongest piece of evidence, and where the rest is. The
 * disclaimer stays because it is the sentence that stops a reader assuming the case was actioned.
 */
export function renderBrief(summary: SummaryRecord): string {
  const evidence = summary.keyEvidence[0];
  const lines = [
    `Automated investigation — ${summary.tpPercent}% true positive${summary.impact === undefined ? "" : `, impact ${summary.impact}`}.`,
    "",
    clip(summary.whatHappened, 420),
    ...(evidence === undefined ? [] : ["", `Key evidence: ${clip(evidence, 200)}`]),
    "",
    "Automated agent; this alert's status and classification are unchanged. Full findings and the queries behind them are in the run artifact.",
  ];
  return lines.join("\n");
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}
