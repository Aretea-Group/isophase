import type { TokenCredential } from "@azure/identity";
import {
  INCIDENT_COMMENT_MAX_CHARS,
  QueryResponse,
  QueryTable,
  SecurityAlert,
  SecuritySchema,
  type CorpusIdentity,
} from "@soc/contracts";
import { z } from "zod";

import type { SecurityDataSource } from "./client.ts";
import { SentinelApiError, type SentinelApiErrorCode } from "./errors.ts";
import {
  findingsMarker,
  type FindingsPublisher,
  type PublishOutcome,
  type PublishTarget,
} from "./publisher.ts";
import { applyRowCap, isControlCommand, withRowCap } from "./query-text.ts";

/**
 * Microsoft Defender XDR through the Microsoft Graph security API (PRD-8, ADR 011).
 *
 * One data plane, one host, one token audience: alerts from `GET /security/alerts_v2`, telemetry
 * from `POST /security/runHuntingQuery`. The legacy Defender for Endpoint APIs at
 * `api.securitycenter.microsoft.com` are excluded — they reach endpoint telemetry only, where
 * advanced hunting reaches identity, email and cloud-app tables through the same query language and
 * the same token.
 *
 * Every design choice below that could have been guessed was instead measured against a real tenant
 * by `scripts/probe-defender.ts` before this file existed (PRD-8 §4.1 D12). Where the measurement
 * contradicted the expectation, the comment says so.
 */

const GRAPH = "https://graph.microsoft.com/v1.0";
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_DEFENDER_QUERY_MAX_ROWS = 500;
const DEFAULT_ALERT_WINDOW = "P7D";
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const ERROR_BODY_MAX_BYTES = 32 * 1024;

/**
 * More than this many alerts in the window is refused rather than truncated (PRD-8 §4.1 D14).
 *
 * `alerts_v2` supports no `$orderby` — the probe confirmed the parameter is accepted and the
 * documented parameter list still omits it — so "the first 500" is an arbitrary 500 rather than the
 * most recent. A queue whose contents depend on unspecified server ordering changes underneath the
 * operator and reads as agent regression, so the window is the selection criterion and the cap is
 * a refusal.
 */
/**
 * The most alerts one `alerts_v2` page will return.
 *
 * Exported since PRD-9: the watch loop needs it to recognise truncation — receiving exactly the cap
 * means the window holds more than one cycle can see, and the alerts beyond it are invisible rather
 * than queued (§4.1 D10).
 */
export const ALERT_LIST_CAP = 500;

/**
 * Without this header twenty-one evolvable enum members collapse to `unknownFutureValue`, including
 * `microsoftSentinel` itself and every Sentinel rule kind. `serviceSource` is the only filterable
 * field that says where an alert came from, so omitting it would erase the distinction PRD-8 exists
 * to make.
 */
const PREFER_UNKNOWN_ENUMS = "include-unknown-enum-members";

/**
 * The advanced-hunting tables a tenant may hold.
 *
 * A candidate list rather than an enumeration, and that is not a shortcut: Graph exposes no
 * metadata endpoint, no special table and no enumeration query for advanced hunting, so every
 * discovery mechanism starts from a list somebody wrote down. What the schema call below
 * establishes is which of these *this* tenant actually holds, which is a function of its licences.
 *
 * Adding a table here is how a newly licensed workload becomes visible to the agent. Removing one
 * costs nothing at runtime — an absent table is absorbed rather than an error.
 */
const ADVANCED_HUNTING_TABLES = [
  "AlertEvidence",
  "AlertInfo",
  "AADSignInEventsBeta",
  "AADSpnSignInEventsBeta",
  "CloudAppEvents",
  "CloudAuditEvents",
  "IdentityDirectoryEvents",
  "IdentityInfo",
  "IdentityLogonEvents",
  "IdentityQueryEvents",
  "OAuthAppInfo",
  "DeviceEvents",
  "DeviceFileCertificateInfo",
  "DeviceFileEvents",
  "DeviceImageLoadEvents",
  "DeviceInfo",
  "DeviceLogonEvents",
  "DeviceNetworkEvents",
  "DeviceNetworkInfo",
  "DeviceProcessEvents",
  "DeviceRegistryEvents",
  "EmailAttachmentInfo",
  "EmailEvents",
  "EmailPostDeliveryEvents",
  "EmailUrlInfo",
  "UrlClickEvents",
  "DeviceTvmBrowserExtensions",
  "DeviceTvmBrowserExtensionsKB",
  "DeviceTvmCertificateInfo",
  "DeviceTvmHardwareFirmware",
  "DeviceTvmInfoGathering",
  "DeviceTvmInfoGatheringKB",
  "DeviceTvmSecureConfigurationAssessment",
  "DeviceTvmSecureConfigurationAssessmentKB",
  "DeviceTvmSoftwareInventory",
  "DeviceTvmSoftwareVulnerabilities",
  "DeviceTvmSoftwareVulnerabilitiesKB",
  "BehaviorEntities",
  "BehaviorInfo",
  "ExposureGraphEdges",
  "ExposureGraphNodes",
] as const;

/**
 * One call for the whole schema, and the probe is why this is a batched union rather than a loop.
 *
 * PRD-8 §4.2 listed four discovery mechanisms and expected the fourth — a vendored, pinned manifest
 * — because neither `getschema` nor `union isfuzzy=true` appears anywhere in the advanced-hunting
 * documentation set, and an unresolved table is a hard `400`. Both work, and they compose: the
 * probe sent this exact query shape with all candidate legs and got 366 column rows across 18
 * tables back in a single request, 3,311 characters of query text, without hitting the documented
 * "Query size exceeded" limit. `isfuzzy=true` absorbs the legs whose tables the tenant does not
 * hold, so the licence-dependent table set needs no configuration.
 *
 * The alternative — one `getschema` per candidate — would pay forty calls against a documented
 * floor of 45 per minute on every process start.
 */
function schemaQuery(tables: readonly string[]): string {
  const legs = tables
    .map((table) => `(${table} | getschema | extend SourceTable = "${table}")`)
    .join(", ");
  return `union isfuzzy=true ${legs} | project SourceTable, ColumnName, ColumnType, ColumnOrdinal`;
}

/**
 * The Graph error envelope, tolerating both spellings of the nested member.
 *
 * Microsoft's own page disagrees with itself — the JSON representation block says `innererror`,
 * every concrete example says `innerError` — so a parser that picks one is wrong half the time.
 * Only `innerError` was observed against the tenant; the tolerance stays because one run is not a
 * contract and the documentation uses the other spelling.
 */
/**
 * The Graph error envelope, tolerating both spellings of the nested member and requiring nothing
 * of it.
 *
 * Microsoft's own page disagrees with itself on the spelling — the JSON representation block says
 * `innererror`, every concrete example says `innerError` — so a parser that picks one is wrong half
 * the time. Only `innerError` was observed against the tenant; the tolerance stays because the
 * documentation uses the other spelling and one run is not a contract.
 *
 * **Nothing in the nested member is required**, and that is not defensiveness. Every `400` the
 * probe collected carried an `innerError` of exactly `{ date, request-id, client-request-id }` —
 * no `code`, no `message`. A schema demanding either would fail to parse every real rejection, and
 * the connector would fall back to "POST … returned 400 Bad Request" while the Kusto engine's own
 * diagnostic sat unread in the body. That would defeat ADR 010 §3's "preserve actionable query
 * errors" precisely where it earns its keep: the message naming the column the model got wrong.
 */
const GraphInnerError = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
});

const GraphErrorInfo = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z
    .array(z.object({ code: z.string().optional(), message: z.string().min(1) }))
    .optional(),
  innererror: GraphInnerError.optional(),
  innerError: GraphInnerError.optional(),
});

const GraphErrorResponse = z.object({ error: GraphErrorInfo });

/**
 * `runHuntingQuery`'s result: objects keyed by column name, where Log Analytics returns positional
 * arrays. The `schema` array carries lowercase `name`/`type` keys with the column's own casing in
 * the value.
 */
const HuntingQueryResults = z.object({
  schema: z.array(z.object({ name: z.string().min(1), type: z.string() })),
  results: z.array(z.record(z.string(), z.unknown())),
});

const AlertListResponse = z.object({
  value: z.array(z.record(z.string(), z.unknown())),
  "@odata.count": z.number().optional(),
});

/**
 * Only the fields the common envelope maps. Everything else on the alert reaches the model through
 * `native`, so widening this schema would add validation without adding evidence.
 */
const GraphAlert = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullish(),
  severity: z.string().nullish(),
  status: z.string().nullish(),
  firstActivityDateTime: z.string().nullish(),
  lastActivityDateTime: z.string().nullish(),
  createdDateTime: z.string().nullish(),
  categories: z.array(z.string()).nullish(),
  mitreTechniques: z.array(z.string()).nullish(),
  evidence: z.array(z.json()).nullish(),
  /** The incident this alert belongs to. Surfaced as the source-neutral `caseId` (ADR 012 §6). */
  incidentId: z.string().nullish(),
});

export interface DefenderClientOptions {
  credential: TokenCredential;
  /** Optional. Targets one Log Analytics workspace onboarded into the Defender portal. */
  workspaceId?: string;
  timeoutMs?: number;
  /** Row cap pushed into the query text. `take` and `truncation` both derive from it (D15). */
  queryMaxRows?: number;
  /** ISO 8601 duration bounding `listAlerts()` (D14). */
  alertWindow?: string;
}

/** Non-secret Graph target recorded in run artifacts. Carries no tenant identifier. */
export function defenderGraphUrl(): string {
  return `${GRAPH}/security`;
}

/**
 * Milliseconds in an ISO 8601 duration, for the days/hours/minutes subset this connector accepts.
 *
 * Deliberately not a general parser. `DEFENDER_ALERT_WINDOW` bounds an alert queue; months and
 * years are not durations anybody should be setting here, and a wrong answer would silently change
 * which alerts an operator sees.
 */
export function alertWindowMs(duration: string): number {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(duration);
  if (match === null) {
    throw new Error(
      `DEFENDER_ALERT_WINDOW must be an ISO 8601 duration of days, hours or minutes such as P7D or PT12H; got "${duration}".`,
    );
  }
  const total =
    ((Number(match[1] ?? 0) * 24 + Number(match[2] ?? 0)) * 60 + Number(match[3] ?? 0)) * 60_000;
  if (total <= 0) {
    throw new Error(`DEFENDER_ALERT_WINDOW must be a positive duration; got "${duration}".`);
  }
  return total;
}

function diagnostic(error: z.infer<typeof GraphErrorInfo>): string {
  const details = error.details?.map((detail) => detail.message).filter(Boolean) ?? [];
  // The nested member is correlation metadata on every rejection the probe saw — a date and two
  // request ids. It is appended only when it carries something a person could act on, so the
  // engine's diagnostic is not diluted with a request id in the string the model reads.
  const nested = error.innerError ?? error.innererror;
  const nestedMessage = nested?.message;
  return [error.message, ...details, ...(nestedMessage === undefined ? [] : [nestedMessage])].join(
    "; ",
  );
}

function iso(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * Graph's `alert` into ADR 010 §2's envelope.
 *
 * Values stay source-native strings; nothing is translated into a cross-product taxonomy.
 *
 * Two absences are deliberate rather than unfinished. `compromisedEntity` has no Graph equivalent
 * and is left undefined rather than derived from `evidence`. **`alertType` is left undefined too**:
 * PRD-8 §4.2 proposed `detectorId` on the elimination argument — every other candidate is
 * per-instance, per-product or per-sensor — but required it be confirmed against real alerts or
 * left unset, and the probe could not confirm it. The tenant holds one alert, so every
 * (title, detectionSource) group was a singleton and "constant within its group" was a tautology
 * rather than a measurement. One line changes this once evidence exists.
 *
 * `native` carries the whole alert, `incidentId` and `incidentWebUrl` included. The agent cannot
 * enumerate an incident's other alerts, but it can see that an alert belongs to one — that costs
 * nothing and stripping it to honour the incidents non-goal would remove evidence for free.
 */
function projectAlert(raw: Record<string, unknown>): SecurityAlert {
  const alert = GraphAlert.parse(raw);
  const severity = alert.severity ?? undefined;
  const status = alert.status ?? undefined;
  const startTimeUtc = iso(alert.firstActivityDateTime);
  const endTimeUtc = iso(alert.lastActivityDateTime);
  const timeGenerated = iso(alert.createdDateTime);

  const caseId = alert.incidentId ?? undefined;

  return SecurityAlert.parse({
    id: alert.id,
    title: alert.title,
    description: alert.description ?? "",
    // The incident this alert sits in, surfaced as the source-neutral `caseId` so the publisher can
    // address it without reading `native` (ADR 012 §6).
    ...(caseId === undefined ? {} : { caseId }),
    ...(severity === undefined ? {} : { severity }),
    ...(status === undefined ? {} : { status }),
    ...(startTimeUtc === undefined ? {} : { startTimeUtc }),
    ...(endTimeUtc === undefined ? {} : { endTimeUtc }),
    ...(timeGenerated === undefined ? {} : { timeGenerated }),
    // Graph has no `tactics`; `categories` are the kill-chain categories. An empty array is
    // correct here and must not be filled from another field.
    tactics: alert.categories ?? [],
    techniques: alert.mitreTechniques ?? [],
    entities: alert.evidence ?? [],
    native: raw,
  });
}

export class DefenderClient implements SecurityDataSource, FindingsPublisher {
  /**
   * Names this publisher in the run artifact (PRD-9 §4.2).
   *
   * The connector is both the read source and the write target because writing to Defender is the
   * Defender connector's job, and because `#request` already owns the cached token, the timeout and
   * the error mapping — a parallel publisher class would duplicate all three and acquire a second
   * token per run. The seam stays explicit at the caller: `executeRun` takes a publisher in
   * `deps.publisher`, separately from the source (ADR 012 §7).
   */
  readonly id = "defender-graph";

  /** Measured: `POST .../incidents/{id}/comments` rejects 2,913 characters (ADR 012 §8). */
  readonly maxBodyChars = INCIDENT_COMMENT_MAX_CHARS;

  readonly #credential: TokenCredential;
  readonly #workspaceId: string | undefined;
  readonly #timeoutMs: number;
  readonly #queryMaxRows: number;
  readonly #alertWindow: string;

  #token: { value: string; expiresAt: number } | undefined;
  #tokenRequest: Promise<string> | undefined;

  constructor(options: DefenderClientOptions) {
    this.#credential = options.credential;
    this.#workspaceId = options.workspaceId;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#queryMaxRows = options.queryMaxRows ?? DEFAULT_DEFENDER_QUERY_MAX_ROWS;
    this.#alertWindow = options.alertWindow ?? DEFAULT_ALERT_WINDOW;
    // Validated in the constructor rather than on first use: a malformed window should stop the
    // process at startup, not forty investigations into a sweep.
    alertWindowMs(this.#alertWindow);
  }

  /** The window this client draws alerts from, recorded on the run artifact (D14). */
  get alertWindow(): string {
    return this.#alertWindow;
  }

  /**
   * Alerts created inside the configured window, bounded and never silently truncated.
   *
   * `createdDateTime` is one of the eight filterable properties and one of only two that bound
   * recency, which is what makes the window expressible at all. The request asks for one alert
   * beyond the cap so exceeding it is detectable rather than ambiguous.
   */
  async listAlerts(limit?: number): Promise<SecurityAlert[]> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > ALERT_LIST_CAP)) {
      throw new SentinelApiError(
        "bad_request",
        400,
        `limit must be an integer from 1 to ${ALERT_LIST_CAP}.`,
      );
    }

    const since = new Date(Date.now() - alertWindowMs(this.#alertWindow)).toISOString();
    const top = limit ?? ALERT_LIST_CAP + 1;
    const query = [
      `$filter=${encodeURIComponent(`createdDateTime ge ${since}`)}`,
      `$top=${top}`,
      "$count=true",
    ].join("&");

    const payload = await this.#request("GET", `${GRAPH}/security/alerts_v2?${query}`, {
      purpose: "alerts",
    });
    const parsed = AlertListResponse.safeParse(payload);
    if (!parsed.success) {
      throw new SentinelApiError(
        "unreachable",
        200,
        "Microsoft Graph returned an invalid alerts_v2 response.",
      );
    }

    const total = parsed.data["@odata.count"] ?? parsed.data.value.length;
    if (limit === undefined && total > ALERT_LIST_CAP) {
      throw new SentinelApiError(
        "bad_request",
        400,
        `Defender returned more than ${ALERT_LIST_CAP} alerts created in the last ${this.#alertWindow} (${total} in the window). ` +
          "Narrow DEFENDER_ALERT_WINDOW or select one alert by id.",
      );
    }

    return parsed.data.value.map(projectAlert);
  }

  async getAlert(id: string): Promise<SecurityAlert> {
    const payload = await this.#request(
      "GET",
      `${GRAPH}/security/alerts_v2/${encodeURIComponent(id)}`,
      { purpose: "alerts" },
    );
    const record = payload as Record<string, unknown> | undefined;
    if (record === undefined || typeof record !== "object") {
      throw new SentinelApiError("not_found", 404, `No Defender alert with id ${id}`);
    }
    return projectAlert(record);
  }

  /**
   * The tenant's advanced-hunting tables and their columns, in one request.
   *
   * Column order comes from `ColumnOrdinal`, which `getschema` reports, and not from the order rows
   * happen to arrive in — `union` gives no ordering guarantee across its legs.
   */
  async getSchema(): Promise<SecuritySchema> {
    const results = await this.#hunt(schemaQuery(ADVANCED_HUNTING_TABLES));

    const byTable = new Map<string, { name: string; type: string; ordinal: number }[]>();
    for (const row of results.results) {
      const table = row["SourceTable"];
      const name = row["ColumnName"];
      if (typeof table !== "string" || typeof name !== "string") continue;
      const columns = byTable.get(table) ?? [];
      const rawOrdinal = row["ColumnOrdinal"];
      columns.push({
        name,
        type: typeof row["ColumnType"] === "string" ? row["ColumnType"] : "",
        ordinal: typeof rawOrdinal === "number" ? rawOrdinal : columns.length,
      });
      byTable.set(table, columns);
    }

    return SecuritySchema.parse({
      tables: [...byTable.entries()]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([name, columns]) => ({
          name,
          columns: columns
            .toSorted((a, b) => a.ordinal - b.ordinal)
            .map((column) => ({ name: column.name, type: column.type || "unknown" })),
        })),
    });
  }

  /**
   * Read-only KQL against advanced hunting, returned as ADR 010 §3's positional tabular result.
   *
   * Nothing here repairs the query, selects evidence, summarises results or translates values.
   */
  async query(query: string): Promise<QueryResponse> {
    if (isControlCommand(query)) {
      throw new SentinelApiError(
        "query_error",
        400,
        "Control commands are not permitted. Defender advanced hunting queries must be read-only KQL.",
      );
    }

    const results = await this.#hunt(withRowCap(query, this.#queryMaxRows));
    const columns = results.schema.map((column) => ({ name: column.name, type: column.type }));

    // D4: object-keyed results project to positional rows through `schema` order, emitting `null`
    // for a key the object lacks rather than dropping or reordering a column. Order comes from
    // `schema` and from nothing else — never from `Object.keys()` of the first row, which the probe
    // showed carries OData annotation keys (`Column@odata.type`) that `schema` never names, so a
    // projection built from row keys would emit phantom columns as well as depending on which row
    // came back first.
    const rows = results.results.map((row) =>
      results.schema.map((column) => row[column.name] ?? null),
    );

    const table = QueryTable.parse({ name: "PrimaryResult", columns, rows });
    return QueryResponse.parse(applyRowCap([table], this.#queryMaxRows));
  }

  /**
   * `undefined`, as the Azure connector already returns.
   *
   * Corpus identity describes the data a benchmark corpus was built from, and a live tenant has no
   * such identity. The artifact records no corpus rather than a borrowed one.
   */
  async getCorpus(): Promise<CorpusIdentity | undefined> {
    return undefined;
  }

  async #hunt(query: string): Promise<z.infer<typeof HuntingQueryResults>> {
    const body = {
      Query: query,
      ...(this.#workspaceId === undefined ? {} : { workspaceId: this.#workspaceId }),
    };
    const payload = await this.#request("POST", `${GRAPH}/security/runHuntingQuery`, {
      purpose: "query",
      body,
    });
    const parsed = HuntingQueryResults.safeParse(payload);
    if (!parsed.success) {
      throw new SentinelApiError(
        "unreachable",
        200,
        "Microsoft Graph returned an invalid runHuntingQuery response.",
      );
    }
    return parsed.data;
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
      token = await this.#credential.getToken(GRAPH_SCOPE, {
        abortSignal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new SentinelApiError(
        "authentication_error",
        0,
        "Azure Identity could not acquire a Microsoft Graph token. Check DEFENDER_TENANT_ID, DEFENDER_CLIENT_ID and DEFENDER_CLIENT_SECRET; see docs/defender-setup.md.",
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
        "Azure Identity returned an invalid Microsoft Graph token.",
      );
    }

    this.#token = { value: token.token, expiresAt: token.expiresOnTimestamp };
    return token.token;
  }

  /**
   * Add findings as a comment on the alert's incident (ADR 012 §6).
   *
   * **Measured against a live tenant on 2026-09-16**, because the documentation settles none of it
   * and the obvious reading is wrong:
   *
   * - `PATCH /security/alerts_v2/{id}` carrying `comments` returns **200 and discards the field**.
   *   The alert is not the write surface, however much it looks like one.
   * - `POST /security/incidents/{id}/comments` works, and echoes the whole comments collection back
   *   in its 200 — which is how a publication confirms itself without a second call.
   * - `comments` is **not a navigation property** on an incident, so neither `?$expand=comments`
   *   nor `GET .../incidents/{id}/comments` reads it back; both answer 400. A plain
   *   `GET /security/incidents/{id}` carries it inline, which is what the idempotency check uses.
   *
   * Idempotency is read-then-write against the marker (PRD-9 §4.2), not a transaction: two
   * processes publishing the same alert in the same instant can both miss the marker and both
   * write. The loop starts each alert once, so losing that race needs two watch processes against
   * one tenant, and it costs a duplicate comment rather than a duplicate investigation.
   */
  async publishFindings(alert: PublishTarget, body: string): Promise<PublishOutcome> {
    const caseId = alert.caseId;
    if (caseId === undefined) {
      throw new SentinelApiError(
        "bad_request",
        400,
        `Alert ${alert.id} carries no incident id, so there is no case to publish findings to.`,
      );
    }

    const incidentUrl = `${GRAPH}/security/incidents/${encodeURIComponent(caseId)}`;
    const marker = findingsMarker(alert.id);

    const existing = await this.#request("GET", incidentUrl, { purpose: "publish" });
    if (JSON.stringify(existing ?? null).includes(marker)) {
      return { status: "alreadyPresent", caseRef: `${incidentUrl}#${marker}` };
    }

    await this.#request("POST", `${incidentUrl}/comments`, {
      purpose: "publish",
      body: { "@odata.type": "microsoft.graph.security.alertComment", comment: body },
    });

    return { status: "published", caseRef: `${incidentUrl}#${marker}` };
  }

  async #request(
    method: "GET" | "POST",
    url: string,
    options: { purpose: "alerts" | "query" | "publish"; body?: unknown },
  ): Promise<unknown> {
    const token = await this.#accessToken();
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    };
    // Only on alert requests: `runHuntingQuery` returns no evolvable enums, and sending it there
    // would imply a contract that endpoint does not have.
    if (options.purpose === "alerts") headers["prefer"] = PREFER_UNKNOWN_ENUMS;

    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.#timeoutMs) };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json; charset=utf-8";
      init.body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new SentinelApiError(
        "unreachable",
        0,
        this.#sanitize(`${method} ${url} failed: ${reason}`, token),
      );
    }

    const text = response.ok ? await response.text() : await boundedErrorText(response);
    let payload: unknown;
    try {
      payload = text === "" ? undefined : JSON.parse(text);
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      const parsed = GraphErrorResponse.safeParse(payload);
      // The Kusto engine's own message is what lets the model repair its own query, and Graph
      // passes it through verbatim — confirmed against the tenant, where a rejected column name
      // came back inside `error.message`. Nothing wraps or rewrites it (ADR 010 §3).
      const message = parsed.success
        ? diagnostic(parsed.data.error)
        : `${method} ${url} returned ${response.status} ${response.statusText}`.trim();
      throw new SentinelApiError(
        this.#errorCode(response.status, options.purpose),
        response.status,
        this.#sanitize(message, token),
      );
    }

    return payload;
  }

  /**
   * HTTP status to error code.
   *
   * Matching is on status and `code`, never on message text — Microsoft documents that message
   * content may change. The probe confirmed that a semantic failure, a syntax failure and an
   * unresolvable table all return `400` with `error.code` `BadRequest`, so `code` cannot
   * discriminate between them either; the verbatim message is what carries the distinction to the
   * model, and it does so without this layer interpreting it.
   *
   * A `429` becomes `rate_limited` and is never retried. Advanced hunting's quota is a shared
   * per-tenant CPU allowance that blocks until the next 15-minute cycle, so a retry would deepen
   * the outage for every other consumer in the tenant (PRD-7 §8 excluded retries; that holds).
   */
  #errorCode(status: number, purpose: "alerts" | "query" | "publish"): SentinelApiErrorCode {
    if (status === 401) return "authentication_error";
    if (status === 403) return "authorization_error";
    if (status === 404) return "not_found";
    if (status === 429) return "rate_limited";
    if (status >= 500) return "upstream_unavailable";
    // A 400 on a hunting request is the query being rejected — including an unresolvable table,
    // which Graph reports as a 400 and not a 403, so a missing table is never misread as a
    // permission failure.
    if (purpose === "query") return "query_error";
    return "bad_request";
  }

  #sanitize(message: string, token?: string): string {
    return [token]
      .filter((value): value is string => value !== undefined && value !== "")
      .reduce((safe, value) => safe.replaceAll(value, "[redacted]"), message);
  }
}

/** Bounded read of an error body, so a large failure cannot be read into memory whole. */
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
