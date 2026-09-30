# PRD-10 — Unattended Investigation and Findings Write-Back

**Status:** Complete — see `docs/adr/013-findings-write-path.md` §6 for the reversed Graph publisher (§4.2, amendment A1)
**Produces:** ADR 013 — The findings write path and unattended operation
**Amends:** ADR 009 §1, ADR 011 §1, `AGENTS.md` §2, §3, §5
**Reverses:** `AGENTS.md` §2 ("any write path" leaves the non-goal list)
**Full text:** `git show f39a31f:"docs/prd-10-unattended-investigation-and-findings-write-back.md"` — docs(prd-10): amendment A1 — AC5 carried to ADR 013 §6; tick two done checklist items; resolve Q3, 2026-09-30

Eight PRDs in, nothing the system produced reached the person who had to act on it: every verdict
landed in `runs/*.json` and a local TUI, each investigation cost one human action, and the only
documented front door was the Kusto Emulator on an amd64-only image. A reader with a Defender tenant
and no Docker had no path through the README.

Six phases, all landed 2026-09-16. `FindingsPublisher` in `@soc/sentinel-client` with a local
implementation and the Defender connector as the Graph one, opt-in behind `PUBLISH_FINDINGS`; a
comment on the incident, never a state change, idempotent by marker. `investigate --watch`: a sliding
window plus artifact deduplication, no cursor, creation only, backing off under a spend ceiling
(`WATCH_SPEND_CEILING_USD`). A unix domain socket carrying `InvestigationControl`, so the console
attaches to a loop or drives one, and is optional in both directions. `feedback/` and the console's
drive path removed; `AnalystClassification` kept in `@soc/contracts`. A run-mode front door in the
README that needs Bun and tenant credentials and nothing else. Not built as written: the Graph
publisher of §4.2 — `PATCH /security/alerts_v2/{id}` returns 200 and discards the comment (ADR 013
§6), so publication targets the incident under `SecurityIncident.ReadWrite.All`, and
`SecurityAlert.ReadWrite.All` is dropped.

**Corrected during build.** Q1 (comments `PATCH`-writable on `alerts_v2`) — no, measured 2026-09-16.
Q2 (the operator's Sentinel workspace onboarded) — yes. Q4 (publication inside `executeRun`) — yes,
after the artifact is written. Q3 (spend ceiling's unit) — US dollars, per watch process, no default.

**Amendments.** A1 (2026-09-30, cleanup) carried AC5 — the `alerts_v2` comment retrievable under
`SecurityAlert.ReadWrite.All` — to ADR 013 §6 and AC22; it was ticked but the ADR had measured the
path as unworkable. Final tally: 25 ticked, 0 dropped, 1 carried, 0 open.

**Superseded non-goals.** §3 records what *this phase* did not do; it does not bind later phases.
Nothing in it has been picked up since:

- §3 case memory, human feedback capture and a durable-execution runtime — consolidated in
  `docs/roadmap.md` §1, which records that the idempotency key already gives crash recovery.
- §3 "closing alerts, or setting `status`, `classification`, `determination`" — permanently out; a
  future PRD needs its own decision record.
- §3 standalone (non-onboarded) Sentinel workspaces — out unless the REST API's retirement stalls.
- §3 TCP sockets, remote attach, authentication on the control channel — out; `AGENTS.md` §2's
  no-RBAC and no-multi-tenancy lines hold.
- §3 deployment artifacts — `docs/roadmap.md` §11. Richer assessment content — §5. Alert grouping —
  §8. Schema optimization — §3.
- §3 reacting to lifecycle transitions (re-opened alerts, reassignment, merge into an incident) —
  promised "the roadmap, beside case memory"; no roadmap entry was written. Still out.
