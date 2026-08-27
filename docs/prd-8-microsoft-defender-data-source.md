# PRD-8 — Microsoft Defender Data Source

**Status:** Complete — Phase 0, Phase 1 and Phase 2 delivered (ADR 011)
**Depends on:** PRD-7 — Real Microsoft Sentinel Connector
**Produces:** ADR 011 — Multi-source security data and the Microsoft Defender connector
**Reverses:** ADR 010 §4 ("Startup selects one bundle containing `SecurityDataSource` and one
profile"); `AGENTS.md` §2 ("a live second-SIEM connector")
**Amends:** ADR 010 §4 (prompt provenance hashes every active profile); ADR 010 §5 (the artifact's
source block becomes a set with a named primary); `AGENTS.md` §3, §10

## 1. Purpose

The system only speaks Sentinel. Every path from configuration to alert to query assumes a Log
Analytics workspace: `SENTINEL_CONNECTOR` chooses between two transports, and both read the
`SecurityAlert` table with KQL against the Logs endpoint. Mock Sentinel and Azure are two transports
of one product — so the boundary ADR 010 drew to make sources substitutable has never had a second
product to substitute.

**A tenant whose detections live in Microsoft Defender XDR therefore cannot use this system at
all.** Not "cannot use it well": its alerts are not rows in a workspace and its telemetry is not
addressable through the Logs query endpoint, so every hop in the chain is inapplicable rather than
merely unconfigured. Removing that is what this document is for, and Phase 1 alone removes it.

There is a second and smaller cost for a tenant running both products. Defender holds the endpoint,
identity and email telemetry an alert most often needs; the workspace holds whatever else was
ingested. An investigation confined to one stops at the product boundary rather than at the answer,
and the agent cannot even report that it stopped there, because it was never told the other half
existed. Phase 2 addresses this. Phase 1 does not, and does not need to.

**What this does not buy is measurement.** The tempting argument — that a second product would
finally show whether the agent has investigative skill or merely a fit to Sentinel's vocabulary — is
wrong here, and it is worth killing at the top rather than discovering in §3. Real-tenant runs write
to `.data/` and never enter the committed corpus (D10), and `scripts/evaluate-runs.ts` joins to
`fixtures/scenarios/`, so a Defender run is unscored by construction. Comparing two products would
need ground truth for the second one; that is different work and is not proposed here.

PRD-7 asked what breaks when the data is real. This asks what breaks when the *product* is
different — and the answer arrives as a working investigation against Defender, not as a score.

## 2. Goals

- **The system runs on Defender alone.** No Sentinel credential, no workspace, no Mock Sentinel
  process. This is the outcome the rest of the list serves, and Phase 1 delivers it on its own.
- A read-only Microsoft Defender connector behind ADR 010's `SecurityDataSource` boundary, reached
  through the Microsoft Graph security API and adding no new dependency.
- Sentinel addable later without re-onboarding Defender, and vice versa. Neither product is the
  other's prerequisite, in either direction.
- Several sources active within one investigation, with exactly one of them holding the primary
  alert role and the others queryable.
- Query guidance that travels with the Defender profile, so the agent arrives knowing the
  advanced-hunting vocabulary rather than discovering it by failed query.
- PRD-7's secret handling and test tiering carried over without dilution: an all-or-none credential
  group, deterministic tests over mocked transport, one live smoke test that gates itself out.
- Design choices closed by probing the real API, not by argument from documentation — which matters
  more than usual here, because the documentation contradicts itself on several of them.

## 3. Non-Goals

Tempting adjacent work this PRD does not do, and where it goes instead.

- **Merging or deduplicating alerts across sources.** Locked out by §4.1 D5, not deferred. A third
  source's alerts would arrive the same way — through the primary switch, one at a time.
- **The Defender incidents API, and incident-level grouping.** Excluded because an incident is a
  different investigation unit, not because it is expensive — on Graph it is nearly free (D1). A
  later PRD, and D1 records why it will be worth one: incident membership cannot be queried from
  either the alerts API or advanced hunting.
- **Any write path** — alert update, comment, classification, determination, or Defender's response
  actions. This project never mutates a tenant (PRD-7). Not on the roadmap either.
- **The legacy Microsoft Defender for Endpoint APIs** at `api.securitycenter.microsoft.com`.
  Superseded by Graph and endpoint-only; see §4.1 D1.
- **A Defender equivalent of Mock Sentinel.** No emulator, no fixture service, no vendored Defender
  telemetry. The in-memory FixtureQL bundle of ADR 010 §6 already proves the seam; a second mock
  would be a second corpus to maintain and would measure nothing.
- **Defender ground truth, scenarios or evaluation.** `scripts/evaluate-runs.ts` stays joined to
  `fixtures/scenarios/` and the Mock Sentinel corpus. Defender runs are unscored by construction —
  they write to `.data/` (§4.1 D10) and never enter the scored set.
- **A connector registry or plugin discovery.** ADR 010 §4's rejection is upheld on refreshed
  grounds; see §4.1 D6.
- **Delegated or developer credentials for Defender** (`az login`, `Connect-AzAccount`, device
  code, interactive browser). A deliberate divergence from ADR 009 §3; see §4.1 D2.
- **Sovereign and national clouds**, certificates, managed identity and workload identity
  federation. One public-cloud service principal, as PRD-7 §8 scoped for Azure.
- **Fixing the startup-context size.** Two active sources make it worse, and §7 Q2 measures how much
  — but relevant-schema selection and context budgeting stay roadmap §3.
- **A third integration.** The static map of §4.1 D6 is built so a third is one entry plus a
  profile; adding one is not this PRD's work.

## 4. Design

### 4.1 Decisions (locked)

**D1 — Microsoft Graph is the single data plane.** Alerts come from `GET /security/alerts_v2`,
telemetry from `POST /security/runHuntingQuery`, both under one token audience and one host.

*Rejected: the Defender for Endpoint APIs at `api.securitycenter.microsoft.com`.* They reach
endpoint telemetry only, where Graph's advanced hunting reaches identity, email and cloud-app
tables through the same query language and the same token — a narrower surface for the same
integration effort.

*Rejected: the Defender incidents API — but not for ADR 009's reasons.* ADR 009 rejected Sentinel's
incident ARM API over ARM resource configuration and a second token audience. Neither cost exists
here: `GET /security/incidents` is the same host, the same `graph.microsoft.com/.default` token and
the same connector, needing only one more permission. That rationale does not transfer and is not
borrowed.

It stays out for two reasons of its own, and both are `AGENTS.md` §15 stop-and-ask conditions rather
than preferences. ADR 010's boundary is *alert-oriented* — an incident is a different unit, a group
of alerts, and retrieving one is a second investigation capability outside the approved boundary.
And the run artifact, the evaluation join and the console queue are all keyed on one alert id, so an
incident-shaped run changes the measurement and not merely the code.

Worth recording for whoever picks this up: `incidentId` is **not** among the eight filterable
properties on `alerts_v2`, and `AlertInfo`'s eight columns carry no incident column either. So
sibling alerts of an incident are reachable *only* through `GET /security/incidents/{id}?$expand=alerts`
— there is no workaround through the alerts API or through advanced hunting. That makes this a
sharper gap than a nice-to-have, and it belongs in its own PRD rather than being quietly widened
into this one.

**D2 — A service-principal triple, all-or-none, with no developer fallback.**
`DEFENDER_TENANT_ID`, `DEFENDER_CLIENT_ID` and `DEFENDER_CLIENT_SECRET` are required together; a
partial group is a configuration error naming the missing keys, never a silent fallback to another
identity. Absent the whole group, the Defender source is simply not active.

This mirrors ADR 009 §3's all-or-none rule and then deliberately diverges from it. Azure falls back
to `AzureCliCredential` then `AzurePowerShellCredential` when the triple is absent; Defender has no
such chain, because developer sign-in is not a verified path to `ThreatHunting.Read.All` — a fact
`.env.example` already records. **This is a divergence, not an omission**, and ADR 011 states it as
one so a later reader does not "fix" it.

**D3 — No new dependency.** `ClientSecretCredential` from `@azure/identity`, already present for
PRD-7, against the Graph `.default` scope. Transport stays `fetch`, `AbortSignal.timeout` and Zod.

*Rejected: `@microsoft/microsoft-graph-client` and the Graph SDKs.* The connector calls two
endpoints. ADR 009 §3's finding — that one Azure Identity dependency covers the observed
authentication need and the SDKs do not earn their surface — holds unchanged here.

**D4 — Object-keyed hunting results project to positional rows.** `runHuntingQuery` returns
`{ schema: [{name, type}], results: [{Column: value}] }`: objects keyed by column name, where Log
Analytics returns positional arrays. ADR 010 §3's common result is positional, so the connector
projects each result object through `schema` order, emitting `null` for a key the object lacks
rather than dropping or reordering a column. Column order comes from `schema` and from nothing
else — never from `Object.keys()` of the first row, which would make column order depend on which
row happened to come back first.

**D5 — Exactly one source produces alerts: whichever one is primary.** `listAlerts()` and
`getAlert()` are called on the primary source and on no other.

Primacy is a **configured role, not a property of a connector**. `PRIMARY_ALERT_SOURCE` reassigns
it, and a source that produced every alert in one run produces none in the next if the setting
moves. What this rule forbids is two sources producing alerts *at the same time* — not any
particular source producing them. Every active source is queryable in every run regardless of which
one holds the role.

Moving the role is a configuration change like any other, so ADR 008 §3 folds it into the derived
condition key and runs either side of the move are correctly different conditions. And because only
one source produces alerts at a time, alert ids from two products never coexist in a run — which is
what keeps the evaluation join and the console queue safe without either of them knowing that more
than one source exists.

*Rejected: merging alerts across active sources.* A Sentinel workspace onboarded into the Defender
portal surfaces the same detection through both APIs under different identifiers, so an unguarded
merge double-counts. Deduplicating instead would mean mapping two products' identity schemes onto
each other — precisely the cross-product taxonomy ADR 010 §2 rejected. It would also break the
evaluation join, which is keyed on one source's alert id, and the queue, which assumes an alert id
addresses one alert.

The overlap is a portal setting away rather than hypothetical: Sentinel alerts surface in
`alerts_v2` precisely when the workspace is onboarded to the Defender portal. This tenant is not
onboarded today (§7 Q9), so the two sources are disjoint right now — which is exactly why the rule
is written as a decision rather than left to be discovered. A merge that is only correct while a
setting stays off is not a rule, and the setting is changed by someone who has never read this
document.

`getCorpus()` follows the same rule and for the same reason: corpus identity describes the data the
alerts came from, so it is read from the primary alone. A Defender primary returns `undefined`, as
the Azure connector already does, and the artifact records no corpus rather than a borrowed one.

**D6 — Startup selects an ordered set of bundles, exactly one of them primary.** This reverses
ADR 010 §4's "startup selects one bundle".

`SECURITY_SOURCES` is an ordered list of source ids, defaulting to `sentinel`. `PRIMARY_ALERT_SOURCE`
names one of the active ids; with a single active source it defaults to that source, and with more
than one it is required rather than guessed. Ids resolve through a **static map of bundle
factories** — adding a fourth integration is one entry in that map plus a profile.

*Rejected: a registry with runtime discovery.* ADR 010 §4 rejected one on the premise that there was
no third deployable source. That premise has expired, so the rejection is restated on the reason
that survives it: `toolDescriptors()` and the prompt-provenance hash must be derivable by reading
source, and a discovered source set is not. Nothing in this project consumes a connector it did not
write, so a plugin protocol would buy lifecycle and partial-failure semantics for no consumer.

*Rejected: reaching Sentinel through Defender's `workspace()` operator.* Advanced hunting supports
`workspace('<id>').<Table>`, so one Defender connector could in principle query Sentinel tables and
make a second connector unnecessary. Rejected on three counts: it works only for Sentinel tables and
only when the workspace is onboarded, it is unsupported in GCC and with GDAP, and — decisively — it
collapses two sources into one source identity, so the artifact, the provenance hash and the
condition key could no longer say which product answered. It also inverts the requirement: Defender
would become Sentinel's prerequisite, where §2 asks for neither to depend on the other.

**D7 — What the harness may branch on.** ADR 010 §4 says the harness contains "no source-id
branch". As written, that is reversed: the harness now holds a source-id keyed map and routes
through it. The narrower rule survives and is the one that was load-bearing — **no branch on source
kind, connector or query language.** `sources.get(id)` is routing; `if (kind === "defender")` stays
forbidden, and `AGENTS.md` §3 is amended to say so rather than left to be read as violated.

**D8 — `{ query }` becomes `{ query, source? }`: one static shape.** Both `get_security_schema` and
`query_security_data` gain an optional `source` parameter naming an active source id; omitted, it
means the primary. Tool names do not change. The schema is not per-source and not built at runtime,
and an unrecognised id returns a correctable tool error the way an invalid query does — Pi validates
shape, the tool validates membership.

ADR 010 §4's rejection of dynamic tool schemas and names is therefore **upheld**: this is one more
static property on a stable tool, not a schema that varies by deployment.

**D9 — Provenance hashes every active profile; the artifact records the set.**
`provenanceForProfile` becomes plural, hashing each active profile's prompt-visible content in
source order — inactive profiles, client implementations and credentials stay excluded exactly as
ADR 010 §4 requires. `config.source` keeps its current shape and carries the **primary**;
`config.sources` carries the ordered active set. ADR 008 §3 hashes the whole of `config`, so both
enter the derived condition key with no contract edit.

This is a measurement change and it is intended: runs before and after Phase 2 are different
conditions and must not merge into one cell. No existing artifact is rewritten, and a reader that
finds `config.sources` absent renders a single-source run, never a fabricated set.

**D10 — Any active live-tenant source forces the whole run under `.data/`.**
`assertAzureArtifactDirectories` generalises over the active set: if *any* active source reads a
real tenant, the run and trace directories must sit under `.data/`. `SENTINEL_CONNECTOR=mock`
alongside an active Defender still writes to `.data/`, never `runs/` — a mixed run is a development
convenience and must not enter the committed scored corpus (`AGENTS.md` §5, ADR 009 §5). The rule is
about the presence of tenant data anywhere in the run, not about which source produced the alert.

**D11 — Defender ships a query-instruction overlay, as Sentinel does.**
`DEFENDER_QUERY_INSTRUCTIONS` sits beside `SENTINEL_QUERY_INSTRUCTIONS` and activates on first use
of a Defender tool, so the initial system prompt stays free of query tactics. Its *content* is
written from Phase 0's measured findings, not from the published schema reference.

**D12 — Phase 0 precedes design commitment.** No connector code lands before the probe has run
against a real tenant and its findings are recorded in `docs/research-defender-api.md`. Several
choices below are stated as options with a decision procedure rather than as answers — schema
discovery, result-key casing, the `alertType` mapping — because the documentation is thin or
self-contradictory on each, and guessing them would put an unfalsifiable claim in a locked section.

**D13 — Defender standalone is a first-class deployment.** The system must run with Defender as the
only configured source and no Sentinel of any kind — not as a degraded mode, and not as a
transitional state on the way to adding Sentinel. Concretely: `SECURITY_SOURCES=defender` requires
no Sentinel credential, no workspace id and no Mock Sentinel process; `PRIMARY_ALERT_SOURCE`
resolves to `defender` without being set; turn-0 carries one table block; provenance hashes one
profile; and nothing in the harness, the tools or the console may assume a Sentinel profile exists.

`SECURITY_SOURCES` still *defaults* to `sentinel`, which is not a contradiction: the default exists
so a zero-credential checkout keeps working against Mock Sentinel, and standalone Defender is an
explicit opt-in rather than an accident of configuration.

Two consequences an operator should know before choosing this mode, both inherited rather than new.
D10 puts every run under `.data/`, so a standalone Defender deployment writes no artifact into the
committed corpus; and `scripts/evaluate-runs.ts` joins to `fixtures/scenarios/`, so those runs are
unscored by construction (§3). Standalone Defender investigates; it does not benchmark.

**D14 — Alert listing is bounded by an explicit time window, never by server order.**
`listAlerts()` filters server-side on `createdDateTime` over a configured window
(`DEFENDER_ALERT_WINDOW`, an ISO 8601 duration, default `P7D`) and keeps PRD-7's fail-loud cap: more
than 500 alerts in the window is refused with a message telling the operator to narrow it, never
silently truncated.

`alerts_v2` supports no `$orderby`, so "the first 500" is an arbitrary 500 rather than the most
recent — the reference page's prose claims most-recent-first, but the supported-parameter list does
not back it and §2 of the research note records the contradiction. A window is the only selection
criterion this API can express that is *stated* rather than inherited from unspecified server
behaviour.

The window is recorded on the artifact's `config`, which means ADR 008 §3 folds it into the derived
condition key at no cost: two runs that drew from different windows are different conditions and
must not merge. It is absent from artifacts of runs that did not use a Defender primary, and absent
means absent.

*Rejected: copying PRD-7's `$top=501` unchanged.* It is correct only if the service happens to
return newest-first, which is undocumented. A queue whose contents depend on unspecified ordering
changes underneath the operator and reads as agent regression.

*Rejected: paging `@odata.nextLink` to exhaustion.* Correct and unbounded; PRD-7 §8 deferred
pagination until a real workspace demanded it, and a window removes the demand.

Phase 0 still measures whether the service returns newest-first in practice. That is worth
recording; it is not worth designing on.

**D15 — Row limits belong to the adapter; the character budget belongs to the core and stays there.**
The two limits do different jobs and must not be confused again, so this decision fixes where each
one lives.

The **row limit** is pushed into the query text, so the engine never produces the extra rows. It
bounds *fetch* cost — bytes over the wire, engine work, and on Defender a shared per-tenant CPU
allowance. It is therefore per adapter, because what a fetch costs is a property of the product:
Mock Sentinel keeps its service-side `QUERY_MAX_ROWS`, Azure keeps its connector constant, and
Defender gets `DEFENDER_QUERY_MAX_ROWS` (default 500 until Phase 0 measures row widths).

The **character budget** is applied to the response after it arrives, and bounds what reaches the
model — context window, provider per-minute token budget, and cost. It is a property of the *model*,
not of any source, so it stays exactly where it is: `INVESTIGATOR_RESULT_MAX_CHARS` in the
investigator's environment, default `40_000`, applied source-neutrally by `fitResultToBudget` for
every connector. **It does not become per-source.** A second adapter is precisely when someone would
propose that; `fitResultToBudget` already adapts to row width by binary search, so a per-source
character budget would be re-solving a solved problem in the wrong layer.

How the Defender number is chosen is a rule, not a preference: **high enough that a realistic
projection runs out of characters before it runs out of rows, low enough that a runaway query cannot
drag 100,000 rows across.** Below that band the model is handed less evidence than its context could
hold, and `fitResultToBudget`'s "ask a narrower or aggregated query" notice fires at an agent that
already asked a narrow one — misdirection, not guidance. Above it, quota is spent producing rows
that the character budget will discard.

One correctness rule falls out of this and applies to every adapter: **the cap is one value.**
`azure.ts` currently holds `QUERY_MAX_ROWS = 500` alongside a hard-coded `| take 501` string, two
places that must agree by hand — raise the constant alone and the connector reports a complete
result for a response the engine truncated, which is the exact failure `QueryResponse.truncation`
exists to prevent. Defender derives its `take` and its `truncation` from one constant, and Phase 1
closes the same gap in `azure.ts` while it is in that file.

### 4.2 Design details

**The active set.** `createSecuritySources(env)` returns an ordered set rather than a bundle:

```ts
export interface SecuritySourceSet {
  /** Active bundles by source id, in `SECURITY_SOURCES` order. */
  readonly sources: ReadonlyMap<string, SecuritySourceBundle>;
  /** The sole alert producer (D5). Also the default for a tool call without `source`. */
  readonly primary: SecuritySourceBundle;
}
```

`SecuritySourceBundle` and `SecuritySourceProfile` are unchanged — a profile still carries one
kind, connector, target, query language, tool descriptions, context framing and guidance. What
changes is that the harness holds several of them and one is marked primary.

**Configuration.** Six variables are new; `SENTINEL_CONNECTOR` keeps its current meaning
underneath the `sentinel` id, so a zero-credential checkout behaves exactly as it does today.

| Variable | Default | Meaning |
|---|---|---|
| `SECURITY_SOURCES` | `sentinel` | Ordered, comma-separated active source ids |
| `PRIMARY_ALERT_SOURCE` | the sole active id | Which source produces alerts. Required when more than one is active |
| `SENTINEL_CONNECTOR` | `mock` | `mock` or `azure`, within the `sentinel` source |
| `DEFENDER_TENANT_ID` / `_CLIENT_ID` / `_CLIENT_SECRET` | — | All-or-none (D2) |
| `DEFENDER_WORKSPACE_ID` | — | Optional `workspaceId` passed to `runHuntingQuery` |
| `DEFENDER_ALERT_WINDOW` | `P7D` | ISO 8601 duration bounding `listAlerts()` (D14) |
| `DEFENDER_QUERY_MAX_ROWS` | `500` | Row cap pushed into the query. Interim until Phase 0 measures row widths (D15) |
| `DEFENDER_TIMEOUT_MS` | `30000` | Per-request, matching `SENTINEL_TIMEOUT_MS` |
| `DEFENDER_LIVE_TEST` | unset | Gates the live smoke test, matching `AZURE_SENTINEL_LIVE_TEST` |

`.env.example` already carries the Defender credential group and `DEFENDER_WORKSPACE_ID`; all six
new variables need adding to it. All three `env.ts` files keep their current character: the console
requires nothing, the investigator validates at import, Mock Sentinel is untouched.

**Alert mapping.** Graph's `alert` resource into ADR 010 §2's envelope. Values stay source-native
strings; nothing is translated into a shared taxonomy.

| `SecurityAlert` | Graph `alert` | Note |
|---|---|---|
| `id` | `id` | |
| `title` | `title` | |
| `description` | `description` | |
| `severity` | `severity` | `unknown` / `informational` / `low` / `medium` / `high`, unmapped |
| `status` | `status` | |
| `alertType` | `detectorId` | The only per-detection-logic field; the others are per-instance, per-product or per-sensor. Inferred, not documented — confirmed by Phase 0 (§7 Q4) |
| `startTimeUtc` | `firstActivityDateTime` | |
| `endTimeUtc` | `lastActivityDateTime` | |
| `timeGenerated` | `createdDateTime` | When Defender raised it, not when the activity happened |
| `tactics` | `categories` | Graph has no `tactics` field; `categories` are the kill-chain categories |
| `techniques` | `mitreTechniques` | |
| `compromisedEntity` | — | Absent. Left `undefined` rather than derived from `evidence` |
| `entities` | `evidence` | Opaque objects, discriminated by `@odata.type` |
| `native` | the validated `alert` | Minus transport and authentication metadata (ADR 010 §2) |

`native` carries `incidentId` and `incidentWebUrl` along with everything else, and must keep
doing so. The agent cannot enumerate an incident's other alerts (D1), but it can see that an alert
belongs to one — that costs nothing, needs no extra call, and is not what the incidents non-goal
excludes. Stripping those fields to "honour" the non-goal would remove evidence for free.

`tactics` is a required array in the contract and may legitimately be empty here — an empty array is
correct and must not be filled from another field.

**Schema discovery.** Graph exposes no metadata endpoint for advanced hunting, no special table and
no enumeration query, and the table set a tenant actually holds depends on its licences — so the
connector cannot read the schema the way `azure.ts` reads workspace metadata. Desk research closed
less of this than expected: **neither `getschema` nor `union isfuzzy=true` appears anywhere in the
advanced-hunting documentation set**, and an unresolved table is a hard `400 BadRequest`
(`Failed to resolve table or column expression named 'X'`) with no documented tolerance mechanism.
Four mechanisms, closed by Phase 0 (§7 Q1):

1. **Per-table `getschema`** — one hunting query per candidate table. Exact if it works, but
   `getschema` is undocumented for this surface and pays dozens of calls against a 45/minute budget
   on every process start.
2. **One batched `union isfuzzy=true`** over `getschema` per table. A single call, and the only
   option that scales — but `isfuzzy` is documented only for Sentinel and Log Analytics, and the
   hard-error behaviour above is exactly what it would have to suppress.
3. **Probe by error** — `TableName | take 0` per candidate, reading `400 BadRequest` as *absent* and
   `200` as *present*. Needs no undocumented operator and follows from behaviour that *is*
   documented; still one call per candidate.
4. **A vendored, pinned table manifest** generated by the probe and committed, echoing ADR 001's
   pinned-revision discipline. Zero startup cost; drifts from the tenant, and needs a regeneration
   step the way `data:manifest` does.

Phase 0 tests 1 and 2 empirically because the documentation cannot settle them, and 4 is the
expected outcome if both fail — with 3 as the validation pass that keeps a pinned manifest honest
against the tenant. Whichever lands, the result must reach `SecuritySchema`: table name plus
ordered column name/type pairs, native type strings kept opaque.

**Listing alerts.** `GET /security/alerts_v2` supports exactly four OData parameters — `$count`,
`$filter`, `$skip`, `$top` — and **not `$orderby`**, so newest-first cannot be requested even though
the page prose claims the most recent are returned first. Eight properties are filterable
(`assignedTo`, `classification`, `determination`, `createdDateTime`, `lastUpdateDateTime`,
`severity`, `serviceSource`, `status`); `detectorId`, `detectionSource`, `productName`, `categories`,
`title` and `providerAlertId` are not. No maximum `$top` is documented. Paging is `@odata.nextLink`,
which must be followed rather than reconstructed.

D14 settles what the connector does with this: filter on `createdDateTime` over
`DEFENDER_ALERT_WINDOW`, cap at 500 and fail loudly above it. `createdDateTime` being filterable is
what makes the window expressible at all — of the eight filterable properties it and
`lastUpdateDateTime` are the only two that bound recency.

Two exclusions matter for what a Defender primary can actually see: alerts suppressed by
alert-tuning rules and standalone detections never promoted to an incident are **not** returned by
`alerts_v2`, and Sentinel-generated alerts appear only when the workspace is onboarded to the
Defender portal (§7 Q9).

The connector must send `Prefer: include-unknown-enum-members` on alert requests. `serviceSource`
and `detectionSource` are evolvable enums, and without that header twenty-one members collapse to
`unknownFutureValue` — including `microsoftSentinel` itself and every Sentinel rule kind
(`scheduledAlerts`, `nrtAlerts`, `builtInMl`, `microsoftDefenderThreatIntelligenceAnalytics`). Since
`serviceSource` is also the only filterable field that distinguishes where an alert came from,
omitting the header would silently erase the distinction this PRD exists to make.

**Results and limits.** The two limits are split by D15 and neither is new machinery.
`INVESTIGATOR_RESULT_MAX_CHARS` sits above the connector, source-neutral and unchanged. The
connector pushes its own row cap into the query text the way `azure.ts` does, from
`DEFENDER_QUERY_MAX_ROWS`, with `take` and `truncation` derived from that one value so they cannot
disagree.

Defender's own ceilings — 100,000 rows within a 50 MB payload — sit far above anything this project
asks for, so the cap is a choice about fetch cost rather than an API constraint. The CPU allowance
behind it is per-tenant and shared, and blocks until the next 15-minute cycle once exhausted, so a
sweep across many alerts can exhaust it for everything else in the tenant. A throttling response
therefore surfaces as a typed error rather than a silent retry: PRD-7 §8 excluded retries and
background refresh, and that exclusion holds. What such an error can usefully *say* depends on
§7 Q11.

**Error contract.** A rejected hunting query returns `400` with `error.code` `"BadRequest"` and the
Kusto engine's own message passed through verbatim — which is what makes ADR 010 §3's "preserve
actionable query errors" achievable without the connector inventing text. Two casing traps are
already visible in Microsoft's own material and the parser must absorb both: the code is
`BadRequest` here where the generic Graph example uses `badRequest`, and the nested member appears
as both `innererror` and `innerError`. Matching is on `code` and status, never on message text.
An unresolvable *table* is also a `400`, not a `403` — which is what makes mechanism 3 above viable,
and what stops a missing table being misread as a permission failure.

**Turn-0 context with several sources.** `buildInitialContext` currently emits one
`<available_tables>` block from one profile. With several it emits one block per active source,
labelled with the source id, in `SECURITY_SOURCES` order, each introduced by its own profile's
`tablesIntroduction`. The alert is introduced once, by the primary's `alertIntroduction`. The agent
therefore learns the source ids from the same place it learns the table names, which is what makes
the `source` parameter of D8 usable without a separate explanation.

This is the change §7 Q2 measures, and the one `AGENTS.md` §15 names as a stop-and-ask.

**The console's query rendering.** ADR 010 §5 gives a query its leading-table summary only when the
owning run records `queryLanguage: "kql"`. With `config.sources` an array that predicate has no
single answer, so it resolves per activity row: the trace already records tool arguments, so from
D8 onwards it carries `source` too, and the console reads the language from the `config.sources`
entry matching it — falling back to the primary's language when the argument is absent, which is
every run written before Phase 2. Nothing degrades today because both active sources are KQL; the
predicate is defined now so the first non-KQL source does not have to invent it.

**The Defender overlay.** `DEFENDER_QUERY_INSTRUCTIONS` mirrors the Sentinel overlay's job: the
things a competent analyst knows before writing the first query, and nothing that steers the
investigation. Expected shape — the 30-day lookback ceiling and that it is a hard boundary rather
than a default; that all data is UTC regardless of any timezone setting; that the timestamp column
is `Timestamp` and not `TimeGenerated`; how `AlertInfo` and `AlertEvidence` relate and which column
joins them; the row and payload ceilings; aggregate before dumping rows; and that `search` and
`union` must be **scoped to named tables** rather than forbidden — unscoped forms span every table
and fail on query size. Exact content comes from Phase 0, per D11.

## 5. Phasing

**Phase 0 — Probe, then document.** A live-gated `scripts/probe-defender.ts` exercises both Graph
endpoints against the real tenant: list alerts, fetch one, run a hunting query, run a deliberately
invalid one, attempt each schema-discovery mechanism, and measure the combined startup-schema size
with both sources active. Raw output goes under `.data/`. Two documents come out of it:
`docs/defender-setup.md` (the app-registration walkthrough `.env.example` already points at,
tenant-free) and `docs/research-defender-api.md` (the findings, scrubbed of tenant identifiers).

*Exit:* every question in §7 answered with recorded evidence, or explicitly reclassified as
unanswerable and moved.

**Phase 1 — The connector, standing alone.** `DefenderClient` in `@soc/sentinel-client` implementing
`SecurityDataSource`; `createDefenderSourceBundle` and its profile; `DEFENDER_QUERY_INSTRUCTIONS`;
the static bundle-factory map with `SECURITY_SOURCES` accepting exactly one id. Deterministic tests
over mocked transport, plus the gated live smoke test. `.data/` enforcement generalised.

Two limit-related pieces land here rather than in Phase 2, because they are the connector's own
behaviour: `DEFENDER_QUERY_MAX_ROWS` with its `take` and its `truncation` derived from one value
(D15), and the same single-value rule applied to `azure.ts`, whose cap and hard-coded `| take 501`
can currently disagree. The character budget is untouched — it is already global, already
env-driven and already source-neutral, and D15 exists partly to keep it that way.

*Exit:* `SECURITY_SOURCES=defender bun run investigate` completes a real investigation against the
tenant with no Sentinel configuration present at all, and writes a valid artifact under `.data/`.
This is the standalone deployment of D13, and it is the phase that delivers it. Nothing about a
Sentinel-only deployment has changed — same turn-0 context, same tool schemas, same prompt hash, same condition key.

**Phase 2 — Several sources, one primary.** `SECURITY_SOURCES` accepts a list; `PRIMARY_ALERT_SOURCE`
selects the alert producer; `source` lands on both security tools; turn-0 context grows a block per
source; provenance hashes every active profile; the artifact records the set.

*Exit:* one investigation queries both products, alerts come only from the primary, and the artifact
records both sources with a condition key distinct from any single-source run.

With §7 Q9 resolved — this tenant's Sentinel is not onboarded — Phase 2's value is precisely
cross-source *querying*, not a choice between two views of the same alert: the sources are disjoint,
so `PRIMARY_ALERT_SOURCE` selects which product's detections start an investigation, and the other
source is there to be reached mid-investigation. That is a narrower benefit than dual-active would
carry in an onboarded tenant, and it is worth re-reading before Phase 2 is scheduled.

Phase 2 is gated on Phase 0's §7 Q2 measurement. If the combined startup schema is too large to be
useful context, roadmap §3 becomes a prerequisite rather than a follow-up, and that is a
stop-and-ask under `AGENTS.md` §15 rather than a decision to take inside this PRD.

## 6. Acceptance criteria

All met except AC2, which records a deliberate deviation below. Two live exercises remain
unperformed and are not criteria: the `PRIMARY_ALERT_SOURCE=sentinel` direction of AC11 is covered by
deterministic tests but not by a live run, and cross-source querying is proven as *routing* only —
in the live two-source run every tool call went to the primary, because this tenant's Sentinel is not
onboarded and the two sources are disjoint (§7 Q9).

> **Cross-source querying was subsequently demonstrated live (2026-08-27).** With the Azure connector
> pointed at a real Log Analytics workspace and Defender primary, the agent reached the secondary
> source unprompted: `get_security_schema` for `sentinel`, then five `query_security_data` calls
> against the workspace, inside one investigation. The paragraph above is left as written — it
> records what this PRD proved at completion — but its "routing only" claim no longer describes the
> system. Note also that §7 Q9 is a separate matter: it governs whether Sentinel *alerts* appear in
> `alerts_v2`, not whether the workspace can be *queried*, and the two were conflated above.

- [x] **AC1** — Given `DEFENDER_TENANT_ID` and `DEFENDER_CLIENT_ID` set but no
      `DEFENDER_CLIENT_SECRET`, When configuration is resolved, Then it throws naming the missing
      key and never falls back to another identity. _(test: unit)_
- [ ] **AC2** — Given no Defender variables and `SECURITY_SOURCES` unset, When the investigator
      starts, Then it runs against Mock Sentinel with no credential required and an unchanged
      prompt hash. _(test: unit)_
      **Not met, deliberately (ADR 011 §14).** The zero-credential half holds: Mock Sentinel still
      starts with no credential. The prompt hash does not — it moved from `a70f3066b376` to
      `5c385038af3e` when Phase 2 made the labelled turn-0 block and the `source` tool property
      unconditional rather than multi-source-only. The alternative (emit the Phase 1 shape whenever
      exactly one source is active) was considered and rejected: a tool schema that changes form
      with the source count is two prompts wearing one name. The cost is a corpus split — new
      Sentinel runs are a different condition from those already in `runs/`, so `evaluate` will not
      compare them without a re-run. The new hash is pinned by a test.
- [x] **AC3** — Given a `runHuntingQuery` response whose `results` objects omit a key present in
      `schema`, When the connector projects it, Then rows are positional in `schema` order and the
      absent key becomes `null`, never a dropped or reordered column. _(test: unit)_
- [x] **AC4** — Given a hunting query the service rejects, When it runs, Then the connector throws
      a typed `query_error` carrying the service's message verbatim and never rewrites the query.
      _(test: unit)_
- [x] **AC5** — Given a Graph alert with `categories` absent, When it is mapped, Then `tactics` is
      an empty array, `native` carries the validated alert without transport or authentication
      metadata, and no field is filled from another. _(test: unit)_
- [x] **AC6** — Given any active source that reads a live tenant, When run or trace directories
      resolve outside `.data/`, Then startup throws — including when Sentinel is `mock`.
      _(test: unit)_
- [x] **AC7** — Given more than one active source and no `PRIMARY_ALERT_SOURCE`, When the set is
      built, Then startup throws rather than guessing; and an id naming an inactive source throws
      too. _(test: unit)_
- [x] **AC8** — Given a tool call whose `source` names no active source, When it executes, Then it
      returns a correctable tool error listing the active ids and the investigation continues.
      _(test: unit)_
- [x] **AC9** — Given `DEFENDER_LIVE_TEST=true` and a complete credential group, When the smoke
      test runs, Then schema, query, alert round-trip and a preserved query error all pass; and
      given the flag unset, Then the suite skips with a printed reason. _(test: integration)_
- [x] **AC10** — Given two active sources, When an investigation starts, Then turn-0 carries one
      labelled table block per source in `SECURITY_SOURCES` order, and the alert is introduced once
      by the primary's framing. _(test: integration)_
- [x] **AC11** — Given two active sources, When the run lists alerts, Then only the primary's
      `listAlerts()` is called and no secondary contributes an alert; and When `PRIMARY_ALERT_SOURCE`
      is changed to the other source, Then that source becomes the sole producer and the former
      primary contributes none — primacy is a role, not a property of a connector (D5).
      _(test: integration)_
- [x] **AC12** — Given two active sources, When the artifact is written, Then `config.source` holds
      the primary and `config.sources` the ordered set, and `conditionOf` differs from an otherwise
      identical single-source run. _(test: integration)_
- [x] **AC13** — Given `SECURITY_SOURCES=defender` against the real tenant with **no Sentinel
      credential, no workspace id and no Mock Sentinel process running**, When `bun run investigate`
      runs one alert, Then it completes with a valid artifact under `.data/` and nothing is written
      to `runs/` (D13). _(test: e2e)_
- [x] **AC14** — Given the probe script, When it runs, Then it writes only under `.data/`, and
      `ground-truth-isolation.test.ts` still passes with the connector and probe sources in scope.
      _(test: unit)_
- [x] **AC15** — Given a Defender primary and a window containing more than 500 alerts, When
      `listAlerts()` runs, Then it refuses with a message naming the window and the count rather
      than truncating; and given a window within the cap, Then the request carries a
      `createdDateTime` filter and the window is recorded on `config`. _(test: unit)_
- [x] **AC16** — Given a connector that builds its own query text (Azure or Defender) with its row
      cap set to N, When a query returns more than N rows, Then the `take` it sends and the reported
      `truncation.maxRows` both derive from that one value and `truncated` is true — so raising the
      cap can never produce a complete-looking result for a truncated response. _(test: unit)_
- [x] **AC17** — Given two active sources and no `INVESTIGATOR_RESULT_MAX_CHARS` set, When each
      returns a result, Then both are fitted to the same 40,000-character budget by the same code
      path, and no per-source character budget exists. _(test: unit)_

## 7. Open questions

Every question here is answered by Phase 0's probe against a real tenant. Desk research narrowed
several and made two of them harder; where it did, that is recorded rather than smoothed over.

- **Q1 — How does the connector discover the tenant's table set?** Sharpened rather than settled:
  neither `getschema` nor `union isfuzzy=true` appears in the advanced-hunting documentation, and an
  unresolved table is a hard `400`. §4.2 lists four mechanisms; Phase 0 must test 1 and 2
  empirically because no document can, with the pinned manifest as the expected outcome if both
  fail. *Surfaced to ADR 011.*
- **Q2 — How large is turn-0 context with both sources active?** Sentinel's workspace tables plus
  Defender's advanced-hunting set, measured as names only, the way the agent actually receives them.
  `roadmap.md` §3 already cites this question and defers the fix to itself; the number decides
  whether Phase 2 proceeds or whether relevant-schema selection becomes its prerequisite.
  *Surfaced to `docs/roadmap.md` §3 and ADR 011.*
- **Q3 — What is the actual casing of `runHuntingQuery` result keys?** Confirmed as a genuine
  contradiction on Microsoft's own reference page: one example returns `Timestamp`, the next returns
  `timestamp`, while the `schema` array uses lowercase `name`/`type` in both. D4's projection is
  correct either way, but the connector must know whether to match `schema` names exactly or
  case-insensitively — and must not hard-code either.
- **Q4 — Is `detectorId` the honest `alertType`?** Narrowed from four candidates to one by
  elimination: `providerAlertId` is per-instance, `productName` and `serviceSource` are per-product,
  `detectionSource` is a closed per-technology enum that names the Sentinel rule *kind* but never
  which rule. Only `detectorId` is per-detection-logic. No Microsoft page states the mapping, so it
  is confirmed against real alerts or the field is left `undefined`.
- **Q5 — Does `DEFENDER_WORKSPACE_ID` change anything for this tenant?** `runHuntingQuery` accepts
  an optional `workspaceId` and otherwise uses the caller's primary workspace, falling back to it
  silently when the named one is inaccessible. Whether that matters here is a property of the
  tenant. The silent fallback is itself worth confirming: it can make a misconfiguration look like
  success.
- ~~**Q6 — How should alert listing and paging behave?**~~ **Resolved 2026-08-25: an explicit
  `createdDateTime` window with a fail-loud cap** — see D14. `$orderby` does not exist on
  `alerts_v2`, so PRD-7's `$top=501` precedent would have bounded an uncharacterisable window.
  Phase 0 still measures whether the service returns newest-first anyway, as a recorded observation
  rather than a design input.

- ~~**Q7 — What row cap should hunting queries carry?**~~ **Resolved 2026-08-25: per adapter, via
  `DEFENDER_QUERY_MAX_ROWS`** — see D15. The question was framed as comparability across sources,
  which was the wrong frame: the character budget already equalises evidence source-neutrally and
  adapts to row width, so the row cap is a fetch-cost bound and nothing else. What remains for
  Phase 0 is not the *policy* but the *number* — the median and p95 serialised width of a row for
  the tables an investigation actually reaches, which is what places the cap inside D15's band.

- **Q8 — Does a Defender alert fill `AlertContext`?** The artifact's triage subset wants severity,
  activity window, tactics, techniques and a compromised entity. Defender supplies no
  `compromisedEntity`, and `categories` may not populate `tactics` in practice. If too much of the
  subset is empty, the console's queue and the evaluation report degrade in ways worth knowing
  before Phase 2 rather than after.
- ~~**Q9 — Is this tenant's Sentinel workspace onboarded to the Defender portal?**~~ **Resolved
  2026-08-25: it is not.** The two sources are therefore disjoint — Sentinel alerts do not appear in
  `alerts_v2` at all, and no detection can be reached through both. D5's no-merge rule stands
  anyway (see D5), and D13 makes Defender-standalone a first-class deployment rather than a
  degraded one. Two consequences carry forward: a Defender primary sees only Defender-native
  detections, and tuned or never-promoted alerts remain invisible regardless.

- **Q10 — What does an unconsented app registration actually do?** `.env.example` states that
  without admin consent a token is still issued but carries no roles, so every call returns `403`.
  Microsoft documents the `403` and documents that apps must **not** decode Graph tokens to check
  claims, but does not confirm that the token endpoint issues a role-less token rather than
  refusing. The probe should establish the real failure mode so startup can produce a diagnosis
  instead of an opaque `403`.
- **Q11 — Does a `runHuntingQuery` 429 carry `Retry-After`?** Graph's general guarantee covers only
  the endpoints listed in its service-specific limits, and advanced hunting is not among them. Its
  quota model is a CPU allowance that blocks until the next 15-minute cycle, and the documentation
  gives no response body. Since PRD-7 §8 excluded retries, this determines only what the typed error
  can tell an operator — but an error that cannot say "try again in twelve minutes" is much worse.

## 8. References

- [PRD-7 — Real Microsoft Sentinel Connector](./prd-7-real-sentinel-connector.md)
- [ADR 009 — Azure Monitor Logs Connector](./adr/009-azure-monitor-logs-connector.md)
- [ADR 010 — Tabular Security Data-Source Boundary](./adr/010-tabular-security-data-source-boundary.md)
- [ADR 008 — The Comparability Record](./adr/008-comparability-record.md)
- [`roadmap.md` §3 — Schema Context Scaling](./roadmap.md)
- [Microsoft Graph security API overview](https://learn.microsoft.com/en-us/graph/api/resources/security-api-overview?view=graph-rest-1.0)
- [`security: runHuntingQuery`](https://learn.microsoft.com/en-us/graph/api/security-security-runhuntingquery?view=graph-rest-1.0)
- [`alert` resource type (alerts_v2)](https://learn.microsoft.com/en-us/graph/api/resources/security-alert?view=graph-rest-1.0)
- [Advanced hunting schema tables](https://learn.microsoft.com/en-us/defender-xdr/advanced-hunting-schema-tables)
- [`research-defender-api.md`](./research-defender-api.md) — the desk half of Phase 0: what the
  published documentation settles, what it contradicts itself on, and what only a tenant can answer
- `docs/defender-setup.md` — app registration and consent (not yet written)
