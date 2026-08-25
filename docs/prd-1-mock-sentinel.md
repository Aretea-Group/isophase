# PRD-1 — Mock Sentinel Investigation Environment

**Status:** Complete — see `docs/adr/004-alert-api-shape.md` for what shipped
**Decisions:** ADR 004 — Alert API shape (produced here); ADR 001 — Training Lab + Kusto (the spike this rests on)
**Full text:** `git show 211735a:"docs/prd-1-mock-sentinel.md"` — docs: reconcile PRDs, ADRs and architecture with what was built, 2026-08-19

A SOC investigation agent cannot be developed against a live Azure tenant: the telemetry is not
reproducible, the alerts are not stable, and nobody can run the thing twice and compare. PRD-1 built
the environment that makes an agent testable at all — realistic security telemetry, alerts, schema
discovery and KQL, all local, all deterministic, and deliberately stopping before the first line of
agent code.

What shipped is the first three hops of the chain: `fixtures/telemetry/` holds the Microsoft Sentinel
Training Lab CSVs at a pinned revision, `scripts/bootstrap-sentinel-data.ts` shifts them onto one
`TELEMETRY_TIME_ANCHOR` offset (ADR 001) and ingests them into the Kusto Emulator, and
`apps/mock-sentinel` is the only code that talks to Kusto — five routes under `src/routes/`
(`alerts`, `schema`, `query`, `corpus`, `health`) fronted by `packages/contracts` and consumed
through `packages/sentinel-client`. `/corpus` is not from this PRD; PRD-6 §6.8 added it. The alert
shape that emerged differs from the one drafted here, and ADR 004 is where that was settled.

**Superseded non-goals.** §10 records what *this phase* did not build; it does not bind later
phases, four of which went on to build these:

- §10 "an LLM agent", "Pi integration" — built in PRD-2 (ADR 002, ADR 005).
- §10 "web research" — built in PRD-2 §12 as `web_search`; `web_fetch` added by ADR 005.
- §10 "Azure authentication", "production Sentinel ingestion" — built in PRD-7 (ADR 009).
- §10 "frontend" — scoped to a local TUI, not deleted, by PRD-3 and ADR 006 §1.
- §10 "BAML assessment contracts" — never built; ADR 005 replaced the BAML finalizer with the
  `submit_investigation` tool.
- §10 "investigation memory", "human-feedback learning", "threat intelligence", "SOAR", "RBAC",
  "multi-tenancy", "production scaling" — still out of scope; roadmap §1, §2.
