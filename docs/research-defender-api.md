# Microsoft Defender API — Design Research

**Status:** Research note. Not a PRD. **Desk half only** — every claim here comes from published
Microsoft documentation, not from a tenant.
**Scope:** PRD-8 Phase 0. This note is what Phase 0's probe *extends*, not what it replaces; §8
lists what only a live tenant can settle.
**Would become:** the evidence behind `docs/prd-8-microsoft-defender-data-source.md` §4.1 and §4.2.
**Method:** seven agents over `learn.microsoft.com`, `microsoftgraph/microsoft-graph-docs-contrib`
and `MicrosoftDocs/defender-docs`, August 2026, plus the live CSDL at
`https://graph.microsoft.com/v1.0/$metadata`. Every claim is tagged `[D]` documented, `[I]` inferred
or `[C]` contradictory, and contradictions state both readings rather than picking one silently.

> **Read the tags.** A `[D]` claim can be quoted into a design decision. An `[I]` claim is a
> reading of field names, SDK surfaces or example payloads and must be confirmed against a tenant
> before anything locks to it. A `[C]` claim means Microsoft's own pages disagree — the parser or
> the design has to tolerate both readings, not choose.

---

## 1. The answer

**The documentation settles most of the connector's shape and makes exactly one thing harder than
assumed.**

What it settled, and what each one changed in PRD-8:

1. **The error contract is concrete** — `400`, `error.code` `"BadRequest"`, and the Kusto engine's
   own message passed through verbatim. That is what makes ADR 010 §3's "preserve actionable query
   errors" reachable without the connector inventing text (§3, §4.2 "Error contract").
2. **An unresolvable table is a `400`, not a `403`** — so a missing table can never be misread as a
   permission failure, and probing for table existence becomes viable (§3).
3. **`alerts_v2` supports four OData parameters and `$orderby` is not one of them.** Without a sort,
   "the first 500 alerts" is not "the most recent 500", so PRD-7's fail-loud-at-501 precedent cannot
   be copied unexamined (§2, PRD-8 §7 Q6).
4. **`Prefer: include-unknown-enum-members` is mandatory.** Without it, twenty-one enum members
   collapse to `unknownFutureValue` — including `microsoftSentinel` and every Sentinel rule kind.
   Since `serviceSource` is also the only filterable field that says where an alert came from,
   omitting the header erases the source distinction the whole PRD exists to make (§6).
5. **`detectorId` is the `AlertType` equivalent**, by elimination rather than by any stated mapping:
   everything else is per-instance, per-product or per-sensor (§6). Still `[I]`.
6. **Sentinel alerts reach `alerts_v2` only when the workspace is onboarded to the Defender
   portal**, and standalone Sentinel alerts never do. This makes PRD-8 §4.1 D5's no-merge rule
   documented rather than merely cautious: the deployment that most wants both sources is exactly
   the one where the same detection appears twice (§2).
7. **`alerts_v2` silently excludes** alerts suppressed by tuning rules, standalone detections never
   promoted to an incident, and low-signal Exchange Online events (§2).
8. **`workspace('<id>').<Table>` works in advanced hunting** — Defender can reach Sentinel tables
   directly. Recorded in PRD-8 §4.1 D6 as a rejected alternative, because it collapses two sources
   into one source identity (§4).
9. **Scoped `search` is supported**; it is the *unscoped* `search`/`union` forms that are
   discouraged, because they span every table and hit the size limit (§4).
10. **Advanced hunting is UTC always**, and 30 days is a hard ceiling rather than a default (§4).
11. **Never decode the Graph token** to detect missing consent — Microsoft says so explicitly.
    Detect the `403` at call time (§7).

What it made **harder**:

> **Schema discovery has no documented mechanism at all.** There is no metadata endpoint, no special
> table and no enumeration query — that much was expected. What was not: **neither `getschema` nor
> `union isfuzzy=true` appears anywhere in the advanced-hunting documentation set.** `getschema`
> shows up only on streaming-API and ADX pages; `isfuzzy` only on Sentinel and Log Analytics pages.
> Both of PRD-8's originally preferred mechanisms are therefore unverified, and the hard-error
> behaviour of finding 2 is precisely what `isfuzzy` would have to suppress. PRD-8 §4.2 now carries
> four mechanisms instead of three, expects the pinned manifest, and sends Phase 0 to test the two
> undocumented ones empirically because no document can (§4, PRD-8 §7 Q1).

One trap worth stating on its own, because it is easy to hit by searching:

> **The widely-quoted advanced-hunting limits belong to the legacy API, not to Graph.** "45 calls per
> minute, 1,500 per hour, 10 minutes of running time per hour, 3 hours per day" describes
> `api.security.microsoft.com/api/advancedqueries/run`. Graph's `runHuntingQuery` documents 45 calls
> per minute per tenant, a CPU allowance that blocks until the next 15-minute cycle, a three-minute
> single-request timeout, 100,000 rows and 50 MB. §3 keeps the two surfaces separate deliberately —
> do not blend them.

---

Legend: `[D]` documented · `[I]` inferred · `[C]` contradictory (both readings stated).

---

## 2. Alerts (alerts_v2) — endpoint, paging, filtering, limits

### Endpoint
- `[D]` `GET /security/alerts_v2` — full v1.0 URL `https://graph.microsoft.com/v1.0/security/alerts_v2`. Namespace `microsoft.graph.security`.
- `[D]` `GET /security/alerts_v2/{alertId}` → `200 OK`, single alert. `PATCH /security/alerts_v2/{id}` for update.
- `[D]` Success: `200 OK`, body `{ "value": [ { "@odata.type": "#microsoft.graph.security.alert", ... } ] }`.
- `[D]` CSDL: `<NavigationProperty Name="alerts_v2" Type="Collection(self.alert)" ContainsTarget="true" />` on the security singleton, **with no OData Capabilities annotations** (no TopSupported/MaxTop/SkipSupported/SortRestrictions/FilterRestrictions) — public metadata cannot confirm or deny `$orderby`/`$select`/`$expand`.
- `[I]` Kiota Go SDK (`security/alerts_escaped_v2_request_builder.go`) declares all eight query fields: `%24count`, `%24expand`, `%24filter`, `%24orderby`, `%24search`, `%24select`, `%24skip`, `%24top` — default generation for an unannotated nav property; weak evidence of server support.
- `[I]` `security/alerts_escaped_v2_count_request_builder.go` implies `GET /security/alerts_v2/$count` is routable; undocumented.

### OData query parameters
- `[D]` Verbatim: "This method supports the following OData query parameters to help customize the response: `$count`, `$filter`, `$skip`, `$top`." Exactly four.
- `[D]` `$orderby`, `$select`, `$expand`, `$search` are **absent** from the supported list on v1.0 and beta pages. Neither page says they are rejected — behavior unasserted.
- `[D]` Filterable properties, verbatim (8): **assignedTo**, **classification**, **determination**, **createdDateTime**, **lastUpdateDateTime**, **severity**, **serviceSource**, **status**. Beta list identical (Oxford comma only diff).
- `[D]` Not filterable per docs: `detectorId`, `detectionSource`, `productName`, `categories`, `title`, `providerAlertId` → you can filter to Sentinel-sourced alerts but **cannot server-side filter by detection rule**.
- `[D]` Documented examples: `GET /security/alerts_v2?$filter={property}+eq+'{property-value}'` and `GET /security/alerts_V2?$top=100&$skip=200` (capital `V` is a published doc typo, not a second endpoint).
- `[D]` Example 2: `GET https://graph.microsoft.com/v1.0/security/alerts_v2?$filter=serviceSource eq 'microsoftSentinel'` — sample response has `"serviceSource": "microsoftSentinel"`, `"detectionSource": "scheduledAlerts"`, `"evidence": []`.

### `[C]` Contradiction — sorting
- Reading A (page prose): "This operation lets you filter and sort through alerts…" and "The most recent alerts are displayed at the top of the list" — implies an ordering and sort capability.
- Reading B (supported-parameter list): `$orderby` is not among the four supported parameters, and no sortable-property list exists anywhere in alerts_v2 docs.

### `[C]` Contradiction — evidence filtering
- Reading A (reference page): exactly 8 filterable properties; `evidence` is not one.
- Reading B (concepts/alertsv1-alertsv2-migration.md): presents evidence-navigation filters as working v2 examples — `$filter=evidence/any(e: e/microsoft.graph.security.userEvidence/userAccount/userPrincipalName eq 'alice@contoso.com')`, `$filter=evidence/any(e: e/microsoft.graph.security.deviceEvidence/deviceDnsName eq 'pc123.contoso.com')` — and instructs: "use the new property names and the `evidence/any()` function for evidence-based filtering."

### Paging
- `[D]` Verbatim: "Use `@odata.nextLink` for pagination." No `$skiptoken` mentioned on the alerts_v2 page.
- `[D]` General (concepts/paging.md): "Different APIs might have different default and maximum page sizes." and "Different APIs might behave differently if you specify a page size (via the `$top` query parameter) that exceeds the maximum page size for that API. The requested page size might be ignored, it might default to the maximum page size for that API, or Microsoft Graph might return an error."
- `[D]` "Depending on the API… the `@odata.nextLink` URL value contains either a `$skiptoken` or a `$skip` query parameter… Don't try to extract the `$skiptoken` or `$skip` value and use it in a different request."
- `[I]` Because alerts_v2 documents `$skip` and shows `$top=100&$skip=200`, its `@odata.nextLink` most likely carries `$skip`, not `$skiptoken`. No page states which.
- `[D]` No `$top` max or default is stated on v1.0 or beta pages, nor in the beta raw markdown. Only general statement applies: "The minimum value of $top is 1 and the maximum depends on the corresponding API."
- `[D]` No hard cap on total retrievable alerts (no 10,000 `$skip` ceiling) appears on the v1.0 page, beta page, security-api-overview, alertsv1-alertsv2-migration, paging.md, or query-parameters.md.

### Sentinel coverage
- `[D]` `microsoftSentinel` is a live v1.0 CSDL `serviceSource` member: `<Member Name="microsoftSentinel" Value="512" />`.
- `[D]` Onboarding gate, verbatim (security-api-overview.md and security-alert.md): "To view Sentinel alerts and incidents you must onboard Sentinel to the Defender Portal."
- `[D]` Migration guide, verbatim: "**Microsoft Sentinel coverage**: Sentinel-generated alerts aren't returned by the v2 API unless your Sentinel workspace is connected to the Microsoft Defender portal. In the interim, use the [Sentinel REST API](/rest/api/loganalytics/) to retrieve these alerts." and "Standalone Sentinel alerts aren't supported in the v2 API, and the Sentinel REST API will be retired in the future."
- `[D]` Other documented exclusions from alerts_v2: **Standalone alerts** — "Alerts that exist outside of the Microsoft 365 Defender incident model—including standalone detections not promoted to an incident—aren't returned by the v2 API."; **Tuned alerts** — "Alerts suppressed by alert-tuning rules aren't returned through the `alerts_v2` endpoint."; **Low-signal Exchange Online events** — "such as mailbox rule creation and message delays, aren't included in `alerts_v2`."
- `[D]` Onboarding procedure: 1. Go to the Microsoft Defender portal and sign in. 2. **System** > **Settings** > **Microsoft Sentinel** > **Connect a workspace**. 3. Select workspaces, **Next**. 4. Select the **Primary workspace**. 5. Read product changes. 6. **Connect**.
- `[D]` Onboarding prerequisites: single Entra tenant, one primary workspace + multiple secondary. Roles: "At least a Security Administrator in Microsoft Entra ID" plus "Owner (unconditional role assignment) OR User Access Administrator and Microsoft Sentinel Contributor", scoped "Tenant - Subscription for Owner role"; "For onboarding, the Owner role assignment must be unconditional at the subscription scope." Log Analytics workspace with Sentinel enabled required. "In many cases, customers onboarding to Microsoft Sentinel after **July 1, 2025** are automatically onboarded to the Defender portal."

### Permissions / availability
- `[D]` Delegated (work/school): least privileged `SecurityAlert.Read.All`; higher `SecurityAlert.ReadWrite.All`. Application: least `SecurityAlert.Read.All`; higher `SecurityAlert.ReadWrite.All`. Delegated (personal MSA): "Not supported."
- `[D]` Delegated least-privilege Entra roles, exactly: Security Reader, Global Reader, Security Operator, Security Administrator.
- `[D]` National cloud: Global ✅ · US Gov L4 ✅ · US Gov L5 (DOD) ✅ · China (21Vianet) ❌.

### Throttling
- `[D]` includes/throttling-security-detections-incidents.md — "The following limits apply to any request on `/security`." Column header "Limit per app per tenant":
  | Any operation on `alert`, `securityActions`, `secureScore` | 150 requests per minute |
  | Any operation on `tiIndicator` | 1,000 requests per minute |
  | Any operation on `secureScore` or `secureScorecontrolProfile` | 10,000 API requests in a 10-minute period |
  | Any operation on `secureScore` or `secureScorecontrolProfile` | Four concurrent requests |
- `[I]` The 150 rpm row names `alert`, not `alerts_v2`. Scoped to "any request on `/security`" and alerts_v2 returns `microsoft.graph.security.alert`, so 150 req/min per app per tenant is the applicable figure — no page states it for alerts_v2.
- `[D]` `[D]` eDiscovery: "The following limits apply to any request on `/security/eDiscoveryCases`." | Any | Five requests per minute |.

### Migration
- `[D]` `GET /v1.0/security/alerts` → `GET /v1.0/security/alerts_v2`; `GET /v1.0/security/alerts/{id}` → `GET /v1.0/security/alerts_v2/{id}`; `PATCH /v1.0/security/alerts/{id}` → `PATCH /v1.0/security/alerts_v2/{id}`. `SecurityEvents.Read.All` → `SecurityAlert.Read.All`; `SecurityEvents.ReadWrite.All` → `SecurityAlert.ReadWrite.All`.
- `[C]` Legacy `/security/alerts` retirement date:
  - Reading A (api-reference/v1.0/includes/security-alerts-v1-deprecation.md, rendered into security-api-overview): "The legacy alerts API is deprecated and will be retired on **October 15, 2026**."
  - Reading B (concepts/alertsv1-alertsv2-migration.md): "…deprecated and will be retired on **August 31, 2026**" and "After August 31, 2026, the legacy `/security/alerts` endpoint will stop returning data."

---

## 3. Hunting queries (runHuntingQuery) — request/response shape, limits, error behaviour

### Request
- `[D]` `POST /security/runHuntingQuery` — `https://graph.microsoft.com/v1.0/security/runHuntingQuery`.
- `[D]` Body: `Query` (String, **required**, KQL); `Timespan` (String, optional, ISO 8601, "The default value is 30 days"); `workspaceId` (Guid, optional).
- `[D]` Headers: `Authorization: Bearer {token}`, `Content-Type: application/json` (docs: use `application/json; charset=utf-8` for non-ANSI characters).
- `[D]` Permissions: Delegated (work/school) least `ThreatHunting.Read.All`, higher "Not available."; Delegated (personal MSA) "Not supported."; Application least `ThreatHunting.Read.All`, higher "Not available."
- `[D]` National cloud: Global ✅ · US Gov L4 ✅ · US Gov L5 (DOD) ✅ · China (21Vianet) ❌.

### `Timespan` semantics
- `[D]` Verbatim: "The interval of time over which to query data, in ISO 8601 format. The default value is 30 days, meaning if no startTime is specified, the query looks back 30 days from now. If a time filter is specified in both the query and the startTime parameter, the shorter time span is applied. For example, if the query has a filter for the last seven days and the startTime is 10 days ago, the query only looks back seven days." (Prose says "startTime"; the parameter is `Timespan`.)
- `[D]` Accepted forms: Date/Date `"2024-02-01T08:00:00Z/2024-02-15T08:00:00Z"`; Duration/endDate `"P30D/2024-02-15T08:00:00Z"`; Start/duration `"2024-02-01T08:00:00Z/P30D"`; ISO8601 duration `"P30D"`; single date/time `"2024-02-01T08:00:00Z"` ("Start time with end time defaulted to the current time").

### Response (200 only documented)
- `[D]` "If successful, this action returns a `200 OK` response code and a [huntingQueryResults] in the response body." The reference page contains **no error section, no error code strings, no non-200 status codes, no throttling section, no Retry-After mention** (verified against rendered Learn page and raw markdown).
- `[D]` Body: `{"@odata.context": "https://graph.microsoft.com/v1.0/$metadata#microsoft.graph.security.huntingQueryResults", "schema": [{"name": "...", "type": "..."}], "results": [ {...} ]}` — lowercase `schema`/`results`.
- `[D]` Envelope rename from legacy: legacy returned "**QueryResponse** object consisting of **Stats**, **Schema**, and **Results**"; Graph returns huntingQueryResults with **schema** and **results** — **`Stats` is dropped entirely in Graph.**

### `[C]` Contradiction — result row key casing (same page)
- Reading A (Example 1): `"results": [{"Timestamp": …, "FileName": "cmd.exe", "InitiatingProcessFileName": "powershell.exe"}]` — PascalCase keys.
- Reading B (Example 2): `"results": [{"timestamp": …, "fileName": "conhost.exe", "initiatingProcessFileName": "powershell.exe"}]` — camelCase keys.
- Both examples' `schema` arrays use lowercase `name`/`type` keys with PascalCase values (`"name": "Timestamp"`). **Do not hard-code result-key casing.**

### `[C]` Contradiction — Example 2 lookback
- Reading A (prose): the query "looks into the deviceProcessEvents table in the advanced hunting schema 60 days back".
- Reading B (request body on the same example): `"Timespan": "P90D"` (90 days).

### `[C]` Contradiction — legacy hunting-API host
- Reading A (defender-endpoint/api/run-advanced-query-api): `POST https://api.security.microsoft.com/api/advancedqueries/run`.
- Reading B (graph security-api-overview migration table): `https://api.securitycenter.microsoft.com/api/advancedqueries/run`.

### `[C]` Contradiction — legacy hunting-API retirement
- Reading A (defender-xdr/api-advanced-hunting): "Retirement began in January 2026. After retirement completes, the Microsoft Defender XDR advanced hunting API no longer functions."
- Reading B (graph security-api-overview): "The older APIs are now retired and will stop returning data on **February 1, 2027**."

### `[C]` Contradiction — migration target version
- Reading A (security-api-overview migration table): target is `https://graph.microsoft.com/beta/security/runHuntingQuery`.
- Reading B (API reference): `runHuntingQuery` is GA in v1.0, documented as `POST https://graph.microsoft.com/v1.0/security/runHuntingQuery`. **Use v1.0.**

### Limits — by surface (do not blend)
**Graph v1.0 `POST /security/runHuntingQuery`** (security-api-overview, "Quotas and resource allocation"):
- `[D]` "Queries explore and return data from the past 30 days."
- `[D]` "Results can return up to 100,000 rows."
- `[D]` "You can make up to at least 45 calls per minute per tenant. The number of calls varies per tenant based on its size."
- `[D]` CPU allocated by tenant size; "Queries are blocked if the tenant reaches 100% of the allocated resources until after the next 15-minute cycle."
- `[D]` "If a single request runs for more than three minutes, it times out and returns an error."
- `[D]` "A `429` HTTP response code indicates that you reached the allocated CPU resources, either by the number of requests sent or by allotted running time. Read the response body to understand the limit you reached." — no body shape given.
- `[D]` "Query results have an overall size limit of 50 MB."

**Legacy MDE `POST https://api.security.microsoft.com/api/advancedqueries/run`** (do NOT attribute to Graph):
- `[D]` 30 days of data; "The results include a maximum of 100,000 rows."
- `[D]` "API calls: Up to 45 calls per minute, and up to 1,500 calls per hour."
- `[D]` "Execution time: 10 minutes of running time every hour and 3 hours of running time a day."
- `[D]` "The maximal execution time of a single request is 200 seconds."
- `[D]` 50 MB result cap with exact message: HTTP 400 Bad Request, "Query execution has exceeded the allowed result size. Optimize your query by limiting the number of results and try again".
- `[D]` Legacy XDR `POST .../api/advancedhunting/run` body `{"Query": "<kql>"}`; response `Stats` / `Schema` / `Results`. `Stats` contains `ExecutionTime`, `resource_usage` (`cache.memory.{hits,misses,total}`, `cache.disk.{hits,misses,total}`, `cpu.{user,kernel,"total cpu"}`, `memory.peak_per_node`), `dataset_statistics[].{table_row_count,table_size}`.

**Defender portal (advanced hunting UI)**: `[D]` Date range 30 days native Defender data (Sentinel tables per analytics-tier retention); result set 100,000 rows; timeout **10 minutes**; results size limit **64 MB**; CPU refresh cycle every 15 minutes (warn >10%, block at 100%).

### `[C]` Contradiction — single-request timeout
- Reading A (defender-endpoint legacy page): "The maximal execution time of a single request is 200 seconds" (200 s), applying to `api.security(center).microsoft.com/api/advancedqueries/run`.
- Reading B (Graph security-api-overview + Defender XDR advanced hunting page): "If a single request runs for more than three minutes, it times out and returns an error" (180 s), applying to Graph runHuntingQuery and `api/advancedhunting/run`.

### Observed error behaviour (user-reported, not docs)
- `[I]` **Semantic KQL failure** → HTTP `400`, code string `BadRequest` (PascalCase), message passes the Kusto engine text through **verbatim**: `'summarize' operator: Failed to resolve scalar expression named 'IsInteetFacing'. Fix semantic errors in your query.` (msgraph-sdk-powershell issue #3188).
- `[I]` **Unresolvable table** → same 400 shape, **not 403**: `Error code: BadRequest`, `Error message: 'where' operator: Failed to resolve table or column expression named 'DeviceProcessEvents'. Fix semantic errors in your query.` Reporter held only `SecurityEvents.Read.All` + `AdvancedQuery.Read.All` (not `ThreatHunting.Read.All`) and still got 400/BadRequest (Microsoft Q&A 2260523).
- `[I]` Observed `innerError` members on a runHuntingQuery 400: `date` (e.g. `"2025-02-26T09:31:49"`), `request-id` (e.g. `"6ae93e30-7472-4bdd-80e2-1a464e8658eb"`), `client-request-id` (e.g. `"c43d412b-1b5b-42c8-8c85-e9c28c9abd35"`).
- `[I]` Casing trap: observed code is `BadRequest` for this endpoint, while the generic graph/errors example uses `badRequest`. Do not assume camelCase when matching.
- `[D]` Docs warn against message matching: "The **message** property is a human-readable value that describes the error condition. Don't take any dependency on the content of this value in your code." / "You should only code against error codes returned in **code** properties."

### Error envelope
- `[D]` Shape: single object with `error` → `code` (string, machine-readable), `message` (string, developer-facing, not localized), optional inner error object (may recurse), optional `details` (array of error objects). Documented example: `{"error": {"code": "badRequest", "message": "Uploaded fragment overlaps with existing data.", "innerError": {"code": "invalidRange", "request-id": "request-id", "date": "date-time"}}}`.
- `[C]` Inner-error key name:
  - Reading A (graph/errors JSON representation block + property table): `innererror` (all lowercase).
  - Reading B (the two concrete JSON examples on that same page, the 429 example on graph/throttling, and observed runHuntingQuery responses): `innerError` (capital E).
  - **Parsers must accept both keys.**

### Generic 429 (not runHuntingQuery-specific)
- `[D]` `HTTP/1.1 429 Too Many Requests`, headers `Content-Length: 312`, `Content-Type: application/json`, `Retry-After: 10`; body `{"error": {"code": "TooManyRequests", "innerError": {"code": "429", "date": "2020-08-18T12:51:51", "message": "Please retry after", "request-id": "94fb3b52-452a-4535-a601-69e0a90e3aa2", "status": "429"}, "message": "Please retry again later."}}`. Top-level code `TooManyRequests` (PascalCase).
- `[D]` "All the resources and APIs described in the [Service-specific limits](throttling-limits) provide a `Retry-After` header except where indicated." **throttling-limits has no security/threat-hunting/advanced-hunting section**, so runHuntingQuery is not covered by that guarantee.
- `[D]` "If no `Retry-After` header is provided by the response, we recommend implementing an exponential backoff retry policy."

### Permission-failure contract (generic, not endpoint-specific)
- `[D]` `403 Forbidden` = "Access is denied to the requested resource. The user does not have enough permission or does not have a required license." `401 Unauthorized` = "Required authentication information is either missing or not valid for the resource." A token that authenticated but lacks the role falls under 403.
- `[D]` resolve-auth-errors: authorization failures, "most of which generate a 403 error (with a few exceptions)". Its only 403 body example is the unrelated Exchange/EWS case `{"error": {"code": "ErrorAccessDenied", "message": "Access to OData is disabled."}}` — **not** the runHuntingQuery body.
- `[D]` Conditional access variant: `HTTP 403; Forbidden error=insufficient_claims` (token acquisition may return 400 `interaction_required`) — distinct from missing-role 403.

### Beta variant
- `[D]` `GET /security/getRunHuntingQuery(query='{query}',timespan='{timespan}',workspaceId={workspaceId})` returns the same `huntingQueryResults` shape. `query` "must be percent-encoded when called directly over REST". "Because the query is passed in the URL, callers whose query string exceeds infrastructure URI limits receive a `414 URI Too Long` response." Example: `GET https://graph.microsoft.com/beta/security/getRunHuntingQuery(query='AlertInfo%20%7C%20project%20Timestamp%2C%20Title%20%7C%20take%202',timespan='P1D')`.

---

## 4. KQL support and schema discovery

### Confirmed supported in Defender XDR advanced hunting
| Construct | Status | Notes |
|---|---|---|
| `union` | `[D]` supported | Official first sample: `union DeviceProcessEvents, DeviceNetworkEvents \| where Timestamp > ago(7d)` |
| `search` | `[D]` supported | Must be scoped: `search in (EmailEvents, EmailAttachmentInfo, IdentityInfo) "email"` |
| `externaldata` | `[D]` supported | `let abuse_sha256 = (externaldata(sha256_hash: string) [@"https://bazaar.abuse.ch/export/txt/sha256/recent/"] with (format="txt")) \| where sha256_hash !startswith "#" \| project sha256_hash;` — TXT, CSV, JSON, or other supported ingestion formats |
| `adx('<Cluster URI>/<Database Name>').<Table Name>` | `[D]` supported (GA, unified Defender portal) | Not supported for custom detections; not supported cross-Defender/Sentinel in GCC; not supported with GDAP |
| `workspace('<Workspace ID or Azure Resource ID>').<Table Name>` | `[D]` supported | e.g. `workspace('00000000-0000-0000-0000-000000000000').SigninLogs \| take 10`. Not supported for custom detections. "only works with Microsoft Sentinel tables. If your query includes Defender tables that haven't been exported to Log analytics, it will fail." |
| `arg("").<ARG table>` | `[D]` supported | e.g. `arg("").Resources`. Not supported for analytics rules; "only works with Microsoft Sentinel tables." |
| Documented "common" operators | `[D]` | `where`, `summarize`, `join`, `count`, `top`, `limit`, `project`, `extend`, `makeset`, `find` — then "For more information on Kusto query language and supported operators, see Kusto query language documentation." |

- `[D]` **There is no published allowlist or denylist of KQL operators for advanced hunting.**
- `[D]` "In general, queries from Microsoft Sentinel work in advanced hunting, including queries that use the `adx()` operator. IntelliSense might warn you that the operators in your query don't match the schema. However, you can still run the query and it should execute successfully."

### Restrictions and exclusions
- `[D]` Unscoped `search`/`union`: "Avoid running unscoped `search` or `union` queries, as they span all tables in the schema and could exceed query size limits in environments with many tables." Documented error type "Query size exceeded", message: `The query cannot run because it exceeds the allowed size limit when processed. ` (trailing space in docs).
- `[D]` GCC-M: "Queries that reference both Microsoft Sentinel and Defender tables aren't supported. If you use *Search* or *Union \** in your queries, consider replacing the *\** with an explicit list of tables that are limited to Microsoft Sentinel only or Defender only."
- `[D]` **Continuous / NRT custom detection frequency only** (not ad-hoc hunting): a query can run continuously only if "The query doesn't use joins, unions, or the `externaldata` operator.", "The query references one table only.", "The query doesn't include any comments line or information."
- `[D]` "Data stored exclusively in the Microsoft Sentinel data lake isn't available in advanced hunting." / "After onboarding to the Microsoft Sentinel data lake, Microsoft Defender advanced hunting no longer supports auxiliary log tables."
- `[D]` Retention >30 days requires onboarding a Sentinel workspace and configuring analytics-tier retention.
- `[D]` Time is UTC: "Kusto time filters are in UTC regardless of the timezone you specified in your time zone settings" / "Advanced hunting uses UTC (Coordinated Universal Time) for all data. Write queries in UTC."
- `[D]` Scalar types in docs table: `datetime`, `string` ("Character string in UTF-8 enclosed in single quotes (') or double quotes (\")"), `bool`, `int` (32-bit), `long` (64-bit).

### Undocumented for advanced hunting (code-searched, zero hits on any `advanced-hunting-*.md`)
- `[I]` `getschema` — appears only in streaming-API/ADX pages (`defender-xdr/streaming-api-storage.md`, `streaming-api-event-hub.md`, `defender-endpoint/api/raw-data-export-storage.md`, `raw-data-export-event-hub.md`) and ASIM parser pages.
- `[I]` `union isfuzzy=true` — appears only in Sentinel/Log Analytics pages. Documented Sentinel semantics: "The `union isfuzzy=true` statement combines results from both the existing and the new custom parser, tolerating minor schema differences between them".
- `[I]` `evaluate` — appears only in `sentinel/false-positives.md` (`| evaluate ipv4_lookup(subnets, IPAddress, network, return_unmatched = true)`) and `sentinel/audit-track-tasks.md` (`| evaluate bag_unpack(Tasks)`).
- `[I]` Kusto control commands (leading `.`) are not mentioned at all in the Defender XDR advanced hunting doc set — neither supported nor rejected, no error message published.

### Different surface — Sentinel data lake exploration (NOT advanced hunting; inverse support matrix)
- `[D]` Supported control commands: `.show version`, `.show databases`, `.show databases entities`, `.show database`.
- `[D]` "All KQL operators and functions are supported except for the following: `adx()`, `arg()`, `externaldata()`, `ingestion_time()`", plus "Calling external data via KQL query against the data lake isn't supported" and "Using out-of-the-box or custom functions isn't supported in KQL queries against the data lake."
- `[D]` Limits: "Queries are limited to 500,000 rows or 64 MB of data and time out after 8 minutes"; 4-minute timeout for lake-tier interactive; 30 queries/minute per tenant; concurrency 10 per tenant; async execution timeout 1 hour; queryable range up to 12 years; ADX connection URI `https://api.securityplatform.microsoft.com/lake/kql` requiring `external_table("<TableName>")`.

### Schema / table discovery
- `[D]` **No documented programmatic endpoint, special table, or query enumerates the tables available to a tenant in Defender XDR advanced hunting.** Only in-portal discovery is documented: schema reference via "select the **View reference** action next to the table name in the schema representation… You can also select **Schema reference** to search for a table"; and "Schema tree - a schema representation that includes the list of tables and their columns is provided next to your working area."
- `[I]` Graph exposes exactly two hunting operations — `POST /security/runHuntingQuery` (v1.0) and `GET /security/getRunHuntingQuery(...)` (beta) — and **neither returns a table list**. No schema-enumeration operation is documented.

### Documented advanced-hunting error messages (portal surface)
| Error type | Exact message |
|---|---|
| Query size exceeded | `The query cannot run because it exceeds the allowed size limit when processed. ` |
| Timeout | `Query exceeded the timeout period.` |
| CPU quota | `You have exceeded processing resources allocated to this tenant. You can run queries again in <duration>.` |
| Syntax errors | `A recognition error occurred.` |
| Semantic errors | `'project' operator: Failed to resolve scalar expression named 'x'` |
| Excessive resource consumption | `Query stopped due to excessive resource consumption.` / `Query stopped. Adjust use of the <operator name> operator to avoid excessive resource consumption.` |
| Unknown | `An unexpected error occurred during query execution. Please try again in a few minutes.` |

- `[D]` Syntax-error cause text covers nonexistent tables: "The query contained unrecognized names, including references to nonexistent operators, columns, functions, or tables." — a nonexistent table is a hard error with no documented tolerance mechanism.
- `[D]` 64 MB overflow behavior: "the portal returns the maximum number of records it can within this limit and displays a message indicating that the displayed results are partial due to size constraints."

---

## 5. Core advanced-hunting tables — timestamp columns and join keys

- `[D]` **All 11 tables name their time column `Timestamp`, type `datetime`.** None uses `TimeGenerated`, `EventTime`, or `LastSeen` as the primary time column.

| Table | Timestamp meaning (verbatim) | Alert id | `ReportId` type | Primary join keys | Notably ABSENT |
|---|---|---|---|---|---|
| **AlertInfo** | "Date and time when the record was generated" | `AlertId` (string) | — (no column) | `AlertId` only | DeviceId, ReportId, all account/email/file columns |
| **AlertEvidence** | "Date and time when the event was recorded" | `AlertId` (string) | — (no column) | `AlertId`, `DeviceId`, `AccountObjectId`/`AccountUpn`/`AccountSid`, `NetworkMessageId` | ReportId |
| **DeviceProcessEvents** | "Date and time when the event was recorded" | none | `long` | `DeviceId`, `DeviceName`, `ReportId` | — (only Device* table with full `AccountName`/`AccountDomain`/`AccountSid`/`AccountUpn`/`AccountObjectId`) |
| **DeviceNetworkEvents** | "Date and time when the event was recorded" | none | `long` | `DeviceId`, `DeviceName`, `ReportId`; `RemoteIP`, `RemoteUrl`, `RemotePort` (int), `LocalIP`, `LocalPort` (int) | `AccountName`, `AccountSid`, `AccountUpn`, `AccountObjectId` (only `InitiatingProcessAccount*`) |
| **DeviceLogonEvents** | "Date and time when the event was recorded" | none | `long` | `DeviceId`, `DeviceName`, `ReportId`, `AccountSid` | `AccountUpn`, `AccountObjectId` (acting-account cols are only `AccountDomain`, `AccountName`, `AccountSid`) |
| **DeviceFileEvents** | "Date and time when the event was recorded" | none | `long` | `DeviceId`, `DeviceName`, `ReportId`, `SHA1`, `SHA256` | all acting-account columns (`AccountName`/`AccountSid`/`AccountUpn`/`AccountObjectId`) |
| **IdentityLogonEvents** | "Date and time when the event was recorded" | none | `string` | `AccountUpn`, `AccountObjectId`, `AccountSid` | **`DeviceId`** — device correlation only via FQDN strings `DeviceName`, `DestinationDeviceName`, `TargetDeviceName`. 26 columns total |
| **IdentityInfo** | "The date and time that the line was written to the database. This is used when there are multiple lines for each identity, such as when a change is detected, or if 24 hours have passed since the last database line was added." | none | `string` | `AccountObjectId`, `AccountUpn`, `OnPremSid`, `CloudSid` | **`AccountSid`**, `DeviceId` — joining a device-table `AccountSid` needs `OnPremSid`/`CloudSid` |
| **EmailEvents** | "Date and time when the event was recorded" | none | `string` | `NetworkMessageId`, `RecipientEmailAddress`, `RecipientObjectId`, `SenderObjectId` | `DeviceId`, `AccountUpn`, `AccountObjectId` |
| **CloudAppEvents** | "Date and time when the event was recorded" | none | `string` | `AccountObjectId`, `AccountId`, `ReportId`; also `ApplicationId` (int), `AppInstanceId` (int), `OAuthAppId`, `ObjectId`, `IPAddress` | `DeviceId`, `AccountUpn` |
| **DeviceInfo** | "**Last date and time recorded for the device**" (state, not event time) | none | `long` | `DeviceId`, `DeviceName`, `ReportId`, `AadDeviceId` | — |

### AlertInfo ↔ AlertEvidence
- `[D]` One-to-many header/detail pair joined on `AlertId`. MDE→XDR migration article: replace `DeviceAlertEvents` and "join the `AlertInfo` and the `AlertEvidence` tables on `AlertId`".
- `[D]` AlertInfo has exactly 8 columns: `Timestamp` (datetime), `AlertId` (string, "Unique identifier for the alert"), `Title`, `Category`, `Severity`, `ServiceSource`, `DetectionSource`, `AttackTechniques` (all string).
- `[D]` AlertEvidence secondary pivots: `SHA1`, `SHA256`, `RemoteIP`, `RemoteUrl`, `FileName`, `FolderPath`, `ProcessCommandLine`, `EmailSubject`, `LocalIP`, `ApplicationId` (int), `OAuthApplicationId`, `RegistryKey`, `RegistryValueName`, `RegistryValueData`, `AdditionalFields`.
- `[D]` Documented joins both directions: `AlertInfo | where Timestamp > ago(30d) | where Category == "CredentialAccess" | join AlertEvidence on AlertId`; and `DeviceInfo | where LoggedOnUsers contains '<account-name>' | distinct DeviceId | join kind=inner AlertEvidence on DeviceId | project AlertId | join AlertInfo on AlertId | project AlertId, Timestamp, Title, Severity, Category`.
- `[D]` DeviceAlertEvents column migration: `AlertId`, `Timestamp` → both AlertInfo and AlertEvidence; `Severity`, `Category`, `Title`, `AttackTechniques` → AlertInfo; `DeviceId`, `DeviceName`, `FileName`, `SHA1`, `RemoteUrl`, `RemoteIP` → AlertEvidence; `ReportId`, `Table` → "Get related data directly from `AlertEvidence`".
- `[I]` AlertEvidence holds one row per entity per alert → a single `AlertId` yields multiple rows. Supported by `EntityType` ("Type of object, such as a file, a process, a device, or a user"), `EvidenceRole` ("How the entity is involved in an alert, indicating whether it is impacted or is merely related"), `EvidenceDirection`. **No page states the cardinality outright.**
- `[D]` `AlertId` exists in exactly two of the eleven tables (AlertInfo, AlertEvidence). All other nine reach an alert only via AlertEvidence entity columns.
- `[D]` AlertInfo uses singular `Category` ("Type of threat indicator or breach activity identified by the alert"); AlertEvidence uses plural `Categories` ("List of categories that the information belongs to, in JSON array format"). Different columns, different shapes.

### Cross-table join recipes (documented)
- `[D]` EmailEvents → IdentityInfo joins on **email address**, not object id: `EmailEvents | where Timestamp > ago(7d) | where ThreatTypes has "Malware" or ThreatTypes has "Phish" | join (IdentityInfo | distinct AccountUpn, AccountDisplayName, JobTitle, Department, City, Country) on $left.RecipientEmailAddress == $right.AccountUpn`. Same pattern for EmailPostDeliveryEvents → IdentityLogonEvents.
- `[D]` Email → device pivot derives account by string split: `AccountName = tostring(split(RecipientEmailAddress, "@")[0])`, then `join (DeviceProcessEvents | ... | project TimeProc = Timestamp, AccountName, DeviceName, ...) on AccountName`.
- `[D]` EmailAttachmentInfo → DeviceFileEvents joins `on SHA256`.
- `[D]` DeviceInfo current-state pattern: `DeviceInfo | extend IngestionTime = ingestion_time() | where DeviceName == "example" and isnotempty(OSPlatform) | summarize arg_max(IngestionTime, *) by DeviceId`.
- `[D]` DeviceInfo also has `MergedDeviceIds` ("Previous device IDs that have been assigned to the same device") and `MergedToDeviceId` ("The most recent device ID assigned to a device") — a `DeviceId` join can miss rows written under a superseded id.

### Gotchas
- `[D]` `ReportId` type splits by family: `long` in DeviceProcessEvents, DeviceNetworkEvents, DeviceLogonEvents, DeviceFileEvents, DeviceInfo; `string` in EmailEvents, CloudAppEvents, IdentityLogonEvents, IdentityInfo. Absent from AlertInfo and AlertEvidence.
- `[D]` DeviceProcessEvents contains two columns differing only by case: `LogonId` (long, "Identifier for a logon session. This identifier is unique on the same device only between restarts.") and `LogonID` (long, "A unique identifier for the user initiating the event… This field is located inside AdditionalFields/InitiatingProcessPosixEffectiveUser"). **Any case-insensitive column mapping collides.**
- `[D]` LogonId/LogonID split across tables: DeviceProcessEvents has BOTH; DeviceLogonEvents has `LogonId` only; DeviceNetworkEvents and DeviceFileEvents have `LogonID` only.
- `[D]` Streaming to Log Analytics adds a separate `TimeGenerated`: "If the data arrives to Log Analytics after 48 hours, the ingestion process overrides it to `now()`. Therefore, to get the actual time the event happened, rely on the `Timestamp` column." Streaming also adds `SourceSystem` and `MachineGroup`, which "remain blank for Defender tables that you don't stream".
- `[D]` IdentityInfo license footnotes: `[*]` = "Available only for tenants with Microsoft Defender for Identity, Microsoft Defender for Cloud Apps, or Microsoft Defender for Endpoint P2 licensing" and covers `Timestamp`, `ReportId`, `AccountDomain`, `Type`, `DistinguishedName`, `Manager`, `Phone`, `CreatedDateTime`, `ChangeSource`, `Tags`, `AssignedRoles`, `SourceSystem`. `[**]` = "Available only for tenants with Microsoft Sentinel" (`BlastRadius`, `CompanyName`, `DeletedDateTime`, `EmployeeId`, `OtherMailAddresses`, `State`). `[***]` = `PrivilegedEntraPimRoles`, Defender for Identity only.
- `[D]` AlertEvidence describes `NetworkMessageId` as "generated by Office 365"; EmailEvents describes the same column as "generated by Microsoft 365". Same identifier, stale product name.
- `[D]` Custom-detection "strong identifier" columns, exactly: Device — `DeviceId`, `DeviceName`, `RemoteDeviceName`; Mailbox — `RecipientEmailAddress`, `SenderFromAddress`, `SenderMailFromAddress`, `SenderObjectId`, `RecipientObjectId`; Account — `AccountObjectId`, `AccountSid`, `AccountUpn`, `InitiatingProcessAccountSid`, `InitiatingProcessAccountUpn`. Plus: "For Microsoft Defender for Endpoint tables, include `DeviceId` or `DeviceName`"; "For all other Defender tables, project `Timestamp` and `ReportId` from the same event"; rule query must return "`Timestamp` or `TimeGenerated`".

### `[C]` Contradiction — EmailEvents `ReportId` description (self-inconsistent on its own page)
- Reading A (literal text): "| `ReportId` | `string` | Event identifier based on a repeating counter. To identify unique events, this column must be used in conjunction with the DeviceName and Timestamp columns. |" — **but the EmailEvents schema table has no `DeviceName` column**, so this is not executable.
- Reading B: the wording was copied from the Device* tables; the real uniqueness key for EmailEvents is `NetworkMessageId` + `Timestamp` (+ recipient).

### `[C]` Contradiction — hash column to join on
- Reading A: AlertEvidence `SHA256` carries "This field is usually not populated—use the SHA1 column when available." Identical caveat on DeviceProcessEvents `SHA256`/`InitiatingProcessSHA256` and DeviceFileEvents `SHA256`/`InitiatingProcessSHA256` → join on `SHA1`.
- Reading B: the documented EmailAttachmentInfo → DeviceFileEvents example joins `on SHA256`.

---

## 6. Alert field mapping — Sentinel `AlertType` equivalent, and evidence subtypes

### The AlertType answer
- `[I]` **`detectorId` is the closest semantic equivalent of Microsoft Sentinel's `SecurityAlert.AlertType`.** Rationale: AlertType identifies the *detection logic* and is stable across every instance produced by it. Sentinel schema verbatim: "**AlertType** | string | The type of alert. - **Scheduled rule alerts:** taken from the rule ID. - **Ingested alerts:** some products group their alerts by type. In some cases, may be identical to or synonymous with the product name." Defender for Cloud defines it as "unique alert identifier". Among alerts_v2 fields, only `detectorId` ("The ID of the detector that triggered the alert") is per-detection-logic rather than per-instance / per-product / per-sensor / per-threat.
- `[I]` Elimination: `providerAlertId` = per-instance → `VendorOriginalId` ("Unique ID for the specific alert instance, set by the originating product") / `SystemAlertId` ("The internal unique ID for the alert in Microsoft Sentinel"). `productName` → `ProductName`. `serviceSource` → `ProviderName` ("The name of the alert provider (the service within the product) that generated the alert") / `ProductName`. `detectionSource` is a closed per-technology enum — it encodes the Sentinel rule *kind* (`scheduledAlerts`/`nrtAlerts`/`builtInMl`) but never *which* rule. `title` → `AlertName`/`DisplayName`. `categories`/`category` → `Tactics`. `threatDisplayName`/`threatFamilyName` have no SecurityAlert counterpart.
- `[I]` Corroborating shape: List alerts_v2 "Example 2: Get all alerts from Microsoft Sentinel" carries `"serviceSource": "microsoftSentinel"`, `"detectionSource": "scheduledAlerts"`, `"detectorId": "a1b2c3d4-e5f6-47a8-b9c0-d1e2f3a4b5c6"` — a Sentinel analytics-rule-shaped GUID. **That GUID is a synthetic docs placeholder; it corroborates shape, not value binding.**
- `[D]` **No Microsoft page states an explicit AlertType↔alerts_v2 mapping.** The official legacy→v2 field mapping table contains no AlertType row and no detectorId row; its only source-identity row is verbatim: "vendorInformation.provider | serviceSource + productName | Provider metadata is split into an enum and a display name." The Sentinel↔XDR schema-differences page says nothing about AlertType.
- `[D]` `AlertInfo` (hunting) has **no DetectorId column** — `detectorId` is Graph-only.
- `[D]` `detectorId` on the alert resource is current and NOT deprecated. Do not confuse with the beta-only `microsoft.graph.security.detectionRule.detectorId`, which IS deprecated: "detectorId (deprecated) | String | Internal detector identifier. **Deprecated.** This property will be removed from this resource on 2026-10-01."

### Alert-kind fields
| Property | Type | Docs description (verbatim) |
|---|---|---|
| `serviceSource` | `microsoft.graph.security.serviceSource` enum, `Nullable="false"` | "The service or product that created this alert." |
| `detectionSource` | `microsoft.graph.security.detectionSource` enum, nullable | "Detection technology or sensor that identified the notable component or activity." |
| `detectorId` | String | "The ID of the detector that triggered the alert." (Defender example: `"detectorId": "e0da400f-affd-43ef-b1d5-afc2eb6f2756"`) |
| `productName` | String | "The name of the product which published this alert." Present in properties table + JSON representation, **absent from both example response bodies**. |
| `providerAlertId` | String | "The ID of the alert as it appears in the security provider product that generated the alert." Defender example: `id` and `providerAlertId` both `"da637551227677560813_-961444813"`. |
| `threatDisplayName` | String | "The threat associated with this alert." `null` in both examples. |
| `threatFamilyName` | String | "Threat family associated with this alert." `null` in both examples. |
| `categories` | String collection | "The attack kill-chain categories that the alert belongs to. Aligned with the MITRE ATT&CK framework." JSON: `"categories": ["String"]` |
| `category` **(deprecated)** | String | "The attack kill-chain category that the alert belongs to. Aligned with the MITRE ATT&CK framework. This property is in the process of being deprecated. Use the **categories** property instead." Still in CSDL and still populated (`"category": "DefenseEvasion"`, `"category": "CredentialAccess"`). |

### `serviceSource` — full CSDL enum (15 members, authoritative)
`unknown=0`, `microsoftDefenderForEndpoint=1`, `microsoftDefenderForIdentity=2`, `microsoftDefenderForCloudApps=4`, `microsoftDefenderForOffice365=8`, `microsoft365Defender=16`, `azureAdIdentityProtection=32`, `microsoftAppGovernance=64`, `dataLossPrevention=128`, `unknownFutureValue=255`, `microsoftDefenderForCloud=256`, `microsoftSentinel=512`, `microsoftInsiderRiskManagement=1024`, `microsoftThreatIntelligence=2048`, `microsoftSecurityForAI=4096`.

### `[C]` Contradiction — serviceSource member count
- Reading A (learn.microsoft.com enums-security page, "### serviceSource values"): **14** members, omitting `microsoftInsiderRiskManagement`. Order: unknown, microsoftDefenderForEndpoint, microsoftDefenderForIdentity, microsoftDefenderForCloudApps, microsoftDefenderForOffice365, microsoft365Defender, azureAdIdentityProtection, microsoftAppGovernance, dataLossPrevention, unknownFutureValue, microsoftDefenderForCloud, microsoftSentinel, microsoftThreatIntelligence, microsoftSecurityForAI.
- Reading B (live CSDL at `https://graph.microsoft.com/v1.0/$metadata`): **15** members, including `<Member Name="microsoftInsiderRiskManagement" Value="1024" />` between microsoftSentinel and microsoftThreatIntelligence. Omission verified in the raw contrib-repo markdown → a real docs gap, not a rendering artifact.
- **Adjudication: CSDL is authoritative; accept `microsoftInsiderRiskManagement` as a possible wire value.**

### `detectionSource` — full enum (39 members, docs and CSDL identical)
`unknown(0)`, `microsoftDefenderForEndpoint(1)`, `antivirus(2)`, `smartScreen(4)`, `customTi(8)`, `microsoftDefenderForOffice365(512)`, `automatedInvestigation(1024)`, `microsoftThreatExperts(2048)`, `customDetection(4096)`, `microsoftDefenderForIdentity(8192)`, `cloudAppSecurity(16384)`, `microsoft365Defender(32768)`, `azureAdIdentityProtection(65536)`, `manual(262144)`, `microsoftDataLossPrevention(524288)`, `appGovernancePolicy(1048576)`, `appGovernanceDetection(2097152)`, `unknownFutureValue(4194303)`, `microsoftDefenderForCloud(4194304)`, `microsoftDefenderForIoT(1073741833)`, `microsoftDefenderForServers(1073741834)`, `microsoftDefenderForStorage(1073741835)`, `microsoftDefenderForDNS(1073741836)`, `microsoftDefenderForDatabases(1073741837)`, `microsoftDefenderForContainers(1073741838)`, `microsoftDefenderForNetwork(1073741839)`, `microsoftDefenderForAppService(1073741840)`, `microsoftDefenderForKeyVault(1073741841)`, `microsoftDefenderForResourceManager(1073741842)`, `microsoftDefenderForApiManagement(1073741843)`, `nrtAlerts(1073741844)`, `scheduledAlerts(1073741845)`, `microsoftDefenderThreatIntelligenceAnalytics(1073741846)`, `builtInMl(1073741847)`, `microsoftInsiderRiskManagement(1073741848)`, `microsoftThreatIntelligence(1073741849)`, `microsoftDefenderForAIServices(1073741850)`, `securityCopilot(1073741851)`, `microsoftSentinel(268435456)`.

- `[D]` **Evolvable enum.** Verbatim: "You must use the `Prefer: include-unknown-enum-members` request header to get the following values in this evolvable enum" — 21 gated members: `microsoftDefenderForCloud`, `microsoftDefenderForIoT`, `microsoftDefenderForServers`, `microsoftDefenderForStorage`, `microsoftDefenderForDNS`, `microsoftDefenderForDatabases`, `microsoftDefenderForContainers`, `microsoftDefenderForNetwork`, `microsoftDefenderForAppService`, `microsoftDefenderForKeyVault`, `microsoftDefenderForResourceManager`, `microsoftDefenderForApiManagement`, `nrtAlerts`, `scheduledAlerts`, `microsoftDefenderThreatIntelligenceAnalytics`, `builtInMl`, `microsoftInsiderRiskManagement`, `microsoftThreatIntelligence`, `microsoftDefenderForAIServices`, `securityCopilot`, `microsoftSentinel`. Without the header expect `unknownFutureValue`. **This gate covers all four Sentinel rule kinds and `microsoftSentinel`.**
- `[D]` Sentinel rule-kind member descriptions: `nrtAlerts` = "Sentinel NRT Alerts."; `scheduledAlerts` = "Sentinel Scheduled Alerts."; `microsoftDefenderThreatIntelligenceAnalytics` = "Sentinel Threat Intelligence Alerts."; `builtInMl` = "Sentinel Built-in ML."; `microsoftSentinel` = "Microsoft Sentinel."

### `[C]` Contradiction — alertEvidence page's "detectionSource values" table
- Reading A (security-alertevidence.md, line 89 of raw markdown, heading "### detectionSource values"): members are `detected` / `blocked` / `prevented` / `unknownFutureValue`.
- Reading B (security-detectionsource page + CSDL + alert resource page): `detectionSource` is the 39-member sensor/technology enum; `detected`/`blocked`/`prevented`/`unknownFutureValue` are `microsoft.graph.security.detectionStatus` (CSDL: detected=0, blocked=1, prevented=2, unknownFutureValue=31).
- **Adjudication: Reading B is correct; the alertEvidence heading is a docs bug.** No evidence subtype has a `detectionSource` property; the example payloads carry `"detectionStatus": "detected"` on fileEvidence and processEvidence.

### `[C]` Contradiction — alertDetermination member spelling (same page)
- Reading A (`determination` property row): member is `confirmedUserActivity`.
- Reading B ("alertDetermination values" table on the same page): member is `confirmedActivity`.

### Alert resource — full JSON representation key set (v1.0)
`@odata.type`, `actorDisplayName`, `additionalData`, `alertWebUrl`, `assignedTo`, `category`, `categories`, `classification`, `comments`, `createdDateTime`, `customDetails`, `description`, `detectionSource`, `detectorId`, `determination`, `evidence`, `firstActivityDateTime`, `id`, `incidentId`, `incidentWebUrl`, `investigationState`, `lastActivityDateTime`, `lastUpdateDateTime`, `mitreTechniques`, `productName`, `providerAlertId`, `recommendedActions`, `resolvedDateTime`, `serviceSource`, `severity`, `status`, `systemTags`, `tenantId`, `threatDisplayName`, `threatFamilyName`, `title`.
- `[D]` The JSON representation block **omits `alertPolicyId`** even though the properties table documents it (String, "The ID of the policy that generated the alert…") and the CSDL confirms `<Property Name="alertPolicyId" Type="Edm.String" />`.
- `[D]` Enums serialized as JSON strings: `serviceSource`, `detectionSource`, `status` (`unknown|new|inProgress|resolved|unknownFutureValue`), `severity` (`unknown|informational|low|medium|high|unknownFutureValue`), `classification` (`unknown|falsePositive|truePositive|informationalExpectedActivity|unknownFutureValue`), `determination`, `investigationState`.
- `[D]` `id` = "Unique identifier to represent the **alert** resource."; other identity-bearing props: `incidentId`, `tenantId`, `detectorId`, `alertPolicyId`, `alertWebUrl`, `incidentWebUrl`.

### AlertId ↔ alerts_v2 id
- `[D]` Mapping table in defender-for-cloud-apps/migrate-to-supported-api-solutions.md, columns "CEF Field (MDA SIEM) | Description | Defender XDR Streaming API (CloudAppEvents/AlertEvidence/AlertInfo) | Graph Security Alerts API (v2)", row: "| `externalId` (Alert) | Alert ID | `AlertId` | `id` |" → hunting `AlertId` maps to alerts_v2 **`id`**, not `providerAlertId`, not `incidentId`.
- `[I]` Same identifier string, not a different id space. Evidence: the mapping row; example payloads where `id` and `providerAlertId` are byte-identical (`"da637551227677560813_-961444813"`, `"da637878227677560813_-334257894"`); `alertWebUrl` built as `https://security.microsoft.com/alerts/{id}?tid={tenantId}`. **No page states the equality in one sentence.**
- `[D]` Same MDCA table: CEF `start` ("Activity or alert timestamp") → hunting `Timestamp` → Graph `firstActivityDateTime`. The adjacent `rt` row is defective (its advanced-hunting cell reads `createdDateTime`, not a hunting column name).
- `[D]` Same MDCA table: CEF `externalId` (Activities, "Event ID") → hunting `ReportId` → **"N/A"** on Graph. alerts_v2 has no `ReportId` equivalent.
- `[I]` `deviceEvidence.mdeDeviceId` ≈ hunting `DeviceId` (example `"73e7e2de709dff64ef64b1d0c30e67fab63279db"`, 40-hex MDE device id); `deviceEvidence.azureAdDeviceId` ≈ DeviceInfo `AadDeviceId`. Read off field names + example payload, not stated in prose.
- `[D]` Naming divergence: alerts_v2 `categories` (String collection) + deprecated `category`, and `mitreTechniques` (String collection); AlertInfo has scalar `Category` + `AttackTechniques`; AlertEvidence has `Categories` (string containing a JSON array).

### Recommended alerts_v2 → SecurityAlert mapping `[I]`
`detectorId` → `AlertType` (detection-logic identity; **inferred, not documented**) · `providerAlertId` → `VendorOriginalId` · `id` → `SystemAlertId` (analogous role, different ID space) · `title` → `AlertName`/`DisplayName` · `description` → `Description` · `severity` → `AlertSeverity` (casing differs: `high` vs `High`) · `status` → `Status` (Graph has no `Dismissed`; Sentinel Status is New/InProgress/Resolved/Dismissed/Unknown vs alertStatus `unknown|new|inProgress|resolved|unknownFutureValue`) · `productName` → `ProductName` · `serviceSource` → `ProviderName`/`ProductName` · `mitreTechniques` → `Techniques` · `categories` → `Tactics` · `firstActivityDateTime` → `StartTime` · `lastActivityDateTime` → `EndTime` · `createdDateTime` → `TimeGenerated`/`ProcessingEndTime` · `evidence[]` → `Entities` · `customDetails`/`additionalData` → `ExtendedProperties` · `alertWebUrl` → `AlertLink` · `recommendedActions` → `RemediationSteps`.

- `[D]` SecurityAlert (Azure Monitor Logs) column list: `AlertLink`, `AlertName`, `AlertSeverity`, `AlertType`, `CompromisedEntity`, `ConfidenceLevel`, `ConfidenceScore`, `Description`, `DisplayName`, `EndTime`, `Entities`, `ExtendedLinks`, `ExtendedProperties`, `IsIncident`, `ProcessingEndTime`, `ProductComponentName`, `ProductName`, `ProviderName`, `RemediationSteps`, `ResourceId`, `SourceComputerId`, `SourceSystem`, `StartTime`, `Status`, `SubTechniques`, `SystemAlertId`, `Tactics`, `Techniques`, `TenantId`, `TimeGenerated`, `Type`, `VendorName`, `VendorOriginalId`, `WorkspaceResourceGroup`, `WorkspaceSubscriptionId`. `AlertType` is `string`. `DisplayName` = "Synonymous with *AlertName* but retained for compatibility." `IsIncident` = "DEPRECATED. Always set to *false*."

### alertEvidence — base type and 48 subtypes
- `[D]` Base `#microsoft.graph.security.alertEvidence` with **exactly 48** derived subtypes; the docs list and the CSDL `BaseType="self.alertEvidence"` set were diffed programmatically and are identical (zero difference in either direction).
- `[D]` Base properties inherited by all 48: `createdDateTime` (DateTimeOffset), `detailedRoles` (String collection), `remediationStatus` (`microsoft.graph.security.evidenceRemediationStatus`), `remediationStatusDetails` (String), `roles` (`microsoft.graph.security.evidenceRole` collection), `tags` (String collection), `verdict` (`microsoft.graph.security.evidenceVerdict`). Base JSON: `{"@odata.type": "#microsoft.graph.security.alertEvidence", "createdDateTime": "String (timestamp)", "verdict": "String", "remediationStatus": "String", "remediationStatusDetails": "String", "roles": ["String"], "detailedRoles": ["String"], "tags": ["String"]}`.
- `[D]` The `evidence` array is polymorphic; the `@odata.type` discriminator (with leading `#`) is present on **every** element in real payloads — verified in the official Defender example (four elements: `#microsoft.graph.security.deviceEvidence`, `#microsoft.graph.security.fileEvidence`, `#microsoft.graph.security.processEvidence`, `#microsoft.graph.security.registryKeyEvidence`).

**Complete subtype `@odata.type` list (48, exact casing):**
`#microsoft.graph.security.activeDirectoryDomainEvidence`, `#microsoft.graph.security.aiAgentEvidence`, `#microsoft.graph.security.amazonResourceEvidence`, `#microsoft.graph.security.analyzedMessageEvidence`, `#microsoft.graph.security.azureResourceEvidence`, `#microsoft.graph.security.blobContainerEvidence`, `#microsoft.graph.security.blobEvidence`, `#microsoft.graph.security.cloudApplicationEvidence`, `#microsoft.graph.security.cloudLogonRequestEvidence`, `#microsoft.graph.security.cloudLogonSessionEvidence`, `#microsoft.graph.security.containerEvidence`, `#microsoft.graph.security.containerImageEvidence`, `#microsoft.graph.security.containerRegistryEvidence`, `#microsoft.graph.security.deviceEvidence`, `#microsoft.graph.security.dnsEvidence`, `#microsoft.graph.security.fileEvidence`, `#microsoft.graph.security.fileHashEvidence`, `#microsoft.graph.security.gitHubOrganizationEvidence`, `#microsoft.graph.security.gitHubRepoEvidence`, `#microsoft.graph.security.gitHubUserEvidence`, `#microsoft.graph.security.googleCloudResourceEvidence`, `#microsoft.graph.security.hostLogonSessionEvidence`, `#microsoft.graph.security.ioTDeviceEvidence`, `#microsoft.graph.security.ipEvidence`, `#microsoft.graph.security.kubernetesClusterEvidence`, `#microsoft.graph.security.kubernetesControllerEvidence`, `#microsoft.graph.security.kubernetesNamespaceEvidence`, `#microsoft.graph.security.kubernetesPodEvidence`, `#microsoft.graph.security.kubernetesSecretEvidence`, `#microsoft.graph.security.kubernetesServiceAccountEvidence`, `#microsoft.graph.security.kubernetesServiceEvidence`, `#microsoft.graph.security.mailClusterEvidence`, `#microsoft.graph.security.mailboxConfigurationEvidence`, `#microsoft.graph.security.mailboxEvidence`, `#microsoft.graph.security.malwareEvidence`, `#microsoft.graph.security.networkConnectionEvidence`, `#microsoft.graph.security.nicEvidence`, `#microsoft.graph.security.oauthApplicationEvidence`, `#microsoft.graph.security.processEvidence`, `#microsoft.graph.security.registryKeyEvidence`, `#microsoft.graph.security.registryValueEvidence`, `#microsoft.graph.security.sasTokenEvidence`, `#microsoft.graph.security.securityGroupEvidence`, `#microsoft.graph.security.servicePrincipalEvidence`, `#microsoft.graph.security.submissionMailEvidence`, `#microsoft.graph.security.teamsMessageEvidence`, `#microsoft.graph.security.urlEvidence`, `#microsoft.graph.security.userEvidence`.

- `[D]` **Casing traps:** `ioTDeviceEvidence` (lowercase i, uppercase o-T), `gitHubOrganizationEvidence`/`gitHubRepoEvidence`/`gitHubUserEvidence` (lowercase g), `oauthApplicationEvidence` (all-lowercase oauth), `sasTokenEvidence`, `nicEvidence`, `dnsEvidence`, `urlEvidence`, `ipEvidence`. **There is no `emailEvidence`** — mail types are `analyzedMessageEvidence`, `mailClusterEvidence`, `mailboxEvidence`, `mailboxConfigurationEvidence`, `submissionMailEvidence`.
- `[D]` Sample subtype fields: `deviceEvidence` — `mdeDeviceId`, `azureAdDeviceId`, `deviceDnsName`, `hostName`, `roles`, `detailedRoles`. `fileEvidence` — nested `fileDetails` with `sha1`, `sha256`, `fileName`, `filePath`, `fileSize`. `processEvidence` — `processId`, `parentProcessId`, `processCommandLine`, nested `imageFile` and `userAccount`.

---

## 7. Authentication — scope, consent failure mode, throttling

### Client credentials flow
- `[D]` Scope string, exactly: `https://graph.microsoft.com/.default` (form-encoded `https%3A%2F%2Fgraph.microsoft.com%2F.default`).
- `[D]` Token endpoint: `POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`, `Host: login.microsoftonline.com:443`, `Content-Type: application/x-www-form-urlencoded`. `{tenant}` "in GUID or domain-name format".
- `[D]` Body: exactly four required params — `client_id`, `scope`, `client_secret`, `grant_type` ("Must be set to `client_credentials`"). "The client secret must be URL-encoded before being sent."
- `[D]` Alternative: "The Basic auth pattern of instead providing credentials in the Authorization header, per RFC 6749 … is also supported."
- `[D]` "Client credentials requests in your client service *must* include `scope={resource}/.default`. … Issuing a client credentials request by using individual application permissions (roles) is *not* supported. All the app roles (application permissions) that have been granted for that web API are included in the returned access token."
- `[D]` "Clients can't combine static (`.default`) consent and dynamic consent in a single request. So `scope=https://graph.microsoft.com/.default Mail.Read` results in an error because it combines scope types."
- `[D]` "refresh tokens will never be granted with this flow".
- `[D]` `token_type` = `Bearer` ("The only type that the Microsoft identity platform supports is `bearer`"). `expires_in` = "The amount of time that an access token is valid (in seconds)", sample `3599`.
- `[D]` Token-endpoint errors: `400 Bad Request`, JSON fields `error`, `error_description`, `error_codes` (array of ints), `timestamp`, `trace_id`, `correlation_id`. Example: `{"error": "invalid_scope", "error_description": "AADSTS70011: The provided value for the input parameter 'scope' is not valid. …", "error_codes": [70011], …}`.
- `[D]` Hosts: global `https://login.microsoftonline.com` / `https://graph.microsoft.com`; China `https://login.chinacloudapi.cn` / `https://microsoftgraph.chinacloudapi.cn`; USGov `https://login.microsoftonline.us` / `https://graph.microsoft.us`; USGovDoD `https://login.microsoftonline.us` / `https://dod-graph.microsoft.us`.

### `[C]` Contradiction — successful token response shape
- Reading A (entra `v2-oauth2-client-creds-grant-flow`): exactly three fields — `{"token_type": "Bearer", "expires_in": 3599, "access_token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsIng1dCI6Ik1uQ19WWmNBVGZNNXBP..."}`.
- Reading B (graph `auth-v2-service`): four fields, adding `"ext_expires_in":3599` ("Used to indicate an extended lifetime for the access token and to support resiliency when the token issuance service isn't responding").
- **Code must tolerate the extra field.**

### Consent failure mode
- `[D]` "Microsoft Graph exposes application permissions for apps that call Microsoft Graph with their own identity. These permissions always require administrator consent."
- `[D]` **A token IS still issued without consent; the missing piece is the `roles` claim.** Verbatim: "In order to enable this ACL-based authorization pattern, Microsoft Entra ID doesn't require that applications be authorized to get tokens for another application. Thus, app-only tokens can be issued without a `roles` claim. Applications that expose APIs must implement permission checks in order to accept tokens."
- `[D]` graph/security-authorization: "The application registers to require permission **P1**. When users in tenant **T1** get a Microsoft Entra token for this application, the token does not contain any permissions." and "Permissions granted to an application are recorded as snapshots of what was granted; they *do not change automatically* after the application registration (permission) changes."
- `[D]` `roles` claim = "Array of strings, a list of permissions. The set of permissions exposed by the application that the requesting application or user has been given permission to call. The client credential flow uses this set of permission in place of user scopes for application tokens." `scp` is irrelevant for app-only — "Only included for user tokens."
- `[I]` Calling `/security` with an app-only token lacking the role → HTTP `403 Forbidden` ("Access is denied to the requested resource. The user does not have enough permission or does not have a required license."). Derived from the generic 403 table + the roles-claim doc; **no page states it for `/security`**.
- `[D]` `401 Unauthorized` = token missing/invalid/expired — a different failure from missing consent.
- `[D]` **Do not decode the token to detect the missing role:** "Don't attempt to validate or read tokens for any API you don't own … Tokens for Microsoft services can use a special format that will not validate as a JWT". Detect the 403 at call time.
- `[D]` Conditional access: "your app receives a 400 with an *interaction_required* error during access token acquisition or a 403 with *insufficient_claims* error when calling Microsoft Graph"; "If conditional access policies are applied to a resource, an `HTTP 403; Forbidden error=insufficient_claims` message is returned."

### Permission identifiers
| Permission | Application id | Delegated id | DisplayText | AdminConsentRequired |
|---|---|---|---|---|
| `ThreatHunting.Read.All` | `dd98c7f5-2d42-42d3-a0e4-633161547251` | `b152eca8-ea73-4a48-8c98-1a6742673d99` | "Run hunting queries" | Yes (both) |
| `SecurityAlert.Read.All` | `472e4a4d-bb4a-4026-98d1-0b0d74cb74a5` | `bc257fb8-46b4-4b15-8713-01e91bfbe4ea` | "Read all security alerts" | Yes (both) |

### SDK wiring (documented, supported)
- `[D]` Graph "Choose a Microsoft Graph authentication provider" maps "Daemon app | Client Credentials | App Only | Client credentials provider" with `ClientSecretCredential` samples for C#, Go, Java, Python, TypeScript. Libraries: .NET `Azure.Identity`, TS/JS `@azure/identity`, Java/Android `azure-identity`.
- `[D]` Scope passed to the credential is the single-element array `['https://graph.microsoft.com/.default']`. Repeated doc comment: "The client credentials flow requires that you request the /.default scope, and pre-configure your permissions on the app registration in Azure. An administrator must grant consent to those permissions beforehand."
- `[D]` TypeScript: `new ClientSecretCredential('YOUR_TENANT_ID', 'YOUR_CLIENT_ID', 'YOUR_CLIENT_SECRET')` → `new TokenCredentialAuthenticationProvider(credential, { scopes: ['https://graph.microsoft.com/.default'] })` (from `@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials`) → `Client.initWithMiddleware({ authProvider: authProvider })`.
- `[D]` Go: `azidentity.NewClientSecretCredential("TENANT_ID", "CLIENT_ID", "CLIENT_SECRET", nil)` → `graph.NewGraphServiceClientWithCredentials(cred, []string{"https://graph.microsoft.com/.default"})`. C#: `new ClientSecretCredential(tenantId, clientId, clientSecret, options)` → `new GraphServiceClient(clientSecretCredential, scopes)` with `var scopes = new[] { "https://graph.microsoft.com/.default" };`.
- `[D]` The choose-authentication-providers page enumerates only: AuthorizationCodeCredential, ClientCertificateCredential, ClientSecretCredential, OnBehalfOfCredential, DeviceCodeCredential, InteractiveBrowserCredential, UsernamePasswordCredential.

### Delegated access
- `[D]` Delegated to the security API needs **both** admin consent **and** an Entra directory role: "A user who is a member of the Microsoft Entra tenant is signed in. The user must be a member of a Microsoft Entra ID Limited Admin role—either Security Reader or Security Administrator—in addition to the application having been granted the required permissions." and "The Microsoft Entra tenant admin must explicitly grant consent to your application. This is required both for application-level authorization and user delegated authorization."
- `[D]` Microsoft recommends app-only for Defender data: "Microsoft Defender for Endpoint requires additional user roles to those required by the Microsoft Graph security API. Only the users in both Microsoft Defender for Endpoint and Microsoft Graph security API roles can access the Microsoft Defender for Endpoint data. Because application-only authentication isn't limited by this, we recommend that you use an application-only authentication token."
- `[D]` "Graph Explorer does not support application-level authorization."
- `[D]` Azure CLI: `az account get-access-token --resource-type ms-graph`. `--resource-type` accepted values exactly: `aad-graph, arm, batch, data-lake, media, ms-graph, oss-rdbms`. Also `--scope` ("Space-separated scopes in Microsoft Entra v2.0. Default to Azure Resource Manager.") and `--tenant`. "The token will be valid for at least 5 minutes with the maximum at 60 minutes." Output `expires_on` = POSIX timestamp; `expiresOn` = local datetime.
- `[I]` Azure CLI / Az PowerShell tokens are **delegated** tokens for a Microsoft first-party client app → subject to the delegated caveats: tenant admin must have consented `ThreatHunting.Read.All` (delegated variant AdminConsentRequired = Yes) to that client app, and the signed-in user must hold Security Reader or Security Administrator. Microsoft docs do not state that the CLI app carries these scopes.
- `[D]` Microsoft Graph PowerShell can request scopes by name: `Connect-MgGraph -Scopes "User.Read.All", "Group.ReadWrite.All"` (interactive) or `-UseDeviceAuthentication`. App-only via `-ClientSecretCredential`, `-CertificateThumbprint`/`-CertificateName`/`-Certificate`, `-Identity`.

### Throttling / retry
- `[D]` `/security` limits (per app per tenant) — see §1 table. `Retry-After: 10` (seconds) on the generic 429.
- `[D]` Documented backoff, verbatim: "1. Wait the number of seconds specified in the `Retry-After` header. 2. Retry the request. 3. If the request fails again with a 429 error code, you're still being throttled. Continue to use the recommended `Retry-After` delay and retry the request until it succeeds." Plus "Avoid immediate retries, because all requests accrue against your usage limits."
- `[I]` The "Security detections and incidents" include has **no** Retry-After exception note, so combined with "All the resources and APIs described in the Service-specific limits provide a `Retry-After` header except where indicated", 429s on `/security` should carry `Retry-After`. **Derived from an absence, not an affirmative statement.**
- `[D]` Documented Retry-After **exceptions** in adjacent namespaces: "Information protection service limits" (`/informationProtection`), "Identity and access data policy operation service limits", "Identity protection and conditional access service limits" — each followed by "The resources listed earlier don't return a `Retry-After` header on `429 Too Many Requests` responses." `/informationProtection` limits: POST 150 requests per 15 minutes and 10,000 requests per 24 hours per tenant; one request per 15 minutes and 3 requests per 24 hours per resource.
- `[D]` JSON batching: "Requests in a batch are evaluated individually against throttling limits and if any request exceeds the limits, it fails with a status code of `429` … The batch itself succeeds with a status code of `200` (OK). … You should retry each failed request from the batch using the value provided in the `retry-after` response header from the JSON content." and "throttled requests that were part of a batch aren't retried automatically."

---

## 8. Must be settled by a live probe

### alerts_v2 — query parameters, paging, limits
1. What is the maximum accepted value of `$top` for `/security/alerts_v2`? (Send `$top=1`, `100`, `1000`, `2000`, `10000`; record 400 `InvalidRequest` vs silent clamp vs honored — count items in `value`.)
2. What is the default page size when `$top` is omitted? (GET with no query params; count `value` length on page 1.)
3. Does `/security/alerts_v2` accept `$orderby`, on which properties, and is an unsupported parameter rejected with an error or silently ignored? (Try `$orderby=createdDateTime desc`, `$orderby=severity`, `$orderby=lastUpdateDateTime`; record 200 vs 400 and the exact `code`/`message`.)
4. Which alerts_v2 properties are actually sortable?
5. Do `$select` and `$expand` work on `/security/alerts_v2`? (Try `$select=id,severity,createdDateTime` and `$expand=comments`; record 200 vs 400.)
6. Is `$search` supported on `/security/alerts_v2`?
7. Does `$count=true` return `@odata.count` for alerts_v2, and is it present only on the first page?
8. Is there a hard cap on total alerts retrievable via paging (e.g. a `$skip` depth ceiling near 10,000)? (Follow `@odata.nextLink` continuously; record the offset at which the server errors or stops emitting nextLink; try explicit `$skip=10000` and `$skip=10001`.)
9. Does the alerts_v2 `@odata.nextLink` carry `$skip` or `$skiptoken`? (Inspect the literal URL.)
10. Does `$filter=evidence/any(...)` actually work on v1.0 alerts_v2, despite `evidence` being absent from the 8-property filterable list?
11. Which HTTP status codes other than 200 does `GET /security/alerts_v2/{alertId}` return — 404 for unknown id, 403 for insufficient scope, 429?
12. Is there a per-request timeout or execution-time quota for alerts_v2?
13. What is the actual retention window for alerts returned by alerts_v2 (docs say only "within the time range you specified in your environment retention policy")?
14. Which legacy `/security/alerts` retirement date is authoritative — October 15, 2026 or August 31, 2026 — i.e. does the endpoint still return data today?

### alerts_v2 — enums, Prefer header, field population
15. Do the post-`unknownFutureValue` `serviceSource` members (`microsoftDefenderForCloud`, `microsoftSentinel`, `microsoftInsiderRiskManagement`, `microsoftThreatIntelligence`, `microsoftSecurityForAI`) require `Prefer: include-unknown-enum-members`, or do they deserialize as `unknownFutureValue` without it? (Probe with and without the header.)
16. Does `$filter=serviceSource eq 'microsoftSentinel'` return results without `Prefer: include-unknown-enum-members`, and what HTTP status/error body results if a gated enum literal is rejected in a filter expression?
17. Does `microsoftInsiderRiskManagement` (serviceSource 1024, absent from the docs table) ever appear on the wire, and do docs-generated SDKs fail to deserialize it?
18. Is `productName` ever populated on alerts_v2 responses — present, null, or omitted — specifically for Sentinel-sourced alerts?
19. Is `alertPolicyId` (in the properties table and CSDL but omitted from the JSON representation block) returned on the wire, and for which `serviceSource` values?
20. Can `detectionSource` be null/absent on the wire (CSDL does not mark it `Nullable="false"`), and what should a client do when it is missing?

### runHuntingQuery — errors and quotas
21. What is the exact JSON error body and `code` string for a purely **syntactic** KQL parse failure (unbalanced quotes, stray pipe) on `POST /security/runHuntingQuery`? (Candidates seen elsewhere but unconfirmed for this endpoint: `Query could not be parsed at ...`, `SYN0002: A recognition error occurred`, `Fix syntax errors in your query.`)
22. Do syntax errors and semantic errors return different top-level `code` values, or both `BadRequest`?
23. Does a table that exists in the advanced hunting schema but is **not licensed/onboarded** in the tenant return the same 400 "Failed to resolve table or column expression named X", or a distinct status/code (e.g. 403 with a licensing code)?
24. What exact HTTP status, `code` string and `message` does runHuntingQuery return when a valid token lacks the `ThreatHunting.Read.All` role or admin consent? (Do not assume `accessDenied`, `Authorization_RequestDenied`, or `Forbidden`.)
25. Is a missing-role failure on runHuntingQuery surfaced as 403 or as 401?
26. What is the exact 429 JSON body for `POST /security/runHuntingQuery` — is the top-level `code` `TooManyRequests` or a Defender/hunting-specific string, and what text distinguishes "request-count quota exceeded" from "CPU/running-time quota exceeded"?
27. Does `POST /security/runHuntingQuery` emit a `Retry-After` header on 429, and in what unit / typical value?
28. Do 429s from `/security/alerts_v2` and `/security/incidents` carry a `Retry-After` header? (Log response headers.)
29. Does the 15-minute CPU-block cycle produce a 429 or some other status, and is it reported with a distinct error code and a `Retry-After`?
30. Does the documented 150 requests-per-minute-per-app-per-tenant limit on `alert` actually govern `/security/alerts_v2`, `/security/incidents` and `/security/runHuntingQuery`, or only the legacy `/security/alerts`? (Burst >150 req/min and observe 429 + Retry-After.)
31. Does the Graph v1.0 runHuntingQuery endpoint have an hourly call cap and/or a concurrency cap, and running-time-per-hour / per-day budgets? (Only "at least 45 calls per minute per tenant" is documented; 1,500/hr, 10 min/hr and 3 hr/day are legacy-MDE-only.)
32. What HTTP status and body does a Graph runHuntingQuery request return when it exceeds the three-minute timeout (504? 400? 429?)?
33. What is the exact status and message for the 50 MB result-size overflow on the **Graph** endpoint (only the legacy MDE endpoint publishes the 400 message string)?
34. Are runHuntingQuery error `message` values stable enough to pattern-match on (e.g. "Fix semantic errors in your query.")? Microsoft explicitly documents that message content can change.
35. Does the `workspaceId` fallback ("If the workspace isn't found or not accessible, the service falls back to the caller's primary workspace") ever produce an error instead of a silent fallback?
36. Does `workspaceId` require any additional Log Analytics workspace grant for an app-only token?
37. Is `ThreatHunting.Read.All` honoured for a Sentinel-only tenant that has **not** onboarded Sentinel to the Defender portal?

### KQL support and schema discovery
38. Is `getschema` accepted by Defender XDR advanced hunting via runHuntingQuery? (`{"Query":"DeviceInfo | getschema"}` — record status + body.)
39. Is `union isfuzzy=true` accepted, and does it tolerate a non-existent table name (returning rows for the existing tables) instead of failing with `A recognition error occurred.`? (Compare `{"Query":"union isfuzzy=true DeviceInfo, ThisTableDoesNotExist | take 1"}` against the same without `isfuzzy`.)
40. Is `evaluate` accepted in advanced hunting, and which plugins (`bag_unpack`, `ipv4_lookup`, `pivot`, `narrow`, …) are permitted?
41. Are Kusto control commands (leading `.`, e.g. `.show tables`, `.show databases entities`, `.show version`) rejected by advanced hunting, and with exactly what error message and HTTP status?
42. Is there ANY programmatic way to enumerate the tables available to a tenant in advanced hunting? (Test `.show tables`, `.show databases entities`, `search * | getschema`, `union * | take 0 | getschema`, and any undocumented Graph route.)
43. Does advanced hunting expose `ingestion_time()`, `external_table()`, `stored_query_results`, or `.show` variants at all?
44. Does `externaldata` work when called through the API (not just the portal), and are outbound URIs subject to an allowlist / egress restriction?
45. What is the maximum accepted `Timespan` value for runHuntingQuery (`P90D` appears in an official example, exceeding the stated 30-day native retention), and what happens when `Timespan` exceeds available retention?
46. When the 100,000-row cap is hit via the API, are results silently truncated or is an error raised?
47. Which result-size limit applies when a query is issued via API against a Sentinel-onboarded tenant — the portal's 64 MB or the API's 50 MB?
48. Is `Timespan` prose that says "60 days" or the body value `P90D` the correct description of the documented Example 2 behavior?

### Tables, alert identity, and mapping
49. Does AlertInfo contain exactly one row per `AlertId`, or can an alert be re-emitted (status change, enrichment) producing multiple AlertInfo rows with the same `AlertId`?
50. Is AlertEvidence one row per (`AlertId`, entity), or can the same entity appear twice for one alert? (No documented uniqueness key; AlertEvidence has no `ReportId`.)
51. What is the complete enumeration of `EntityType`, `EvidenceRole` and `EvidenceDirection` values in AlertEvidence?
52. Does `AlertEvidence.Timestamp` carry the alert's generation time (matching `AlertInfo.Timestamp`) or the time of the underlying entity event?
53. Is alerts_v2 `id` equal to AlertInfo `AlertId` for **every** `serviceSource` value, or only for Defender-workload alerts? (Sentinel-sourced alerts are the likeliest divergence.)
54. When does alerts_v2 `providerAlertId` differ from `id`, and for which providers?
55. Does `AlertInfo.Timestamp` equal alerts_v2 `firstActivityDateTime` exactly, or is it closer to `createdDateTime`?
56. Does `detectorId` on alerts with `serviceSource: microsoftSentinel` literally carry the Sentinel analytics rule ID — i.e. does it equal `SecurityAlert.AlertType` for scheduled/NRT rule alerts? (Join alerts_v2 `detectorId` against the workspace's analytics rule IDs and against `SecurityAlert.AlertType` for the same alerts.)
57. Is `detectorId` stable across alert instances of the same detection rule, or can it vary per instance? (Pull many alerts from one known rule; check `detectorId` is constant.)
58. Which alertEvidence subtypes actually appear on Sentinel-sourced alerts, and are Sentinel `SecurityAlert.Entities` types lossily projected onto the 48 Graph evidence subtypes or dropped?
59. What is the uniqueness scope of `ReportId` in EmailEvents, CloudAppEvents, IdentityLogonEvents and IdentityInfo (per tenant? per table? global?)?
60. Does IdentityInfo hold one row per identity or an append-only history, and what is the correct dedup query?
61. Can DeviceLogonEvents ever surface the Entra object id or UPN of the account that logged on (as opposed to `InitiatingProcessAccountObjectId`/`InitiatingProcessAccountUpn`), and can `AccountSid` be resolved reliably?
62. Is there a supported way to go from an AlertEvidence row back to the exact source event row in a Device*/Email/CloudApp table?
63. Does the advanced hunting API / KQL surface enforce join-cardinality or row limits when joining AlertEvidence to the large Device* tables?

### Authentication
64. What exact `error.code` string does Microsoft Graph return in the 403 body when an app-only token lacks the required app role for the `/security` namespace (`accessDenied`? `Forbidden`? `UnknownError`? `Authorization_RequestDenied`?)
65. Does the token endpoint ever refuse to issue a token (vs. issuing a role-less one) when the app registration has `SecurityAlert.Read.All` / `ThreatHunting.Read.All` configured but zero permissions granted in the tenant — 200 with a token, or an AADSTS error?
66. Does the Graph client-credentials token response always include `ext_expires_in`, or only sometimes?
67. Is the Azure CLI first-party application pre-authorized for, or admin-consentable for, delegated `ThreatHunting.Read.All` / `SecurityAlert.Read.All`?
68. Can `Get-AzAccessToken` (Az.Accounts) mint a Microsoft Graph token carrying `ThreatHunting.Read.All`, and which first-party client app does it use?
69. Are `AzureCliCredential`, `AzureDeveloperCliCredential`, `DefaultAzureCredential` and `EnvironmentCredential` usable with the Graph SDK against `/security` (none are listed on the choose-authentication-providers page)?
---

## 9. The live half — what a real tenant answered

**Status:** Phase 0 complete. **Method:** `scripts/probe-defender.ts` against one public-cloud tenant,
2026-08-25, four runs totalling ~155 Graph calls. Raw request/response records and the generated
findings are under `.data/defender-probe/<timestamp>/`, which is gitignored — this section is the
committed extract, scrubbed of tenant identifiers.

This section closes PRD-8 §4.1 D12. Everything above is desk research tagged `[D]` / `[I]` / `[C]`;
everything here is tagged `[M]` **measured** or `[U]` **unanswerable on this tenant**. A `[M]` claim
comes from one tenant on one day and is evidence, not a contract — where a single tenant cannot
settle something, it says so rather than generalising.

### 9.1 What the documentation got wrong

Three findings reverse or narrow what §1–§8 concluded.

- `[M]` **Schema discovery is one call, not a vendored manifest.** §4 recorded that neither
  `getschema` nor `union isfuzzy=true` appears anywhere in the advanced-hunting documentation set,
  and PRD-8 §4.2 named the pinned manifest the expected outcome. **Both operators work, and they
  compose.** One `union isfuzzy=true` over 41 `getschema` legs returned **366 column definitions
  across 18 tables in a single request**, 3,311 characters of query text, no "Query size exceeded".
  `isfuzzy` absorbs the legs whose tables the tenant lacks, so the licence-dependent table set needs
  no configuration. Mechanism 4 is unnecessary; PRD-8 §4.2's expectation is reversed.
- `[M]` **A zero-row result still carries its full `schema`.** `AlertEvidence | take 0` returned 43
  column definitions and no rows. Mechanisms 1 and 3 therefore collapse: the call that proves a table
  exists also returns its columns.
- `[M]` **`print` is accepted**, as is `getschema`. Both are core KQL undocumented for this surface.
  Kusto control commands are rejected: `.show tables` → `400`, *"The incomplete fragment is
  unexpected.. Fix syntax errors in your query."*

### 9.2 The error contract

- `[M]` A semantic failure, a syntax failure and an unresolvable table **all** return `400` with
  `error.code` `BadRequest`. §8 #22 is answered: `code` cannot discriminate between them.
- `[M]` The engine's message is passed through **verbatim** and names what it rejected —
  `'project' operator: Failed to resolve scalar expression named 'ProbeColumnThatDoesNotExist'. Fix
  semantic errors in your query.` This is what makes ADR 010 §3 reachable, and it was observed
  working: the Phase 1 live investigation repaired two of its own queries from these messages.
- `[M]` An unresolvable table is a **`400`, not a `403`** — confirming §3's `[I]` reading. A missing
  table can never be misread as a permission failure.
- `[M]` **The nested member carries no `code` and no `message`.** Every `400` collected carried
  `innerError: { date, request-id, client-request-id }` and nothing else. This is not a detail: an
  error schema requiring either field fails to parse every real rejection, and a connector would then
  substitute a generic message for the diagnostic the model needs. Only the `innerError` spelling was
  observed; §3's tolerance for `innererror` stands, because the documentation uses it.

### 9.3 `alerts_v2`

- `[M]` `$orderby=createdDateTime desc` is **accepted** with `200`, while the documented parameter
  list still omits it. Accepted-and-ignored remains the likeliest reading, and it does not change
  PRD-8 D14: a window is the only *stated* selection criterion, so the connector bounds by window.
- `[M]` `$count=true`, `$select` and `$top=1000` are all accepted. `$filter=createdDateTime ge <iso>`
  works, which is what makes the window expressible.
- `[U]` **Page size and the `$top` ceiling are unmeasurable here.** This tenant holds one alert
  (`@odata.count` = 1), so "default page size 1" and "`$top=1000` honoured" are both restatements of
  the alert count. Needs a tenant with more alerts than the requested `$top`.
- `[M]` An unknown alert id returns `404` / `ResourceNotFound`. The list id and the item id address
  the same alert, which `getAlert()` depends on.
- `[U]` **The Prefer header could not be cleared.** With and without
  `Prefer: include-unknown-enum-members` the same alert returned
  `microsoftDefenderForEndpoint / antivirus` — not a post-`unknownFutureValue` member, so this sample
  could not have shown a difference. The header stays mandatory on §6's documented grounds.

### 9.4 Alert mapping

- `[U]` **§7 Q4 is unanswerable on this tenant, so `alertType` is left unmapped.** PRD-8 §4.2
  proposed `detectorId` by elimination and required confirmation against real alerts. With one alert,
  every (title, detectionSource) group is a singleton and "one distinct `detectorId` per group" is a
  tautology rather than a measurement. §4.2's own rule then applies: the field is left `undefined`.
  Settling it needs one detection that has fired more than once.
- `[M]` Over the one alert available, every other mapped field populated —
  `severity`, `status`, `firstActivityDateTime`, `lastActivityDateTime`, `createdDateTime`,
  `categories`, `evidence`, `incidentId` — except `mitreTechniques`, which was absent. `[U]` A fill
  rate over one alert describes that alert, not the product.
- `[M]` `compromisedEntity` has no Graph equivalent, as §6 recorded. Left `undefined` rather than
  derived from `evidence`.

### 9.5 Result shape

- `[M]` **Result keys match `schema` names exactly.** §3's `[C]` casing contradiction did not
  materialise here.
- `[M]` **Rows carry keys `schema` never names** — OData annotations such as
  `ProbeMixedCaseOne@odata.type`. This is independent evidence for PRD-8 D4's rule that column order
  comes from `schema` and never from `Object.keys()`: a projection built from row keys would emit
  phantom columns as well as depending on which row arrived first.

### 9.6 Quotas, workspace and authentication

- `[M]` **A `workspaceId` no tenant owns is accepted with `200`** and answered from the primary
  workspace, confirming §3's documented silent fallback. A misconfigured `DEFENDER_WORKSPACE_ID`
  looks exactly like success, so a `200` is not evidence the configured workspace was used.
- `[U]` **§7 Q5 could not be settled.** `DEFENDER_WORKSPACE_ID` is unset on this tenant, and the
  parameter selects a *Sentinel* workspace — which this tenant has not onboarded (§7 Q9) — so an
  identical result proves nothing either way.
- `[U]` **§7 Q11 was not measured, deliberately.** No call was throttled. Forcing a `429` means
  exhausting the tenant's shared hunting CPU allowance, which blocks every other consumer until the
  next 15-minute cycle. The probe records `Retry-After` when it receives one; it does not manufacture
  one. Since PRD-7 §8 excluded retries, this determines only what a typed error can tell an operator.
- `[M]` The token endpoint **issues** a token (§8 #65), and `ext_expires_in` was present.
- `[U]` **§7 Q10's failure mode is unmeasured on a consented registration.** The first Graph call
  succeeded, so the missing-role `403` body shape was never seen. Measuring it would mean
  deliberately removing consent.

### 9.7 What this tenant actually holds

`[M]` 18 of 41 candidate tables resolve; 23 return `400`. Column counts from the batched call:

```text
AADSignInEventsBeta(46)  AADSpnSignInEventsBeta(20)  AlertEvidence(43)  AlertInfo(9)
BehaviorEntities(37)     BehaviorInfo(15)            CloudAppEvents(36) IdentityInfo(46)
IdentityLogonEvents(28)  ExposureGraphEdges(11)      ExposureGraphNodes(6)
DeviceTvmInfoGathering(6)                DeviceTvmInfoGatheringKB(5)
DeviceTvmSecureConfigurationAssessment(12)  DeviceTvmSecureConfigurationAssessmentKB(10)
DeviceTvmSoftwareInventory(11)  DeviceTvmSoftwareVulnerabilities(15)
DeviceTvmSoftwareVulnerabilitiesKB(10)
```

**No `Device*` event tables and no Email tables at all** — despite the tenant's one alert being an
MDE antivirus detection. A Defender-standalone investigation here reaches identity, cloud-app,
vulnerability-management and exposure-graph telemetry, not endpoint or email. That is a property of
this tenant's licensing, and it bounds what any investigation run against it can conclude.

`[M]` **§7 Q9 corroborated:** every alert carried `serviceSource: microsoftDefenderForEndpoint`. No
`microsoftSentinel` entry, consistent with the workspace not being onboarded.

### 9.8 Row widths — the number behind `DEFENDER_QUERY_MAX_ROWS`

`[M]` Whole rows (`| take 50`, no projection), serialised positionally as the connector emits them:

| Table | Columns | Median | p95 | Max | Null cells |
|---|---|---|---|---|---|
| `CloudAppEvents` | 36 | 4,299 | 4,987 | 7,979 | 7% |
| `IdentityLogonEvents` | 28 | 859 | 903 | 946 | 0% |
| `AlertInfo` / `AlertEvidence` | 9 / 43 | — | — | — | no rows in 30 days |

At the widest p95, `INVESTIGATOR_RESULT_MAX_CHARS` (40,000) runs out at roughly **8 whole rows**.
Read as a lower bound: these are unprojected rows, and a realistic query projecting eight of forty
columns fits several times more. PRD-8 D15 asks the cap to sit high enough that characters bind
before rows and low enough that a runaway query cannot drag 100,000 rows across — 500 satisfies both.

### 9.9 Turn-0 context — the Phase 2 gate

`[M]` Table **names** only, in the labelled per-source shape PRD-8 §4.2 specifies:

| | Tables | Characters | ≈ tokens |
|---|---|---|---|
| Defender alone | 18 | 535 | 134 |
| Mock Sentinel | 23 | 557 | 140 |
| **Both blocks** | 41 | **1,094** | **≈274** |

**§7 Q2 is answered and Phase 2 was not gated on `roadmap.md` §3.** Two active sources cost about
274 tokens of turn-0 context, which is not a context-budget problem, so PRD-8 §5's stop-and-ask
condition did not trigger and Phase 2 proceeded.

Three caveats on the number. Token figures are a chars/4 estimate rather than a tokeniser. Both
halves are small: 18 Defender tables on a partially licensed tenant and 23 Mock Sentinel tables, and
a fully licensed tenant against a production workspace would be larger on both sides. And this
measures **names only** — the full schema stays in the harness and never enters context (ADR 005 §4),
so the number says nothing about what `get_security_schema` costs once the agent starts pulling
column lists for 43-column tables.

### 9.10 Still open

| Question | Why it stayed open | What would close it |
|---|---|---|
| §7 Q4 — is `detectorId` the honest `alertType`? | One alert; every group a singleton | One detection that has fired more than once |
| §7 Q5 — does `DEFENDER_WORKSPACE_ID` change anything? | Unset, and the tenant has no onboarded workspace | A tenant with Sentinel onboarded to the Defender portal |
| §7 Q10 — the unconsented failure mode | This registration is consented | A deliberately unconsented registration |
| §7 Q11 — does a `429` carry `Retry-After`? | Not provoked, on purpose | Nothing; wait for one to occur naturally |
| §8 #1, #2 — `$top` ceiling and default page size | One alert in the tenant | More alerts than the requested `$top` |
| §8 #15 — does the Prefer header change the wire? | No post-`unknownFutureValue` member present | An alert whose `serviceSource` is one of the gated members |
