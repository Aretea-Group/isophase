import type { TokenCredential } from "@azure/identity";
import {
  AlertEntity,
  AlertSeverity,
  AlertStatus,
  AttackTactic,
  ConfidenceLevel,
  QueryResponse,
  QueryTable,
  SchemaResponse,
  SecurityAlertResource,
  type CorpusIdentity,
  type SecurityAlertResource as SecurityAlert,
} from "@soc/contracts";
import { z } from "zod";

import type { SentinelClient } from "./client.ts";
import { SentinelApiError, type SentinelApiErrorCode } from "./errors.ts";

const LOGS_ENDPOINT = "https://api.loganalytics.azure.com";
const LOGS_SCOPE = "https://api.loganalytics.io/.default";
const QUERY_MAX_ROWS = 500;
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const ERROR_BODY_MAX_BYTES = 32 * 1024;

const ErrorInfo = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z
    .array(z.object({ code: z.string().optional(), message: z.string().min(1) }))
    .optional(),
});

const ErrorResponse = z.object({ error: ErrorInfo });

const AzureQueryResponse = z.object({
  tables: z.array(QueryTable),
  error: ErrorInfo.optional(),
});

const MetadataResponse = z.object({
  tables: z.array(
    z.object({
      name: z.string().min(1),
      columns: z.array(z.object({ name: z.string().min(1), type: z.string().min(1) })),
    }),
  ),
  workspaces: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      resourceId: z.string().min(1),
    }),
  ),
});

type Metadata = z.infer<typeof MetadataResponse>;

export interface AzureSentinelClientOptions {
  credential: TokenCredential;
  workspaceId: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

const ALERT_COLUMNS = [
  "SystemAlertId",
  "TimeGenerated",
  "DisplayName",
  "AlertName",
  "AlertSeverity",
  "Description",
  "Status",
  "AlertType",
  "VendorOriginalId",
  "VendorName",
  "ProductName",
  "ProductComponentName",
  "ProviderName",
  "Tactics",
  "Techniques",
  "SubTechniques",
  "StartTime",
  "EndTime",
  "ProcessingEndTime",
  "ConfidenceLevel",
  "ConfidenceScore",
  "CompromisedEntity",
  "RemediationSteps",
  "AlertLink",
  "ExtendedProperties",
  "Entities",
] as const;

const ALERT_PROJECTION = ALERT_COLUMNS.join(", ");

/** Non-secret Azure Monitor target recorded in run artifacts. */
export function azureWorkspaceUrl(workspaceId: string): string {
  return `${LOGS_ENDPOINT}/v1/workspaces/${encodeURIComponent(workspaceId)}`;
}

function isControlCommand(query: string): boolean {
  const firstStatement = query
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "" && !line.startsWith("//"));

  return firstStatement?.startsWith(".") ?? false;
}

function kqlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function diagnostic(error: z.infer<typeof ErrorInfo>): string {
  const details = error.details?.map((detail) => detail.message).filter(Boolean) ?? [];
  return [error.message, ...details].join("; ");
}

async function boundedErrorText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";

  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < ERROR_BODY_MAX_BYTES) {
      // eslint-disable-next-line no-await-in-loop -- a response body stream must be read in order
      const { done, value } = await reader.read();
      if (done) break;
      const kept = value.subarray(0, ERROR_BODY_MAX_BYTES - size);
      chunks.push(kept);
      size += kept.length;
      if (kept.length < value.length || size === ERROR_BODY_MAX_BYTES) {
        void reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

function recaseEntity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(recaseEntity);
  if (value === null || typeof value !== "object") return value;

  const exceptions: Readonly<Record<string, string>> = {
    NTDomain: "ntDomain",
    UPNSuffix: "upnSuffix",
    OMSAgentID: "omsAgentID",
    OSFamily: "osFamily",
    OSVersion: "osVersion",
  };

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, inner]) => {
      const first = key[0];
      const recased =
        key.startsWith("$") || first === undefined
          ? key
          : (exceptions[key] ?? first.toLowerCase() + key.slice(1));
      return [recased, recaseEntity(inner)];
    }),
  );
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.trim() === "") return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function entities(value: unknown): z.infer<typeof AlertEntity>[] {
  const parsed = jsonValue(value);
  if (!Array.isArray(parsed)) return [];

  return parsed.flatMap((candidate) => {
    const entity = AlertEntity.safeParse(recaseEntity(candidate));
    return entity.success ? [entity.data] : [];
  });
}

function text(row: Readonly<Record<string, unknown>>, column: string): string {
  const value = row[column];
  return value === null || value === undefined ? "" : String(value);
}

function iso(value: string): string | undefined {
  if (value === "") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return String(value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

function projectAlert(
  row: Readonly<Record<string, unknown>>,
  workspaceResourceId: string,
): SecurityAlert {
  const systemAlertId = text(row, "SystemAlertId");
  const timeGenerated = iso(text(row, "TimeGenerated")) ?? new Date(0).toISOString();
  const confidenceScore = Number(text(row, "ConfidenceScore"));
  const remediation = z.array(z.string()).safeParse(jsonValue(row["RemediationSteps"]));
  const extras = z.record(z.string(), z.unknown()).safeParse(jsonValue(row["ExtendedProperties"]));

  const severity = AlertSeverity.safeParse(row["AlertSeverity"]);
  const status = AlertStatus.safeParse(row["Status"]);
  const confidence = ConfidenceLevel.safeParse(row["ConfidenceLevel"]);
  const tactics = stringList(row["Tactics"]).flatMap((value) => {
    const tactic = AttackTactic.safeParse(value);
    return tactic.success ? [tactic.data] : [];
  });

  return SecurityAlertResource.parse({
    id: `${workspaceResourceId}/providers/Microsoft.SecurityInsights/Entities/${systemAlertId}`,
    name: systemAlertId,
    type: "Microsoft.SecurityInsights/Entities",
    kind: "SecurityAlert",
    properties: {
      systemAlertId,
      alertDisplayName: text(row, "DisplayName") || text(row, "AlertName"),
      description: text(row, "Description"),
      severity: severity.success ? severity.data : "Informational",
      status: status.success ? status.data : "Unknown",
      alertType: text(row, "AlertType") || "Unknown",
      vendorOriginalId: text(row, "VendorOriginalId") || undefined,
      vendorName: text(row, "VendorName") || "Unknown",
      productName: text(row, "ProductName") || "Unknown",
      productComponentName: text(row, "ProductComponentName") || undefined,
      providerName: text(row, "ProviderName") || "Unknown",
      tactics,
      techniques: [
        ...new Set([...stringList(row["Techniques"]), ...stringList(row["SubTechniques"])]),
      ],
      startTimeUtc: iso(text(row, "StartTime")) ?? timeGenerated,
      endTimeUtc: iso(text(row, "EndTime")) ?? timeGenerated,
      timeGenerated,
      processingEndTime: iso(text(row, "ProcessingEndTime")) ?? timeGenerated,
      confidenceLevel: confidence.success ? confidence.data : "Unknown",
      confidenceScore:
        Number.isFinite(confidenceScore) && confidenceScore > 0 ? confidenceScore : undefined,
      compromisedEntity: text(row, "CompromisedEntity") || undefined,
      remediationSteps: remediation.success ? remediation.data : [],
      alertLink: text(row, "AlertLink") || undefined,
      additionalData: extras.success ? extras.data : {},
      entities: entities(row["Entities"]),
    },
  });
}

function namedRows(table: z.infer<typeof QueryTable>): Record<string, unknown>[] {
  return table.rows.map((row) =>
    Object.fromEntries(table.columns.map((column, index) => [column.name, row[index]])),
  );
}

export class AzureSentinelClient implements SentinelClient {
  readonly #credential: TokenCredential;
  readonly #workspaceId: string;
  readonly #timeoutMs: number;

  #token: { value: string; expiresAt: number } | undefined;
  #tokenRequest: Promise<string> | undefined;
  #metadata: Metadata | undefined;
  #metadataRequest: Promise<Metadata> | undefined;

  constructor(options: AzureSentinelClientOptions) {
    this.#credential = options.credential;
    this.#workspaceId = options.workspaceId;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async listAlerts(top?: number): Promise<SecurityAlert[]> {
    if (top !== undefined && (!Number.isInteger(top) || top < 1 || top > QUERY_MAX_ROWS)) {
      throw new SentinelApiError(
        "bad_request",
        400,
        `top must be an integer from 1 to ${QUERY_MAX_ROWS}.`,
      );
    }

    const requested = top ?? QUERY_MAX_ROWS + 1;
    const result = await this.query(
      `SecurityAlert\n| order by TimeGenerated desc\n| take ${requested}\n| project ${ALERT_PROJECTION}`,
    );
    if (top === undefined && result.truncation.truncated) {
      throw new SentinelApiError(
        "bad_request",
        400,
        `Workspace has more than ${QUERY_MAX_ROWS} alerts. Select one alert by id or request a bounded list.`,
      );
    }

    const metadata = await this.#getMetadata();
    const table = result.tables[0];
    if (table === undefined) return [];
    return namedRows(table).map((row) => projectAlert(row, this.#workspace(metadata).resourceId));
  }

  async getAlert(id: string): Promise<SecurityAlert> {
    const result = await this.query(
      `SecurityAlert\n| where SystemAlertId == ${kqlString(id)}\n| take 1\n| project ${ALERT_PROJECTION}`,
    );
    const row = result.tables[0] === undefined ? undefined : namedRows(result.tables[0])[0];
    if (row === undefined) {
      throw new SentinelApiError("not_found", 404, `No alert with id ${id}`);
    }

    const metadata = await this.#getMetadata();
    return projectAlert(row, this.#workspace(metadata).resourceId);
  }

  async getSchema(): Promise<SchemaResponse> {
    const metadata = await this.#getMetadata();
    const workspace = this.#workspace(metadata);
    return SchemaResponse.parse({
      database: workspace.name,
      tables: metadata.tables.map((table) => ({
        name: table.name,
        columns: table.columns.map((column) => ({ name: column.name, type: column.type })),
      })),
    });
  }

  async query(kql: string, timespan?: string): Promise<QueryResponse> {
    if (isControlCommand(kql)) {
      throw new SentinelApiError(
        "query_error",
        400,
        "Control commands are not permitted. Azure Sentinel queries must be read-only KQL.",
      );
    }

    const body =
      timespan === undefined
        ? { query: `${kql}\n| take 501` }
        : { query: `${kql}\n| take 501`, timespan };
    const payload = await this.#authenticatedRequest(
      "POST",
      `${azureWorkspaceUrl(this.#workspaceId)}/query`,
      body,
      "query",
    );
    const parsed = AzureQueryResponse.safeParse(payload);
    if (!parsed.success) {
      throw new SentinelApiError(
        "unreachable",
        200,
        "Azure Monitor returned an invalid query response.",
      );
    }
    if (parsed.data.error !== undefined) {
      throw new SentinelApiError("query_error", 200, diagnostic(parsed.data.error));
    }

    const primary = parsed.data.tables[0];
    const truncated = (primary?.rows.length ?? 0) > QUERY_MAX_ROWS;
    const tables = parsed.data.tables.map((table, index) => ({
      name: table.name,
      columns: table.columns,
      rows: index === 0 && truncated ? table.rows.slice(0, QUERY_MAX_ROWS) : table.rows,
    }));
    const returnedRows = tables[0]?.rows.length ?? 0;

    return QueryResponse.parse({
      tables,
      truncation: { truncated, returnedRows, maxRows: QUERY_MAX_ROWS },
    });
  }

  async getCorpus(): Promise<CorpusIdentity | undefined> {
    return undefined;
  }

  #workspace(metadata: Metadata): Metadata["workspaces"][number] {
    const workspace = metadata.workspaces.find(
      (candidate) => candidate.id.toLowerCase() === this.#workspaceId.toLowerCase(),
    );
    if (workspace === undefined) {
      throw new SentinelApiError(
        "authorization_error",
        403,
        `Azure Monitor metadata did not include workspace ${this.#workspaceId}.`,
      );
    }
    return workspace;
  }

  async #getMetadata(): Promise<Metadata> {
    if (this.#metadata !== undefined) return this.#metadata;
    if (this.#metadataRequest !== undefined) return this.#metadataRequest;

    const request = (async (): Promise<Metadata> => {
      const payload = await this.#authenticatedRequest(
        "GET",
        `${azureWorkspaceUrl(this.#workspaceId)}/metadata`,
        undefined,
        "metadata",
      );
      const parsed = MetadataResponse.safeParse(payload);
      if (!parsed.success) {
        throw new SentinelApiError(
          "unreachable",
          200,
          "Azure Monitor returned invalid workspace metadata.",
        );
      }
      this.#metadata = parsed.data;
      return parsed.data;
    })();
    this.#metadataRequest = request;

    try {
      return await request;
    } finally {
      if (this.#metadataRequest === request) this.#metadataRequest = undefined;
    }
  }

  async #accessToken(): Promise<string> {
    if (this.#token !== undefined && Date.now() < this.#token.expiresAt - TOKEN_EXPIRY_SKEW_MS) {
      return this.#token.value;
    }
    if (this.#tokenRequest !== undefined) return this.#tokenRequest;

    const request = this.#acquireToken();
    this.#tokenRequest = request;
    try {
      return await request;
    } finally {
      if (this.#tokenRequest === request) this.#tokenRequest = undefined;
    }
  }

  async #acquireToken(): Promise<string> {
    let token;
    try {
      token = await this.#credential.getToken(LOGS_SCOPE, {
        abortSignal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new SentinelApiError(
        "authentication_error",
        0,
        "Azure Identity could not acquire a Log Analytics token. Check the configured service principal or sign in with Azure CLI or Azure PowerShell.",
      );
    }
    if (
      token === null ||
      token.token.trim() === "" ||
      !Number.isFinite(token.expiresOnTimestamp) ||
      token.expiresOnTimestamp <= Date.now()
    ) {
      throw new SentinelApiError(
        "authentication_error",
        0,
        "Azure Identity returned an invalid Log Analytics token.",
      );
    }

    this.#token = {
      value: token.token,
      expiresAt: token.expiresOnTimestamp,
    };
    return token.token;
  }

  async #authenticatedRequest(
    method: "GET" | "POST",
    url: string,
    body: unknown,
    purpose: "metadata" | "query",
  ): Promise<unknown> {
    const token = await this.#accessToken();
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    };
    const init: RequestInit = { headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return this.#request(method, url, init, purpose, token);
  }

  async #request(
    method: "GET" | "POST",
    url: string,
    init: RequestInit,
    purpose: "metadata" | "query",
    token?: string,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        method,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new SentinelApiError(
        "unreachable",
        0,
        this.#sanitize(`${method} ${url} failed: ${reason}`, token),
      );
    }

    const body = response.ok ? await response.text() : await boundedErrorText(response);
    let payload: unknown;
    try {
      payload = body === "" ? undefined : JSON.parse(body);
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      const oneApi = ErrorResponse.safeParse(payload);
      const message = oneApi.success
        ? diagnostic(oneApi.data.error)
        : `${method} ${url} returned ${response.status} ${response.statusText}`.trim();
      throw new SentinelApiError(
        this.#errorCode(response.status, purpose),
        response.status,
        this.#sanitize(message, token),
      );
    }

    return payload;
  }

  #errorCode(status: number, purpose: "metadata" | "query"): SentinelApiErrorCode {
    if (status === 401) return "authentication_error";
    if (status === 403) return "authorization_error";
    if (status === 429) return "rate_limited";
    if (status >= 500) return "upstream_unavailable";
    if (purpose === "query") return "query_error";
    return "bad_request";
  }

  #sanitize(message: string, token?: string): string {
    return [token]
      .filter((value): value is string => value !== undefined && value !== "")
      .reduce((safe, value) => safe.replaceAll(value, "[redacted]"), message);
  }
}
