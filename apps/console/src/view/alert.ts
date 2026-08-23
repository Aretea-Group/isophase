import { SecurityAlert } from "@soc/contracts";

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

function decodedJson(value: unknown): unknown {
  if (typeof value !== "string" || value.trim() === "") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function strings(value: unknown): string[] {
  const decoded = decodedJson(value);
  return Array.isArray(decoded)
    ? decoded.filter((item): item is string => typeof item === "string")
    : [];
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/** Source entities are opaque; these are the label conventions the current connectors emit. */
export function entityLabel(entity: Record<string, unknown>): string {
  return (
    firstString(entity, [
      "hostName",
      "HostName",
      "name",
      "Name",
      "address",
      "Address",
      "url",
      "Url",
      "fileName",
      "FileName",
      "processId",
      "ProcessId",
      "value",
      "Value",
    ]) ?? "—"
  );
}

function alertEntities(value: unknown): AlertEntity[] {
  const decoded = decodedJson(value);
  if (!Array.isArray(decoded)) return [];
  return decoded
    .map(asRecord)
    .filter((entity): entity is Record<string, unknown> => entity !== undefined)
    .map((entity) => ({
      type: firstString(entity, ["type", "Type", "kind", "Kind"]) ?? "unknown",
      label: entityLabel(entity),
    }));
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
  const record = asRecord(decodedJson(value));
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
/**
 * Facts for an alert that has no run yet (PRD-5 §7).
 *
 * `alertFactsFromResult` starts from what a run recorded; this starts from the normalized alert the
 * queue has. Connector-native evidence only enriches fields that are not part of that shared
 * contract, such as remediation steps and rule-specific additional data.
 */
export function alertFactsFromAlert(alert: SecurityAlert): AlertFacts {
  const base: AlertFacts = {
    alertId: alert.id,
    title: alert.title,
    severity: severityOf(alert.severity),
    severityTag: severityTag(alert.severity),
    window: incidentWindow(alert.startTimeUtc, alert.endTimeUtc),
    detected: incidentTime(alert.timeGenerated),
    hasTime: alert.startTimeUtc !== undefined || alert.timeGenerated !== undefined,
    tactics: alert.tactics,
    techniques: alert.techniques,
    ...(alert.compromisedEntity === undefined
      ? {}
      : { compromisedEntity: alert.compromisedEntity }),
    ...(alert.alertType === undefined ? {} : { alertType: alert.alertType }),
    description: alert.description,
    entities: alertEntities(alert.entities),
    remediationSteps: [],
    additionalData: [],
    source: "transcript",
  };
  return enrichWithNativeAlert(base, alert.native);
}

/** Project current Azure's native row into the same evidence keys as Mock Sentinel's ARM payload. */
function azureAlertProperties(
  record: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const nativeKeys = ["SystemAlertId", "Entities", "RemediationSteps", "ExtendedProperties"];
  if (!nativeKeys.some((key) => key in record)) return undefined;
  return {
    severity: record["AlertSeverity"],
    startTimeUtc: record["StartTime"],
    endTimeUtc: record["EndTime"],
    timeGenerated: record["TimeGenerated"],
    tactics: record["Tactics"],
    techniques: record["Techniques"],
    compromisedEntity: record["CompromisedEntity"],
    alertType: record["AlertType"],
    description: record["Description"],
    entities: decodedJson(record["Entities"]),
    remediationSteps: decodedJson(record["RemediationSteps"]),
    additionalData: decodedJson(record["ExtendedProperties"]),
  };
}

function enrichWithNativeAlert(facts: AlertFacts, alertJson: unknown): AlertFacts {
  const record = asRecord(alertJson);
  const properties =
    asRecord(record?.["properties"]) ??
    (record === undefined ? undefined : azureAlertProperties(record));
  if (properties === undefined) return facts;

  const entities = alertEntities(properties["entities"]);

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
    entities: entities.length === 0 ? facts.entities : entities,
    remediationSteps: strings(properties["remediationSteps"]),
    additionalData: scalarPairs(properties["additionalData"]),
    source: facts.source === "artifact" || facts.source === "both" ? "both" : "transcript",
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

function mergeAlertFacts(facts: AlertFacts, evidence: AlertFacts): AlertFacts {
  const merged: AlertFacts = {
    ...facts,
    severity: facts.source === "none" ? evidence.severity : facts.severity,
    severityTag: facts.source === "none" ? evidence.severityTag : facts.severityTag,
    window: facts.hasTime ? facts.window : evidence.window,
    detected: facts.hasTime ? facts.detected : evidence.detected,
    hasTime: facts.hasTime || evidence.hasTime,
    tactics: facts.tactics.length > 0 ? facts.tactics : evidence.tactics,
    techniques: facts.techniques.length > 0 ? facts.techniques : evidence.techniques,
    entities: evidence.entities.length === 0 ? facts.entities : evidence.entities,
    remediationSteps: evidence.remediationSteps,
    additionalData: evidence.additionalData,
    source: facts.source === "artifact" || facts.source === "both" ? "both" : "transcript",
  };
  if (evidence.description !== undefined) merged.description = evidence.description;
  if (merged.compromisedEntity === undefined && evidence.compromisedEntity !== undefined) {
    merged.compromisedEntity = evidence.compromisedEntity;
  }
  if (merged.alertType === undefined && evidence.alertType !== undefined) {
    merged.alertType = evidence.alertType;
  }
  return merged;
}

export function enrichWithAlertJson(facts: AlertFacts, alertJson: unknown): AlertFacts {
  const alert = SecurityAlert.safeParse(alertJson);
  return alert.success
    ? mergeAlertFacts(facts, alertFactsFromAlert(alert.data))
    : enrichWithNativeAlert(facts, alertJson);
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
    // `severityTag` is blank-padded when nothing was recorded, so `trim` left this one field
    // showing nothing at all while every other absent field showed an em dash — which reads as a
    // rendering fault rather than as a fact the alert does not carry.
    labelled(
      "severity",
      `${facts.severityTag.trim() === "" ? "—" : facts.severityTag.trim()}${facts.alertType === undefined ? "" : `  ${facts.alertType}`}`,
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
