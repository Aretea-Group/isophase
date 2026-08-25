# PRD-2 — Core Investigation Agent

**Status:** Complete — see `docs/adr/005-investigation-agent-boundary.md` for accepted deviations
**Produces:** ADR 005 — Investigation agent boundary (amends ADR 002, ADR 003)
**Full text:** `git show fe28b0c:"docs/prd-2-Core Investigation Agent.md"` — feat(console): ship PRD-5 operator surface, 2026-08-20

PRD-1 left a deterministic investigation environment with nothing investigating it. PRD-2 asked one
deliberately narrow question — *can a capable LLM autonomously perform useful T1/T2 SOC
investigations when given an alert, knowledge of the available telemetry, and sufficiently general
investigation capabilities?* — and built the smallest agent that could answer it. Not a production
SOC platform, and explicitly not a playbook: the wager was that generality beats a scripted
procedure, which only holds if nothing in the harness encodes how to investigate.

`apps/investigator` is that agent. `src/harness.ts` is the only file in the repository that imports
Pi and owns dependencies, startup context, limits and completion semantics while knowing nothing
about security; `src/tools/` is the agent's entire capability surface — `query_security_data`,
`get_security_schema`, `web_search`, `web_fetch`, `submit_investigation` — and
`query_security_data` returns the raw result on purpose, because anything the harness summarises is
a playbook smuggled in through formatting. Each sweep writes one `runs/<run-id>.json` keyed by
`systemAlertId`, flushed per alert. Six things were built differently from this document and ADR 005
records them all: `submit_investigation` replaced the BAML finalizer, the run artifact replaced a
trace store, five tools replaced one, table names replaced the full schema, TypeBox took the Pi tool
boundary, and the `agent-runtime` wrapper package was never created — §24 ruled it out and PRD-2 §24
still holds.

**Superseded non-goals.** §24 records what *this phase* did not build; it does not bind later
phases:

- §24 "alert queue" — built in PRD-5 (ADR 007), which also reverses PRD-3 §4.1.
- §24 "frontend/UI" — scoped to a local TUI, not deleted, by PRD-3 and ADR 006 §1.
- §24 "formal evaluation/regression platform" — built in PRD-6 (ADR 008); §23's deferred regression
  infrastructure is what PRD-6 is.
- §24 "generalized connector interfaces" — bounded and built as the tabular source boundary in
  ADR 010; the boundary it defines is in `packages/contracts/src/security-source.ts`.
- §24 "additional security-system integrations" — built in PRD-7 (ADR 009), Azure Monitor Logs.
- §24 "trace database" — never built; ADR 005 §2 chose the run artifact instead, with transcripts
  under `runs/traces/` only when `INVESTIGATOR_TRACE=true`.
- §24 "generic custom agent framework", "generic harness plugins/providers" — still excluded, and
  PRD-2 §24 is the citation AGENTS.md §5 uses to keep excluding them.
- §24 "case memory", "tenant memory" — roadmap §1. "human-feedback learning" — roadmap §2.
  "context compaction" — roadmap §3. "alert-specific investigation playbooks" — permanently out
  (AGENTS.md §10). SOAR, ticketing, multi-agent workflows, planner/executor and reviewer agents,
  scheduling and polling ingestion remain out of scope.
