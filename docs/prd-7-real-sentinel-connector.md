# PRD-7 — Real Microsoft Sentinel Connector

**Status:** Complete — see `docs/adr/009-azure-monitor-logs-connector.md`
**Produces:** ADR 009 — Azure Monitor Logs Connector
**Depends on:** PRD-2 — Core Investigation Agent; PRD-5 — Console Operator Surface
**Full text:** `git show 8ad3c2a:"docs/prd-7-real-sentinel-connector.md"` — docs: describe Azure identity options, 2026-08-22

Everything through PRD-6 was measured against Mock Sentinel, which is deterministic by design and
therefore proves nothing about a real workspace. PRD-7 ran the existing investigation flow against
one real Microsoft Sentinel tenant without touching its alert-first strategy or its five tools —
same agent, same console, different source. Mock Sentinel stays the default, and the point was to
find out what breaks when the data is real, not to build a product surface.

`SENTINEL_CONNECTOR=azure` selects `packages/sentinel-client/src/azure.ts` through
`src/factory.ts`, which is the one place either application resolves a client; both `env.ts` files
default to `mock` so a zero-credential checkout is unchanged. Tokens come from Azure Identity —
a complete service-principal group is used alone and all-or-none, so a broken deployment identity
never falls back to a developer login, otherwise Azure CLI then Azure PowerShell; the role needed is
workspace-scoped `Log Analytics Data Reader`, and this project never mutates Azure configuration.
Three limits are worth knowing because they exist nowhere else: `listAlerts()` reads at most 501
alerts and **fails loudly rather than hiding any** above 500, pagination deferred until a real
workspace asks for it; a `200 PartialError` is rejected rather than presented as complete evidence;
and Azure runs must write to an operator-selected ignored root such as `.data/azure-runs`, traces
included, because `runs/` is a committed tree of Mock Sentinel measurements and tenant data may not
enter it. `getCorpus` returns `undefined` — corpus identity belongs to benchmarking.
`packages/sentinel-client/test/azure.test.ts` covers all of it in 31 deterministic tests; the live
smoke test in `test/integration/azure.test.ts` is `describe.skipIf`-gated and model-free.

**Superseded non-goals.** §8 records what *this phase* did not build; it does not bind later phases.
Nothing in it has been picked up since:

- §8 "connector registries, plugin discovery, new packages, agent tools or investigation playbooks"
  — still excluded, and ADR 010 §1 excluded them again when it drew the tabular source boundary.
- §8 "Azure provisioning or RBAC changes", "managed identity, certificates, workload federation,
  interactive browser or device-code login", "incident ARM APIs, incident grouping, multi-workspace
  queries or write-back", "retries, background token refresh, sovereign-cloud endpoints or workspace
  shared-key query auth", "Azure Monitor or ARM client SDKs beyond the single Azure Identity
  dependency" — all still out of scope, with two narrowings recorded elsewhere:
  **write-back** was taken up by PRD-9 for Defender only (ADR 012), and **"retries"** means what it
  says — the connector re-issuing a request — which no connector does. ADR 012 §11 added backoff to
  the unattended *loop*, which delays its next poll and therefore sends fewer requests, not more.
