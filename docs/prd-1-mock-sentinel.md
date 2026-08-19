# PRD — Mock Sentinel Investigation Environment

**Status:** Delivered — see `docs/adr/004-alert-api-shape.md` for what shipped  
**Owner:** SOC Investigation Agent project  
**Purpose:** Local deterministic investigation environment

## 1. Goal

Build a local Microsoft Sentinel-like environment that can be used to develop and test a future SOC investigation agent without depending on a live Azure tenant.

The environment must expose realistic security telemetry, alerts, schema information, and KQL query capabilities through REST.

The milestone ends before implementing the LLM agent.

## 2. Core Idea

Use the Microsoft Sentinel Training Lab telemetry as the underlying security dataset.

Load that telemetry into a local Microsoft Kusto Emulator and expose the required investigation capabilities through a small REST service.

```text
Microsoft Sentinel Training Lab telemetry
                    |
                    v
              Kusto Emulator
                    |
                    v
          Mock Sentinel REST API
          +-- Alert API
          +-- Schema API
          +-- KQL Query API
                    |
                    v
            Sentinel capability
                    |
                    v
              Future agent
```

The future agent and investigator must interact with this environment through HTTP. They must not directly read fixture files or access the Kusto container.

## 3. Product Principles

### Behavioral fidelity over Azure emulation

The mock should reproduce the behaviors relevant to an investigation agent:

- remote HTTP calls;
- JSON request/response boundaries;
- realistic alert data;
- real KQL execution;
- Kusto query errors;
- result limits/truncation;
- deterministic reset.

It does not need to reproduce:

- Azure ARM hierarchy;
- Azure authentication;
- all Sentinel APIs;
- all Defender XDR APIs;
- every Microsoft security product;
- Microsoft API URL shapes exactly.

### Same consumer boundary as the future real integration

The Mock Sentinel REST service is one implementation behind the Sentinel capability. Future application code must not depend on mock internals.

## 4. Scope

### 4.1 Training Lab telemetry

Use the prerecorded telemetry from Microsoft’s Sentinel Training Lab repository.

Requirements:
- pin a specific upstream repository revision;
- load the relevant lab telemetry into Kusto Emulator;
- preserve the available tables, columns, and relationships as far as practical;
- keep one shared data environment rather than duplicating telemetry per scenario;
- provide a repeatable bootstrap/reset process.

A local loader is expected because Kusto still requires table/schema creation and ingestion commands.

### 4.2 Mock Alert API

Expose read-only alert fixtures that correlate with scenarios represented in the Training Lab data.

Initial operations:

```text
GET /alerts
GET /alerts/:id
```

Alerts should contain enough realistic Microsoft security context for agent testing, including:
- identifier;
- title;
- description;
- severity;
- detection time;
- provider/source;
- relevant entities where available;
- provider-specific/raw properties where useful.

Perfect Microsoft response compatibility is not required.

### 4.3 Schema API

Expose the data that can actually be queried.

```text
GET /schema
```

Minimum response information:
- table name;
- column names;
- column types.

The response must be derived from or verified against the current Kusto environment.

### 4.4 KQL Query API

Expose read-only KQL execution.

```text
POST /query
```

The service forwards the query to Kusto Emulator.

Responses must make available:
- result columns;
- rows;
- returned row count where available;
- truncation information;
- Kusto errors.

Do not automatically repair invalid KQL. A future agent must be able to observe an error and choose whether to retry with a corrected query.

### 4.5 Operational endpoint

Expose:

```text
GET /health
```

This is for local orchestration and tests, not part of the Sentinel domain capability.

## 5. Scenario Definitions

A scenario is test metadata layered on top of the shared telemetry.

It may contain:
- starting alert ID;
- source Training Lab exercise;
- expected analyst outcome;
- important entities;
- approximate time window;
- evaluator notes.

Scenario metadata is hidden from the future agent.

Do not duplicate telemetry for each scenario.

## 6. Initial Scenario

Start with one Training Lab scenario that has:
- a clear starting alert;
- supporting underlying telemetry;
- more than one plausible investigative query;
- a comprehensible expected outcome.

The architecture must not depend on the chosen alert type.

## 7. Public REST Boundary

All consumers must use the REST service.

Forbidden consumer paths:
- direct fixture imports;
- direct CSV access;
- direct Kusto access;
- importing internal Mock Sentinel repositories.

Target surface:

```text
GET  /health
GET  /alerts
GET  /alerts/:id
GET  /schema
POST /query
```

The REST contracts must be validated with Zod 4.

## 8. Local Development

Target container setup:

```text
docker compose
+-- mock-sentinel
+-- kusto
```

The Kusto container is an internal dependency.

A developer should be able to:

1. bootstrap/pin the Training Lab data;
2. start the environment;
3. wait for health;
4. list alerts;
5. retrieve an alert;
6. retrieve the schema;
7. execute investigative KQL;
8. receive useful query errors;
9. reset to a known state.

No frontend is required.

## 9. Testing Requirements

### REST
- list alerts;
- retrieve known alert;
- 404 for unknown alert;
- retrieve schema;
- execute valid KQL;
- invalid KQL returns a useful non-success response;
- oversized results are bounded or explicitly marked as truncated.

### Data
- expected representative tables exist;
- representative rows are present after bootstrap;
- at least one alert correlates with the underlying telemetry.

### Manual investigation acceptance test

A developer can complete this flow only through the public REST API:

```text
retrieve alert
    |
    v
inspect alert entities/context
    |
    v
inspect schema
    |
    v
run relevant KQL
    |
    v
find supporting/contradicting evidence
    |
    v
reach expected analyst conclusion
```

## 10. Non-Goals

This PRD does not include:
- an LLM agent;
- Pi integration;
- BAML assessment contracts;
- production Sentinel ingestion;
- Azure authentication;
- complete Azure API emulation;
- investigation memory;
- human-feedback learning;
- web research;
- threat intelligence;
- SOAR;
- frontend;
- RBAC;
- multi-tenancy;
- production scaling.

## 11. Success Criteria

The PRD is complete when:
- the Training Lab telemetry is loaded locally into Kusto Emulator;
- the environment can be recreated deterministically from a pinned upstream revision;
- realistic mock alerts are available over REST;
- the current schema is available over REST;
- read-only KQL can be executed over REST;
- Kusto query failures are represented usefully;
- at least one mock alert correlates with underlying data strongly enough for a manual investigation;
- no consumer requires direct access to Mock Sentinel or Kusto internals.

## 12. Next Slice

Attach an autonomous LLM investigation agent to the Sentinel capability.

The next system should be able to:

```text
receive alert
-> reason over existing evidence
-> decide whether more evidence is required
-> optionally execute KQL
-> produce a justified likely FP / likely TP / inconclusive assessment
```
