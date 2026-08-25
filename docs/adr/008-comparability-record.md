# ADR 008 — The Comparability Record

**Status:** Accepted
**Date:** 2026-08-20
**Implements:** PRD-6 — Run Comparability
**Amends:** ADR 005 §2 (the run artifact holds per-alert outcomes only); PRD-2 §23 (formal
regression infrastructure, deferred); `AGENTS.md` §5 (the run corpus becomes append-only), §9 (the
REST surface gains a sixth route), §12 (the artifact gains counters), §14 (a new phase);
`docs/roadmap.md` §7 (which owned the band partition — decision 7)
**Extends:** ADR 006 §4 (run artifact lifecycle), §5 (ground-truth scoring stays in `scripts/`);
ADR 007 §2 (the investigator remains the sole writer of run artifacts)

## Context

PRD-6 makes investigation runs comparable across models, parameters, tools, prompts, analyst
steering and — later — case memory, and accumulates enough saved evidence for those comparisons to
mean something. Implementing it as written contradicts three decisions taken when there was nothing
to compare.

`AGENTS.md` §15 asks for an ADR rather than a silent change of course. This is that ADR.

Three facts set the terms. First, the run artifact was deliberately not a trace store: ADR 005 §2
records that PRD-2 persists "per-alert outcomes only", and `contracts/run.ts` says the same in the
schema, conditioning any addition on *"evaluation showing a concrete need"*. Second, PRD-2 §23
deferred regression infrastructure and asked only that artifacts make later comparison
straightforward. Third, PRD-4 §9 and `docs/roadmap.md` §7 left the overlapping verdict bands alone so
that scoring changes and corpus authoring would not land together.

The need has now been demonstrated rather than argued. Measured across **all 47 artifacts on disk**,
the 43 in `runs/` and the 4 in `runs/.archive/`:

- Grouping runs by everything they actually record yields **nine conditions, 32 cells, none with
  more than two draws, and no condition covering more than 9 of the 14 scenarios** — while
  `evaluate` reports two model tables, so each is a blend.
- The only matched model comparison available has given **three different answers in one afternoon**
   — terra ahead, luna ahead, and a 3–3 tie at `p = 1.000` — as runs were archived and restored
  beneath it. None was wrong; each rested on one or two draws per cell.
- A stub answering a constant to every alert, issuing no queries, scores **12/14** — beating both
  measured models. Under a partition it scores 9/14, and **the partition flips exactly one draw in
  forty**, so the cost that justified deferring it was an order of magnitude smaller than assumed.
- **Analyst context, a parameter PRD-5 shipped, has zero scoreable draws.** All three steered
  artifacts produced none, and `evaluate` skips steered runs anyway. The axis the console's re-run button
  exists to exercise has never been measured once.
- The system cannot state what a run cost without an opt-in transcript that writes 0.16–23 MB per
  investigation into the loop that is supposed to be cheap to repeat.

Forty-seven artifacts that cannot answer the roadmap's own cost question, a comparison that inverts
under an archived file, and a shipped parameter with no measurements are the concrete need
`contracts/run.ts` asked for.

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
- Legacy artifacts can never be recomputed into a declared taxonomy. All forty-seven existing
  artifacts resolve under a derived one.

A concrete consequence, already visible: PRD-5's `config.analystContext` becomes a comparison axis
with **zero code in this work**, because it lives inside `config`. A future memory field will arrive
the same way. It renders as `ctx=<hash6>` or `baseline`, never as a bare steered flag — two different
premises are two different conditions — and because a premise is written about a specific alert, a
steered condition is usually one scenario wide. Read the cell rather than a condition-level skill
figure computed from one draw.

**The key hashes settings, never outcomes.** A condition answers *how was this run set up*, so a
field describing what the agent then did is excluded from the hash and kept on the artifact:
`config.webSearchUsed` is recorded, printed, never hashed. Including it fragmented cells for a reason
that is a result — two runs of the same model under the same limits landed in different conditions
because the agent happened to search in one — which is precisely the variation a cell exists to
average over. What this benchmark scores is the outcome against ground truth; effort, cost and tool
counts sit beside the score as diagnostics and never enter it.

**`derivedFrom` is recorded and not scored.** PRD-5 records which run a re-run came from, and that
stays. The benchmark does not read it and does not pair parent against child: a derived pair is
provenance, and this decision keeps the scored surface to outcomes alone. A pairing view can be built
the day something asks for one.

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

### 7. The bands are repartitioned here — reversing a deferral

**Was:** the overlapping verdict bands (`TP >= 60`, `FP <= 40`, inconclusive `[30, 70]`) are owned by
roadmap §7. An earlier draft of this ADR kept them there, on the grounds that repartitioning
alongside a new metric would move every cell for two reasons simultaneously and destroy the
baseline — the principle PRD-4 §9 established.

**Now:** PRD-6 lands the partition (`FP <= 40`, inconclusive `41–59`, `TP >= 60`) together with the
skill column, and prints both band columns for at least one release.

The deferral is recorded rather than deleted because the reason it failed is the useful part: **its
central cost estimate was assumed, and the measurement is an order of magnitude smaller.** Across
the 40 scoreable draws on disk the partition flips exactly **one**. That draw sits in
`runs/.archive/`, which means the roadmap's claim that "none of the 21 scored runs to date changes
verdict under it" holds today only because the run that flips was archived out of the set — and
decision 8 puts it back. The two changes therefore cannot be sequenced apart: whichever lands
second is blamed for the other's movement.

Three things keep PRD-4 §9's principle intact rather than trading it away:

- **What §9 forbids is scoring changes landing with *corpus authoring*.** The partition is a scoring
  change and it lands with the other scoring changes, in one pure module. Corpus authoring — the
  class imbalance and the scenario dependence, PRD-6's D19 and D20 — stays with roadmap §7. The
  boundary PRD-4 drew is exactly where it was.
- **The movement is auditable per draw, not merely in aggregate.** The report prints `band⁰`, the
  pre-partition column, beside `band`. A cell where they disagree is a cell the partition moved.
- **The partition is asserted as a property, not as a number.** For every integer `0–100` and every
  verdict, exactly one class accepts it, and no blind constant exceeds the class-mix floor. Pinning
  the literal `9/14` would re-break the moment roadmap §7 rebalances the corpus.

**The skill column is still the real fix, and this is the argument for it.** The one draw the
partition flips is `app-credential-added` at `tp=60` — a Brier error of 0.010 against a target of
0.5, the *best-calibrated* inconclusive answer anywhere in the corpus, marked FAIL for sitting one
point over a boundary. Every other inconclusive draw ever recorded is 72 or higher, or 15. A
three-way band is a lossy view of a continuous number wherever the boundaries go. That is why the
bands are repartitioned *and* kept subordinate: the blind-constant row printing
`tp=65: band 9/14 · skill −0.075` under every report is what stops either column from being read
alone.

### 8. The run corpus is append-only, and the queue may not reach into it

**Was:** `runs/` is a working directory. `scripts/reset-queue.ts` returns an alert to the queue by
renaming its artifact into `runs/.archive/`, and its own comment records why that works: both
readers use a non-recursive `new Bun.Glob("*.json")`, "so a rename into `runs/.archive/` removes a
run from the console *and* from the evaluation report with no code change in either".

**Now:** that coupling is severed. `evaluate` reads `<runsDir>/*.json` **and**
`<runsDir>/.archive/*.json`, deduping by run id; `queue:reset --purge` requires `--yes` and states
what it destroys in draws and scenarios; and the report header carries a fingerprint over the sorted
run ids actually scored.

The rule underneath:

> **A run artifact is a measurement that cost money and cannot be re-derived.** The model is
> non-deterministic and pi-ai exposes no seed, so a repeat is a new sample, not a reproduction.
> Nothing may remove a run from the scored set as a side effect of an unrelated operation.

The console side of the archive is correct and unchanged — an archived run *should* leave the queue,
because that is what returning an alert to the queue means. The evaluation side was never intended
and was never decided; it fell out of two readers happening to share a glob. This ADR records the
separation so it is not re-coupled by the next reader that wants "the current runs".

This is the defect with the largest blast radius in PRD-6's register, because it is the one that
makes every other number unquotable: three passes of PRD-6 read three different answers from the same
two models (context above), and the differences were entirely file movements.

**And the corpus enters version control.** `/runs/` leaves `.gitignore`; `/runs/traces/` replaces it.
The run artifacts and their archive are committed; the transcripts are not. That split is what makes
it cheap — 47 artifacts total 200 KB, none over 5.5 KB, against 126 MB of transcripts for 40 runs.

Append-only inside the working tree is what the benchmark *requires*; committing is what makes the
benchmark *portable*, and both are needed for the same reason. Step 5 buys roughly 96 investigations
with real money against a non-deterministic model that exposes no seed, so the corpus cannot be
regenerated — only bought again. A measurement set that exists on one laptop is one disk failure from
being bought twice, and a number quoted with a fingerprint (above) is only checkable if someone else
can check out the set it was computed over.

It also gives §5.6's rule an enforcement mechanism that does not depend on anyone remembering it:
removing a measurement becomes a diff.

**Accepted cost:** the working tree goes dirty on every `bun run investigate`. That is correct rather
than noisy — the artifacts *are* the deliverable — but it is a change in how the repository feels to
work in, and it amends `AGENTS.md` §5's repository shape, which previously did not list `runs/` at
all. `runs/traces/` and `feedback/` stay ignored: transcripts are optional by construction (decision
1), and analyst classifications are operational data that ADR 007 keeps out of `runs/` deliberately.

**One consequence worth recording because it was found by running the check rather than by reasoning
about it:** `runs/` has to join `.oxfmtrc.json`'s `ignorePatterns`, beside `fixtures/**` and
`**/*.md`. A committed artifact is data, and a formatter that rewrites it makes the committed bytes
differ from what `writeRunArtifact` emits — so every subsequent run would land unformatted, and
`bun run fmt:check` would be asking someone to edit a measurement. The general rule is already in
that file's other entries: tooling formats source, never records.

**Rejected: a curated `fixtures/baseline-runs/`** promoted into by a new command. It adds a committed
root that `AGENTS.md` §5 would have to govern, plus a workflow step, to avoid a `git add` — and it
reintroduces exactly the two-tier split (real runs here, blessed runs there) that decision 8 exists
to remove.

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
- A test loads one committed artifact per schema generation, under
  `apps/investigator/test/fixtures/runs/`, through `InvestigationRun.parse`. Deliberately not a sweep
  of the live `runs/`: that couples the suite to whatever a developer last ran, and stays wrong
  whichever way §12 Q7 goes.
- A property test asserts the three bands partition `[0, 100]` — for every integer and every verdict,
  exactly one class accepts it — and that no blind constant beats the class-mix floor (decision 7).
- A test writes an artifact into `<runsDir>/.archive/` and asserts it is scored, appears in the
  report and is inside the run-set fingerprint; another asserts a run id present in both directories
  is counted once (decision 8).
- A test asserts `queue:reset --purge` without `--yes` refuses, and that its dry-run names the draws
  it would destroy (decision 8).
- A test asserts a run carrying `analystContext` is scored, lands in a condition distinct from its
  parent's, and that a `derivedFrom` pair differing by more than the premise is marked `unmatched`
  (decision 3).
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
denominator, coverage and noise floor; a run can no longer leave the measurement set as a side
effect of a queue operation, so a quoted number stays checkable against its fingerprint; repeats
stop being discarded, which is the only variance instrument the system can have, since pi-ai exposes
no seed; a blind constant stops beating the models it is supposed to calibrate them against; analyst
context becomes a measurable axis with a matched, paired comparison built into the report, which is
worth more per run than anything else here; cost and effort become artifact-side
facts with tracing off, retiring three of the four coverage caveats in the console and dissolving
the cost half of PRD-5 §18 Q2 (the durable-transcript half stands, since decision 1 keeps
transcripts optional); the prompt becomes a comparison axis for the first time, which is what makes steering
and memory measurable at all; a rule edit or a re-vendored telemetry revision becomes a loud
mismatch instead of a silent empty report; PRD-5 §4.5's defensive skip becomes unnecessary rather
than something to write and later delete; and no new service, package, store or dependency enters
the baseline.

**Negative:** the run artifact grows a provenance block and three per-result fields, and ADR 005 §2's
sentence no longer reads literally; the report gets substantially longer and its headline gets
worse **twice over**, with most conditions reading "insufficient data" and the partition taking a
further draw off the corpus and three off the blind constant — a correction that will be read as a
regression; the partition marks the corpus's best-calibrated inconclusive answer FAIL, which is
honest about bands and uncomfortable to read; a second band column (`band⁰`) has to be carried and
later removed; every existing measurement is invalidated, and a re-baseline of roughly **96**
investigations — 84 baseline plus 12 steered — is unavoidable because no condition on disk has three
draws and the steering axis has none at all; `evaluate` and `queue:reset` both gain a dependency on
the archive layout, which is now a contract between them rather than an implementation detail; the
harness gains a second always-on subscriber; Mock Sentinel gains a route and the client a method;
and the `_CorpusManifest` write makes bootstrap responsible for a fact it previously only computed
and discarded.

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
- `docs/roadmap.md` §7 (Evaluation at Scale — owned the band partition until decision 7 moved it into
  PRD-6; still owns corpus rebalancing) and §9 (Benchmarking Surface)
- `scripts/reset-queue.ts` (PRD-5 §11) — the archive mechanism decision 8 decouples from scoring
