import { z } from "zod";

import { AlertEntity } from "./entities.ts";

/**
 * Alert contract for `GET /alerts` and `GET /alerts/:id`.
 *
 * Shaped after the real Microsoft Sentinel ARM API
 * (`Microsoft.SecurityInsights`, api-version 2025-09-01): an ARM resource
 * envelope of `id` / `name` / `type` / `kind` wrapping a camelCase `properties`
 * bag. Keeping this shape means the Sentinel Client built in the next slice
 * parses the same payload here as it would against a real workspace
 * (`architecture.md` §2.4).
 *
 * Two deliberate deviations from Microsoft, both documented in ADR 004:
 *
 * 1. **URLs are `/alerts`, not the ARM path.** PRD-1 §3 explicitly excludes
 *    reproducing the ARM subscription/resourceGroup/workspace hierarchy. The
 *    `id` field still carries an ARM-shaped string so clients that parse it
 *    keep working.
 * 2. **`properties.entities` exists.** The real ARM alert omits entities
 *    entirely — they are reachable only through the `SecurityAlert` table or a
 *    separate entities call. PRD-1 §4.2 requires entities on the alert, and
 *    they are the single most useful thing an investigator receives, so they
 *    are included here.
 */

export const AlertSeverity = z.enum(["High", "Medium", "Low", "Informational"]);
export type AlertSeverity = z.infer<typeof AlertSeverity>;

export const AlertStatus = z.enum(["Unknown", "New", "Resolved", "Dismissed", "InProgress"]);
export type AlertStatus = z.infer<typeof AlertStatus>;

export const ConfidenceLevel = z.enum(["Unknown", "Low", "High"]);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevel>;

/** MITRE ATT&CK tactics, verbatim from the ARM `AttackTactic` enumeration. */
export const AttackTactic = z.enum([
  "Reconnaissance",
  "ResourceDevelopment",
  "InitialAccess",
  "Execution",
  "Persistence",
  "PrivilegeEscalation",
  "DefenseEvasion",
  "CredentialAccess",
  "Discovery",
  "LateralMovement",
  "Collection",
  "Exfiltration",
  "CommandAndControl",
  "Impact",
  "PreAttack",
  "ImpairProcessControl",
  "InhibitResponseFunction",
]);
export type AttackTactic = z.infer<typeof AttackTactic>;

/** Where an alert came from, mirroring Sentinel's two alert origins. */
export const AlertProviderKind = z.enum(["ScheduledRule", "Connector"]);
export type AlertProviderKind = z.infer<typeof AlertProviderKind>;

export const SecurityAlertProperties = z.object({
  /** Sentinel's internal unique id for the alert. Stable across bootstraps. */
  systemAlertId: z.string().min(1),
  alertDisplayName: z.string().min(1),
  description: z.string().default(""),
  severity: AlertSeverity,
  status: AlertStatus,

  /** Rule id for scheduled alerts; the vendor's alert type for ingested ones. */
  alertType: z.string().min(1),
  /** Unique id assigned by the originating product, where one exists. */
  vendorOriginalId: z.string().optional(),
  providerAlertId: z.string().optional(),

  vendorName: z.string().min(1),
  productName: z.string().min(1),
  productComponentName: z.string().optional(),
  /** The service *within* the product that produced the alert. */
  providerName: z.string().min(1),

  tactics: z.array(AttackTactic).default([]),
  /** MITRE technique ids such as `T1110.001`. */
  techniques: z.array(z.string()).default([]),

  /** First event contributing to the alert. */
  startTimeUtc: z.iso.datetime(),
  /** Last event contributing to the alert. */
  endTimeUtc: z.iso.datetime(),
  /** When the alert itself was produced. */
  timeGenerated: z.iso.datetime(),
  processingEndTime: z.iso.datetime(),

  confidenceLevel: ConfidenceLevel.default("Unknown"),
  /** 0.0–1.0 where the provider supplies one. */
  confidenceScore: z.number().min(0).max(1).optional(),

  /** Display name of the main entity the alert is about. */
  compromisedEntity: z.string().optional(),
  remediationSteps: z.array(z.string()).default([]),
  alertLink: z.string().optional(),

  /** Provider-specific extras. Free-form by design (PRD-1 §4.2). */
  additionalData: z.record(z.string(), z.unknown()).default({}),

  /** See the file header — present here, absent from the real ARM alert. */
  entities: z.array(AlertEntity).default([]),
});
export type SecurityAlertProperties = z.infer<typeof SecurityAlertProperties>;

export const SecurityAlertResource = z.object({
  /** ARM-shaped resource id. Not routable here; see the file header. */
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.literal("Microsoft.SecurityInsights/Entities"),
  kind: z.literal("SecurityAlert"),
  properties: SecurityAlertProperties,
});
export type SecurityAlertResource = z.infer<typeof SecurityAlertResource>;

/** `GET /alerts`. ARM list envelope. */
export const AlertListResponse = z.object({
  value: z.array(SecurityAlertResource),
});
export type AlertListResponse = z.infer<typeof AlertListResponse>;
