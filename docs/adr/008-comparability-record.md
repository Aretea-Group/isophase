# ADR 008 — The Comparability Record

**Status:** Proposed — the decisions PRD-6 (Draft) rests on; none is implemented yet
**Date:** 2026-08-20
**Implements:** PRD-6 — Run Comparability
**Amends:** ADR 005 §2 (the run artifact holds per-alert outcomes only); PRD-2 §23 (formal
regression infrastructure, deferred); `AGENTS.md` §9 (the REST surface gains a sixth route), §12
(the artifact gains counters), §14 (a new phase)
**Extends:** ADR 006 §4 (run artifact lifecycle), §5 (ground-truth scoring stays in `scripts/`);
ADR 007 §2 (the investigator remains the sole writer of run artifacts)

## Context

PRD-6 makes investigation runs comparable across models, prompts, analyst steering and — later —
case memory. Implementing it as written contradicts two decisions taken when there was nothing to
compare.

`AGENTS.md` §15 asks for an ADR rather than a silent change of course. This is that ADR.

Two facts set the terms. First, the run artifact was deliberately not a trace store: ADR 005 §2
records that PRD-2 persists "per-alert outcomes only", and `contracts/run.ts` says the same in the
schema, conditioning any addition on *"evaluation showing a concrete need"*. Second, PRD-2 §23
deferred regression infrastructure and asked only that artifacts make later comparison
straightforward.

The need has now been demonstrated rather than argued. Measured across the artifacts on disk:

- Grouping runs by everything they actually record yields **seven conditions, 30 cells, none with
  more than two draws** — while `evaluate` reports two model tables, so each is a blend.
- The only matched model comparison available gave **opposite signs two hours apart**, because one
  run was archived and the shared scenario set shrank by one. Neither answer was wrong; both rested
  on one draw per cell.
- A stub answering a constant `65` to every alert, issuing no queries, scores **12/14** — beating
  both measured models.
- The system cannot state what a run cost without an opt-in transcript that writes 0.16–23 MB per
  investigation into the loop that is supposed to be cheap to repeat.

Forty artifacts that cannot answer the roadmap's own cost question, and a comparison that inverts
under an archived file, are the concrete need `contracts/run.ts` asked for.

## Decisions

### 1. The artifact gains fixed-size counters — counters yes, content no

**Was:** ADR 005 §2 — one `runs/<run-id>.json` per invocation holding per-alert outcomes only, with
any addition conditioned on evaluation showing a concrete need.

**Now:** the same file, plus fixed-size counters, with the addition conditioned on a bright line
rather than on nothing.

`InvestigationResult` gains `turns`, `toolCalls` (a `Record` keyed by the five closed tool names)
and `usage` (`input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, `costUsd`).
`InvestigationRun` gains an optional `provenance` block.

This amends ADR 005 §2 in letter. It is written to keep it true in substance, and the bright line is
this:

> **Nothing added to the artifact may grow with the length of an investigation.** No per-event
> records, no messages, no tool arguments, no KQL text, no query results. The artifact must remain
> unable to reconstruct what the agent saw, and must not be replayable.

A count of `query_security_data` calls is a number. The queries themselves are a trace. The first is
in; the second stays in `runs/traces/`, optional and off by default.

ADR 005 §2 made the same distinction for the same file when it argued that a transcript is a
debugging aid for one run while the artifact is the durable, comparable output. Cost and effort are
properties of the run as a whole, not of any event within it, which is why they belong on the side
of the line the artifact is on.

**Rejected: forcing `INVESTIGATOR_TRACE=true` for evaluation runs.** It is the only alternative that
needs no contract change, and it makes the repeatable loop expensive precisely when repeats become
the primary instrument. It also leaves cost recoverable only by parsing a 370-line index over a
multi-megabyte JSONL, when the number is already in process — `agent.state` is public and assistant
messages carry `usage`. The harness currently discards it.

### 2. The measurement is derived in `scripts/`, and never persisted

PRD-6 scores runs on a Brier-style skill axis beside the existing PASS/FAIL bands, and groups runs by
a **condition key derived from what each artifact recorded** rather than by model name.

Both live in `scripts/evaluate/`. Neither is a field on any contract, and **no scored artifact is
written to disk**.

The reason is ground-truth isolation, and it is not a property of the new metric. Given `p` — the
agent's own `tpPercent`, already on the artifact — and a score, `t = p ± √score`; with `t` drawn
from `{0, 0.5, 1}` that recovers the verdict exactly. A scored file is the answer key in a new coat.
**The same inversion works on a PASS/FAIL artifact**, so this rule pre-dates the metric and outlives
it.

Neither existing guard would catch the leak: the oxlint `no-restricted-imports` rule blocks static
imports, and `ground-truth-isolation.test.ts` scans agent-side source *text*. A runtime
`Bun.file("…/scores.json")` is invisible to both. Since PRD-5 makes `apps/console/src` agent-side
source, a scored artifact would put the key inside the process the agent runs in.

This extends ADR 006 §5 rather than restating it: §5 kept *scoring* in `scripts/`; this keeps
*scores* there too.

### 3. The condition key is derived, never declared

`conditionOf(run)` hashes `{model.provider, model.id, config, limits, provenanceKey(run)}` — the
whole of `config`, not named members of it.

`provenance` is the one deliberate exception, and it is a projection rather than the whole block:
`corpus.anchorUtc` and `corpus.offsetMs` move on every bootstrap, so hashing them would mint a fresh
condition on every `data:bootstrap` and no two runs either side of one would share a cell. They are
recorded and not hashed, for the same reason decision 5 keeps the anchor outside `alertSetHash`.

The alternative is a declared taxonomy: an `augmentation: ["analyst-context", "case-memory"]` enum,
or a `conditionId` computed and stored at run time. Rejected for three reasons:

- Every new axis costs a contract edit, and the axes are not known — `AGENTS.md` §2 lists
  cross-investigation memory under *Do not implement*, so a memory slot today would be building
  ahead of need in exactly the way §5 forbids.
- A stored key can be computed wrongly at write time and is then wrong forever. A derived key is
  fixed in one file and re-applied to all history.
- Legacy artifacts can never be recomputed into a declared taxonomy. All forty existing artifacts
  resolve under a derived one.

A concrete consequence, already visible: PRD-5's `config.analystContext` becomes a comparison axis
with **zero code in this work**, because it lives inside `config`. A future memory field will arrive
the same way.

Corollary, and it is load-bearing: **an absent field is a value, never a wildcard.** A run that
recorded no thinking level is `think=?`, and `?` never merges with `medium`. Treating absence as
"probably the default" is how the fabricated `medium` in decision §4 stayed invisible.

### 4. The artifact stops fabricating `thinkingLevel`

`execute-run.ts` wrote `config.thinkingLevel ?? "medium"` into the artifact while omitting the key
from the harness options when unset, so `pi-agent-core` fell back to `off`. A run executed with
reasoning **off** produced an artifact claiming **medium** — on a knob that no condition on disk has
ever varied, so the fabrication has never once been caught by a comparison.

`InvestigationRunConfig.thinkingLevel` becomes optional and the `??` is deleted.

**Rejected: making `RunConfig.thinkingLevel` required.** It closes the same defect, but it is a
breaking interface change into a tree PRD-5 is actively landing in, and it forecloses `?` as a legal
condition value — which decision §3's corollary needs.

### 5. Corpus identity lives in the database, not in a file

Bootstrap writes a `_CorpusManifest` marker table — `{anchorUtc, offsetMs, telemetryRevision,
alertSetHash, generatedAt}` — into the database it has just built, exposed through a new
`GET /corpus` and a `getCorpus()` that returns `undefined` on 404.

A generated file drifts. A marker table cannot, because it **dies with the database** — the database
is volatile, which is precisely the property that makes this safe.

It must also be invisible to the agent, and that is not automatic. `GET /schema` enumerates the
database with no allowlist and the harness puts every table name into the opening context, so a
table added here is a table the agent is invited to query. `_CorpusManifest` holds no answers, but a
benchmarking change that silently alters turn-0 context alters the thing being measured. `GET
/schema` and `POST /query` therefore exclude `_`-prefixed tables, and a test pins the startup
table-name list.

Not `/health`: `packages/contracts/src/health.ts` records health as operational-only and
deliberately not an investigation primitive, and that decision is still good. A separate route
degrading to `undefined` also means an older Mock Sentinel does not break `bun run investigate`, and
the report prints `corpus unknown` rather than a fabricated match.

`anchorUtc` sits **beside** `alertSetHash`, never inside it. Under ADR 001 the anchor moves on every
bootstrap while shifting the whole dataset by one constant offset, and alert ids exclude timestamps
from their hash by construction. Hashing the anchor would invalidate all history on every
`infra:up` for no semantic reason; `alertSetHash` is what catches the change that genuinely breaks
the join.

### 6. The trajectory still is not graded

PRD-2 §23 forbids grading the path an investigation took, and this ADR does not amend that.

Concretely, PRD-6 records `toolCalls` keyed by tool name and **refuses a per-table tally**, refuses
to score `discriminatingEvidence` coverage, and refuses to put KQL on the artifact. The distinction
it holds: *how much work was done* is a property of the run; *whether the right ground was covered*
is a judgement about the path.

The refusal is about slope as much as principle. Once the artifact says which tables were touched,
the next patch scores whether they were the right ones, and the rule is gone without anyone deciding
to remove it. `toolCalls.query_security_data` answers the question a memory experiment actually asks
— *did it do less work for the same answer* — without naming a table.

### 7. The bands are not touched here

The overlapping verdict bands (`TP >= 60`, `FP <= 40`, inconclusive `[30, 70]`) are a real defect:
they let a blind constant score 12/14. They are owned by roadmap §7, and PRD-6 adds a skill column
*beside* them rather than repartitioning them.

Landing both at once would move every cell for two reasons simultaneously and destroy the baseline —
which is exactly what PRD-4 §9 refused to create when it left the bands alone so that corpus
authoring and scoring changes would not arrive together. The same reasoning applies in the other
direction.

The band column also stays because it is the only scoring continuity the existing artifacts have,
and because a row reading `12/14 PASS · skill −0.075` is a better argument for the partition than a
silent re-score.

## Testing

- `scripts/evaluate-runs.test.ts` — flat beside `scripts/reset-queue.test.ts`, where PRD-5 set the
  convention. Drives the binary through the existing `RUNS_DIR` override against synthetic corpora in
  a temp directory. Nothing under `runs/` is read or written.
- `scripts/evaluate/scoring.test.ts` — pure. Asserts the decomposition identity
  `bias² + variance === score`, that score-then-average and average-then-score differ on a bimodal
  cell, and the exact sign-test tail values.
- A test asserts `evaluate` writes no file (decision §2).
- A test asserts `toolCalls` keys are a subset of the five tool names and that every added field is a
  scalar or a fixed-key record (decision §1's bright line).
- A test loads every artifact in `runs/` and `runs/.archive/` through `InvestigationRun.parse`.
- `ground-truth-isolation.test.ts` ROOTS and the oxlint boundary rule are unchanged, and a test
  asserts that they remain sufficient — no new agent-side reachable path reads `fixtures/scenarios/`.
- A test pins the table-name list reaching `buildInitialContext`, so the corpus manifest cannot
  change the agent's opening context (decision 5).

Three gaps are worth naming, as ADR 005 and 006 named theirs. Nothing tests that a condition key
survives a `pi-ai` version bump: `piVersion` is inside the key, so an upgrade re-partitions every
condition at once and the report will read as a total loss of history until someone recognises the
cause — the legend printing the changed field is the whole mitigation. Nothing tests the *scores*
against a known-good corpus, because there is no reference implementation to compare with; the pure
module's tests assert internal identities, not correctness against an oracle. And nothing exercises
the metric at n>=3, because no condition on disk has three draws — step 5's re-baseline is the first
time the variance decomposition runs on real data rather than on fixtures.

## Consequences

**Positive:** a comparison that inverted under an archived file becomes one that states its own
denominator, coverage and noise floor; repeats stop being discarded, which is the only variance
instrument the system can have, since pi-ai exposes no seed; cost and effort become artifact-side
facts with tracing off, retiring three of the four coverage caveats in the console and dissolving
the cost half of PRD-5 §18 Q2 (the durable-transcript half stands, since decision 1 keeps
transcripts optional); the prompt becomes a comparison axis for the first time, which is what makes steering
and memory measurable at all; a rule edit or a re-vendored telemetry revision becomes a loud
mismatch instead of a silent empty report; PRD-5 §4.5's defensive skip becomes unnecessary rather
than something to write and later delete; and no new service, package, store or dependency enters
the baseline.

**Negative:** the run artifact grows a provenance block and three per-result fields, and ADR 005 §2's
sentence no longer reads literally; the report gets substantially longer and its headline gets
worse, with most conditions reading "insufficient data" — a correction that will be read as a
regression; every existing measurement is invalidated, and a re-baseline of roughly 84 investigations
is unavoidable because no condition on disk has three draws; the harness gains a second always-on
subscriber; Mock Sentinel gains a route and the client a method; and the `_CorpusManifest` write
makes bootstrap responsible for a fact it previously only computed and discarded.

## References

- `docs/prd-6-run-comparability.md`, particularly §3 (the defect register) and §5 (design principles)
- `docs/research-run-comparability.md` — the measurements this ADR rests on, and how they were taken
- ADR 005 §2 (run artifact, not a trace store) — amended by decision §1
- ADR 006 §4 (artifact lifecycle), §5 (ground-truth scoring stays in `scripts/`) — extended by §2
- ADR 001 (the one time anchor for the whole dataset) — the constraint behind decision §5
- ADR 004 ("Alert ids are content-addressed and time-independent") — why `alertSetHash` works and
  why `anchorUtc` must stay outside it
- PRD-2 §20 (ground-truth isolation), §23 (regression infrastructure, trajectory not graded)
- PRD-4 §9 (why scoring changes and corpus authoring must not land together)
- PRD-5 §4.5 (record what a later benchmark will need; measure nothing here)
- `docs/roadmap.md` §7 (Evaluation at Scale — owns the band partition) and §9 (Benchmarking Surface)
