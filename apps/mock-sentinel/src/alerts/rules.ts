import type { AlertSeverity, AttackTactic } from "@soc/contracts";

import type { EntityBag } from "./entities.ts";

/**
 * Scheduled analytics rules.
 *
 * One of the two ways real Sentinel produces alerts: a rule runs KQL on a
 * schedule, and every row the query returns becomes an alert. Deriving alerts
 * this way rather than hand-writing alert JSON means each one provably
 * correlates with the telemetry — an alert cannot claim something the data does
 * not support, because the data is what produced it.
 *
 * The Training Lab does ship its own detection rules, but they are authored
 * against the live connector schema rather than the CSV export that accompanies
 * them, and running them here required rebuilding a flattened column, widening
 * every time filter, and repairing a rule that projects away a column it then
 * uses. That was judged too much adaptation for too little fidelity, so the
 * rules here are our own. See ADR 004.
 *
 * Each query must project `StartTime` and `EndTime`, which become the alert's
 * impact window, plus whatever columns `build` needs. One result row = one
 * alert, exactly as Sentinel behaves.
 */

/** Values Kusto returns for one result row, keyed by column name. */
export type RuleRow = Record<string, unknown>;

export interface RuleAlert {
  displayName: string;
  description: string;
  /** Display name of the principal entity the alert is about. */
  compromisedEntity: string;
  /** Free-form provider extras; lands in `ExtendedProperties`. */
  additionalData: Record<string, unknown>;
}

export interface AnalyticsRule {
  /** Becomes `AlertType`. Stable — it feeds the deterministic alert id. */
  id: string;
  displayName: string;
  description: string;
  severity: AlertSeverity;
  tactics: AttackTactic[];
  techniques: string[];
  remediationSteps: string[];
  query: string;
  /** Builds the per-row alert body and populates its entities. */
  build: (row: RuleRow, entities: EntityBag) => RuleAlert;
}

const str = (row: RuleRow, column: string): string => {
  const value = row[column];
  return value === null || value === undefined ? "" : String(value);
};

const num = (row: RuleRow, column: string): number => Number(row[column] ?? 0);

/** Kusto `make_set` returns a JSON array; results arrive already parsed. */
const set = (row: RuleRow, column: string): string[] => {
  const value = row[column];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
};

/**
 * Splits a Windows `DOMAIN\user` account string.
 *
 * SecurityEvent accounts arrive as `\ADMINISTRATOR` (no domain) or
 * `PKWORK\mirage`. The leading-backslash form is why these entities need a host
 * to survive Sentinel's generic-name rule.
 */
function splitWindowsAccount(account: string): { name: string; ntDomain?: string } {
  const index = account.indexOf("\\");
  if (index === -1) return { name: account };
  const domain = account.slice(0, index);
  return { name: account.slice(index + 1), ntDomain: domain === "" ? undefined : domain };
}

/**
 * Adds an account entity from a UPN or bare username.
 *
 * Splitting on `@` gives Sentinel the `Name` + `UPNSuffix` pair it treats as a
 * strong identifier; a bare name would be a weak one, and would be dropped
 * outright if it happened to be generic.
 */
function addUpnAccount(entities: EntityBag, upn: string): void {
  const trimmed = upn.trim();
  if (trimmed === "") return;
  const [name = trimmed, upnSuffix] = trimmed.split("@");
  entities.account({ name, upnSuffix });
}

export const ANALYTICS_RULES: readonly AnalyticsRule[] = [
  {
    id: "SOC-RULE-0001-RdpBruteForce",
    displayName: "Multiple failed logon attempts against a single host",
    description:
      "A large volume of Windows logon failures (event 4625) was observed against one host " +
      "within a short window, consistent with a password brute-force or spray attempt.",
    severity: "Medium",
    tactics: ["CredentialAccess"],
    techniques: ["T1110.001"],
    remediationSteps: [
      "Confirm whether any targeted account subsequently authenticated successfully.",
      "Verify whether the host should be reachable for remote logon from the source network.",
      "If any account succeeded, reset its credentials and review its session activity.",
    ],
    // Deliberately does not judge the outcome: it reports failures only. Whether
    // the attack succeeded is what the investigation has to establish, and the
    // answer for SOC-FW-RDP is that it did not (ADR 001).
    query: `
      // Two stages so the account sample is the *most targeted* accounts and is
      // reproducible. A bare array_slice(array_sort_asc(make_set(Account)), 0, 4) returns an arbitrary five of
      // 257, and dcount is approximate — both make the alert body, and the
      // content-addressed id derived from it, differ between bootstraps.
      let perAccount =
        SecurityEvent
        | where EventID == 4625
        | summarize
            Failures = count(),
            FirstSeen = min(TimeGenerated),
            LastSeen = max(TimeGenerated)
          by Computer, Account;
      let totals =
        perAccount
        | summarize
            FailureCount = sum(Failures),
            TargetedAccounts = count_distinct(Account),
            StartTime = min(FirstSeen),
            EndTime = max(LastSeen)
          by Computer
        | where FailureCount > 1000;
      let topAccounts =
        perAccount
        | join kind=inner (totals | project Computer) on Computer
        | top-nested of Computer by Ignore = max(1),
          top-nested 5 of Account by AccountFailures = sum(Failures)
        | summarize SampleAccounts = make_set(Account) by Computer;
      totals
      | join kind=inner topAccounts on Computer
      | project Computer, FailureCount, TargetedAccounts, SampleAccounts, StartTime, EndTime
      | order by FailureCount desc
    `,
    build: (row, entities) => {
      const computer = str(row, "Computer");
      const failures = num(row, "FailureCount");
      const targeted = num(row, "TargetedAccounts");

      const host = entities.host({ hostName: computer });
      for (const account of set(row, "SampleAccounts")) {
        const { name, ntDomain } = splitWindowsAccount(account);
        if (name !== "") entities.account({ name, ntDomain, host });
      }

      return {
        displayName: `Multiple failed logon attempts against ${computer}`,
        description:
          `${failures.toLocaleString("en-US")} failed logon attempts (event 4625) targeting ` +
          `${targeted} distinct account names were observed on ${computer}.`,
        compromisedEntity: computer,
        additionalData: {
          "Failure Count": failures,
          "Targeted Account Count": targeted,
          "Query Period": "01:00:00",
          "Trigger Threshold": 1000,
        },
      };
    },
  },

  {
    id: "SOC-RULE-0002-AuditLogCleared",
    displayName: "Security audit log was cleared",
    description:
      "The Windows security audit log was cleared (event 1102). This is a common " +
      "anti-forensic step following interactive access to a host.",
    severity: "High",
    tactics: ["DefenseEvasion"],
    techniques: ["T1070.001"],
    remediationSteps: [
      "Establish which account cleared the log and whether the action was authorised.",
      "Look for activity on the host immediately preceding the clear.",
    ],
    query: `
      SecurityEvent
      | where EventID == 1102
      | summarize
          EventCount = count(),
          SampleAccounts = array_slice(array_sort_asc(make_set(Account)), 0, 4),
          StartTime = min(TimeGenerated),
          EndTime = max(TimeGenerated)
        by Computer
    `,
    build: (row, entities) => {
      const computer = str(row, "Computer");
      const hostName = computer.split(".")[0] ?? computer;
      const dnsDomain = computer.includes(".") ? computer.slice(hostName.length + 1) : undefined;

      const host = entities.host({ hostName, dnsDomain, osFamily: "Windows" });
      const accounts = set(row, "SampleAccounts");
      for (const account of accounts) {
        const { name, ntDomain } = splitWindowsAccount(account);
        if (name !== "") entities.account({ name, ntDomain, host });
      }

      return {
        displayName: `Security audit log cleared on ${hostName}`,
        description:
          `The security audit log on ${computer} was cleared` +
          (accounts.length > 0 ? ` by ${accounts.join(", ")}.` : "."),
        compromisedEntity: computer,
        additionalData: { "Event Count": num(row, "EventCount"), "Event ID": 1102 },
      };
    },
  },

  // ---------------------------------------------------------------- identity
  {
    id: "SOC-RULE-0010-OktaMfaTampering",
    displayName: "Okta MFA factor removed or reset",
    description:
      "Multi-factor authentication factors were deactivated or reset on an Okta account. " +
      "Stripping MFA is how an attacker keeps an identity they have taken over.",
    severity: "High",
    tactics: ["Persistence", "DefenseEvasion"],
    techniques: ["T1556.006"],
    remediationSteps: [
      "Confirm with the account owner whether the MFA change was expected.",
      "Review the source address and any privilege changes in the same session.",
      "Re-enrol MFA and revoke active sessions and API tokens if unauthorised.",
    ],
    query: `
      OktaV2_CL
      | where EventOriginalType startswith "user.mfa.factor"
      | summarize
          EventCount = count(),
          Operations = array_slice(array_sort_asc(make_set(EventOriginalType)), 0, 7),
          SourceAddresses = array_slice(array_sort_asc(make_set(SrcIpAddr)), 0, 4),
          Countries = array_slice(array_sort_asc(make_set(SrcGeoCountry)), 0, 4),
          StartTime = min(TimeGenerated),
          EndTime = max(TimeGenerated)
        by ActorUsername
    `,
    build: (row, entities) => {
      const user = str(row, "ActorUsername");
      addUpnAccount(entities, user);
      for (const address of set(row, "SourceAddresses")) entities.ip(address);
      entities.cloudApplication({ name: "Okta" });
      return {
        displayName: `MFA factors modified for ${user}`,
        description: `MFA factors were changed for ${user} (${set(row, "Operations").join(", ")}).`,
        compromisedEntity: user,
        additionalData: {
          Operations: set(row, "Operations"),
          "Source Addresses": set(row, "SourceAddresses"),
          Countries: set(row, "Countries"),
        },
      };
    },
  },

  {
    id: "SOC-RULE-0011-OktaPrivilegeEscalation",
    displayName: "Okta privilege granted shortly after sign-in",
    description:
      "An Okta account was granted privileges or issued an API token within minutes of a " +
      "session starting, a pattern consistent with account takeover rather than routine admin.",
    severity: "High",
    tactics: ["PrivilegeEscalation", "Persistence"],
    techniques: ["T1098", "T1078.004"],
    remediationSteps: [
      "Verify the privilege change against an approved request.",
      "Revoke any API token minted in the same session.",
      "Force re-authentication and review what the account did afterwards.",
    ],
    query: `
      let sessions = OktaV2_CL
        | where EventOriginalType == "user.session.start"
        | project ActorUsername, LoginTime = TimeGenerated, SrcIpAddr, SrcGeoCountry;
      let escalations = OktaV2_CL
        | where EventOriginalType in ("user.account.privilege.grant", "system.api_token.create")
        | project ActorUsername, EscalationTime = TimeGenerated, Operation = EventOriginalType;
      sessions
      | join kind=inner escalations on ActorUsername
      | where EscalationTime between (LoginTime .. (LoginTime + 15m))
      | summarize
          Operations = array_slice(array_sort_asc(make_set(Operation)), 0, 4),
          SourceAddresses = array_slice(array_sort_asc(make_set(SrcIpAddr)), 0, 4),
          Countries = array_slice(array_sort_asc(make_set(SrcGeoCountry)), 0, 4),
          StartTime = min(LoginTime),
          EndTime = max(EscalationTime)
        by ActorUsername
    `,
    build: (row, entities) => {
      const user = str(row, "ActorUsername");
      addUpnAccount(entities, user);
      for (const address of set(row, "SourceAddresses")) entities.ip(address);
      entities.cloudApplication({ name: "Okta" });
      return {
        displayName: `Privilege escalation after sign-in for ${user}`,
        description:
          `${user} performed ${set(row, "Operations").join(", ")} within 15 minutes of signing in ` +
          `from ${set(row, "Countries").join(", ") || "an unknown location"}.`,
        compromisedEntity: user,
        additionalData: {
          Operations: set(row, "Operations"),
          "Source Addresses": set(row, "SourceAddresses"),
          Countries: set(row, "Countries"),
        },
      };
    },
  },

  {
    id: "SOC-RULE-0012-SignInToDisabledAccount",
    displayName: "Repeated sign-in attempts against a disabled account",
    description:
      "Authentication was repeatedly attempted against an account that is disabled. This " +
      "indicates someone holds credentials for a decommissioned identity.",
    severity: "Medium",
    tactics: ["InitialAccess", "CredentialAccess"],
    techniques: ["T1078.002"],
    remediationSteps: [
      "Confirm the account is intentionally disabled and should stay so.",
      "Check whether the source address has succeeded against any other account.",
    ],
    query: `
      // No StartTime/EndTime: this export carries no datetime column at all, so
      // the alert is stamped with the ingestion instant instead — the same
      // thing Log Analytics does for a record with no event time of its own.
      disable_accounts_CL
      | summarize
          Attempts = count(),
          SourceAddresses = array_slice(array_sort_asc(make_set(IPAddress)), 0, 4),
          Apps = array_slice(array_sort_asc(make_set(AppDisplayName)), 0, 4)
        by UserPrincipalName
    `,
    build: (row, entities) => {
      const user = str(row, "UserPrincipalName");
      addUpnAccount(entities, user);
      for (const address of set(row, "SourceAddresses")) entities.ip(address);
      return {
        displayName: `Sign-in attempts against disabled account ${user}`,
        description:
          `${num(row, "Attempts")} sign-in attempts targeted the disabled account ${user} ` +
          `from ${set(row, "SourceAddresses").join(", ")}.`,
        compromisedEntity: user,
        additionalData: {
          Attempts: num(row, "Attempts"),
          "Source Addresses": set(row, "SourceAddresses"),
          Applications: set(row, "Apps"),
        },
      };
    },
  },

  {
    id: "SOC-RULE-0013-AppCredentialAdded",
    displayName: "Credential added to an application registration",
    description:
      "A certificate or client secret was added to an application registration. Attackers use " +
      "this to obtain long-lived, MFA-exempt access that survives a password reset.",
    severity: "High",
    tactics: ["Persistence", "PrivilegeEscalation"],
    techniques: ["T1098.001"],
    remediationSteps: [
      "Confirm the credential was added by an authorised owner.",
      "Remove unrecognised keys and review what the application accessed.",
    ],
    query: `
      // No StartTime/EndTime — see SOC-RULE-0012.
      AuditLogsHunting_CL
      | summarize
          Changes = count(),
          Targets = array_slice(array_sort_asc(make_set(targetDisplayName)), 0, 7),
          Keys = array_slice(array_sort_asc(make_set(keyDisplayName)), 0, 7)
        by InitiatingUserOrApp
    `,
    build: (row, entities) => {
      const actor = str(row, "InitiatingUserOrApp");
      addUpnAccount(entities, actor);
      return {
        displayName: `Application credentials added by ${actor}`,
        description:
          `${actor} added ${num(row, "Changes")} credential(s) to ` +
          `${set(row, "Targets").join(", ")}.`,
        compromisedEntity: actor,
        additionalData: { Targets: set(row, "Targets"), Keys: set(row, "Keys") },
      };
    },
  },

  {
    id: "SOC-RULE-0014-SuspiciousSignInVolume",
    displayName: "High volume of successful sign-ins from a single address",
    description:
      "One account authenticated successfully many times from a single address in a short " +
      "window. Unremarkable for a scripted client, and also the shape credential replay takes " +
      "once the credentials are valid.",
    severity: "Medium",
    tactics: ["InitialAccess", "CredentialAccess"],
    techniques: ["T1078.004"],
    remediationSteps: [
      "Confirm the sign-ins with the account owner.",
      "Establish what the account did after authenticating.",
    ],
    query: `
      // Successes only. Failed authentication against a live account is a
      // different question, and SOC-RULE-0012 already asks it of disabled ones.
      sign_in_adelete_CL
      | where ResultType == 0
      | summarize
          SignIns = count(),
          Apps = array_slice(array_sort_asc(make_set(AppDisplayName)), 0, 6),
          Locations = array_slice(array_sort_asc(make_set(Location)), 0, 4),
          StartTime = min(CreatedDateTime),
          EndTime = max(CreatedDateTime)
        by UserPrincipalName, IPAddress
      | where SignIns >= 20
    `,
    build: (row, entities) => {
      const user = str(row, "UserPrincipalName");
      const address = str(row, "IPAddress");
      addUpnAccount(entities, user);
      if (address !== "") entities.ip(address);
      return {
        displayName: `${num(row, "SignIns")} successful sign-ins for ${user} from ${address}`,
        description:
          `${user} authenticated successfully ${num(row, "SignIns")} time(s) from ${address}, ` +
          `across ${set(row, "Apps").length} application(s).`,
        compromisedEntity: user,
        additionalData: {
          "Sign-ins": num(row, "SignIns"),
          "Source Address": address,
          Applications: set(row, "Apps"),
          // Reported, not relied on: the vendored data labels this same address
          // differently in different tables.
          Locations: set(row, "Locations"),
        },
      };
    },
  },

  // ------------------------------------------------------------------- cloud
  {
    id: "SOC-RULE-0020-AwsIamPersistence",
    displayName: "New AWS IAM user or access key created",
    description:
      "An IAM user, access key or policy attachment was created in AWS. All three are used to " +
      "establish persistence that outlives the original access.",
    severity: "High",
    tactics: ["Persistence", "PrivilegeEscalation"],
    techniques: ["T1136.003", "T1098.001"],
    remediationSteps: [
      "Confirm the IAM change against an approved change request.",
      "Review what the created principal or key did afterwards.",
      "Disable the key and remove the principal if unauthorised.",
    ],
    query: `
      AWSCloudTrail
      | where EventName in ("CreateUser", "CreateAccessKey", "AttachUserPolicy", "CreateRole")
      | summarize
          EventCount = count(),
          Operations = array_slice(array_sort_asc(make_set(EventName)), 0, 7),
          SourceAddresses = array_slice(array_sort_asc(make_set(SourceIpAddress)), 0, 4),
          StartTime = min(TimeGenerated),
          EndTime = max(TimeGenerated)
        by UserIdentityUserName, UserIdentityArn, RecipientAccountId
    `,
    build: (row, entities) => {
      const actor = str(row, "UserIdentityUserName");
      const arn = str(row, "UserIdentityArn");
      entities.account({ name: actor, dnsDomain: "aws" });
      for (const address of set(row, "SourceAddresses")) entities.ip(address);
      if (arn !== "") entities.azureResource(arn);
      entities.cloudApplication({ name: "Amazon Web Services" });
      return {
        displayName: `AWS IAM persistence activity by ${actor}`,
        description:
          `${actor} performed ${set(row, "Operations").join(", ")} in AWS account ` +
          `${str(row, "RecipientAccountId")}.`,
        compromisedEntity: actor === "" ? arn : actor,
        additionalData: {
          Operations: set(row, "Operations"),
          "AWS Account": str(row, "RecipientAccountId"),
          "Source Addresses": set(row, "SourceAddresses"),
        },
      };
    },
  },

  {
    id: "SOC-RULE-0021-AwsSecurityGroupOpened",
    displayName: "AWS security group opened or instance launched",
    description:
      "A security group ingress rule was authorised or a compute instance launched. Together " +
      "these are how an intruder exposes a foothold or provisions resources for abuse.",
    severity: "High",
    tactics: ["Persistence", "Impact"],
    techniques: ["T1562.007", "T1496"],
    remediationSteps: [
      "Verify the network exposure is intentional and scoped.",
      "Terminate unrecognised instances and revoke the ingress rule.",
    ],
    query: `
      AWSCloudTrail
      | where EventName in ("AuthorizeSecurityGroupIngress", "RunInstances", "ModifyImageAttribute")
      | summarize
          EventCount = count(),
          Operations = array_slice(array_sort_asc(make_set(EventName)), 0, 4),
          SourceAddresses = array_slice(array_sort_asc(make_set(SourceIpAddress)), 0, 4),
          StartTime = min(TimeGenerated),
          EndTime = max(TimeGenerated)
        by UserIdentityUserName, RecipientAccountId
    `,
    build: (row, entities) => {
      const actor = str(row, "UserIdentityUserName");
      entities.account({ name: actor, dnsDomain: "aws" });
      for (const address of set(row, "SourceAddresses")) entities.ip(address);
      entities.cloudApplication({ name: "Amazon Web Services" });
      return {
        displayName: `AWS network exposure or resource abuse by ${actor}`,
        description: `${actor} performed ${set(row, "Operations").join(", ")} in AWS.`,
        compromisedEntity: actor,
        additionalData: {
          Operations: set(row, "Operations"),
          "Source Addresses": set(row, "SourceAddresses"),
        },
      };
    },
  },

  {
    id: "SOC-RULE-0022-AwsConsoleLogin",
    displayName: "AWS console sign-in from an external address",
    description:
      "An AWS console sign-in originated from an address outside the corporate ranges. Benign " +
      "for remote administrators, but the entry point for a stolen-credential intrusion.",
    severity: "Medium",
    tactics: ["InitialAccess"],
    techniques: ["T1078.004"],
    remediationSteps: [
      "Confirm the sign-in with the account owner.",
      "Check whether MFA was satisfied for the session.",
    ],
    query: `
      AWSCloudTrail
      | where EventName == "ConsoleLogin"
      | where not(ipv4_is_private(SourceIpAddress))
      | summarize
          Logins = count(),
          SourceAddresses = array_slice(array_sort_asc(make_set(SourceIpAddress)), 0, 4),
          StartTime = min(TimeGenerated),
          EndTime = max(TimeGenerated)
        by UserIdentityUserName, RecipientAccountId
    `,
    build: (row, entities) => {
      const actor = str(row, "UserIdentityUserName");
      entities.account({ name: actor, dnsDomain: "aws" });
      for (const address of set(row, "SourceAddresses")) entities.ip(address);
      entities.cloudApplication({ name: "Amazon Web Services" });
      return {
        displayName: `AWS console sign-in by ${actor} from an external address`,
        description:
          `${actor} signed in to the AWS console ${num(row, "Logins")} time(s) from ` +
          `${set(row, "SourceAddresses").join(", ")}.`,
        compromisedEntity: actor,
        additionalData: {
          Logins: num(row, "Logins"),
          "Source Addresses": set(row, "SourceAddresses"),
        },
      };
    },
  },

  {
    id: "SOC-RULE-0023-GcpServiceAccountAbuse",
    displayName: "GCP service account or key created",
    description:
      "A GCP service account or service-account key was created. Service-account keys are " +
      "long-lived credentials and a common persistence mechanism.",
    severity: "High",
    tactics: ["Persistence", "PrivilegeEscalation"],
    techniques: ["T1136.003", "T1098"],
    remediationSteps: [
      "Confirm the service account is part of an approved deployment.",
      "Delete unrecognised keys and audit what the identity accessed.",
    ],
    query: `
      GCPAuditLogs
      | where MethodName has_any ("CreateServiceAccount", "CreateServiceAccountKey", "SetIamPolicy")
      | summarize
          EventCount = count(),
          Operations = array_slice(array_sort_asc(make_set(MethodName)), 0, 7),
          Projects = array_slice(array_sort_asc(make_set(ProjectId)), 0, 4),
          StartTime = min(TimeGenerated),
          EndTime = max(TimeGenerated)
        by PrincipalEmail
    `,
    build: (row, entities) => {
      const actor = str(row, "PrincipalEmail");
      addUpnAccount(entities, actor);
      entities.cloudApplication({ name: "Google Cloud Platform" });
      return {
        displayName: `GCP identity persistence by ${actor}`,
        description: `${actor} performed ${set(row, "Operations").join(", ")} in GCP.`,
        compromisedEntity: actor,
        additionalData: { Operations: set(row, "Operations"), Projects: set(row, "Projects") },
      };
    },
  },

  {
    id: "SOC-RULE-0024-GcpFirewallChange",
    displayName: "GCP firewall rule inserted",
    description:
      "A firewall rule was inserted in GCP, which can expose internal services to the internet.",
    severity: "Medium",
    tactics: ["DefenseEvasion", "Persistence"],
    techniques: ["T1562.007"],
    remediationSteps: [
      "Review the rule's source ranges and target ports.",
      "Remove the rule if it was not part of an approved change.",
    ],
    query: `
      GCPAuditLogs
      | where MethodName has "firewalls.insert"
      | summarize
          EventCount = count(),
          Resources = array_slice(array_sort_asc(make_set(GCPResourceName)), 0, 4),
          StartTime = min(TimeGenerated),
          EndTime = max(TimeGenerated)
        by PrincipalEmail
    `,
    build: (row, entities) => {
      const actor = str(row, "PrincipalEmail");
      addUpnAccount(entities, actor);
      entities.cloudApplication({ name: "Google Cloud Platform" });
      return {
        displayName: `GCP firewall rule inserted by ${actor}`,
        description: `${actor} inserted ${num(row, "EventCount")} firewall rule(s) in GCP.`,
        compromisedEntity: actor,
        additionalData: { Resources: set(row, "Resources") },
      };
    },
  },

  {
    id: "SOC-RULE-0025-GcpExternalPrincipal",
    displayName: "GCP activity by a principal outside the organisation",
    description:
      "GCP operations were performed by a principal whose domain is not the corporate tenant.",
    severity: "High",
    tactics: ["InitialAccess", "PrivilegeEscalation"],
    techniques: ["T1078.004"],
    remediationSteps: [
      "Confirm whether external access was intentionally granted.",
      "Remove the principal's bindings if not.",
    ],
    query: `
      GCPAuditLogs
      | where isnotempty(PrincipalEmail)
      | where PrincipalEmail !endswith "pkwork.onmicrosoft.com"
      | where PrincipalEmail !endswith ".iam.gserviceaccount.com"
      | summarize
          EventCount = count(),
          Operations = array_slice(array_sort_asc(make_set(MethodName)), 0, 7),
          Severities = array_slice(array_sort_asc(make_set(Severity)), 0, 4),
          StartTime = min(TimeGenerated),
          EndTime = max(TimeGenerated)
        by PrincipalEmail
    `,
    build: (row, entities) => {
      const actor = str(row, "PrincipalEmail");
      addUpnAccount(entities, actor);
      entities.cloudApplication({ name: "Google Cloud Platform" });
      return {
        displayName: `External principal ${actor} active in GCP`,
        description:
          `${actor}, outside the corporate domain, performed ` +
          `${set(row, "Operations").join(", ")} in GCP.`,
        compromisedEntity: actor,
        additionalData: {
          Operations: set(row, "Operations"),
          Severities: set(row, "Severities"),
        },
      };
    },
  },

  {
    id: "SOC-RULE-0026-CloudResourceDestruction",
    displayName: "Multiple cloud resources deleted by one principal",
    description:
      "A single caller deleted several Azure resources in a short window. Routine during a " +
      "planned teardown, and what destructive impact looks like from the control plane.",
    severity: "High",
    tactics: ["Impact"],
    techniques: ["T1485"],
    remediationSteps: [
      "Confirm the deletions were planned, with the team that owns the resources.",
      "Check whether the caller authenticated from an unfamiliar address.",
    ],
    query: `
      // Azure Activity logs one operation as several rows — Start, Accept and
      // Success for the same delete — so counting rows would report one
      // deletion as three. Only terminal successes count.
      azureActivity_adele_CL
      | where OperationNameValue endswith "/DELETE"
      | where ActivityStatusValue == "Success"
      | summarize
          Deletions = count(),
          Operations = array_slice(array_sort_asc(make_set(OperationNameValue)), 0, 8),
          ResourceGroups = array_slice(array_sort_asc(make_set(ResourceGroup)), 0, 8),
          StartTime = min(TimeGenerated),
          EndTime = max(TimeGenerated)
        by Caller, CallerIpAddress
      | where Deletions >= 5
    `,
    build: (row, entities) => {
      const caller = str(row, "Caller");
      const address = str(row, "CallerIpAddress");
      addUpnAccount(entities, caller);
      if (address !== "") entities.ip(address);
      entities.cloudApplication({ name: "Microsoft Azure" });
      return {
        displayName: `${num(row, "Deletions")} Azure resources deleted by ${caller}`,
        description:
          `${caller} deleted ${num(row, "Deletions")} resource(s) from ${address}, spanning ` +
          `${set(row, "ResourceGroups").length} resource group(s).`,
        compromisedEntity: caller,
        additionalData: {
          Deletions: num(row, "Deletions"),
          Operations: set(row, "Operations"),
          "Resource Groups": set(row, "ResourceGroups"),
          "Caller Address": address,
        },
      };
    },
  },

  // ----------------------------------------------------------------- network
  {
    id: "SOC-RULE-0030-FirewallThreatDetected",
    displayName: "Firewall threat signature triggered",
    description:
      "The perimeter firewall raised a threat verdict such as spyware or command-and-control " +
      "traffic on a session it observed.",
    severity: "High",
    tactics: ["CommandAndControl"],
    techniques: ["T1071.001"],
    remediationSteps: [
      "Identify the internal host behind the source address.",
      "Confirm whether the session was blocked or allowed to complete.",
    ],
    query: `
      CommonSecurityLog
      | where DeviceEventClassID == "THREAT" or Activity in ("spyware", "virus", "vulnerability")
      | summarize
          Sessions = count(),
          Destinations = array_slice(array_sort_asc(make_set(DestinationIP)), 0, 4),
          Activities = array_slice(array_sort_asc(make_set(Activity)), 0, 4),
          StartTime = min(TimeGenerated),
          EndTime = max(TimeGenerated)
        by SourceIP, DeviceVendor
    `,
    build: (row, entities) => {
      const source = str(row, "SourceIP");
      entities.ip(source);
      for (const destination of set(row, "Destinations")) entities.ip(destination);
      return {
        displayName: `Firewall threat detected from ${source}`,
        description:
          `${str(row, "DeviceVendor")} raised ${set(row, "Activities").join(", ")} on traffic ` +
          `from ${source} to ${set(row, "Destinations").join(", ")}.`,
        compromisedEntity: source,
        additionalData: {
          Sessions: num(row, "Sessions"),
          Activities: set(row, "Activities"),
          Destinations: set(row, "Destinations"),
        },
      };
    },
  },

  {
    id: "SOC-RULE-0031-LargeOutboundTransfer",
    displayName: "Large outbound data transfer to a single destination",
    description:
      "A single external destination received an unusually large volume of outbound data, " +
      "consistent with data staging or exfiltration.",
    severity: "High",
    tactics: ["Exfiltration"],
    techniques: ["T1041"],
    remediationSteps: [
      "Identify the internal host and the data involved.",
      "Determine whether the destination is a sanctioned service.",
      "Block the destination if the transfer was not authorised.",
    ],
    query: `
      CommonSecurityLog
      | where isnotempty(DestinationIP)
      | summarize
          Sessions = count(),
          BytesSent = sum(todouble(SentBytes)),
          Sources = array_slice(array_sort_asc(make_set(SourceIP)), 0, 4),
          StartTime = min(TimeGenerated),
          EndTime = max(TimeGenerated)
        by DestinationIP
      | where BytesSent > 50000000
    `,
    build: (row, entities) => {
      const destination = str(row, "DestinationIP");
      entities.ip(destination);
      for (const source of set(row, "Sources")) entities.ip(source);
      const megabytes = Math.round(Number(row["BytesSent"] ?? 0) / 1_000_000);
      return {
        displayName: `Large outbound transfer to ${destination}`,
        description: `${megabytes} MB was sent to ${destination} across ${num(row, "Sessions")} session(s).`,
        compromisedEntity: destination,
        additionalData: {
          "Megabytes Sent": megabytes,
          Sessions: num(row, "Sessions"),
          Sources: set(row, "Sources"),
        },
      };
    },
  },

  {
    id: "SOC-RULE-0032-InternalPortScan",
    displayName: "Internal port scan detected",
    description:
      "One source contacted many distinct ports on internal hosts and the sessions never " +
      "completed, the signature of a port scan.",
    severity: "Medium",
    tactics: ["Discovery"],
    techniques: ["T1046"],
    remediationSteps: [
      "Identify the scanning host and whether it is a sanctioned scanner.",
      "If not, isolate it and review what it reached.",
    ],
    query: `
      CommonSecurityLog
      | where ApplicationProtocol == "incomplete"
      | summarize
          Sessions = count(),
          DistinctPorts = dcount(DestinationPort),
          DistinctHosts = dcount(DestinationIP),
          Targets = array_slice(array_sort_asc(make_set(DestinationIP)), 0, 4),
          StartTime = min(TimeGenerated),
          EndTime = max(TimeGenerated)
        by SourceIP
      | where DistinctPorts > 10
    `,
    build: (row, entities) => {
      const source = str(row, "SourceIP");
      entities.ip(source);
      for (const target of set(row, "Targets")) entities.ip(target);
      return {
        displayName: `Port scan from ${source}`,
        description:
          `${source} contacted ${num(row, "DistinctPorts")} distinct ports across ` +
          `${num(row, "DistinctHosts")} host(s) without completing a session.`,
        compromisedEntity: source,
        additionalData: {
          "Distinct Ports": num(row, "DistinctPorts"),
          "Distinct Hosts": num(row, "DistinctHosts"),
          Sessions: num(row, "Sessions"),
        },
      };
    },
  },

  {
    id: "SOC-RULE-0033-KnownMaliciousDomain",
    displayName: "Known malicious domain resolved",
    description:
      "A host resolved a domain on the threat-intelligence blocklist. `avsvmcloud.com` in " +
      "particular is the SUNBURST / SolarWinds command-and-control domain.",
    severity: "High",
    tactics: ["CommandAndControl"],
    techniques: ["T1071.004"],
    remediationSteps: [
      "Isolate the resolving host pending triage.",
      "Determine which process issued the lookup and whether the connection completed.",
    ],
    query: `
      solarigate_beacon_umbrella_CL
      | extend StartTime = Timestamp, EndTime = Timestamp
      | project StartTime, EndTime, Domain, Action, InternalIp, ExternalIp, Categories_0
    `,
    build: (row, entities) => {
      const domain = str(row, "Domain");
      const internal = str(row, "InternalIp").trim();
      if (internal !== "") entities.ip(internal);
      const external = str(row, "ExternalIp").trim();
      if (external !== "") entities.ip(external);
      return {
        displayName: `Known malicious domain ${domain} resolved`,
        description: `${internal || "A host"} resolved ${domain}; the request was ${str(row, "Action")}.`,
        compromisedEntity: internal || domain,
        additionalData: {
          Domain: domain,
          Action: str(row, "Action"),
          Category: str(row, "Categories_0"),
        },
      };
    },
  },

  // ------------------------------------------------------- collaboration / AI
  {
    id: "SOC-RULE-0040-InboxRuleCreated",
    displayName: "Mailbox inbox rule created",
    description:
      "An inbox rule was created that moves or deletes incoming mail. Attackers add these " +
      "after taking over a mailbox so the owner does not see replies to fraudulent messages.",
    severity: "Medium",
    tactics: ["Persistence", "DefenseEvasion"],
    techniques: ["T1564.008"],
    remediationSteps: [
      "Review the rule's conditions and actions with the mailbox owner.",
      "Remove the rule and reset credentials if it was not created by them.",
    ],
    query: `
      office_activity_inbox_rule_CL
      | extend StartTime = ElevationTime, EndTime = ElevationTime
      | summarize
          Rules = count(),
          Clients = array_slice(array_sort_asc(make_set(ClientIP)), 0, 4),
          StartTime = min(StartTime),
          EndTime = max(EndTime)
        by UserId, Operation
    `,
    build: (row, entities) => {
      const user = str(row, "UserId");
      addUpnAccount(entities, user);
      entities.mailbox({ mailboxPrimaryAddress: user });
      return {
        displayName: `Inbox rule created for ${user}`,
        description:
          `${num(row, "Rules")} ${str(row, "Operation")} operation(s) were performed on ` +
          `${user}'s mailbox.`,
        compromisedEntity: user,
        additionalData: { Operation: str(row, "Operation"), Clients: set(row, "Clients") },
      };
    },
  },

  {
    id: "SOC-RULE-0041-ModelEvasionAttempt",
    displayName: "AI model evasion attempt detected",
    description:
      "Input designed to bypass a model's safety or classification controls was detected — " +
      "prompt injection or adversarial evasion against an AI-backed service.",
    severity: "Medium",
    tactics: ["DefenseEvasion"],
    techniques: ["T1027"],
    remediationSteps: [
      "Review the submitted input and what the model returned.",
      "Confirm whether the account is behaving anomalously elsewhere.",
    ],
    query: `
      model_evasion_detection_CL
      | extend StartTime = todatetime(logging_time), EndTime = todatetime(logging_time)
      | summarize
          Attempts = count(),
          Hosts = array_slice(array_sort_asc(make_set(host)), 0, 4),
          Addresses = array_slice(array_sort_asc(make_set(client_ip)), 0, 4),
          StartTime = min(StartTime),
          EndTime = max(EndTime)
        by account
    `,
    build: (row, entities) => {
      const account = str(row, "account");
      addUpnAccount(entities, account);
      for (const address of set(row, "Addresses")) entities.ip(address);
      return {
        displayName: `Model evasion attempts by ${account}`,
        description: `${num(row, "Attempts")} model evasion attempt(s) were submitted by ${account}.`,
        compromisedEntity: account,
        additionalData: { Attempts: num(row, "Attempts"), Hosts: set(row, "Hosts") },
      };
    },
  },

  {
    id: "SOC-RULE-0042-AnonymousSharingLinkCreated",
    displayName: "Anonymous sharing link created for a document",
    description:
      "A link requiring no authentication was created for a file in SharePoint or OneDrive. " +
      "Anyone holding the URL can retrieve the document, and the audit trail ends at the link.",
    severity: "High",
    tactics: ["Exfiltration", "Collection"],
    techniques: ["T1567", "T1213.002"],
    remediationSteps: [
      "Revoke the link and establish who received it.",
      "Review what else the account did in the same session.",
    ],
    query: `
      // Event-shaped rather than volume-shaped on purpose. This table is mostly
      // FileAccessed and PageViewed; a volume rule would fire on reading.
      OfficeActivity_CL
      | where Operation == "AnonymousLinkCreated"
      | summarize
          Links = count(),
          Files = array_slice(array_sort_asc(make_set(SourceFileName)), 0, 6),
          Objects = array_slice(array_sort_asc(make_set(OfficeObjectId)), 0, 4),
          Clients = array_slice(array_sort_asc(make_set(ClientIP)), 0, 4),
          Workloads = array_slice(array_sort_asc(make_set(OfficeWorkload)), 0, 3),
          StartTime = min(TimeGenerated),
          EndTime = max(TimeGenerated)
        by UserId
    `,
    build: (row, entities) => {
      const user = str(row, "UserId");
      const files = set(row, "Files");
      addUpnAccount(entities, user);
      for (const address of set(row, "Clients")) entities.ip(address);
      for (const name of files) entities.file({ name });
      for (const object of set(row, "Objects")) entities.url(object);
      return {
        displayName: `Anonymous sharing link created by ${user}`,
        description:
          `${user} created ${num(row, "Links")} anonymous link(s)` +
          (files.length === 0 ? "." : ` for ${files.join(", ")}.`),
        compromisedEntity: user,
        additionalData: {
          Links: num(row, "Links"),
          Files: files,
          Clients: set(row, "Clients"),
          Workloads: set(row, "Workloads"),
        },
      };
    },
  },

  // ------------------------------------------------------------------- assets
  {
    id: "SOC-RULE-0050-CriticalVulnerabilityOpen",
    displayName: "Critical vulnerability unpatched on a managed host",
    description:
      "A vulnerability rated critical remains open on a managed endpoint. Exposure context " +
      "rather than an active intrusion, but it changes how other alerts on the host are read.",
    severity: "Medium",
    tactics: ["InitialAccess"],
    techniques: ["T1190"],
    remediationSteps: [
      "Patch or mitigate the affected host.",
      "Confirm exposure to untrusted networks.",
    ],
    query: `
      CrowdStrikeVulnerabilities
      | where tolower(tostring(Status)) == "open"
      | where tolower(tostring(Cve_severity)) in ("critical", "high")
      | summarize
          Findings = count(),
          Cves = array_slice(array_sort_asc(make_set(Cve_id)), 0, 7),
          Severities = array_slice(array_sort_asc(make_set(Cve_severity)), 0, 4),
          Products = array_slice(array_sort_asc(make_set(App_product_name)), 0, 4),
          StartTime = min(TimeGenerated),
          EndTime = max(TimeGenerated)
        by HostInfo_hostname, HostInfo_os_version
    `,
    build: (row, entities) => {
      const hostName = str(row, "HostInfo_hostname");
      if (hostName !== "") entities.host({ hostName });
      const cves = set(row, "Cves");
      return {
        displayName: `${cves.length} unpatched high-severity vulnerabilit${cves.length === 1 ? "y" : "ies"} on ${hostName || "an unmanaged host"}`,
        description:
          `Open findings on ${hostName}: ${cves.join(", ")}` +
          (str(row, "HostInfo_os_version") === "" ? "." : ` (${str(row, "HostInfo_os_version")}).`),
        compromisedEntity: hostName,
        additionalData: {
          CVEs: cves,
          Severities: set(row, "Severities"),
          Products: set(row, "Products"),
        },
      };
    },
  },
];
