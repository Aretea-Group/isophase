import { z } from "zod";

/**
 * Microsoft Sentinel entity schema.
 *
 * Modelled on the documented entity types
 * (learn.microsoft.com/azure/sentinel/entities-reference). Entities are what an
 * investigation actually pivots on — a host, an account, an address — so this is
 * the part of the alert contract worth getting right.
 *
 * Two structural details are taken from the real format rather than invented:
 *
 * - The entity list is **flat**. An entity that belongs to another (the host an
 *   account lives on, the file a process ran) is a sibling in the array, linked
 *   by `$ref` to the other entity's `$id`. Nothing nests.
 * - The discriminator is the lowercase `type` string (`"account"`, `"host"`,
 *   `"mail-message"`, …), not the entity's class name.
 *
 * Field casing here is camelCase, matching the ARM representation returned by
 * `GET /alerts`. The `SecurityAlert` Kusto table stores the same entities
 * PascalCase-encoded inside a JSON *string*; converting between the two is the
 * job of the projection layer, not this contract.
 */

/** A pointer to another entity in the same array, by its `$id`. */
export const EntityReference = z.object({ $ref: z.string().min(1) });
export type EntityReference = z.infer<typeof EntityReference>;

/** Identity assigned to every entity so siblings can reference it. */
const identified = { $id: z.string().min(1) };

export const AccountEntity = z.object({
  ...identified,
  type: z.literal("account"),
  /** UPN prefix only — for `user@contoso.com` this holds `user`. */
  name: z.string().optional(),
  /** NETBIOS domain as it appears in `domain\username`. */
  ntDomain: z.string().optional(),
  dnsDomain: z.string().optional(),
  upnSuffix: z.string().optional(),
  sid: z.string().optional(),
  aadUserId: z.string().optional(),
  aadTenantId: z.string().optional(),
  isDomainJoined: z.boolean().optional(),
  /** The host this account is local to, when it is a local account. */
  host: EntityReference.optional(),
});

export const HostEntity = z.object({
  ...identified,
  type: z.literal("host"),
  /** Hostname without the domain suffix. */
  hostName: z.string().optional(),
  netBiosName: z.string().optional(),
  dnsDomain: z.string().optional(),
  ntDomain: z.string().optional(),
  azureID: z.string().optional(),
  omsAgentID: z.string().optional(),
  osFamily: z.enum(["Linux", "Windows", "Android", "IOS", "Mac"]).optional(),
  osVersion: z.string().optional(),
  isDomainJoined: z.boolean().optional(),
});

export const IpEntity = z.object({
  ...identified,
  type: z.literal("ip"),
  address: z.string().min(1),
  /** Set only for private, non-global addresses; empty for global ones. */
  addressScope: z.string().optional(),
});

export const UrlEntity = z.object({
  ...identified,
  type: z.literal("url"),
  url: z.string().min(1),
});

export const FileHashEntity = z.object({
  ...identified,
  type: z.literal("filehash"),
  algorithm: z.enum(["Unknown", "MD5", "SHA1", "SHA256", "SHA256AC"]),
  value: z.string().min(1),
});

export const FileEntity = z.object({
  ...identified,
  type: z.literal("file"),
  name: z.string().optional(),
  directory: z.string().optional(),
  sizeInBytes: z.number().int().nonnegative().optional(),
  host: EntityReference.optional(),
  fileHashes: z.array(EntityReference).optional(),
});

export const ProcessEntity = z.object({
  ...identified,
  type: z.literal("process"),
  processId: z.string().optional(),
  commandLine: z.string().optional(),
  creationTimeUtc: z.string().optional(),
  elevationToken: z
    .enum(["TokenElevationTypeDefault", "TokenElevationTypeFull", "TokenElevationTypeLimited"])
    .optional(),
  imageFile: EntityReference.optional(),
  account: EntityReference.optional(),
  parentProcess: EntityReference.optional(),
  host: EntityReference.optional(),
});

export const MalwareEntity = z.object({
  ...identified,
  type: z.literal("malware"),
  name: z.string().min(1),
  category: z.string().optional(),
  files: z.array(EntityReference).optional(),
  processes: z.array(EntityReference).optional(),
});

export const MailboxEntity = z.object({
  ...identified,
  type: z.literal("mailbox"),
  mailboxPrimaryAddress: z.string().min(1),
  displayName: z.string().optional(),
  upn: z.string().optional(),
  externalDirectoryObjectId: z.string().optional(),
});

export const MailMessageEntity = z.object({
  ...identified,
  type: z.literal("mail-message"),
  recipient: z.string().optional(),
  sender: z.string().optional(),
  senderIP: z.string().optional(),
  subject: z.string().optional(),
  receivedDate: z.string().optional(),
  internetMessageId: z.string().optional(),
  networkMessageId: z.string().optional(),
  urls: z.array(z.string()).optional(),
  threats: z.array(z.string()).optional(),
  antispamDirection: z.enum(["Unknown", "Inbound", "Outbound", "Intraorg"]).optional(),
  deliveryAction: z
    .enum(["Unknown", "DeliveredAsSpam", "Delivered", "Blocked", "Replaced"])
    .optional(),
  deliveryLocation: z
    .enum([
      "Unknown",
      "Inbox",
      "JunkFolder",
      "DeletedFolder",
      "Quarantine",
      "External",
      "Failed",
      "Dropped",
      "Forwarded",
    ])
    .optional(),
  files: z.array(EntityReference).optional(),
});

export const CloudApplicationEntity = z.object({
  ...identified,
  type: z.literal("cloud-application"),
  name: z.string().optional(),
  appId: z.number().int().optional(),
  instanceName: z.string().optional(),
});

export const AzureResourceEntity = z.object({
  ...identified,
  type: z.literal("azure-resource"),
  resourceId: z.string().min(1),
  subscriptionId: z.string().optional(),
  resourceType: z.string().optional(),
  resourceName: z.string().optional(),
});

export const SecurityGroupEntity = z.object({
  ...identified,
  type: z.literal("security-group"),
  distinguishedName: z.string().optional(),
  sid: z.string().optional(),
  objectGuid: z.string().optional(),
});

export const DnsEntity = z.object({
  ...identified,
  type: z.literal("dns"),
  domainName: z.string().min(1),
  ipAddress: z.array(EntityReference).optional(),
  dnsServerIp: EntityReference.optional(),
  hostIpAddress: EntityReference.optional(),
});

export const AlertEntity = z.discriminatedUnion("type", [
  AccountEntity,
  HostEntity,
  IpEntity,
  UrlEntity,
  FileHashEntity,
  FileEntity,
  ProcessEntity,
  MalwareEntity,
  MailboxEntity,
  MailMessageEntity,
  CloudApplicationEntity,
  AzureResourceEntity,
  SecurityGroupEntity,
  DnsEntity,
]);
export type AlertEntity = z.infer<typeof AlertEntity>;

/** Every `type` value the union accepts. */
export const ENTITY_TYPES = [
  "account",
  "host",
  "ip",
  "url",
  "filehash",
  "file",
  "process",
  "malware",
  "mailbox",
  "mail-message",
  "cloud-application",
  "azure-resource",
  "security-group",
  "dns",
] as const;

/**
 * Account names Sentinel refuses to treat as identifying on their own.
 *
 * Real behaviour, not a simplification: an Account entity defined only by `Name`
 * is **dropped from its alert** when the name is one of these, because the value
 * cannot distinguish one principal from another across hosts. Anything building
 * an account entity for these names must supply a host or domain as well.
 */
export const GENERIC_ACCOUNT_NAMES = new Set([
  "ADMIN",
  "ADMINISTRATOR",
  "SYSTEM",
  "ROOT",
  "ANONYMOUS",
  "AUTHENTICATED USER",
  "NETWORK",
  "NULL",
  "LOCAL SYSTEM",
  "LOCALSYSTEM",
  "NETWORK SERVICE",
]);
