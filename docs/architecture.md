# SOC Investigation Agent — Architecture

**Status:** v0.1 baseline  
**Scope:** Mock Sentinel environment + first autonomous investigation agent  
**Language:** TypeScript  
**Runtime:** Bun

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

Pi is the initial agent harness, not the domain architecture. Sentinel access, persistence, BAML contracts, and investigation state belong to the application.

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
BAML assessment finalization
      |
      v
PostgreSQL trace + assessment
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

### 4.3 Investigation Runner

**Why it exists:** Owns one investigation execution.

**Responsibilities:**
- obtain the starting alert;
- obtain context required at startup;
- create the Pi agent;
- register capabilities/tools;
- subscribe to runtime events;
- persist tool/model trace;
- call the final BAML assessment step;
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
- trace persistence;
- final assessment contract.

### 4.5 BAML Contracts

BAML owns LLM-facing structured contracts, initially the final investigation assessment.

The initial flow is:

```text
Pi autonomous investigation
        |
        v
investigation evidence / trace
        |
        v
BAML FinalizeAssessment
        |
        v
validated structured assessment
```

This intentionally keeps autonomous investigation and contractual output separate.

### 4.6 Persistence

PostgreSQL with Drizzle is the initial persistence layer for the investigator.

Persist enough information to inspect and later learn from a case:

- original alert;
- schema snapshot/version used;
- model/provider configuration;
- agent events/messages required for debugging;
- tool calls;
- exact KQL;
- tool results or stored result references;
- final BAML assessment;
- timestamps;
- failures.

Cross-investigation retrieval and human-feedback learning are not implemented in the current slice, but this data becomes the input to the later Memory PRD.

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
+ current queryable schema
+ available tools
```

No previous investigation transcript is included in the current implementation.

Later, the Memory PRD will add relevant prior cases as additional retrieved context.

### 7.1 Schema strategy

For the first implementation, inject the current schema at startup.

If measurement shows that the full schema is too large or noisy, a later optimization may replace or complement this with dynamic schema discovery. Do not add that complexity before measuring the real schema.

## 8. Agent Tool Surface

Start with one security investigation tool:

```text
query_security_data(kql)
```

The tool:
- accepts KQL;
- calls the Sentinel Client;
- receives query data or a useful query error;
- returns bounded results to the agent;
- records the exact query and response metadata.

The agent decides whether to call it.

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

### 9.2 BAML

Use BAML for LLM contracts:

- final assessment structure;
- associated LLM instructions/prompts;
- provider-independent structured output generation.

Rule:

```text
Zod = application/runtime validation
BAML = LLM input/output contracts
```

Do not duplicate the same responsibility in both systems unless integration requires a generated adapter.

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
| LLM contracts | BAML |
| Query backend | Microsoft Kusto Emulator |
| Mock telemetry | Microsoft Sentinel Training Lab telemetry |
| Database | PostgreSQL |
| DB access | Drizzle |
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
|   +-- agent-runtime/
|   +-- contracts/
|   +-- persistence/
|   +-- testkit/
|
+-- baml_src/
|   +-- assessment.baml
|   +-- clients.baml
|
+-- fixtures/
|   +-- alerts/
|   +-- scenarios/
|
+-- infra/
|   +-- docker-compose.yml
|   +-- kusto/
|
+-- scripts/
|   +-- bootstrap-sentinel-data.ts
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

Do not create empty packages for future roadmap capabilities.

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

### Milestone 5 — Investigation runtime

- PostgreSQL/Drizzle;
- Investigation Runner;
- Pi runtime;
- model configuration;
- one `query_security_data` tool;
- agent event persistence.

### Milestone 6 — Assessment

- BAML final assessment contract;
- finalizer;
- persisted result;
- first end-to-end autonomous investigation.

## 14. Current Non-Goals

Do not implement in this architecture slice:

- case-based memory/retrieval;
- human feedback learning;
- generalized SIEM ingestion;
- SOAR/forwarding;
- alert grouping;
- web research;
- threat intelligence;
- Nuxt frontend;
- authentication/RBAC;
- multi-tenancy;
- production HA;
- semantic SOC playbooks.

These are separate capability PRDs.

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

## 16. References

- Microsoft Learn: Azure Data Explorer Kusto Emulator overview and installation.
- Microsoft Azure-Sentinel repository: Microsoft Sentinel Training Lab.
- Pi repository: `earendil-works/pi`, especially `pi-agent-core` and `pi-ai`.
- Boundary BAML documentation.
- Zod documentation.
- Oxc documentation for Oxlint and Oxfmt.
- Hono Bun documentation.
- Drizzle Bun/PostgreSQL documentation.
