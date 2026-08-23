# ADR 009 — Azure Monitor Logs Connector

**Status:** Accepted

**Date:** 2026-08-22

**Implements:** PRD-7 — Real Microsoft Sentinel Connector

## Context

The investigator already obtains alerts, schema and arbitrary read-only KQL through one client.
Consumers currently name its concrete Mock Sentinel implementation even though they use only five
methods. A real workspace needs the same capability without exposing Azure configuration to the
investigation harness or adding tools.

## Decisions

### 1. Azure Monitor Logs is the single data plane

Alerts come from the `SecurityAlert` table, schema from workspace metadata, and investigation data
from the Logs query endpoint. This needs one workspace identifier and one token audience.

The Sentinel incident ARM API is rejected for this slice. It would add ARM resource configuration,
a second token audience, incident pagination, per-incident alert fan-out and deduplication without
improving the current per-alert KQL investigation.

### 2. One structural capability replaces the concrete dependency

`SentinelClient` contains the five existing methods. `SentinelApiClient` remains the Mock Sentinel
implementation and `AzureSentinelClient` is the Azure implementation. A two-branch factory is the
only selection mechanism.

No base class, registry, plugin protocol or provider package is introduced.

### 3. Azure Identity supplies credentials; transport stays direct

The Azure client asks an Azure Identity `TokenCredential` for the Log Analytics `.default` scope,
caches the result in memory until shortly before expiry, and shares one in-flight token request.
Metadata and query calls continue to use `fetch`, `AbortSignal.timeout` and Zod directly.

A complete service-principal triple creates a standalone `ClientSecretCredential`. With no triple,
an explicit chain tries `AzureCliCredential` and then `AzurePowerShellCredential`. The two modes are
separate so an invalid deployment credential cannot silently fall back to a personal login.
`DefaultAzureCredential` is rejected because managed identity, environment variants and interactive
developer credentials are outside this slice. Azure Monitor and ARM client SDKs are also rejected;
one Azure Identity dependency covers the observed authentication need.

### 4. Azure responses retain existing contracts

Query tables keep Azure's positional shape and gain the repository's existing truncation sibling.
The client appends `take 501`, returns at most 500 rows and rejects Azure `PartialError` responses.

`SecurityAlert` rows are projected to the existing `SecurityAlertResource` contract. Alert resource
IDs use the workspace ARM resource ID from metadata plus `SystemAlertId`. `getCorpus()` returns
`undefined` without a network request.

### 5. Real tenant artifacts stay outside the benchmark corpus

Azure startup refuses the committed `runs/` directory and requires run and trace paths under one
ignored operator-selected root. Only the non-secret Logs workspace target is recorded in the
existing `sentinelBaseUrl` artifact field.

## Consequences

- Investigator and console depend on a capability rather than either transport.
- Mock Sentinel stays the zero-configuration default.
- The connector supports one public-cloud workspace through a service principal or an existing
  Azure CLI/Azure PowerShell session.
- Workspace shared keys remain ingestion-only and are not offered as query credentials.
- Workspaces with more than 500 alerts require targeted operation until pagination has a real
  product requirement.
