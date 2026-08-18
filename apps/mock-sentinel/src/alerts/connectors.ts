import {
  AttackTactic,
  type AlertSeverity,
  type AlertStatus,
  type ConfidenceLevel,
} from "@soc/contracts";

import type { EntityBag } from "./entities.ts";
import type { RuleRow } from "./rules.ts";

/**
 * Connector-ingested alerts.
 *
 * The second way real Sentinel gets alerts: another security product raises
 * them and a data connector ingests them as-is, preserving the vendor's own
 * identifiers, severity and MITRE mapping. `ProviderName` and `VendorName`
 * name the originating product rather than a Sentinel rule.
 *
 * Each connector's query selects the rows that genuinely represent alerts —
 * which is not always every row in the table (see the mail connectors) — and
 * `build` translates one row into alert fields plus entities.
 */

export interface ConnectorAlert {
  displayName: string;
  description: string;
  alertType: string;
  vendorOriginalId: string;
  severity: AlertSeverity;
  status: AlertStatus;
  tactics: AttackTactic[];
  techniques: string[];
  confidenceScore?: number;
  compromisedEntity: string;
  additionalData: Record<string, unknown>;
  /** Falls back to the row's TimeGenerated when a vendor gives no window. */
  startTimeUtc?: string;
  endTimeUtc?: string;
}

export interface Connector {
  /** Stable id feeding the deterministic alert id. */
  id: string;
  vendorName: string;
  productName: string;
  productComponentName?: string;
  providerName: string;
  query: string;
  build: (row: RuleRow, entities: EntityBag) => ConnectorAlert;
}

const str = (row: RuleRow, column: string): string => {
  const value = row[column];
  return value === null || value === undefined ? "" : String(value);
};

const numberOrUndefined = (row: RuleRow, column: string): number | undefined => {
  const value = row[column];
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * Maps a vendor's tactic label onto Sentinel's `AttackTactic` enum.
 *
 * Vendors write "Credential Access" and "Command and Control" where Sentinel
 * expects `CredentialAccess` and `CommandAndControl`, so comparison strips
 * everything that is not alphanumeric. Unrecognised labels are **dropped
 * rather than guessed** — an invented tactic would fail contract validation
 * and, worse, mislead an investigation.
 */
const TACTIC_LOOKUP = new Map(
  AttackTactic.options.map((tactic) => [tactic.toLowerCase().replaceAll(/[^a-z0-9]/g, ""), tactic]),
);

export function toAttackTactic(raw: string): AttackTactic | undefined {
  return TACTIC_LOOKUP.get(raw.toLowerCase().replaceAll(/[^a-z0-9]/g, ""));
}

/** Splits a vendor's comma/semicolon-delimited list and maps each entry. */
export function toAttackTactics(raw: string): AttackTactic[] {
  const mapped = raw
    .split(/[,;]/)
    .map((part) => toAttackTactic(part.trim()))
    .filter((tactic): tactic is AttackTactic => tactic !== undefined);
  return [...new Set(mapped)];
}

/**
 * Normalises a vendor severity to Sentinel's four values.
 *
 * CrowdStrike's scale includes `Critical`, which Sentinel does not have; it
 * folds into `High`, the most severe value available. Losing that distinction
 * is a real consequence of the target schema, so the original is preserved in
 * `additionalData` rather than discarded.
 */
export function toAlertSeverity(raw: string): AlertSeverity {
  switch (raw.trim().toLowerCase()) {
    case "critical":
    case "high":
      return "High";
    case "medium":
    case "moderate":
      return "Medium";
    case "low":
      return "Low";
    default:
      return "Informational";
  }
}

export function toAlertStatus(raw: string): AlertStatus {
  switch (
    raw
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z]/g, "")
  ) {
    case "new":
    case "open":
    case "reopened":
      return "New";
    case "inprogress":
    case "triaged":
      return "InProgress";
    case "closed":
    case "resolved":
      return "Resolved";
    case "dismissed":
    case "falsepositive":
      return "Dismissed";
    default:
      return "Unknown";
  }
}

/** Vendor confidence is 0-100; Sentinel's score is 0.0-1.0. */
function toConfidence(percent: number | undefined): {
  confidenceScore?: number;
  confidenceLevel: ConfidenceLevel;
} {
  if (percent === undefined) return { confidenceLevel: "Unknown" };
  const score = Math.min(1, Math.max(0, percent / 100));
  return {
    confidenceScore: score,
    confidenceLevel: score >= 0.8 ? "High" : score <= 0.4 ? "Low" : "Unknown",
  };
}

export { toConfidence };

/** Adds a Windows host plus the account observed on it, linked by `$ref`. */
function hostAndAccount(
  entities: EntityBag,
  hostName: string,
  accountName: string,
  accountDomain: string,
): void {
  const host = hostName === "" ? undefined : entities.host({ hostName, osFamily: "Windows" });
  if (accountName !== "") {
    entities.account({
      name: accountName,
      ntDomain: accountDomain === "" ? undefined : accountDomain,
      host,
    });
  }
}

export const CONNECTORS: readonly Connector[] = [
  {
    id: "CrowdStrikeFalconAlert",
    vendorName: "CrowdStrike",
    productName: "CrowdStrike Falcon",
    productComponentName: "Falcon Alerts",
    providerName: "CrowdStrike Falcon",
    // AgentId is the only host identifier on this table, so the connector
    // resolves it against the device inventory — the same enrichment a real
    // connector performs before handing the alert to Sentinel.
    query: `
      CrowdStrikeAlerts
      | lookup kind=leftouter (
          CrowdStrikeHosts
          | project AgentId = DeviceId, ResolvedHostname = Hostname, ResolvedDomain = MachineDomain
        ) on AgentId
      | project TimeGenerated, Id, CompositeId, DisplayName, Description, Name, Severity,
                SeverityName, Confidence, Status, Tactic, Technique, TacticId, TechniqueId,
                Scenario, Objective, PatternId, Product, Timestamp, CreatedTimestamp,
                AgentId, ResolvedHostname, ResolvedDomain
    `,
    build: (row, entities) => {
      const display = str(row, "DisplayName") || str(row, "Name");
      const hostName = str(row, "ResolvedHostname");
      const confidence = toConfidence(numberOrUndefined(row, "Confidence"));

      if (hostName !== "") entities.host({ hostName, osFamily: "Windows" });

      return {
        displayName: display,
        description: str(row, "Description"),
        alertType: str(row, "Name") || "CrowdStrikeFalconAlert",
        vendorOriginalId: str(row, "CompositeId") || str(row, "Id"),
        severity: toAlertSeverity(str(row, "SeverityName")),
        status: toAlertStatus(str(row, "Status")),
        tactics: toAttackTactics(str(row, "Tactic")),
        techniques: [str(row, "TechniqueId")].filter((t) => t !== ""),
        confidenceScore: confidence.confidenceScore,
        compromisedEntity: hostName || str(row, "AgentId"),
        startTimeUtc: str(row, "Timestamp") || undefined,
        endTimeUtc: str(row, "Timestamp") || undefined,
        additionalData: {
          "Vendor Severity": str(row, "SeverityName"),
          "Vendor Severity Score": numberOrUndefined(row, "Severity"),
          "Vendor Confidence": numberOrUndefined(row, "Confidence"),
          Technique: str(row, "Technique"),
          Tactic: str(row, "Tactic"),
          Scenario: str(row, "Scenario"),
          Objective: str(row, "Objective"),
          "Agent Id": str(row, "AgentId"),
        },
      };
    },
  },

  {
    id: "CrowdStrikeFalconDetection",
    vendorName: "CrowdStrike",
    productName: "CrowdStrike Falcon",
    productComponentName: "Falcon Detections",
    providerName: "CrowdStrike Falcon",
    query: `
      CrowdStrikeDetections
      | project TimeGenerated, DetectionId, Id, CompositeId, Description, Name, DetectionType,
                Severity, SeverityName, MaxSeverityDisplayName, Confidence, MaxConfidence, Status,
                Tactic, Technique, TacticId, TechniqueId, Scenario, Objective,
                Device_hostname, HostInfo_hostname, HostInfo_machine_domain,
                UserName, UserPrincipal, SourceAccountName, SourceAccountDomain,
                Filename, Filepath, Sha256, Md5, Cmdline, ProcessId,
                ParentDetails_process_name, ParentDetails_command_line,
                FirstBehavior, LastBehavior, ProcessStartTime
    `,
    build: (row, entities) => {
      const hostName = str(row, "Device_hostname") || str(row, "HostInfo_hostname");
      const accountName = str(row, "SourceAccountName") || str(row, "UserName");
      const accountDomain = str(row, "SourceAccountDomain") || str(row, "HostInfo_machine_domain");
      const confidence = toConfidence(
        numberOrUndefined(row, "Confidence") ?? numberOrUndefined(row, "MaxConfidence"),
      );

      hostAndAccount(entities, hostName, accountName, accountDomain);

      const sha256 = str(row, "Sha256");
      const md5 = str(row, "Md5");
      const fileName = str(row, "Filename");
      const hashes = [
        ...(sha256 === "" ? [] : [entities.fileHash("SHA256", sha256)]),
        ...(md5 === "" ? [] : [entities.fileHash("MD5", md5)]),
      ];
      if (fileName !== "") {
        entities.file({
          name: fileName,
          directory: str(row, "Filepath") || undefined,
          fileHashes: hashes.length > 0 ? hashes : undefined,
        });
      }

      const severity = str(row, "SeverityName") || str(row, "MaxSeverityDisplayName");

      return {
        displayName: str(row, "Name") || str(row, "DetectionType") || "CrowdStrike detection",
        description: str(row, "Description"),
        alertType: str(row, "DetectionType") || "CrowdStrikeFalconDetection",
        vendorOriginalId: str(row, "DetectionId") || str(row, "CompositeId") || str(row, "Id"),
        severity: toAlertSeverity(severity),
        status: toAlertStatus(str(row, "Status")),
        tactics: toAttackTactics(str(row, "Tactic")),
        techniques: [str(row, "TechniqueId")].filter((t) => t !== ""),
        confidenceScore: confidence.confidenceScore,
        compromisedEntity: hostName || accountName,
        startTimeUtc: str(row, "FirstBehavior") || undefined,
        endTimeUtc: str(row, "LastBehavior") || undefined,
        additionalData: {
          "Vendor Severity": severity,
          "Vendor Confidence": numberOrUndefined(row, "Confidence"),
          Technique: str(row, "Technique"),
          Tactic: str(row, "Tactic"),
          "Command Line": str(row, "Cmdline"),
          "Parent Process": str(row, "ParentDetails_process_name"),
          "Parent Command Line": str(row, "ParentDetails_command_line"),
          Scenario: str(row, "Scenario"),
        },
      };
    },
  },

  ...["MailGuard365_Threats_CL", "SEG_MailGuard_CL"].map((table): Connector => ({
    id: `MailGuard365-${table}`,
    vendorName: "MailGuard 365",
    productName: "MailGuard 365",
    productComponentName: table,
    providerName: "MailGuard 365 Email Security",
    // Clean mail is not an alert. The table is a full mail log — 32 of its 46
    // rows are `ThreatVerdict == "Clean"` — and a real mail-security connector
    // raises alerts only for adverse verdicts. Ingesting all of it would bury
    // 14 genuine detections under delivery noise.
    query: `
      ${table}
      | where isnotempty(ThreatVerdict) and tolower(tostring(ThreatVerdict)) != "clean"
      | project TimeGenerated, EventId, MessageId, InternetMessageId, Subject,
                SenderAddress, SenderDomain, SenderIP, RecipientAddress, RecipientDomain,
                Direction, Action, ThreatVerdict, ThreatConfidence, ScanEngine,
                AttachmentName, AttachmentSHA256, Urls, PolicyName
    `,
    build: (row, entities) => {
      const verdict = str(row, "ThreatVerdict");
      const sender = str(row, "SenderAddress");
      const recipient = str(row, "RecipientAddress");
      const subject = str(row, "Subject");
      const action = str(row, "Action");
      const confidence = toConfidence(numberOrUndefined(row, "ThreatConfidence"));

      if (recipient !== "") entities.mailbox({ mailboxPrimaryAddress: recipient });
      const senderIp = str(row, "SenderIP");
      if (senderIp !== "") entities.ip(senderIp);

      const attachmentHash = str(row, "AttachmentSHA256");
      const attachmentName = str(row, "AttachmentName");
      const hashes = attachmentHash === "" ? [] : [entities.fileHash("SHA256", attachmentHash)];
      const files =
        attachmentName === ""
          ? []
          : [
              entities.file({
                name: attachmentName,
                fileHashes: hashes.length > 0 ? hashes : undefined,
              }),
            ];

      const urls = str(row, "Urls")
        .split(/[,;\s]+/)
        .filter((url) => url.startsWith("http"));
      for (const url of urls) entities.url(url);

      entities.mailMessage({
        sender: sender === "" ? undefined : sender,
        recipient: recipient === "" ? undefined : recipient,
        senderIP: senderIp === "" ? undefined : senderIp,
        subject: subject === "" ? undefined : subject,
        internetMessageId: str(row, "InternetMessageId") || undefined,
        urls: urls.length > 0 ? urls : undefined,
        files: files.length > 0 ? files : undefined,
        deliveryAction: action.toLowerCase() === "allow" ? "Delivered" : "Blocked",
      });

      return {
        displayName: `${verdict} email delivered to ${recipient || "unknown recipient"}`,
        description:
          `A message from ${sender || "an unknown sender"} with subject ` +
          `"${subject}" was classified as ${verdict} and the gateway action was ${action}.`,
        alertType: `MailGuard365-${verdict}`,
        vendorOriginalId: str(row, "EventId") || str(row, "MessageId"),
        // A threat the gateway still allowed through is materially worse than
        // one it quarantined, and the severity should say so.
        severity: action.toLowerCase() === "allow" ? "High" : "Medium",
        status: "New",
        tactics: ["InitialAccess"],
        techniques: verdict.toLowerCase().startsWith("phish") ? ["T1566.002"] : ["T1566"],
        confidenceScore: confidence.confidenceScore,
        compromisedEntity: recipient,
        additionalData: {
          "Threat Verdict": verdict,
          "Gateway Action": action,
          "Scan Engine": str(row, "ScanEngine"),
          "Sender Domain": str(row, "SenderDomain"),
          Direction: str(row, "Direction"),
          "Policy Name": str(row, "PolicyName"),
        },
      };
    },
  })),
];
