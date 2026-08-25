# ADR 010 — Tabular Security Data-Source Boundary

**Status:** Accepted

**Date:** 2026-08-23

**Amends:** PRD-2 §5.2, §11, §22, §24 and §26; ADR 004 (the Sentinel alert shape remains the Mock
REST contract, not the investigator contract); ADR 005 §3 and §4 (query descriptions, argument and
lazy context are selected); ADR 009 §2, §4 and §5 (the Sentinel capability becomes a source-neutral
capability and new artifacts stop writing `sentinelBaseUrl`); `AGENTS.md` §2, §3, §10, §11, §12,
§14 and §15

**Extends:** ADR 008 §3 (the derived condition includes the configured source block)

## Context

PRD-2 deliberately called `SentinelApiClient` an SDK rather than a generalized connector and
deferred additional security integrations. ADR 009 later introduced a five-method
`SentinelClient` so Mock and Azure Sentinel could share control flow. That was the smallest correct
boundary for two transports of one product, but it still exposes Sentinel ARM alerts and KQL to the
harness.

The next requested seam is narrower than a generic connector system: alert-oriented sources with
schema discovery and read-only text queries returning tabular results. No second production product
has been selected. The architecture decision must therefore prove substitutability without
inventing authentication, discovery or result shapes for an unknown integration.

## Decisions

### 1. Replace `SentinelClient` with one source-neutral capability

`SecurityDataSource` owns the five operations already consumed: list alerts, fetch one alert,
discover tabular schema, execute read-only query text, and optionally identify a benchmark corpus.
Its query argument is `query`, not `kql`, and its alert/schema/query return types are source-neutral.

The existing `@soc/sentinel-client` package remains. A package rename or split would move imports
without improving the runtime seam. `SentinelApiClient` and `AzureSentinelClient` become concrete
implementations that normalise at their boundary.

This amends PRD-2's deferral only for the bounded capability defined here. It does not approve arbitrary
connectors or ingestion.

### 2. Preserve native alert evidence inside a small common envelope

The common alert requires stable `id`, `title` and `description`; carries optional source strings
for severity, status, type and timestamps; and carries tactics, techniques, compromised entity and
entities needed by current triage. Values remain source-native strings and entity objects.

The `native` field holds connector-validated source evidence. It is included in agent context so
normalisation cannot hide evidence, but it contains no HTTP response, authentication data or
transport metadata. A connector owns its source schema and the mapping into common triage fields.

ADR 004's Sentinel ARM-shaped resource remains the Mock Sentinel REST contract. It no longer leaks
past the connector into investigation control flow. Azure's projected `SecurityAlert` row likewise
becomes native evidence rather than the investigator type.

**Rejected: one universal alert schema.** Severity, status, provider and entity taxonomies differ
between products. Mapping them before a second product exists risks semantic loss and adds fields
no current consumer needs.

**Rejected: native evidence only.** The harness and artifact writer would then need source branches
to obtain stable identity and triage fields.

### 3. Keep the existing tabular query shape and opaque type strings

The common schema is table name plus ordered column name/type pairs. The common result is ordered
tables with ordered columns, positional rows and explicit truncation. Kusto's `database` is omitted
from the common schema because target identity belongs to the selected source.

Native scalar type strings remain opaque. Connectors preserve column order, values and actionable
query errors, and do not repair queries, select evidence, summarise results or translate values into
a shared taxonomy. The existing fixed result-size budget remains above the connector and reports
every drop.

**Rejected: an engine-neutral scalar enum.** No consumer asks whether two engines' type systems are
equivalent, and a mapping would discard distinctions before a need is demonstrated.

**Rejected: arbitrary result shapes.** The current agent and console rely on tabular evidence. A
document or graph backend is a second capability and needs separate architecture input.

### 4. Select client and query behavior as one immutable bundle

Startup selects one bundle containing `SecurityDataSource` and one profile. The profile supplies
source kind, connector, target, query-language identity, tool descriptions, `{ query }` parameter
description, initial-context framing, lazy syntax guidance and its activation tools.

Tool names remain stable. The harness consumes profile values and contains no Sentinel/KQL import,
source-id branch or hard-coded language tool set. Mock and Azure select different clients and the
same Sentinel/KQL profile.

Prompt provenance hashes generic prompt content plus only the active profile's prompt-visible
content, activation rules, context template and active descriptors. It excludes inactive profiles,
client implementations, credentials and identity values never shown to the model. Operational
identity is recorded separately in run configuration.

**Rejected: dynamic tool schemas or names.** A stable `{ query }` boundary proves the language seam
without complicating Pi validation, traces, metrics or completion behavior.

**Rejected: registry and runtime discovery.** There are two production clients selected by one
existing configuration branch. A registry would add lifecycle and error cases without a third
deployable source.

### 5. Add one source block; preserve artifacts only at read time

New artifacts record `config.source = { kind, connector, target, queryLanguage }` and stop writing
`config.sentinelBaseUrl`. The block is fixed-size and the whole value participates in ADR 008's
derived condition key.

The Zod reader retains `sentinelBaseUrl` as an optional legacy field so every committed artifact
still parses. Missing source fields render unknown and never merge with recorded values. Readers do
not infer source or language from the old URL or current environment, and no artifact is rewritten.

Console activity reads trace argument `query`. KQL gets its existing leading-table summary only
when the owning run records `queryLanguage: "kql"`; every other or unknown language gets bounded
raw query text. Optional legacy trace formats receive no shim.

This is the only compatibility policy approved by this ADR.

### 6. Prove the seam with a test-only non-KQL bundle

An in-memory FixtureQL bundle starts with a non-Sentinel native alert, maps it through the common
envelope, returns tabular schema/results, supplies its own profile and completes a deterministic
scripted-model investigation.

The fixture records received query text and returns contract data; it is not a parser or production
connector. It is available only to tests and adds no dependency, configuration, credentials,
network request, committed artifact or source-specific playbook.

## Consequences

**Positive:** future alert-oriented tabular SIEM work is bounded to a connector and profile;
existing Sentinel transports keep their behavior; source-native evidence stays visible; prompt and
run provenance distinguish source/language changes; legacy measurements remain readable.

**Negative:** `@soc/sentinel-client` becomes a historically named package containing the generic
capability; agent context carries both common triage fields and native evidence; readers must
represent unknown source identity for legacy runs; a genuinely non-tabular backend still requires
architecture work.

## References

- [PRD-2 — Core Investigation Agent](../prd-2-Core%20Investigation%20Agent.md)
- [PRD-6 — Run Comparability](../prd-6-run-comparability.md)
- [PRD-7 — Real Microsoft Sentinel Connector](../prd-7-real-sentinel-connector.md)
- [ADR 004 — Alert API Shape](./004-alert-api-shape.md)
- [ADR 005 — Investigation Agent Boundary](./005-investigation-agent-boundary.md)
- [ADR 008 — The Comparability Record](./008-comparability-record.md)
- [ADR 009 — Azure Monitor Logs Connector](./009-azure-monitor-logs-connector.md)
