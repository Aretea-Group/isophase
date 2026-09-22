# PRD-6 — Run Comparability

**Status:** Complete — see `docs/adr/008-comparability-record.md` for the decisions as accepted
**Produces:** ADR 008 — The Comparability Record
**Amends:** ADR 005 §2 (the artifact gains fixed-size counters); PRD-2 §23 (regression infrastructure, deferred there, is built here); `AGENTS.md` §5, §9, §12, §14; `docs/roadmap.md` §7 (the band partition moved here)
**Full text:** `git show cca0770:"docs/prd-6-run-comparability.md"` — fix(evaluate): hash settings not outcomes, and stop scoring derivedFrom, 2026-08-21

`bun run evaluate` printed numbers that were not noisy but **structurally wrong**: the two tables
were not two models, the denominators were not the same denominator, and a stub answering `65` to
every alert without issuing a single query scored 12/14 — beating both. Terra read `10/13` two hours
after reading `11/14`, because the denominator was "scenarios this model happened to complete" and
one run was archived in between. A headline whose denominator moves on its own cannot answer *is
terra worth ten times luna's token price*, *does analyst context help*, *does thinking level* — and
across all 47 artifacts on disk, an honest grouping yielded 32 cells with not one of them holding
three draws. The goal was a measurement bed, not a report: a data problem before a code problem.

What shipped is a corpus that accumulates honestly and a scorer that never touches it. The run
artifact gained fixed-size counters only — `turns`, a tally over the five closed tool names, one
`usage` object, a `provenance` block — under the bright line that **nothing on the artifact may grow
with the length of an investigation** (ADR 008 §1); `apps/investigator/src/contracts/run.ts` is
where that line lives. The measurement is derived in `scripts/` and never persisted, so no scored
report exists on disk to drift (§2); the condition key is derived from what a run was *set up with*
and never from what it *did* (§3); the artifact stopped fabricating `thinkingLevel` (§4); corpus
identity moved into the database behind `GET /corpus`, the first addition to the REST surface since
PRD-1 specified it (§5); the trajectory is still not graded (§6); the overlapping verdict bands were
repartitioned here — reversing PRD-4 §9's deferral — with the pre-partition `band⁰` printed beside
`band` so the movement is auditable per draw (§7); and `runs/` became a committed append-only root
that `evaluate` reads together with `runs/.archive/`, because archiving returns an alert to the
console's queue and must not delete a measurement (§8). Cost and effort print beside the score and
never enter it. `bun run evaluate --gaps` reports what the corpus still needs. **§12's unresolved
budget recommendation, recorded nowhere else: re-baseline as two conditions at n=3 rather than three
at n=2 — with a measured 75-point spread on one scenario, n=2 cannot separate a model from a coin,
so cut scenarios before cutting repeats.**

**Superseded non-goals.** §9 records what *this phase* did not build; it does not bind later phases.
Nothing in it has been picked up since:

- §9 "scoring `discriminatingEvidence` coverage, and any per-table tally on the artifact" — still
  excluded; PRD-2 §23 forbids grading the trajectory, and `toolCalls.query_security_data` answers
  the memory question without crossing that line.
- §9 "scoring `derivedFrom`" — still recorded and still not read (§6.11).
- §9 "corpus rebalancing, difficulty weights, `cluster`/`role` markers" — roadmap §7; the band
  partition moved here, corpus authoring did not, and that boundary is what keeps PRD-4 §9 intact.
- §9 "a benchmark tab in the console" — still barred; ADR 006 §5 keeps scoring out of the console
  and ADR 007 settled in-process execution without lifting it.
- §9 "`experimentId`, `repeatIndex`, a `baseline|steered` enum, a memory flag, `packages/bench`, a
  run store" — still excluded (AGENTS.md §5, PRD-2 §24).
- §9 "a sampling pin" — impossible rather than deferred: pi-ai exposes no `seed`, `temperature` or
  `samplingParams`, so repeats are the only variance instrument this system can have.
- §9 "`previousAlertIds` on the `Scenario` schema" — still excluded; §6.5 exits naming the unjoined
  ids, so add the alias against a concrete orphaned set when that first fires.
- §9 "forcing `INVESTIGATOR_TRACE=true` for eval runs" — unnecessary; §6.7 exists so it is.
