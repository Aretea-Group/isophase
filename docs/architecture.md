# Isophase — Architecture

**Status:** v0.3 — Mock Sentinel, investigation runtime and Azure connector boundary

**Scope:** Mock Sentinel environment + autonomous investigation agent + read-only Azure connector

**Language:** TypeScript  
**Runtime:** Bun

> **Where this document is superseded.** It was written before PRD-2 was implemented, and
> ADR 005 changed several decisions recorded here: the BAML finalizer became a
> `submit_investigation` tool, the PostgreSQL trace store became a per-run JSON artifact, the tool
> surface grew from one to five, and the full schema is no longer injected at startup. Sections
> below are updated where that happened and say so. ADR 005 is the authority on any remaining
> disagreement.

## 1. Purpose

Build a T1+ SOC investigation agent that can receive an atomic security alert, understand the evidence already present, autonomously gather more evidence when required, and return a concise FP/TP-oriented assessment for human review.

The initial implementation is intentionally narrow:

1. create a realistic local Sentinel-like environment;
2. prove it can be investigated manually over REST;
3. attach an autonomous LLM agent;
4. persist enough trace data to understand and improve investigations.

The architecture must leave clear extension points for later PRDs such as case-based memory, generalized ingestion, forwarding/SOAR, web research, additional security data sources, and a frontend.

## 2. Product Principles

### 2.1 The agent owns the investigation strategy

The application must not encode alert-specific playbooks such as “PowerShell means query table X.” The agent receives the alert, available context, and capabilities, then decides whether additional investigation is required and which queries to run.

### 2.2 Capabilities, not workflows

Sentinel access is exposed as a capability. The platform provides safe access to alerts, schema information, and query execution. It does not decide which evidence is relevant.

### 2.3 Alert first, query only if useful

A KQL query is not a mandatory step. A sufficiently rich alert may be enough for an assessment.

```text
Alert
  |
  v
Agent understands current evidence
  |
  +-- sufficient --> assessment
  |
  +-- insufficient --> query security data
                         |
                         v
                    reassess
```

### 2.4 Mock and real integrations share the same application boundary

The future investigation runtime must not know whether it is using the local Mock Sentinel environment or Azure.

### 2.5 Keep the agent runtime replaceable

Pi is the initial agent harness, not the domain architecture. Sentinel access, the run artifact, the submission contract, and investigation state belong to the application.

## 3. High-Level Architecture

```text
                         SOC INVESTIGATOR

                    +----------------------+
                    | Investigation API /  |
                    | CLI                  |
                    +----------+-----------+
                               |
                               v
                    +----------------------+
                    | InvestigationRunner  |
                    +----------+-----------+
                               |
               +---------------+----------------+
               |                                |
               v                                v
      +-------------------+           +----------------------+
      | Context Builder   |           | Agent Runtime        |
      | - alert           |---------->| Pi Agent Core        |
      | - schema          |           | Pi AI                |
      | - instructions    |           +----------+-----------+
      +-------------------+                      |
                                           optional tool call
                                                  |
                                                  v
                                       +----------------------+
                                       | Sentinel Tool        |
                                       | query_security_data  |
                                       +----------+-----------+
                                                  |
                                                HTTP
                                                  |
                                                  v
                                       +----------------------+
                                       | Sentinel Client      |
                                       +----------+-----------+
                                                  |
                           +----------------------+--------------------+
                           |                                           |
                           v                                           v
                 +-------------------+                       +-------------------+
                 | Mock Sentinel     |                       | Azure Sentinel /  |
                 | REST API          |                       | Defender later    |
                 +---------+---------+                       +-------------------+
                           |
                  +--------+---------+
                  |                  |
                  v                  v
            Alert fixtures     Kusto Emulator
                               Training Lab data

Agent completes
      |
      v
submit_investigation  (validated on the way in)
      |
      v
runs/<run-id>.json
```

## 4. Major Components

### 4.1 Mock Sentinel

**Why it exists:** Provides a deterministic, realistic external security platform for agent development without Azure dependency.

**Responsibilities:**
- expose mock alerts over REST;
- expose current queryable schema over REST;
- accept read-only KQL over REST;
- proxy query execution to Kusto Emulator;
- load Microsoft Sentinel Training Lab telemetry;
- return realistic HTTP and query errors.

**Does not own:**
- agent reasoning;
- investigation lifecycle;
- expected scenario outcome;
- human verdict;
- memory.

### 4.2 Sentinel Client

**Why it exists:** Keeps the investigation code independent of Mock Sentinel and Azure-specific HTTP APIs.

**Responsibilities:**
- retrieve an alert;
- retrieve schema;
- execute a security-data query;
- validate all remote responses with Zod;
- normalize transport errors into application errors.

The client is the application boundary. No investigator code may directly call Mock Sentinel endpoints.

ADR 009 implements the real-workspace branch through Azure Monitor Logs. Consumers depend on the
five-method `SentinelClient` capability; environment configuration selects either the Mock REST
client or the Azure client without changing investigator tools or strategy. Azure Identity selects
either one configured service principal or an explicit Azure CLI-to-PowerShell developer chain.

### 4.3 Investigation Runner

**Why it exists:** Owns one investigation execution.

**Responsibilities:**
- obtain the starting alert;
- obtain context required at startup;
- create the Pi agent;
- register capabilities/tools;
- subscribe to runtime events;
- enforce runtime limits;
- require a valid `submit_investigation`;
- finish as completed or failed.

The runner must not implement its own LLM/tool loop.

### 4.4 Agent Runtime

Initial implementation uses:

- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-ai`

Pi owns:
- model interaction;
- iterative tool calling;
- agent state;
- event streaming;
- provider-level model access.

Application code owns:
- instructions;
- context construction;
- Sentinel tool implementations;
- execution limits;
- run artifact;
- final assessment contract.

Pi sits behind a single replaceable boundary: `apps/investigator/src/harness.ts` is the only file in
the repository that imports it. ADR 005 §7 records why that is the class rather than a wrapper
package.

### 4.5 Structured Assessment

*Superseded by ADR 005 §1 — this was a BAML finalizer.*

The agent submits its own assessment through the `submit_investigation` tool, and a valid call is the
Definition of Done. Pi validates arguments against the tool's TypeBox schema before execution, so an
invalid submission returns to the model as a correctable error rather than needing a second LLM call
to repair it.

```text
Pi autonomous investigation
        |
        v
submit_investigation  (validated on the way in)
        |
        v
InvestigationSummary
```

A normal assistant message never becomes a result, however complete it reads.

BAML is deferred, not rejected. Revisit if free-form submissions prove unreliable.

### 4.6 Persistence

*Superseded by ADR 005 §2 — this was PostgreSQL with Drizzle.*

Each invocation writes one `runs/<run-id>.json` artifact holding per-alert outcomes: the assessment,
timing, the model that produced it, the runtime limits, and any failure. It is deliberately not a
trace — no transcript, no tokens, no raw KQL or web results.

Full Pi transcripts are available per investigation behind `INVESTIGATOR_TRACE=true`, written beside
the artifact as JSONL. Off by default: the artifact is the durable, comparable output and a trace is
a debugging aid for one run.

A trace database remains the right answer once evaluation demonstrates it is needed. It has not.

## 5. Mock Sentinel REST Surface

The public capability surface is deliberately small:

```text
GET  /alerts
GET  /alerts/:id
GET  /schema
POST /query
GET  /health
```

`/health` is operational and is not part of the Sentinel domain abstraction.

Behavioral fidelity matters more than exact Microsoft URL compatibility. The mock should behave like an external service through HTTP, JSON, latency, errors, and KQL semantics without attempting to emulate Azure ARM or authentication.

## 6. Training Data Architecture

The Microsoft Sentinel Training Lab ships prerecorded telemetry in the Azure-Sentinel repository. The lab itself is based on loading this telemetry into a Sentinel workspace.

For local development:

```text
Pinned Azure-Sentinel repository revision
                |
                v
Training Lab telemetry CSV files
                |
                v
Bootstrap loader
  - create database
  - create table schemas
  - ingest CSV files
  - verify expected rows/tables
                |
                v
Kusto Emulator
```

The repository revision must be pinned. Never load an unpinned `master` branch during normal development or CI.

The Kusto Emulator supports local development/testing, exposes a query endpoint over HTTP, and supports ingesting local files via ingestion commands. It does not provide production security or the complete managed ingestion service.

### 6.1 Important implementation spike

The loader must determine how the Training Lab’s built-in and custom table CSVs map to Kusto table schemas. This is implementation work, not an architecture blocker.

Do not build a custom KQL parser.

## 7. Agent Context

Each investigation starts clean.

Initial context:

```text
System instructions
+ current alert
+ available table names
+ available tools
```

No previous investigation transcript is included in the current implementation.

Later, the Memory PRD will add relevant prior cases as additional retrieved context.

### 7.1 Schema strategy

*Superseded by ADR 005 §4 — this said inject the full schema at startup.*

The measurement was taken: the loaded environment reports 22 tables and 1,168 columns, about 60 KB of
JSON. That is spent before the agent knows which telemetry matters, so only table names enter model
context and the agent pulls the schemas it decides are relevant via `get_security_schema`.

The complete schema is still fetched once per investigation and held by the harness; what changed is
its placement in context, not how it is loaded.

## 8. Agent Tool Surface

*Extended by ADR 005 §3 — this started at one tool.*

```text
get_security_schema(tables)     column definitions for tables the agent picks
query_security_data(kql)        arbitrary read-only KQL, returned uninterpreted
web_search(query)               public web search, snippets only
web_fetch(url)                  read one https page
submit_investigation(...)       the Definition of Done
```

`query_security_data` calls the Sentinel Client and returns the raw result. It does not summarise,
extract or normalise — anything this layer chose to emphasise would be an investigation playbook
smuggled in through formatting. Results carry a row cap and a size budget, and report when either
was hit, so the model can narrow the query rather than reason over a silently partial result.

The first four are parallel-capable; independent calls in one turn execute concurrently.

Web content is untrusted. It is returned inside a provenance envelope and the system prompt
standing-orders it as data rather than instructions. The exposure `web_fetch` adds is prompt
injection rather than network reach — see ADR 005 §3 for what that buys and what it costs.

The agent decides which, if any, to call.

Do not initially add semantic SOC tools such as:
- `investigate_signin`;
- `get_user`;
- `get_device`;
- `investigate_powershell`;
- `find_related_alerts`.

Add new capabilities only when evidence shows raw Sentinel/KQL access is insufficient.

## 9. Contracts

### 9.1 Zod

Use Zod 4 for software/runtime boundaries:

- environment configuration;
- REST input;
- REST output;
- alert fixture validation;
- Sentinel Client responses;
- agent tool input/output;
- persisted JSON structures where external/untrusted data crosses a boundary.

### 9.2 TypeBox

*Superseded by ADR 005 §5 — this was BAML.*

Pi types `AgentTool.parameters` as a TypeBox `TSchema` and offers no Zod path, so tool parameter
schemas and the `InvestigationSummary` contract are TypeBox. `Type`, `Static` and `TSchema` are
re-exported by `@earendil-works/pi-ai`, so this adds no dependency and stays version-aligned with the
validator Pi actually runs.

```text
Zod     = application/runtime boundaries — REST, config, run artifact
TypeBox = the Pi tool boundary — tool parameters, submission contract
```

The principle from ADR 003 is unchanged: schemas live at boundaries and types are inferred, never
hand-duplicated. BAML remains deferred.

## 10. Technology Stack

| Concern | Decision |
|---|---|
| Language | TypeScript with `strict: true` |
| Runtime / package manager | Bun |
| Monorepo | Bun workspaces |
| REST | Hono |
| Runtime validation | Zod 4 |
| Agent harness | `@earendil-works/pi-agent-core` |
| Model abstraction | `@earendil-works/pi-ai` |
| LLM tool/output contracts | TypeBox (via `@earendil-works/pi-ai`) |
| Environment validation | `@t3-oss/env-core` |
| Web search | Brave Search API |
| Query backend | Microsoft Kusto Emulator |
| Mock telemetry | Microsoft Sentinel Training Lab telemetry |
| Run artifacts | JSON on disk (`runs/`) |
| Lint | Oxlint |
| Format | Oxfmt |
| Typecheck | `tsc --noEmit` |
| Tests | `bun test` |
| Local infrastructure | Docker Compose |

## 11. Repository Shape

```text
soc-investigator/
|
+-- apps/
|   +-- mock-sentinel/
|   |   +-- src/
|   |
|   +-- investigator/
|       +-- src/
|
+-- packages/
|   +-- sentinel-client/
|   +-- contracts/
|
+-- fixtures/
|   +-- telemetry/
|   +-- scenarios/          <- hidden answer key, never reachable by the agent
|
+-- infra/
|   +-- docker-compose.yml
|   +-- kusto/
|
+-- runs/                  <- run artifacts, gitignored
|
+-- scripts/
|   +-- bootstrap-sentinel-data.ts
|   +-- evaluate-runs.ts   <- joins runs to ground truth, outside the agent
|
+-- docs/
|   +-- architecture.md
|   +-- prd-mock-sentinel.md
|   +-- adr/
|
+-- AGENTS.md
+-- package.json
+-- tsconfig.json
+-- oxlint.config.ts
+-- oxfmt.config.ts
```

Do not create empty packages for future roadmap capabilities. `agent-runtime`, `persistence` and
`testkit` are deliberately absent — see ADR 005 §7 for `agent-runtime` specifically.

## 12. Quality Gates

The root project should expose a single `check` workflow equivalent to:

```text
format check
-> lint
-> typecheck
-> tests
```

Expected commands:

```bash
bun run fmt:check
bun run lint
bun run typecheck
bun test
```

Use:
- Oxfmt for formatting;
- Oxlint for linting;
- TypeScript compiler for type checking.

Do not add ESLint or Prettier.

## 13. Implementation Sequence

### Milestone 1 — Repository bootstrap

- Bun workspace;
- strict TypeScript;
- Hono;
- Zod 4;
- Oxlint;
- Oxfmt;
- Docker Compose;
- root quality scripts.

### Milestone 2 — Training Lab loader

- pin Microsoft Azure-Sentinel revision;
- acquire telemetry CSVs;
- start Kusto Emulator;
- create local database/tables;
- ingest data;
- verify row counts and representative queries.

### Milestone 3 — Mock Sentinel REST API

- `/alerts`;
- `/alerts/:id`;
- `/schema`;
- `/query`;
- realistic error propagation;
- integration tests.

### Milestone 4 — Sentinel Client

- typed REST client;
- Zod response parsing;
- manual investigation performed only through this client/API boundary.

### Milestone 5 — Investigation runtime *(delivered)*

- Investigation Runner;
- Pi runtime behind a single harness boundary;
- model and limits from configuration;
- five agent tools;
- run artifact, with optional full transcripts.

### Milestone 6 — Evaluation *(in progress)*

- `bun run evaluate` joins run artifacts to the hidden scenario metadata;
- qualitative review against ground truth;
- BAML and a trace store if — and only if — evaluation demonstrates the need.

## 14. Current Non-Goals

Do not implement in this architecture slice:

- case-based memory/retrieval;
- human feedback learning;
- generalized SIEM ingestion;
- SOAR/forwarding;
- alert grouping;
- threat intelligence;
- Nuxt frontend;
- authentication/RBAC;
- multi-tenancy;
- production HA;
- semantic SOC playbooks.

These are separate capability PRDs.

*Extended by ADR 006 §1 — "Nuxt frontend" stays out. A local, read-only analyst console over run
artifacts is in scope from PRD-3.*

## 15. Planned Capability Roadmap

The stable core should later allow:

```text
Generalized Ingestion
        |
        v
Investigation
        |
Memory -> Context Builder
        |
        v
Agent Runtime
        |
        +-- Sentinel/XDR
        +-- Entra/Intune
        +-- Web/TI
        |
        v
Assessment
        |
        v
Forwarding / SOAR

Frontend -> Investigation API
```

Major roadmap PRDs:

1. Core Investigation Agent
2. Case-Based Memory + Human Feedback
3. Context / External Research
4. Additional Investigation Capabilities
5. Generalized Ingestion
6. Forwarding / Automation
7. UI / Operations
8. Production Platform

*Partly reordered by ADR 006 §1 — PRD-3 delivers a local, read-only analyst console ahead of item 7.
Item 7 remains the networked UI / Operations surface behind an Investigation API.*

## 16. References

- Microsoft Learn: Azure Data Explorer Kusto Emulator overview and installation.
- Microsoft Azure-Sentinel repository: Microsoft Sentinel Training Lab.
- Pi repository: `earendil-works/pi`, especially `pi-agent-core` and `pi-ai`.
- Zod documentation, and TypeBox as re-exported by `pi-ai`.
- Oxc documentation for Oxlint and Oxfmt.
- Hono Bun documentation.
- Brave Search API documentation.
