# AGENTS.md — SOC Investigation Agent

This file is the implementation contract for coding agents working in this repository.

## 1. Mission

Build the smallest end-to-end system in which an autonomous LLM agent can investigate a realistic mocked Microsoft Sentinel alert.

Do not implement future roadmap features before their PRD exists.

The current sequence is:

```text
Mock Sentinel
-> manual investigation through REST
-> Sentinel Client
-> Investigation Runner
-> Pi autonomous agent
-> structured submission
-> run artifact
-> evaluation against ground truth
```

## 2. Current Scope

Implement:
- TypeScript/Bun monorepo;
- Mock Sentinel REST service;
- Microsoft Kusto Emulator;
- Microsoft Sentinel Training Lab telemetry loader;
- alert fixtures;
- schema endpoint;
- read-only KQL endpoint;
- Sentinel Client;
- investigation runtime;
- Pi agent integration;
- the five agent tools (§10);
- structured submission as the Definition of Done;
- run artifacts, and evaluation against the hidden scenario metadata.
- a read-only Azure Monitor Logs implementation of the Sentinel capability (PRD-7, ADR 009).

Do not implement:
- cross-investigation memory;
- human-feedback retrieval;
- generalized ingestion;
- SOAR forwarding;
- web/product frontend — a local operator console is in scope from PRD-3 and PRD-5 (ADR 006 §1,
  ADR 007);
- RBAC/authentication;
- threat intelligence;
- alert grouping;
- multi-tenancy;
- production HA.

## 3. Architecture Rules

### Sentinel boundary

Consumers interact with Sentinel through the Sentinel Client/capability.

Never:
- import Mock Sentinel fixture repositories from investigator code;
- query Kusto directly from investigator code;
- couple the agent runtime to Mock Sentinel URLs.

### Agent boundary

Use:
- `@earendil-works/pi-agent-core`;
- `@earendil-works/pi-ai`.

Do not implement a custom LLM/tool `while` loop unless an ADR is added documenting a concrete Pi limitation.

Do not use the deprecated `@mariozechner/pi-*` packages.

### Investigation strategy

The agent owns the investigative path.

Do not implement alert-specific deterministic playbooks.

Do not force a KQL call. The agent may conclude that the starting alert contains sufficient evidence.

### Contracts

Use Zod 4 for runtime and network validation — REST, configuration, run artifacts.

Use TypeBox for the Pi tool boundary: tool parameters and the submission contract. This is forced
rather than preferred — `pi-agent-core` types `AgentTool.parameters` as a TypeBox `TSchema` and
offers no Zod path. It is re-exported by `pi-ai`, so it adds no dependency (ADR 005 §5).

BAML is deferred (ADR 005 §1).

Avoid duplicate hand-written TypeScript interfaces when a schema already generates the type.

## 4. Technology Baseline

- TypeScript, `strict: true`
- Bun runtime and package manager
- Bun workspaces
- Hono REST APIs
- Zod 4
- Pi Agent Core + Pi AI
- TypeBox (via `@earendil-works/pi-ai`)
- `@t3-oss/env-core`
- OpenTUI (`@opentui/core`) — analyst console renderer
- Microsoft Kusto Emulator
- Docker Compose
- Oxlint
- Oxfmt
- `tsc --noEmit`
- `bun test`

Do not introduce ESLint or Prettier.

## 5. Expected Repository Shape

```text
apps/
  mock-sentinel/
  investigator/
  console/

packages/
  sentinel-client/
  contracts/

baml_src/

fixtures/
  alerts/
  scenarios/

infra/
  docker-compose.yml
  kusto/

scripts/
  bootstrap-sentinel-data.ts

docs/
  architecture.md
  prd-mock-sentinel.md
  adr/

runs/          committed run artifacts; runs/traces/ is not (PRD-6 §6.9)

AGENTS.md
```

Do not create empty future-capability packages.

`runs/` is a committed root, and the only one that grows by running the software rather than by
someone writing a file. ADR 008 §8 records why: a run artifact is a measurement bought with real
money against a model that exposes no seed, so it cannot be re-derived, and `scripts/evaluate-runs.ts`
must be able to score the same corpus from a fresh clone. Nothing may remove one from the scored set
as a side effect — `runs/.archive/` takes an alert out of the *queue* and is still scored. Transcripts
under `runs/traces/` are the opposite: optional, off by default, megabytes apiece, and ignored.

`agent-runtime` is deliberately absent: `apps/investigator/src/harness.ts` is the single
Pi boundary ADR 002 asks for, and wrapping one class in a package would be the generic
agent framework PRD-2 §24 excludes. `persistence` and `testkit` remain unbuilt.

## 6. Quality Rules

Every change must keep:

```text
bun run fmt:check
bun run lint
bun run typecheck
bun test
```

green.

Preferred root scripts:

```json
{
  "scripts": {
    "fmt": "oxfmt",
    "fmt:check": "oxfmt --check",
    "lint": "oxlint --deny-warnings",
    "lint:fix": "oxlint --fix",
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "check": "bun run fmt:check && bun run lint && bun run typecheck && bun test"
  }
}
```

Adapt command flags only if the installed Oxc version requires it.

## 7. Testing Policy

Write tests for deterministic boundaries.

Priority:
1. telemetry bootstrap;
2. Mock Sentinel REST contracts;
3. Sentinel Client;
4. query error propagation;
5. investigation runner;
6. ground-truth isolation — the agent must never be able to reach `fixtures/scenarios/`.

Do not mock KQL with query-string conditionals such as:

```text
if query contains "CommonSecurityLog" -> canned response
```

Use Kusto Emulator for integration behavior.

Tests that require a paid/live LLM must be opt-in and excluded from default CI unless explicitly configured.

## 8. Training Lab Data Rules

Use Microsoft Sentinel Training Lab telemetry from a pinned Azure-Sentinel repository revision.

Never dynamically consume unpinned `master` in CI.

The bootstrap process must:
- create the local Kusto database;
- create schemas;
- ingest telemetry;
- validate representative tables/rows;
- fail clearly on drift.

Treat an upstream revision update as a dependency upgrade.

Do not deploy Azure simply to obtain the lab telemetry unless ADR 001 is amended because a required dataset cannot be reproduced locally.

## 9. Mock Sentinel API

Initial public surface:

```text
GET  /health
GET  /alerts
GET  /alerts/:id
GET  /schema
POST /query
GET  /corpus
```

All requests/responses crossing the public boundary must have Zod validation where applicable.

`GET /corpus` is PRD-6 §6.8's addition and the first since this surface was specified. It reports
the identity of the loaded corpus — time anchor, offset, telemetry revision, alert-set hash — so a
run artifact can record which data it was scored against. It reads a `_CorpusManifest` marker table
that bootstrap writes into the database it has just built, and returns 404 when there is none, so an
older Mock Sentinel degrades rather than breaking `bun run investigate`.

Tables whose name begins with `_` are infrastructure, not telemetry: `GET /schema` drops them and
`POST /query` rejects them. The agent's opening context is built from the table names `/schema`
returns, so a table added to that database would otherwise be a table the agent is invited to
query — and a benchmarking change that alters turn-0 context is a change to the thing being
measured.

The Mock Sentinel service owns the REST facade. Kusto is internal.

Return useful query errors. Do not silently rewrite invalid KQL.

## 10. Agent Tooling

Current surface (PRD-2 §9, extended by ADR 005):

```text
get_security_schema(tables)
query_security_data(kql)
web_search(query)
web_fetch(url)
submit_investigation(...)
```

`query_security_data` calls the Sentinel Client and returns the raw result to the agent.
Do not summarise, extract or normalise it — anything this layer emphasises is a playbook
smuggled in through formatting.

Web content is untrusted. It is returned inside a provenance envelope and the system
prompt standing-orders it as data rather than instructions. See ADR 005 §3.

Do not add semantic tools such as `get_user`, `investigate_powershell`, or
`investigate_signin`.

Add new tools only when a real investigation failure demonstrates the need.

## 11. Context

Each investigation starts with:
- system instructions;
- current alert;
- available table names;
- available tools.

The complete schema is fetched once per investigation and held by the harness, but only
table names enter model context — 22 tables and 1,168 columns would spend the window
before the agent knows what matters. It requests schemas it wants (ADR 005 §4).

No prior-case memory in the current slice.

Do not build vector search or generalized memory.

## 12. Persistence

PRD-2 persists one `runs/<run-id>.json` artifact per invocation, holding per-alert
outcomes only — not a trace (ADR 005 §2). The list below is the eventual target for a
trace store, deferred until evaluation shows a concrete need:
- source alert;
- schema snapshot/version;
- configured provider/model;
- relevant agent events/messages;
- tool calls;
- exact KQL;
- query result or result reference;
- assessment;
- errors;
- lifecycle timestamps.

PRD-3 adds optional `status`, `traceDir` and `config` fields to that artifact and flushes it
after each alert, so an in-flight run is observable (ADR 006 §4). It stays one JSON file of
per-alert outcomes — it is not the trace store above.

PRD-5 lets the local console drive the investigator through `InvestigationControl` while keeping
the investigator as the sole writer of `runs/` (ADR 007). Analyst classifications live separately
under `feedback/` and are recorded but never fed back to the agent.

PRD-6 adds an optional `provenance` block to the run and optional `turns`, `toolCalls` and `usage`
to each result (ADR 008 §1). Evaluation showed the concrete need this list was always conditioned
on: 47 artifacts that cannot say what a run cost, and a comparison that inverts when a file moves.
One rule governs the addition, and it is what keeps "not a trace store" true in substance:

> **Nothing added to the run artifact may grow with the length of an investigation.** No per-event
> records, no messages, no tool arguments, no KQL text, no query results. A count of
> `query_security_data` calls is a number; the queries themselves are a trace.

The trace store list above is unchanged and still deferred. `runs/` is also a committed root now
(§5) — a run is a measurement that cannot be re-derived, so nothing may remove one from the scored
set as a side effect.

Do not store hidden chain-of-thought as a product requirement.

## 13. Structured Assessment

The agent submits its own assessment through the `submit_investigation` tool, and a valid
call is the Definition of Done. Pi validates it against the tool schema before execution,
so an invalid submission returns to the model as a correctable error (ADR 005 §1).

BAML is deferred, not rejected. Revisit if free-form submissions prove unreliable.

Do not weaken the assessment into unvalidated free text, and never convert a final
assistant message into a result.

## 14. Implementation Order

Do not skip ahead.

### Phase 1
Repository/tooling bootstrap.

### Phase 2
Kusto Emulator + Training Lab loader.

Acceptance:
- repeatable bootstrap;
- representative table queries work.

### Phase 3
Mock Sentinel REST API.

Acceptance:
- alert, schema, and KQL are usable only through REST;
- manual scenario investigation succeeds.

### Phase 4
Sentinel Client.

Acceptance:
- application can perform the same manual investigation through the client without knowing the mock internals.

### Phase 5
Investigator + Pi (PRD-2).

Acceptance:
- agent receives the alert and available table names;
- agent may call any of the five tools, or none;
- a valid `submit_investigation` is required for success;
- each invocation writes a run artifact.

### Phase 6
Evaluation against the hidden scenario metadata, then BAML/trace persistence if
demonstrated necessary (ADR 005 §1, §2).

### Phase 7
Analyst Console (PRD-3).

Acceptance:
- the console reads run artifacts and transcripts only, and never writes to `runs/`;
- an in-flight run is visible while it runs, with its turns and tool calls;
- a finished investigation's verdict, tool calls, exact KQL and web research are readable;
- token and cost figures state how many runs they cover.

### Phase 8
Ground-Truth Expansion (PRD-4).

Returns to Phase 6 evaluation work rather than skipping ahead: six scenarios covering four
clusters, three of them one incident, is too thin a baseline to measure a change against.

Acceptance:
- analytics rules surface the cluster-3 attack, so its stages can start an investigation;
- every scenario pins an alert that resolves against a bootstrapped database;
- `disabled-account-signins` states evidence that matches what its query actually returns.

### Phase 9
Console Operator Surface (PRD-5).

Acceptance:
- the alert queue is derived from alerts and run artifacts rather than persisted separately;
- the console starts, extends and cancels investigations only through `InvestigationControl`;
- the investigator remains the sole writer of `runs/`;
- analyst classifications are recorded outside `runs/` and never enter agent context.

### Phase 10
Run Comparability (PRD-6).

Acceptance:
- runs are grouped by a condition key derived in `scripts/` from what each artifact recorded, never
  by model name and never by a field declared on a contract;
- a cell holds every repeat, and no draw is discarded, overwritten or silently excluded;
- every run ever recorded is scored, including `runs/.archive/`, and the report fingerprints the set
  it scored;
- the verdict bands partition the range, with a blind-constant baseline row printed under every
  report;
- the artifact records prompt, runtime and corpus identity, and cost and effort, with tracing off;
- no scored artifact is written to disk, and ground-truth isolation is unchanged.

### Phase 11
Real Microsoft Sentinel Connector (PRD-7).

Acceptance:
- Mock Sentinel remains the default and both runtime entry points select one shared capability;
- Azure Monitor Logs supplies alerts, schema and read-only KQL through service-principal credentials;
- real tenant artifacts are written only to an ignored operator-selected directory;
- deterministic connector tests pass, followed by an opt-in model-free live smoke test.

## 15. When to Stop and Ask for Architecture Input

Stop implementation and surface the decision if any of these occur:
- Training Lab assets cannot be mapped into Kusto without material semantic loss;
- Kusto Emulator differs from required Sentinel KQL behavior in a way that breaks the experiment;
- Pi cannot support a required agent/tool/context behavior;
- a second investigation capability is required outside KQL;
- the full schema is too large for useful startup context;
- an implementation would require introducing a roadmap feature listed as non-goal.

Prefer a small ADR over silently changing architecture.
