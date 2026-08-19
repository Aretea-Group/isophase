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
-> BAML assessment
-> persisted trace
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
- one KQL investigation tool;
- BAML assessment finalization;
- PostgreSQL/Drizzle trace persistence.

Do not implement:
- cross-investigation memory;
- human-feedback retrieval;
- generalized ingestion;
- SOAR forwarding;
- frontend;
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

Use Zod 4 for runtime/network/tool validation.

Use BAML for LLM contracts and the final structured assessment.

Avoid duplicate hand-written TypeScript interfaces when Zod or BAML already generates the type.

## 4. Technology Baseline

- TypeScript, `strict: true`
- Bun runtime and package manager
- Bun workspaces
- Hono REST APIs
- Zod 4
- Pi Agent Core + Pi AI
- BAML
- PostgreSQL
- Drizzle
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

AGENTS.md
```

Do not create empty future-capability packages.

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
6. BAML contract integration.

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
```

All requests/responses crossing the public boundary must have Zod validation where applicable.

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

## 15. When to Stop and Ask for Architecture Input

Stop implementation and surface the decision if any of these occur:
- Training Lab assets cannot be mapped into Kusto without material semantic loss;
- Kusto Emulator differs from required Sentinel KQL behavior in a way that breaks the experiment;
- Pi cannot support a required agent/tool/context behavior;
- a second investigation capability is required outside KQL;
- the full schema is too large for useful startup context;
- an implementation would require introducing a roadmap feature listed as non-goal.

Prefer a small ADR over silently changing architecture.
