# PRD-8 — Tabular Security Data Sources

**Status:** Approved for implementation

**Depends on:** PRD-2 — Core Investigation Agent; PRD-6 — Run Comparability; PRD-7 — Real
Microsoft Sentinel Connector

**Produces:** ADR 010 — Tabular Security Data-Source Boundary

**Language/runtime:** TypeScript strict mode, Bun

**Runtime schemas:** Zod, with TypeBox only at the Pi tool boundary

## 1. Purpose

Extract the smallest alert-oriented security data-source boundary from the two delivered Sentinel
clients. A future SIEM that exposes alerts, schema discovery and a read-only text query language
must need one connector and one query profile, not changes to investigation control flow.

This PRD approves the bounded connector work that PRD-2 deferred. It does not approve generalized
ingestion or a connector framework.

## 2. Evidence and boundary

**Observed:** Mock and Azure Sentinel already implement the same five-method `SentinelClient`, but
that interface returns Sentinel ARM alerts and names its query argument `kql`. The harness imports
those types, frames every alert as Microsoft Sentinel, activates Sentinel/KQL guidance by a
hard-coded tool-name set, and hashes that content into prompt provenance.

**Observed:** schema and query responses are already tabular. Columns carry engine-native type
strings, rows are positional arrays, and query truncation is explicit. No current consumer needs a
cross-engine scalar taxonomy.

**Observed:** new run artifacts persist `sentinelBaseUrl`; console activity reads trace argument
`kql` and assumes a leading KQL table; evaluation renders the Sentinel URL as a comparison axis.

**User-stated:** the approved slice covers alert-oriented tabular SIEMs and one in-memory non-KQL
contract fixture. It excludes a live second product, dynamic discovery, registries and arbitrary
result shapes.

**Inferred:** a source-neutral client plus one immutable selected profile is sufficient. A package
split, plugin system or base-class hierarchy has no demonstrated use in this slice.

## 3. Product goal

At application startup, configuration selects one source bundle:

```text
Security source bundle
  +-- client: alerts, schema, read-only tabular query, optional corpus identity
  `-- profile: source identity, query language, prompt framing and query guidance
          |
          v
Investigation harness
  +-- generic alert context
  +-- stable five-tool surface
  +-- source-selected query text and lazy guidance
  `-- structured submission
```

The harness receives the bundle. It contains no branch on source kind, connector or query
language. Mock and Azure Sentinel select different clients but the same Sentinel/KQL profile.

## 4. Source-neutral contracts

Names below are normative; exact TypeScript declarations may follow repository naming conventions.
All runtime and persisted boundaries use Zod-derived types.

### 4.1 Alert envelope

```ts
interface SecurityAlert {
  id: string;
  title: string;
  description: string;
  severity?: string;
  status?: string;
  alertType?: string;
  startTimeUtc?: string;
  endTimeUtc?: string;
  timeGenerated?: string;
  tactics: string[];
  techniques: string[];
  compromisedEntity?: string;
  entities: unknown[];
  native: unknown;
}
```

`id` is stable within the selected source and is the value used for fetch, run artifacts and
evaluation joins. `title` and `description` frame triage. Optional strings remain source values;
the boundary does not invent common severity, status or entity taxonomies.

`native` is the connector-validated source evidence, not an HTTP response object. It preserves the
fields that do not belong in the common envelope and is included in agent context. For Mock
Sentinel it is the current `SecurityAlertResource`; for Azure it is the projected source row before
common-envelope mapping. Authentication data, response headers and transport metadata never enter
it.

`entities` preserves the source's entity objects without forcing them into Sentinel's entity
enumeration. Connectors may validate a richer native shape before assigning it, but control flow
treats it as evidence rather than transport or instructions.

### 4.2 Schema and query result

```ts
interface SecuritySchema {
  tables: Array<{
    name: string;
    columns: Array<{ name: string; type: string }>;
  }>;
}

interface TabularQueryResult {
  tables: Array<{
    name: string;
    columns: Array<{ name: string; type: string }>;
    rows: unknown[][];
  }>;
  truncation: {
    truncated: boolean;
    returnedRows: number;
    maxRows: number;
  };
}
```

Column order and positional row alignment are preserved. Column names and native type strings are
opaque. No connector maps `datetime`, `dynamic`, SQL types or another engine's values into a shared
scalar taxonomy. The common schema omits Kusto's `database`; target identity belongs to the source
identity block.

Result-size fitting remains above the connector and drops rows only with the existing explicit
notice. Connectors propagate actionable query errors without repairing query text, selecting
evidence, normalising values or summarising results.

### 4.3 Capability

```ts
interface SecurityDataSource {
  listAlerts(limit?: number): Promise<SecurityAlert[]>;
  getAlert(id: string): Promise<SecurityAlert>;
  getSchema(): Promise<SecuritySchema>;
  query(query: string): Promise<TabularQueryResult>;
  getCorpus(): Promise<CorpusIdentity | undefined>;
}
```

The language-neutral query argument is `query`. Concrete clients keep authentication, endpoint
payload parsing, source validation, query-language safety checks and transport translation inside
their implementation. `getCorpus` remains optional identity for benchmark environments; Azure and
future sources may return `undefined`.

The existing Mock Sentinel REST surface and its Zod contracts do not change. Its connector maps
REST responses into these contracts. Azure continues to use Azure Monitor Logs and maps its native
responses at the same boundary.

## 5. Selected source profile

One immutable profile travels with the selected client. It supplies:

- `kind`, `connector`, `target` and `queryLanguage` identity strings;
- the schema-tool description;
- the query-tool description and `{ query }` parameter description;
- the alert and available-table framing used by initial context;
- lazy query guidance and the stable tool names that activate it.

Source and connector identifiers are stable machine values, not display labels. Initial values are:

| Source | `kind` | `connector` | `queryLanguage` |
|---|---|---|---|
| Mock Sentinel | `microsoft-sentinel` | `mock-sentinel-rest` | `kql` |
| Azure Sentinel | `microsoft-sentinel` | `azure-monitor-logs` | `kql` |
| contract fixture | `contract-fixture` | `in-memory` | `fixtureql` |

`target` is the existing non-secret Mock base URL, Azure workspace URL, or a stable test-only
fixture name. Secrets and credentials remain outside the profile.

Tool names stay `get_security_schema` and `query_security_data`; only their selected descriptions
and the query parameter description vary. The TypeBox query schema is always `{ query: string }`.
The other three tools and structured submission semantics do not change.

Lazy guidance is injected once, after the selected profile's schema or query tool first completes.
The harness consumes the activation list and guidance from the profile; it does not know Sentinel,
KQL or any fixture identity.

## 6. Prompt provenance

`promptHash` continues to identify everything the model is told. It hashes generic instructions,
completion reminders, the generic context template, active tool descriptors, and only the selected
profile's prompt-visible framing, guidance and activation rules.

It does not hash inactive profiles, connector implementations, credentials, or operational
identity values that are not placed in model context. The source block in run configuration records
operational identity separately and evaluation includes it in the condition key.

Changing selected query guidance, descriptions, activation rules or context framing must change the
prompt hash. Adding an unused profile must not.

## 7. Run-artifact compatibility

Every new artifact records this fixed-size block at `config.source`:

```ts
interface RunSecuritySource {
  kind: string;
  connector: string;
  target: string;
  queryLanguage: string;
}
```

New writers stop writing `config.sentinelBaseUrl`. The Zod reader retains it only as an optional
legacy artifact field. Existing committed artifacts are never rewritten.

For an artifact without `config.source`, each source field is unknown. Readers do not infer KQL,
Mock Sentinel or Azure from `sentinelBaseUrl`, tool counts, model, file location or current
environment. Unknown never merges with a recorded value in an evaluation condition.

The whole configured source block participates in the derived condition key. Report legends render
all four fields. The console shows recorded source and language beside current environment values.

Run artifacts remain fixed-size records: query text, source-native alerts and results stay out.
Optional legacy trace formats receive no compatibility shim.

## 8. Console query presentation

New trace calls store the stable `query` argument. Console activity receives the recorded query
language from the owning run:

- for `kql`, it may retain the current leading-table summary;
- for every other or unknown language, it shows bounded raw query text without parsing it as KQL;
- detailed activity shows exact trace query text as it does today.

The fallback must handle whitespace and malformed or missing arguments without throwing. It is a
display rule, not query interpretation, and does not enter run artifacts.

## 9. Non-KQL contract fixture

A test-only in-memory bundle proves the seam. Its source-native alert uses names unrelated to
Sentinel, then normalises through `SecurityAlert`. It supplies a tabular schema/result, FixtureQL
descriptions and guidance, source identity, a stable target, and one actionable query error.

A deterministic scripted-model harness test exercises:

1. initial alert and table context;
2. schema lookup;
3. one `{ query }` FixtureQL call and raw result;
4. one-time lazy FixtureQL guidance;
5. valid `submit_investigation` completion.

The fixture records the query it receives and returns deterministic contract data. It is not a
query parser, production environment option, credential mode, network connector, committed
artifact or investigation playbook.

## 10. Migration and implementation order

1. Add source-neutral schemas and capability; adapt Mock and Azure Sentinel with common capability
   contract tests.
2. Add the selected source profile and remove Sentinel/KQL knowledge from harness, context, tools
   and prompt provenance.
3. Carry source identity and generic query naming through artifacts, console and evaluation.
4. Add the in-memory non-KQL fixture and deterministic harness proof.

Each step keeps existing Sentinel behavior covered. No implementation step starts until this PRD
and ADR 010 are accepted.

## 11. Acceptance

- Mock and Azure Sentinel preserve current alerts, schema, raw query results, error propagation,
  truncation, result fitting and optional corpus behavior.
- Investigation control flow depends only on `SecurityDataSource`, `SecurityAlert` and the selected
  profile; it contains no source or language branch.
- Stable tools use `{ query }`, selected descriptions and one-time selected guidance.
- Native column type strings and source-native alert evidence remain intact.
- Every new artifact identifies source kind, connector, target and query language; every committed
  artifact remains readable and scoreable without rewriting.
- Console and evaluation distinguish recorded source/language values and safely render unknown or
  non-KQL queries.
- The deterministic non-KQL fixture completes an investigation without changes to the harness or
  the five-tool lifecycle.
- `bun run fmt:check`, `bun run lint`, `bun run typecheck` and `bun test` pass.

## 12. Non-goals

- a live second-SIEM connector, product selection, credentials or deployment configuration;
- generalized ingestion, non-alert work items or arbitrary non-tabular query results;
- registry, plugin discovery, dynamic loading, base classes or a new package;
- common scalar, severity, status or entity taxonomies beyond the fields in §4;
- source-specific investigation playbooks or dynamic tool names/schemas;
- changing the Mock Sentinel REST API, structured assessment or five-tool surface;
- rewriting committed artifacts or supporting optional legacy trace formats.
