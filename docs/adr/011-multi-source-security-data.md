# ADR 011 — Multi-source security data and the Microsoft Defender connector

**Status:** Accepted

**Date:** 2026-08-25

**Implements:** PRD-8 — Microsoft Defender Data Source

**Reverses:** `AGENTS.md` §2 ("a live second-SIEM connector" leaves the non-goal list); ADR 010 §4
("startup selects one bundle containing `SecurityDataSource` and one profile")

**Amends:** ADR 010 §4 (the harness holds a source-id keyed map and routes through it; prompt
provenance hashes every active profile); ADR 010 §5 (the artifact's source block gains a set beside
its primary); ADR 009 §3 (the credential rule gains a documented divergence) and §5 (the `.data/`
rule generalises from Azure to any live tenant); `AGENTS.md` §2, §3, §10

**Extends:** ADR 008 §3 (the derived condition includes the active source set and the alert window)

## Context

ADR 010 drew a source-neutral boundary and had nothing to substitute across it. Mock and Azure
Sentinel are two transports of one product: both read `SecurityAlert` with KQL against the Logs
endpoint, so the seam was never exercised by a second vocabulary. A tenant whose detections live in
Microsoft Defender XDR could not use the system at all — its alerts are not rows in a workspace and
its telemetry is not addressable through the Logs query endpoint, so every hop was inapplicable
rather than merely unconfigured.

PRD-8 §4.1 D12 forbade connector code until a probe had run against a real tenant, because the
documentation is thin or self-contradictory on schema discovery, result-key casing and the
`alertType` mapping. `scripts/probe-defender.ts` ran; `docs/research-defender-api.md` §9 records what
it measured. Several decisions below exist because that evidence contradicted the expectation, and
each says so.

## Decisions

### 1. Microsoft Graph is the single data plane

Alerts come from `GET /security/alerts_v2`, telemetry from `POST /security/runHuntingQuery` — one
host, one token audience, one `ClientSecretCredential` from the `@azure/identity` dependency PRD-7
already added. Transport stays `fetch`, `AbortSignal.timeout` and Zod.

**Rejected: the Defender for Endpoint APIs** at `api.securitycenter.microsoft.com`. They reach
endpoint telemetry only, where advanced hunting reaches identity, email and cloud-app tables through
the same query language and the same token — a narrower surface for the same integration effort.

**Rejected: `@microsoft/microsoft-graph-client` and the Graph SDKs.** The connector calls two
endpoints. ADR 009 §3's finding that one Azure Identity dependency covers the observed
authentication need holds unchanged.

**Rejected: the incidents API — and not for ADR 009's reasons.** ADR 009 rejected Sentinel's incident
ARM API over ARM resource configuration and a second token audience; neither cost exists here.
`GET /security/incidents` is the same host, the same token and the same connector. It stays out
because an incident is a different investigation unit — a group of alerts — and the run artifact, the
evaluation join and the console queue are all keyed on one alert id, so an incident-shaped run
changes the measurement rather than the code.

Worth recording for whoever picks it up: `incidentId` is **not** among the eight filterable
properties on `alerts_v2`, and `AlertInfo`'s nine columns carry no incident column. Sibling alerts
are reachable *only* through `GET /security/incidents/{id}?$expand=alerts`. That is a sharper gap
than a nice-to-have and belongs in its own PRD.

### 2. A service-principal triple, all-or-none, with no developer fallback

`DEFENDER_TENANT_ID`, `DEFENDER_CLIENT_ID` and `DEFENDER_CLIENT_SECRET` are required together. A
partial group is a configuration error naming the missing keys; absent the whole group, the Defender
source is simply not active.

This mirrors ADR 009 §3's all-or-none rule and then **deliberately diverges from it**. Azure falls
back to `AzureCliCredential` then `AzurePowerShellCredential` when the triple is absent. Defender has
no such chain, because developer sign-in is not a verified path to `ThreatHunting.Read.All`. **This is
a divergence, not an omission**, and it is stated as one so a later reader does not "fix" it.
`docs/defender-setup.md` is the app-registration and consent walkthrough.

### 3. Startup selects an ordered set of sources, exactly one of them primary

This reverses ADR 010 §4's "startup selects one bundle".

`SECURITY_SOURCES` is an ordered list of source ids defaulting to `sentinel`. `PRIMARY_ALERT_SOURCE`
names one of the active ids; with a single active source it defaults to that source, and with more
than one it is required rather than guessed. Ids resolve through a **static map of bundle
factories** — a fourth integration is one entry in that map plus a profile.

The `sentinel` default is not in tension with Defender-standalone being first class (§11): the
default exists so a zero-credential checkout keeps working against Mock Sentinel, and standalone
Defender is an explicit opt-in rather than an accident of configuration.

**Rejected: a registry with runtime discovery.** ADR 010 §4 rejected one on the premise that there
was no third deployable source. That premise expired, so the rejection is restated on the reason that
survives it: `toolDescriptors()` and the prompt-provenance hash must be derivable by *reading
source*, and a discovered source set is not. Nothing here consumes a connector it did not write, so a
plugin protocol would buy lifecycle and partial-failure semantics for no consumer.

**Rejected: reaching Sentinel through Defender's `workspace()` operator.** Advanced hunting supports
`workspace('<id>').<Table>`, so one Defender connector could in principle query Sentinel tables. It
works only for Sentinel tables and only when the workspace is onboarded, it is unsupported in GCC and
with GDAP, and — decisively — it collapses two sources into one source identity, so the artifact, the
provenance hash and the condition key could no longer say which product answered. It also inverts the
requirement: Defender would become Sentinel's prerequisite.

### 4. Exactly one source produces alerts: whichever one is primary

`listAlerts()`, `getAlert()` and `getCorpus()` are called on the primary source and on no other.
Every active source is queryable in every run regardless of which one holds the role.

Primacy is a **configured role, not a property of a connector**. `PRIMARY_ALERT_SOURCE` reassigns it,
and a source that produced every alert in one run produces none in the next if the setting moves.
What this forbids is two sources producing alerts *at the same time*.

Because only one source produces alerts at a time, alert ids from two products never coexist in a
run — which is what keeps the evaluation join and the console queue safe without either of them
knowing that more than one source exists.

**Rejected: merging alerts across active sources.** A Sentinel workspace onboarded into the Defender
portal surfaces the same detection through both APIs under different identifiers, so an unguarded
merge double-counts. Deduplicating instead would mean mapping two products' identity schemes onto
each other — the cross-product taxonomy ADR 010 §2 rejected. It would also break the evaluation join,
which is keyed on one source's alert id.

The overlap is a portal setting away rather than hypothetical. This tenant is not onboarded today, so
the two sources are disjoint right now — which is exactly why the rule is a decision rather than
something left to be discovered. A merge that is only correct while a setting stays off is not a
rule, and the setting is changed by someone who has never read this document.

### 5. What the harness may branch on

ADR 010 §4 said the harness contains "no source-id branch". As written that is now reversed: the
harness holds a source-id keyed map and routes through it. The narrower rule survives and is the one
that was load-bearing — **no branch on source kind, connector or query language.**
`sources.get(id)` is routing; `if (kind === "defender")` inside investigation control flow stays
forbidden. `AGENTS.md` §3 is amended to say so rather than left to read as violated.

### 6. `{ query }` becomes `{ query, source? }`: one static shape

Both `get_security_schema` and `query_security_data` gain an optional `source` parameter naming an
active source id; omitted, it means the primary. Tool names do not change. The schema is not
per-source and not built at runtime, and an unrecognised id returns a correctable tool error listing
the active ids the way an invalid query does — Pi validates shape, the tool validates membership.

ADR 010 §4's rejection of dynamic tool schemas and names is therefore **upheld**: this is one more
static property on a stable tool, not a schema that varies by deployment.

### 7. One batched `union isfuzzy=true` over `getschema` is the schema

**This reverses PRD-8 §4.2's expectation and is the decision the probe changed most.**

§4.2 listed four discovery mechanisms and named the fourth — a vendored, pinned manifest — the
expected outcome, because neither `getschema` nor `union isfuzzy=true` appears anywhere in the
advanced-hunting documentation set and an unresolved table is a hard `400`. Both operators work and
they compose: one call over 41 `getschema` legs returned **366 column definitions across 18 tables**,
3,311 characters of query text, with no "Query size exceeded". `isfuzzy` absorbs the legs whose tables
the tenant's licences do not cover, so the table set needs no configuration and no regeneration step.

The candidate table list stays a constant in the connector. Graph exposes no metadata endpoint, no
special table and no enumeration query, so *every* mechanism starts from a list somebody wrote down;
what the batched call establishes is which of them this tenant holds.

Also measured: `<Table> | take 0` returns the full `schema` with zero rows, so existence and columns
come from one call either way.

### 8. Object-keyed results project positionally through `schema`, and only `schema`

`runHuntingQuery` returns objects keyed by column name where Log Analytics returns positional arrays.
The connector projects each result object through `schema` order, emitting `null` for a key the
object lacks rather than dropping or reordering a column.

Column order comes from `schema` and from nothing else. Result keys matched `schema` names exactly on
the probed tenant, so the documented casing contradiction did not materialise — but the rule gained a
second and independent reason: result rows also carry keys `schema` never names, such as
`Column@odata.type`. A projection built from `Object.keys()` would emit phantom columns *and* depend
on which row happened to come back first.

### 9. Errors are matched on status and `code`; the message is passed through whole

A semantic failure, a syntax failure and an unresolvable table all return `400` with `error.code`
`BadRequest`, so `code` cannot discriminate between them. The Kusto engine's own message is passed
through verbatim and names what it rejected — which is what makes ADR 010 §3's "preserve actionable
query errors" reachable without the connector inventing text, and it was observed working end to end:
the first live Defender investigation repaired two of its own queries from these messages. Microsoft
documents that message content may change, so nothing matches on it.

An unresolvable table is a **`400`, not a `403`**, so a missing table is never misread as a permission
failure.

**The nested error member requires nothing.** Every `400` observed carried
`innerError: { date, request-id, client-request-id }` — no `code`, no `message`. A schema demanding
either field fails to parse every real rejection, and the connector would then substitute a generic
"returned 400 Bad Request" for the diagnostic the model needs. Both spellings (`innererror` and
`innerError`) are accepted, because the documentation and the wire disagree.

A `429` becomes `rate_limited` and is **never retried**. Advanced hunting's quota is a shared
per-tenant CPU allowance that blocks until the next 15-minute cycle, so a retry deepens the outage for
every other consumer in the tenant. PRD-7 §8 excluded retries; that exclusion holds and is now
load-bearing for a second reason.

### 10. Alert listing is bounded by an explicit time window, never by server order

`listAlerts()` filters server-side on `createdDateTime` over `DEFENDER_ALERT_WINDOW` (an ISO 8601
duration, default `P7D`) and keeps PRD-7's fail-loud cap: more than 500 alerts in the window is
refused with a message naming the window and the count, never silently truncated. The request asks for
one alert beyond the cap so exceeding it is detectable rather than ambiguous.

The probe found `$orderby` is *accepted* while the documented parameter list still omits it, which
makes accepted-and-ignored the likeliest reading and does not change the decision: a window is the
only selection criterion this API can express that is *stated* rather than inherited from unspecified
server behaviour. A queue whose contents depend on undocumented ordering changes underneath the
operator and reads as agent regression.

The window is recorded on the artifact's `config`, so ADR 008 §3 folds it into the derived condition
key at no cost: two runs that drew from different windows are different conditions. It is absent from
runs whose source did not bound its queue, and absent means absent.

### 11. Defender standalone is a first-class deployment

The system runs with Defender as the only configured source and no Sentinel of any kind — not a
degraded mode and not a transitional state. `SECURITY_SOURCES=defender` requires no Sentinel
credential, no workspace id and no Mock Sentinel process; `PRIMARY_ALERT_SOURCE` resolves without
being set; turn-0 carries one table block; provenance hashes one profile; and nothing in the harness,
the tools or the console may assume a Sentinel profile exists. The console's configuration view is
explicitly included — it described the current environment as `microsoft-sentinel` by construction,
and now reads the selected source.

Two consequences an operator should know, both inherited rather than new: §13 puts every run under
`.data/`, so a standalone Defender deployment writes no artifact into the committed corpus; and
`scripts/evaluate-runs.ts` joins to `fixtures/scenarios/`, so those runs are unscored by
construction. Standalone Defender investigates; it does not benchmark.

### 12. Row limits belong to the adapter; the character budget belongs to the core

The two limits do different jobs and must not be confused again.

The **row limit** is pushed into the query text so the engine never produces the extra rows. It bounds
*fetch* cost — bytes over the wire, engine work, and on Defender a shared per-tenant CPU allowance —
which is a property of the product, so it is per adapter: Mock Sentinel keeps its service-side
`QUERY_MAX_ROWS`, Azure keeps its connector constant, Defender gets `DEFENDER_QUERY_MAX_ROWS`
(default 500).

The **character budget** is applied after the response arrives and bounds what reaches the model —
context window, provider token budget, cost. It is a property of the *model*, not of any source, so it
stays exactly where it is: `INVESTIGATOR_RESULT_MAX_CHARS`, applied source-neutrally by
`fitResultToBudget` for every connector. **It does not become per-source.** A second adapter is
precisely when someone would propose that; `fitResultToBudget` already adapts to row width by binary
search, so a per-source character budget would re-solve a solved problem in the wrong layer.

One correctness rule falls out and applies to every adapter: **the cap is one value.** `azure.ts` held
`QUERY_MAX_ROWS = 500` beside a hard-coded `| take 501`, two places that had to agree by hand — raise
the constant alone and the connector reports a complete result for a response the engine truncated,
the exact failure `QueryResponse.truncation` exists to prevent. Both connectors now derive `take` and
`truncation` from one argument through a shared helper.

Measured, for the 500: the widest table sampled serialises at ~5,000 characters per *whole* row, so
the character budget binds first for any realistic projection — which is the band this decision asks
the cap to sit in.

### 13. Any active live-tenant source forces the whole run under `.data/`

`assertLiveTenantArtifactDirectories` generalises ADR 009 §5 over the active set: if *any* active
source reads a real tenant, the run and trace directories must sit under `.data/`.
`SENTINEL_CONNECTOR=mock` alongside an active Defender still writes to `.data/`, never `runs/` — a
mixed run is a development convenience and must not enter the committed scored corpus. The rule is
about the presence of tenant data anywhere in the run, not about which source produced the alert. The
console is routed through the same check.

### 14. Provenance hashes every active profile; the artifact records the set

`provenanceForProfiles` hashes each active profile's prompt-visible content in source order —
inactive profiles, client implementations and credentials stay excluded exactly as ADR 010 §4
requires. `config.source` keeps its current shape and carries the **primary**; `config.sources`
carries the ordered active set. ADR 008 §3 hashes the whole of `config`, so both enter the derived
condition key with no contract edit.

This is a measurement change and it is intended: single-source and multi-source runs are different
conditions and must not merge into one cell. No existing artifact is rewritten, and a reader that
finds `config.sources` absent renders a single-source run rather than fabricating a set.

**Deviation from PRD-8 AC2, taken deliberately.** AC2 required a Sentinel-only run to keep "an
unchanged prompt hash", and PRD-8 §5 restated it as Phase 1's exit: "same turn-0 context, same tool
schemas, same prompt hash, same condition key". That is not what was built. The single-source Mock
Sentinel hash moved from `a70f3066b376` to `5c385038af3e`, for two reasons that are unconditional
rather than multi-source-only:

- turn-0 emits `<available_tables source="sentinel">` where it previously emitted
  `<available_tables>`, even with one active source;
- `query_security_data` and `get_security_schema` carry the optional `source` property in their
  schemas, even with one active source.

Both could have been made conditional — emitting the Phase 1 shape whenever exactly one source is
active — and that was the alternative considered. It was rejected in favour of one shape at every
arity: a tool schema and a context template that change form based on how many sources happen to be
configured are two prompts wearing one name, and the next reader would have to know the arity to know
what the agent was told.

The cost is real and is the reason this is recorded rather than noted. Every Sentinel run written
from now on is a different condition from the ones already in `runs/`, so `scripts/evaluate-runs.ts`
will not compare new runs against the committed baseline — they land in separate cells rather than
merging incorrectly, which is the safe failure but still a discontinuity. Re-establishing a baseline
means re-running the corpus, which ADR 008 §8 records as a real cost paid in money against a model
with no seed.

The new hash is pinned by a test, so the *next* prompt change costs a deliberate edit rather than
passing unnoticed.

### 15. `alertType` is left unmapped

PRD-8 §4.2 proposed `detectorId` as the `alertType` equivalent by elimination — every other candidate
is per-instance, per-product or per-sensor — and required it be confirmed against real alerts or left
`undefined`. The probe could not confirm it: the tenant holds one alert, so every
(title, detectionSource) group is a singleton and "one distinct `detectorId` per group" is a tautology
rather than a measurement. §4.2's own rule then applies and the field is unset.

`compromisedEntity` is likewise absent — Graph has no equivalent, and deriving one from `evidence`
would invent a fact. `tactics` maps from `categories` and may legitimately be empty; an empty array is
correct and is never filled from another field. `native` carries the validated alert whole, including
`incidentId` and `incidentWebUrl`: the agent cannot enumerate an incident's other alerts, but seeing
that an alert belongs to one costs nothing and stripping it to "honour" the incidents non-goal would
remove evidence for free.

### 16. The Defender overlay is a function of the row cap, not a constant

Defender ships a query-instruction overlay beside Sentinel's, activated on first use of a Defender
tool so the initial system prompt stays free of query tactics. That much is PRD-8 §4.1 D11 as
written, and the reason is unchanged: turn-0 is the thing being measured, and query tactics in it
would change the measurement for every run whether or not the agent ever queries.

**Deviation from D11, taken deliberately.** D11 named a `DEFENDER_QUERY_INSTRUCTIONS` constant
mirroring `SENTINEL_QUERY_INSTRUCTIONS`. What shipped is
`defenderQueryInstructions(maxRows: number)` — a function, because §12 made the row cap
configurable through `DEFENDER_QUERY_MAX_ROWS` and the overlay states that cap to the agent. A
constant would either hard-code a number §12 allows an operator to change, or omit it and leave the
agent to discover the cap by hitting it. The two decisions interact, and D11 was written before §12
existed.

Its *content* comes from Phase 0's measured findings rather than the published schema reference, as
D11 required. Two things the probe changed and which are worth keeping visible here, because both
are the kind of guidance that is wrong in a way an agent cannot detect: the error contract is stated
as fact rather than hope — a rejected query returns HTTP 400 carrying the Kusto engine's own message
verbatim — and the unresolvable-*table* case is called out separately from a mistyped column,
because Graph returns the same 400 for both while they mean opposite things. A table that does not
resolve means the tenant is not licensed for that workload, so no spelling of it will work; an agent
reading that as a typo retries the same query until it gives up.

## Consequences

**Positive.** The system runs on Defender alone, with no Sentinel of any kind. Schema discovery is one
request rather than a vendored artifact with a regeneration step. Several sources are active within
one investigation with exactly one producing alerts. The Azure connector's cap gap is closed. A third
integration is one map entry plus a profile. Prompt provenance and the condition key distinguish
source sets, so runs across products cannot silently merge in a comparison.

**Negative.** The advanced-hunting table list is a maintained constant, because Graph enumerates
nothing — a newly licensed workload is invisible until someone adds the table name. `alertType` is
unmapped until a tenant with repeated detections exists. Defender runs are unscored by construction.
Two active sources make turn-0 context larger. The cost first recorded here was ~274 tokens for both
table-name blocks; re-measured against a live workspace on 2026-08-27 it is **≈4,751 tokens** (37
Defender + 833 workspace tables), because a Log Analytics workspace returns its whole table catalogue
where Mock Sentinel returns 23. The verdict is unchanged — that is under half what one query result
may spend, and the live two-source run showed no ill effect — but the number is 17× the one this
paragraph was written around, and it is still names only, saying nothing about what
`get_security_schema` costs on wide tables.

> **The tenant changed (2026-08-27).** 37 of 43 candidate tables now resolve, and `Device*` and Email
> tables are among them — further workloads were licensed after this was written. The paragraph below
> is kept as measured rather than rewritten, because its point survives its own numbers: what a
> Defender investigation can reach is a licensing property of the tenant, and it moves.

**Measured on one tenant, not in general.** 18 of 41 candidate tables resolve, with **no `Device*`
event tables and no Email tables** despite the tenant's only alert being an endpoint antivirus
detection. A Defender-standalone investigation there reaches identity, cloud-app,
vulnerability-management and exposure-graph telemetry, not endpoint or email. That bounds what any
investigation run against that tenant can conclude, and it is a licensing property rather than a
connector limitation.

## References

- [PRD-8 — Microsoft Defender Data Source](../prd-8-microsoft-defender-data-source.md)
- [`research-defender-api.md`](../research-defender-api.md) — §1–§8 desk research, §9 the live half
- [`defender-setup.md`](../defender-setup.md) — app registration and admin consent
- [ADR 008 — The Comparability Record](./008-comparability-record.md)
- [ADR 009 — Azure Monitor Logs Connector](./009-azure-monitor-logs-connector.md)
- [ADR 010 — Tabular Security Data-Source Boundary](./010-tabular-security-data-source-boundary.md)
