# PRD-7 — Real Microsoft Sentinel Connector

**Status:** Approved for implementation

**Depends on:** PRD-2 — Core Investigation Agent; PRD-5 — Console Operator Surface

**Would produce:** ADR 009 — Azure Monitor Logs Connector

**Language/runtime:** TypeScript strict mode, Bun

**Runtime schemas:** Zod

## 1. Purpose

Run the existing investigation flow against one real Microsoft Sentinel workspace without changing
its alert-first strategy or five tools. Mock Sentinel remains the default.

## 2. Product goal

An operator selects `SENTINEL_CONNECTOR=azure`, supplies a Log Analytics workspace ID, and uses
either a service principal or an existing Azure CLI/Azure PowerShell login. The investigator and
console then use Azure Monitor Logs for alerts, schema and read-only KQL.

The connector implements the existing Sentinel capability:

- `listAlerts` and `getAlert` read `SecurityAlert`;
- `getSchema` reads workspace metadata;
- `query` executes read-only KQL and reports truncation;
- `getCorpus` returns `undefined`, because corpus identity belongs to Mock Sentinel benchmarking.

## 3. Requirements

- Acquire tokens through Azure Identity. A complete service-principal configuration uses only that
  identity; otherwise try Azure CLI, then Azure PowerShell. Cache access tokens in memory.
- Use only Azure Monitor Logs data-plane reads.
- Validate remote payloads with Zod and preserve useful authentication, transport and KQL errors.
- Reject Kusto control commands before sending a request.
- Return at most 500 query rows and report when a 501st row proves truncation.
- Reject Azure partial results rather than presenting incomplete evidence as complete.
- Keep secrets and bearer tokens out of URLs, errors, traces and run artifacts.
- Refuse Azure investigations that would write tenant data to the committed `runs/` tree.
- Provide deterministic connector tests and an opt-in, model-free live smoke test.

## 4. First-slice limit

`listAlerts()` reads at most 501 recent alerts. If the workspace contains more than 500, it fails
with an explicit limit error instead of hiding alerts. `listAlerts(top)` remains usable for targeted
operator views, and `getAlert(id)` remains usable for a targeted investigation.

Pagination and alert filtering wait for an observed workspace need and a separate operator-flow
decision.

## 5. Authentication setup

The selected identity needs the workspace-scoped `Log Analytics Data Reader` role. An operator may
provide an existing app registration and secret, or sign in beforehand with `az login` or
`Connect-AzAccount`. Service-principal values are all-or-none so a broken deployment identity never
silently falls back to a developer account. Role assignment and secret lifecycle are operator
responsibilities; this project does not mutate Azure configuration. Workspace shared keys are
ingestion credentials and cannot authorize Logs queries.

## 6. Tenant-data handling

Real alerts, investigation assessments and optional traces can contain tenant data. Azure startup
requires an operator-selected ignored directory such as `.data/azure-runs`; traces must use the
same ignored root. Committed benchmark artifacts under `runs/` remain Mock Sentinel measurements.

## 7. Acceptance

- Mock configuration and behavior remain unchanged by default.
- Both applications select the same narrow client capability from environment configuration.
- Deterministic tests cover credential selection, authentication, schema, queries, alert projection
  and secret safety.
- The repository's scoped checks pass, followed by `bun run check` apart from documented baseline
  failures unrelated to this change.
- The opt-in live smoke test loads schema, queries `SecurityAlert`, round-trips one alert and
  observes an actionable invalid-KQL error.

## 8. Non-goals

- Azure provisioning or RBAC changes;
- managed identity, certificates, workload federation, interactive browser or device-code login;
- incident ARM APIs, incident grouping, multi-workspace queries or write-back;
- retries, background token refresh, sovereign-cloud endpoints or workspace shared-key query auth;
- Azure Monitor or ARM client SDKs beyond the single Azure Identity dependency;
- connector registries, plugin discovery, new packages, agent tools or investigation playbooks.
