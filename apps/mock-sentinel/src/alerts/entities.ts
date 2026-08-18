import { GENERIC_ACCOUNT_NAMES, type AlertEntity, type EntityReference } from "@soc/contracts";

/**
 * Builds Sentinel-shaped entity lists and converts them to and from the
 * PascalCase JSON the `SecurityAlert` table stores.
 *
 * The contract type (`AlertEntity`) is camelCase because that is what the ARM
 * API returns. The table stores the same entities PascalCase-encoded inside a
 * JSON string. Both are real; this module owns the translation so no other code
 * has to know there are two spellings.
 */

/**
 * camelCase → the exact casing Sentinel uses in the `Entities` JSON.
 *
 * Written out rather than derived by capitalising the first letter, because
 * several fields are initialisms Sentinel spells in full caps (`UPNSuffix`,
 * `NTDomain`, `OSFamily`) and a generic rule would silently get them wrong.
 */
const TABLE_CASING: Readonly<Record<string, string>> = {
  type: "Type",
  name: "Name",
  ntDomain: "NTDomain",
  dnsDomain: "DnsDomain",
  upnSuffix: "UPNSuffix",
  sid: "Sid",
  aadUserId: "AadUserId",
  aadTenantId: "AadTenantId",
  isDomainJoined: "IsDomainJoined",
  host: "Host",
  hostName: "HostName",
  netBiosName: "NetBiosName",
  azureID: "AzureID",
  omsAgentID: "OMSAgentID",
  osFamily: "OSFamily",
  osVersion: "OSVersion",
  address: "Address",
  addressScope: "AddressScope",
  url: "Url",
  algorithm: "Algorithm",
  value: "Value",
  directory: "Directory",
  sizeInBytes: "SizeInBytes",
  fileHashes: "FileHashes",
  processId: "ProcessId",
  commandLine: "CommandLine",
  creationTimeUtc: "CreationTimeUtc",
  elevationToken: "ElevationToken",
  imageFile: "ImageFile",
  account: "Account",
  parentProcess: "ParentProcess",
  category: "Category",
  files: "Files",
  processes: "Processes",
  mailboxPrimaryAddress: "MailboxPrimaryAddress",
  displayName: "DisplayName",
  upn: "Upn",
  externalDirectoryObjectId: "ExternalDirectoryObjectId",
  recipient: "Recipient",
  sender: "Sender",
  senderIP: "SenderIP",
  subject: "Subject",
  receivedDate: "ReceivedDate",
  internetMessageId: "InternetMessageId",
  networkMessageId: "NetworkMessageId",
  urls: "Urls",
  threats: "Threats",
  antispamDirection: "AntispamDirection",
  deliveryAction: "DeliveryAction",
  deliveryLocation: "DeliveryLocation",
  appId: "AppId",
  instanceName: "InstanceName",
  resourceId: "ResourceId",
  subscriptionId: "SubscriptionId",
  resourceType: "ResourceType",
  resourceName: "ResourceName",
  distinguishedName: "DistinguishedName",
  objectGuid: "ObjectGuid",
  domainName: "DomainName",
  ipAddress: "IpAddress",
  dnsServerIp: "DnsServerIp",
  hostIpAddress: "HostIpAddress",
};

const CONTRACT_CASING: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(TABLE_CASING).map(([camel, pascal]) => [pascal, camel]),
);

function recase(value: unknown, lookup: Readonly<Record<string, string>>): unknown {
  if (Array.isArray(value)) return value.map((item) => recase(item, lookup));
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
      // `$id` and `$ref` are structural and identical in both spellings.
      key.startsWith("$") ? key : (lookup[key] ?? key),
      recase(inner, lookup),
    ]),
  );
}

/** Serialises entities the way the `SecurityAlert` table stores them. */
export function encodeEntities(entities: readonly AlertEntity[]): string {
  return JSON.stringify(recase(entities, TABLE_CASING));
}

/**
 * Parses the table's `Entities` string back into contract shape.
 *
 * Returns `[]` for empty or malformed input rather than throwing: a single
 * unparseable alert should not take down a list request, and the row-level
 * verification in the bootstrap is where bad data is supposed to be caught.
 */
export function decodeEntities(encoded: string): unknown[] {
  if (encoded.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(encoded);
    return Array.isArray(parsed) ? (recase(parsed, CONTRACT_CASING) as unknown[]) : [];
  } catch {
    return [];
  }
}

/**
 * Accumulates the flat, `$id`-addressed entity list an alert carries.
 *
 * Sentinel does not nest entities: the account's host is a sibling in the same
 * array, referenced by `$ref`. Callers add an entity, get a reference back, and
 * hand that reference to whatever relates to it.
 */
export class EntityBag {
  private readonly entities: AlertEntity[] = [];
  private readonly byKey = new Map<string, EntityReference>();

  /**
   * Adds an entity unless an identical one is already present.
   *
   * @param entity without `$id`; one is allocated here so ids stay sequential
   *   and deterministic across bootstraps.
   * @returns a reference other entities can point at, or `undefined` when the
   *   entity was rejected (see {@link account}).
   */
  private add(entity: Omit<AlertEntity, "$id">): EntityReference {
    const key = JSON.stringify(entity);
    const existing = this.byKey.get(key);
    if (existing) return existing;

    const $id = String(this.entities.length + 1);
    this.entities.push({ ...entity, $id } as AlertEntity);
    const reference: EntityReference = { $ref: $id };
    this.byKey.set(key, reference);
    return reference;
  }

  host(fields: {
    hostName: string;
    ntDomain?: string;
    dnsDomain?: string;
    osFamily?: "Windows" | "Linux";
  }): EntityReference {
    return this.add(stripUndefined({ type: "host", ...fields }) as Omit<AlertEntity, "$id">);
  }

  /**
   * Adds an account, applying Sentinel's real rejection rule.
   *
   * An account identified only by `Name` is dropped when the name is a generic
   * built-in (`ADMINISTRATOR`, `SYSTEM`, …), because that value identifies
   * nothing on its own. Supplying a host, NT domain or UPN suffix makes it a
   * usable identifier and the entity survives.
   *
   * This matters here: the headline scenario is a brute force against
   * `\ADMINISTRATOR`, so its account entities must carry a host or they vanish
   * — exactly the constraint a real detection engineer hits.
   *
   * @returns `undefined` when the entity was dropped.
   */
  account(fields: {
    name: string;
    ntDomain?: string;
    dnsDomain?: string;
    upnSuffix?: string;
    sid?: string;
    aadUserId?: string;
    host?: EntityReference;
  }): EntityReference | undefined {
    const qualified =
      fields.host !== undefined ||
      fields.ntDomain !== undefined ||
      fields.dnsDomain !== undefined ||
      fields.upnSuffix !== undefined ||
      fields.sid !== undefined ||
      fields.aadUserId !== undefined;

    if (!qualified && GENERIC_ACCOUNT_NAMES.has(fields.name.trim().toUpperCase())) return undefined;

    return this.add(stripUndefined({ type: "account", ...fields }) as Omit<AlertEntity, "$id">);
  }

  ip(address: string, addressScope?: string): EntityReference {
    return this.add(
      stripUndefined({ type: "ip", address, addressScope }) as Omit<AlertEntity, "$id">,
    );
  }

  url(url: string): EntityReference {
    return this.add({ type: "url", url } as Omit<AlertEntity, "$id">);
  }

  fileHash(algorithm: "MD5" | "SHA1" | "SHA256", value: string): EntityReference {
    return this.add({ type: "filehash", algorithm, value } as Omit<AlertEntity, "$id">);
  }

  file(fields: {
    name: string;
    directory?: string;
    fileHashes?: EntityReference[];
  }): EntityReference {
    return this.add(stripUndefined({ type: "file", ...fields }) as Omit<AlertEntity, "$id">);
  }

  mailbox(fields: {
    mailboxPrimaryAddress: string;
    displayName?: string;
    upn?: string;
  }): EntityReference {
    return this.add(stripUndefined({ type: "mailbox", ...fields }) as Omit<AlertEntity, "$id">);
  }

  mailMessage(fields: {
    sender?: string;
    recipient?: string;
    senderIP?: string;
    subject?: string;
    internetMessageId?: string;
    urls?: string[];
    files?: EntityReference[];
    deliveryAction?: "Unknown" | "DeliveredAsSpam" | "Delivered" | "Blocked" | "Replaced";
  }): EntityReference {
    return this.add(
      stripUndefined({ type: "mail-message", ...fields }) as Omit<AlertEntity, "$id">,
    );
  }

  process(fields: {
    commandLine?: string;
    processId?: string;
    creationTimeUtc?: string;
    imageFile?: EntityReference;
    account?: EntityReference;
    host?: EntityReference;
  }): EntityReference {
    return this.add(stripUndefined({ type: "process", ...fields }) as Omit<AlertEntity, "$id">);
  }

  cloudApplication(fields: { name: string; instanceName?: string }): EntityReference {
    return this.add(
      stripUndefined({ type: "cloud-application", ...fields }) as Omit<AlertEntity, "$id">,
    );
  }

  azureResource(resourceId: string): EntityReference {
    return this.add({ type: "azure-resource", resourceId } as Omit<AlertEntity, "$id">);
  }

  toArray(): AlertEntity[] {
    return [...this.entities];
  }

  get size(): number {
    return this.entities.length;
  }
}

/** Drops undefined keys so they never reach the serialised JSON. */
function stripUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}
