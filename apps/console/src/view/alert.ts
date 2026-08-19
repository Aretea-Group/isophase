import type { RunResult } from "../data/runs.ts";
import {
  incidentTime,
  incidentWindow,
  severityOf,
  severityTag,
  truncate,
  wrap,
  type Line,
  type Severity,
} from "./format.ts";

/**
 * The alert an investigation was handed, assembled from whichever source has it.
 *
 * Two sources, in order of durability. The run artifact carries the triage subset and is always
 * present for runs written by PRD-3's investigator. The transcript carries the alert verbatim —
 * description, entities, remediation — but only exists when tracing was on, and tracing is off by
 * default (PRD-3 §6.1, §6.2). `source` records which contributed, so the view never implies it
 * knows more than it does.
 */
export type AlertSource = "none" | "artifact" | "transcript" | "both";

export interface AlertEntity {
  type: string;
  label: string;
}

export interface AlertFacts {
  alertId: string;
  title: string;
  severity: Severity;
  severityTag: string;
  /** When the activity happened, formatted so it cannot be read as investigation time. */
  window: string;
  /** When the detection fired. */
  detected: string;
  hasTime: boolean;
  tactics: string[];
  techniques: string[];
  compromisedEntity?: string;
  alertType?: string;
  description?: string;
  entities: AlertEntity[];
  remediationSteps: string[];
  /**
   * The detection's own extra fields (`ExtendedProperties` in the table, `additionalData` in ARM).
   *
   * Scalars only. These are rule-specific and often carry the fact that decides the alert —
   * `Action: Allowed` is the difference between a blocked lookup and a successful one — so they are
   * worth surfacing, but a nested object in a 46-column pane is not.
   */
  additionalData: [string, string][];
  source: AlertSource;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** Sentinel entities are a typed union keyed by `type`; this is the human-readable bit of each. */
export function entityLabel(entity: Record<string, unknown>): string {
  for (const key of ["hostName", "name", "address", "url", "fileName", "processId", "value"]) {
    const value = entity[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return "—";
}

export function alertFactsFromResult(result: RunResult): AlertFacts {
  const alert = result.alert;
  return {
    alertId: result.alertId,
    title: result.alertTitle ?? result.alertId,
    severity: severityOf(alert?.severity),
    severityTag: severityTag(alert?.severity),
    window: incidentWindow(alert?.startTimeUtc, alert?.endTimeUtc),
    detected: incidentTime(alert?.timeGenerated),
    hasTime: alert?.startTimeUtc !== undefined || alert?.timeGenerated !== undefined,
    tactics: alert?.tactics ?? [],
    techniques: alert?.techniques ?? [],
    ...(alert?.compromisedEntity === undefined
      ? {}
      : { compromisedEntity: alert.compromisedEntity }),
    ...(alert?.alertType === undefined ? {} : { alertType: alert.alertType }),
    entities: [],
    remediationSteps: [],
    additionalData: [],
    source: alert === undefined ? "none" : "artifact",
  };
}

/** Scalar `additionalData` entries, in the order the detection recorded them. */
function scalarPairs(value: unknown): [string, string][] {
  const record = asRecord(value);
  if (record === undefined) return [];
  const pairs: [string, string][] = [];
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string" && item !== "") pairs.push([key, item]);
    else if (typeof item === "number" || typeof item === "boolean") pairs.push([key, String(item)]);
  }
  return pairs;
}

/**
 * Fold in the alert as the agent actually received it.
 *
 * Used both to enrich an artifact-backed record and to recover one entirely, for the runs written
 * before the artifact carried any of this.
 */
export function enrichWithAlertJson(facts: AlertFacts, alertJson: unknown): AlertFacts {
  const properties = asRecord(asRecord(alertJson)?.["properties"]);
  if (properties === undefined) return facts;

  const entities = (Array.isArray(properties["entities"]) ? properties["entities"] : [])
    .map(asRecord)
    .filter((entity): entity is Record<string, unknown> => entity !== undefined)
    .map((entity) => ({
      type: typeof entity["type"] === "string" ? entity["type"] : "unknown",
      label: entityLabel(entity),
    }));

  const startTimeUtc =
    typeof properties["startTimeUtc"] === "string" ? properties["startTimeUtc"] : undefined;
  const endTimeUtc =
    typeof properties["endTimeUtc"] === "string" ? properties["endTimeUtc"] : undefined;
  const timeGenerated =
    typeof properties["timeGenerated"] === "string" ? properties["timeGenerated"] : undefined;
  const severity = typeof properties["severity"] === "string" ? properties["severity"] : undefined;

  const merged: AlertFacts = {
    ...facts,
    severity: facts.source === "none" ? severityOf(severity) : facts.severity,
    severityTag: facts.source === "none" ? severityTag(severity) : facts.severityTag,
    window: facts.hasTime ? facts.window : incidentWindow(startTimeUtc, endTimeUtc),
    detected: facts.hasTime ? facts.detected : incidentTime(timeGenerated),
    hasTime: facts.hasTime || startTimeUtc !== undefined || timeGenerated !== undefined,
    tactics: facts.tactics.length > 0 ? facts.tactics : strings(properties["tactics"]),
    techniques: facts.techniques.length > 0 ? facts.techniques : strings(properties["techniques"]),
    entities,
    remediationSteps: strings(properties["remediationSteps"]),
    additionalData: scalarPairs(properties["additionalData"]),
    source: facts.source === "artifact" ? "both" : "transcript",
  };

  if (typeof properties["description"] === "string") merged.description = properties["description"];
  if (
    merged.compromisedEntity === undefined &&
    typeof properties["compromisedEntity"] === "string"
  ) {
    merged.compromisedEntity = properties["compromisedEntity"];
  }
  if (merged.alertType === undefined && typeof properties["alertType"] === "string") {
    merged.alertType = properties["alertType"];
  }
  return merged;
}

/**
 * The entities, as `type value` pairs.
 *
 * The identifiers themselves, not a roll-up of how many of each kind there were. An investigation
 * pivots on the account, the address and the host — the ground-truth fixtures call these
 * `keyEntities` for exactly that reason — and "3 ip, 1 account" is not something anyone can pivot
 * on. Ordered by the alert's own entity order, which is the order the detection built them in.
 */
export function entityPairs(facts: AlertFacts): string[] {
  return facts.entities
    .filter((entity) => entity.label !== "—")
    .map((entity) => `${entity.type} ${entity.label}`);
}

/** Caps, so a pane of fixed height cannot be pushed off the bottom by one noisy alert. */
const MAX_ENTITY_ROWS = 6;
const MAX_DETAIL_ROWS = 4;
const LABEL_WIDTH = 11;

function labelled(label: string, value: string, width: number): Line {
  const room = Math.max(4, width - LABEL_WIDTH - 2);
  const clipped = value.length <= room ? value : `${value.slice(0, room - 1)}…`;
  return [{ text: ` ${label.padEnd(LABEL_WIDTH)}`, tone: "label" }, { text: clipped }];
}

function indented(label: string, value: string, width: number): Line {
  const room = Math.max(4, width - LABEL_WIDTH - 3);
  // Clipped, not padded-past: `cloud-application` is longer than the label column and ran straight
  // into its own value.
  const key = label.length > LABEL_WIDTH - 3 ? label.slice(0, LABEL_WIDTH - 3) : label;
  return [
    { text: `   ${key.padEnd(LABEL_WIDTH - 2)}`, tone: "label" },
    { text: truncate(value, room) },
  ];
}

function capped(rows: Line[], limit: number): Line[] {
  if (rows.length <= limit) return rows;
  const hidden = rows.length - limit;
  return [...rows.slice(0, limit), [{ text: `   +${hidden} more`, tone: "dim" }]];
}

/**
 * The case pane — everything the alert itself says, for pane [1] (PRD-3 §8.1).
 *
 * `description`, `remediationSteps` and `additionalData` were parsed here long before anything
 * rendered them. The first two are the detection's own account of why it fired and what it
 * recommends; keeping them off screen left the analyst reading the agent's summary of an alert
 * they had never been shown.
 */
export function alertLines(facts: AlertFacts, width: number): Line[] {
  const lines: Line[] = [
    labelled(
      "severity",
      `${facts.severityTag.trim()}${facts.alertType === undefined ? "" : `  ${facts.alertType}`}`,
      width,
    ),
    labelled("incident", facts.window, width),
    labelled("detected", facts.detected, width),
    labelled("asset", facts.compromisedEntity ?? "—", width),
    labelled("tactics", facts.tactics.length === 0 ? "—" : facts.tactics.join(", "), width),
    labelled(
      "techniques",
      facts.techniques.length === 0 ? "—" : facts.techniques.join(", "),
      width,
    ),
  ];

  if (facts.entities.length > 0) {
    lines.push("", [{ text: " entities", tone: "heading", bold: true }]);
    lines.push(
      ...capped(
        facts.entities.map((entity) => indented(entity.type, entity.label, width)),
        MAX_ENTITY_ROWS,
      ),
    );
  }

  // The detection's own description is *not* here. Wrapped into a 43-column pane it broke mid-token
  // — "user.account.privilege.grant within 15" — and prose that narrow is unreadable however it is
  // styled. It renders in pane [4] as WHY THE ALERT FIRED, where there is width for a sentence.

  if (facts.additionalData.length > 0) {
    lines.push("", [{ text: " details", tone: "heading", bold: true }]);
    lines.push(
      ...capped(
        facts.additionalData.map(([key, value]) => indented(key, value, width)),
        MAX_DETAIL_ROWS,
      ),
    );
  }

  return lines;
}

/**
 * The detection rule's own recommended actions.
 *
 * Labelled by source, because the console must not be read as the agent recommending anything —
 * `nextAction` was deliberately removed from the submission contract (ADR 005 §1), and this is the
 * alert speaking, not the investigation.
 */
export function remediationLines(facts: AlertFacts, width: number): Line[] {
  if (facts.remediationSteps.length === 0) return [];
  const lines: Line[] = [
    "",
    [{ text: "  REMEDIATION STEPS — FROM THE DETECTION RULE", tone: "heading", bold: true }],
  ];
  for (const [at, step] of facts.remediationSteps.entries()) {
    const wrapped = wrap(step, width - 7);
    lines.push(`  ${String(at + 1).padStart(2)}  ${wrapped[0] ?? ""}`);
    lines.push(...wrapped.slice(1).map((line) => `      ${line}`));
  }
  return lines;
}
