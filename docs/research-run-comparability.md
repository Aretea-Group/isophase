# Run Comparability — Design Research

**Status:** Research note. Not a PRD.
**Scope:** Roadmap §9 "Benchmarking Surface", plus the parts of §7 it cannot proceed without.
**Would become:** `docs/prd-6-run-comparability.md` + `docs/adr/008-comparability-record.md`,
`AGENTS.md` §14 Phase 10.
**Method:** 20 agents over the whole chain; every number below re-derived independently against the
38 artifacts and 14 fixtures on disk. See the appendix.

> **Superseded in part by `docs/prd-6-run-comparability.md`.** Three figures here were measured
> against a `runs/` state that no longer exists, and one is wrong: §1's matched comparison reports
> terra ahead over 8 shared scenarios, which restoring `runs/.archive/` does not reproduce — luna
> is marginally ahead on that set too (0.1356 vs 0.1373). The cell count is 30, not 31, and the
> band-partition flip cited in §3.3 involved a run that has since been archived. PRD-6 §3.1 carries
> the corrected measurements, and the fact that they needed correcting is itself PRD-6's D18.

---

## 1. The answer

**Runs are not comparable today, and the current report is actively misleading rather than merely
thin.** Three defects compound:

1. `evaluate` keys on `model.id` and nothing else, so its two model tables each blend three
   different harness generations.
2. `latestPerScenario` is last-wins, so every repeat but one is discarded — silently, with no count.
3. Three overlapping bands over one scalar have too little resolution to separate a model from a
   constant.

Put together, they produce a specific false result that is in the roadmap right now:

> `gpt-5.6-terra: direction 11/14` vs `gpt-5.6-luna: direction 9/14`

Score only the runs that actually share a configuration — same thinking level, same submission
contract — and the two models tie. Eight shared scenarios, three scenario wins each, two ties,
exact two-sided sign test **p = 1.000**. The 2-scenario gap in the headline is an artifact of which
model happened to be run under which harness generation, not a property of either model.

The fix is not more instrumentation. It is **deriving the comparison key instead of assuming it**,
and **keeping every repeat instead of the last one**. Both live in `scripts/`, need no producer
change, and land against the artifacts already on disk.

---

## 2. What "comparable" requires

Two runs are comparable when everything that could explain a difference between them is either
held equal or recorded. The axes you named, and where each stands:

| Axis | Recorded? | Status |
|---|---|---|
| **Model** | `model.{provider,id}` | Recorded, but it is a moving alias — nothing pins the served version. Used as the *only* key, which is the bug. |
| **Steering** | `config.analystContext` (PRD-5, landed) | Recorded. Not scored — `evaluate` currently *skips* steered runs entirely. |
| **Memory** | nothing | No axis exists. Nothing to record yet; the question is whether the key picks one up for free when it arrives. |
| **Prompt** | nothing | Not merely unrecorded — **unrecordable**. `DEFAULT_INSTRUCTIONS` reaches the harness by module import; `SweepConfig` has no `instructions` field, and traces don't carry it either. |
| **Corpus** | nothing | No telemetry revision, no time anchor, no alert-set identity. |
| **Cost / effort** | nothing in the artifact | Tokens, cost, turns and tool calls exist only inside optional JSONL traces. |

The prompt row is the one that bites hardest, because *steering and memory are both prompt changes*.
An experiment that adds analyst context or case memory and measures the delta is measuring a
difference the artifact cannot describe.

---

## 3. The three defects, demonstrated

### 3.1 The key is `model.id`, so the tables blend generations

`scripts/evaluate-runs.ts` reads `run.model.id` and discards `provider`, `config` and `limits` —
even though `contracts/run.ts:71-76` states the reason they exist verbatim: *"two runs are not
comparable without knowing how each was configured."*

Group the 38 artifacts by everything actually recorded — `{provider, model, thinkingLevel,
resultMaxChars, webSearchConfigured, limits, submission shape}` — and they resolve to **five
conditions, 31 cells, 24 of them at n=1, 7 at n=2, and none at n≥3**:

```
7d1f1e  gpt-5.6-terra  think=?       sub=researchDone  rmc=?       covered  6/14
25f51e  gpt-5.6-terra  think=medium  sub=researchDone  rmc=40000   covered  8/14
1989a0  gpt-5.6-luna   think=medium  sub=researchDone  rmc=40000   covered  9/14
ed732e  gpt-5.6-terra  think=?       sub=nextAction    rmc=?       covered  2/14
ad70b8  gpt-5.6-luna   think=?       sub=nextAction    rmc=?       covered  6/14
```

Today's two model tables are those five conditions collapsed into two rows.

**The matched comparison, which is the only honest one available:**

```
                              truth            terra   luna    winner
adele-azure-destruction       inconclusive     99      95      luna
adele-sharepoint-exfiltration true-positive    99      99      tie
adele-signin-compromise       true-positive    99      99      tie
app-credential-added          inconclusive     60      90/95   terra
aws-backdoor-account          true-positive    99     100      luna
aws-bob-jones-readonly        false-positive    2      70      terra
aws-jane-smith-readonly       false-positive    4      35      terra
model-evasion-attempts        true-positive     8      65      luna

Brier   terra 0.1373   luna 0.1399        wins 3–3 (2 ties)   sign test p = 1.000
```

The roadmap's claim that "terra-class reasoning cleared the calibration control that luna failed, at
roughly ten times the token price" rests on an unmatched pairing — terra never covered
`sunburst-domain-inconclusive` under that condition; luna did. It should be marked unverified, not
deleted, and settled by a matched re-baseline.

### 3.2 Repeats are destroyed, and the surviving row is arbitrary

`latestPerScenario` sets `seen[\`${model}::${scenario}\`]` in `startedAt` order. N repeats become
one row, chosen by which finished last. No count, no spread, no flag.

The roadmap cites `sunburst-domain-inconclusive` "swinging 80/15/90 on the same alert and model".
That is real but *understated in one way and overstated in another*:

```
01a0191c  08:21  luna    tp=95   think=?       sub=nextAction
01a0193d  08:57  terra   tp=80   think=?       sub=nextAction     <- different submission contract
01a0194e  09:15  terra   tp=15   think=?       sub=researchDone
01a01958  09:27  terra   tp=90   think=?       sub=researchDone
01a019ee  12:10  luna    tp=72   think=medium  sub=researchDone
```

The 80 belongs to a different condition. The honest same-condition figure is **15 → 90 at n=2** — a
75-point spread on a two-sample cell, straddling the entire range. `evaluate` prints one of them.

This is the number that decides whether any model, memory or steering delta is believable, and it
is currently unobservable by construction.

### 3.3 Three bands over one scalar cannot discriminate

The corpus is **9 true-positive / 2 false-positive / 3 inconclusive**. The bands overlap
(TP ≥ 60, inconclusive 30–70), so:

```
constant tpPercent = 65, no queries issued:   direction 12/14
gpt-5.6-terra (measured):                     direction 11/14
gpt-5.6-luna  (measured):                     direction  9/14
```

A stub beats both measured models. It fails exactly the two false-positive scenarios — which means
**the two FPs carry the entire dynamic range of the metric**, and they are near-duplicates sharing
three byte-identical discriminating queries.

Fixing the overlap (roadmap §7's one-line partition) is necessary but not sufficient: after it, the
best blind constant still scores 9/14, exactly tying luna. Two caveats §7 should know:

- The roadmap's "none of the 21 scored runs to date changes verdict under it" is now **stale** —
  `01a01b61-deec` (`app-credential-added`, tp=60) flips PASS→FAIL, taking terra to 10/14.
- The band fix belongs in a **separate PR**. Landing it with a re-key moves every cell for two
  reasons at once and destroys the baseline — exactly what PRD-4 §9 refused to create.

### 3.4 The bonus defect: failures vanish

`evaluate-runs.ts` drops `status: "failed"` rows before scoring, and `error` is declared on the
interface and read nowhere. A model that times out on 13 of 14 scenarios and completes one
correctly prints `direction 1/1` — a perfect score — with the 13 failures absent from the
denominator *and* from `mean Xs`, so timeouts also improve reported latency. And because failures
don't overwrite anything in `latestPerScenario`, the previous model's rows survive under the same
model id.

---

## 4. What the producer does not record

| Fact | Where it should be | Consequence |
|---|---|---|
| System instructions (hash or version) | nowhere | Prompt, steering and memory axes are all unmeasurable. |
| `submit_investigation` schema version | nowhere | 8 of 38 summaries were produced under a different contract; the shape has to be inferred from field presence. |
| pi-ai / pi-agent-core version | nowhere | pi-ai owns the dollar figures *and* the meaning of `thinkingLevel`. |
| Tokens, cost | optional trace only | The roadmap's own motivating question (is terra worth 10×?) is unanswerable with tracing off. |
| Turns, tool calls | optional trace only | The memory hypothesis — *did it do less work for the same answer* — has no artifact-side measure. |
| Corpus identity | nowhere | See §5. |
| Served model version | nowhere | A provider re-pointing `gpt-5.6-terra` is invisible. |

One of these is worse than missing — it is **wrong**. `sweep.ts:131` writes
`thinkingLevel: config.thinkingLevel ?? "medium"` into the artifact, while `sweep.ts:181` omits the
key entirely when it is unset, so Pi falls back to its own default of `off`. A caller that omits
`thinkingLevel` runs with reasoning **off** and gets an artifact claiming **medium**, on the
highest-leverage knob in the system.

---

## 5. Reproducibility hazards

- **The telemetry anchor moves.** `bootstrap.ts:157` is `options.timeAnchor ?? new Date()`, and no
  artifact records which bootstrap it ran against. Intervals are preserved; absolute instants are
  not.
- **`TELEMETRY_TIME_ANCHOR` is dead config.** Declared at `config.ts:47`, accepted as a
  `BootstrapOptions` field — and never wired. `scripts/bootstrap-sentinel-data.ts` does not pass it.
  The one documented mechanism for pinning a reproducible corpus is unreachable. Two-line fix.
- **`startingAlertId` is a content hash over rule id + projected row.** A `| project` reorder
  re-pins the fixture and every prior run for that alert becomes unjoinable — reported as
  `[evaluate] no scored results`, exit 0, the same message a typo'd run id produces.
- **The answer key is mutable and unversioned**, read from disk at scoring time. An edit silently
  re-scores all history.
- **`web_search` / `web_fetch` hit the live internet** and nothing durable records the query, URL or
  content.
- **There is no seed.** No `seed`, `temperature` or `samplingParams` anywhere in pi-ai's type
  surface. **Repeats are the only variance instrument this system can ever have** — which is why
  destroying them (§3.2) is the most expensive of the three defects.

---

## 6. The design

Three ideas. The first two are the whole thing; the third is what makes them worth reading.

### 6.1 Derive the condition key; never declare it

New `scripts/evaluate/condition.ts` (~80 lines). `conditionOf(run)` returns `{id, label, fields}`,
where `id` is a short sha256 over a sorted-key stringify of
`{model.provider, model.id, config, limits, provenance}`.

Because it hashes *whatever `config` holds*, PRD-5's already-landed `config.analystContext` is
picked up with zero code, and a future memory field arrives free — which matters, because
AGENTS.md §2 forbids implementing memory now. A declared taxonomy (`augmentation: ["analyst-context",
"case-memory"]`) costs a contract edit per axis and can never be recomputed for the 38 legacy
artifacts. A derived key can be fixed in one file and re-applied to all history.

`label` renders only the axes a reader needs:
`gpt-5.6-terra · think=medium · p=a41f · sub=researchDone · corpus=9c2e`.

**An absent field renders `?`, and `?` is a value, never a wildcard** — an unknown thinking level
must never merge with a known one. For pre-provenance artifacts, infer the submission shape from
field presence and flag it `inferred` in the legend.

This alone makes PRD-5 §4.5's defensive three-line skip of steered runs unnecessary — steered runs
appear *beside* their baselines rather than being hidden.

### 6.2 Cells hold every repeat, and the score has resolution

New `scripts/evaluate/scoring.ts` (~120 lines, pure, no I/O, no scenario import).

- `targetFor(verdict)` → `{true-positive: 1, false-positive: 0, inconclusive: 0.5}`
- `drawScore(p, t) = (p − t)²`, and a cell's score is the **mean of the draw scores**, with the
  exact decomposition `{bias², variance}` where `bias² + variance === score`.

Score-then-average is mandatory, not stylistic. On terra's sunburst cell, averaging the *answers*
first gives 0.014 and ranks the corpus's most unstable cell near-perfect; averaging the *scores*
gives 0.124.

Report skill against the base rate: `1 − brier / referenceBrier`. **The reference must be
coverage-matched** — base rate computed over all 14 (it is a corpus property), but the reference
Brier over the *covered* scenarios only. With an all-14 denominator against a subset numerator, a
condition that covered six easy scenarios inflates from 0.531 to 0.781. Always print `covered K/14`
on the same line; never print skill without it.

Two things this buys that bands structurally cannot:

```
blind constant tp=65:   band 12/14 PASS   skill −0.075
```

...on one line, which is a far better argument for the §7 band fix than silently repartitioning.
And it can say **"no difference"** and **"not enough data"** — an exact two-sided sign test in ~8
lines of integer factorial, plus a noise floor computed per condition from its own cells' measured
variance, never pooled.

**Keep the existing PASS/FAIL band column beside it.** It is the only continuity the 38 artifacts
have, and §7 owns the bands.

Impact stays a plain `k/n (m unscored)`. Do not Brier it — it is categorical with only three
reachable values, and `contained` has zero coverage in the key while `summary.ts` offers it, so an
agent answering `contained` is wrong by construction on all 14.

### 6.3 Fix the reader's honesty problems while you are in there

- Replace the `as RunFile` cast with `InvestigationRun.safeParse`, warn-and-skip. Today one
  malformed artifact throws and takes all 37 valid runs with it.
- Split the merged `continue` into three counted buckets: `no-ground-truth` (silent, correct),
  `failed` (**scored**), `no-summary` (counted).
- A failed draw scores as if it answered the base rate — `drawScore(0.75, t)` — so it lands at
  exactly zero skill, needs no special case in aggregation, and prints with `error.name`.
- `--compare` takes run **or condition** ids, pairs on shared scenarios only, prints both labels and
  a field-level diff of what actually differs, reports delta skill against the noise floor, and runs
  the sign test. This kills three live bugs: `runId.slice(0,8)` is the UUIDv7 millisecond prefix and
  9 of 38 ids collide in it; `pick` never reads `model`, so a cross-model compare prints
  REGRESSED; and `—` renders identically for "not covered" and "failed".
- `runs.length > 0 && scored.length === 0` exits 1 naming the unjoined alert ids, so a corpus change
  stops being indistinguishable from a typo.
- **No exit-code gate.** At n=1 the smallest credible skill delta is ~0.39; a benchmark that cries
  wolf gets disabled.
- New `scripts/test/evaluate-runs.test.ts`, driving the binary through the existing `RUNS_DIR`
  override against synthetic corpora in a temp dir. `scripts/` has no tests today and is about to
  become the load-bearing comparison surface.

---

## 7. What to add on the producer side

Three small, separable additions. All optional on the contract, so the 38 artifacts keep parsing.

**1. `apps/investigator/src/provenance.ts` (~40 lines).** Exports
`PROVENANCE = {promptHash, submissionHash, piVersion}`. `promptHash` covers `DEFAULT_INSTRUCTIONS`
+ each of the five tools' `name`/`description`/serialised schema in name order + the
`buildInitialContext` template with the alert JSON and table list elided. `submissionHash` is
separate, over the `submit_investigation` TypeBox schema — because that is what actually split this
corpus, and a reader wants to see *which* of the two moved. Derived from source, not configuration,
so it does not join the three files permitted to read the environment.

**2. Contract, all optional.** `provenance` on `InvestigationRun`; `turns`, `toolCalls` (a `Record`
over the five closed tool names — not a bare integer, not a per-table tally) and `usage`
(`input/output/cacheRead/cacheWrite/totalTokens/costUsd`) on `InvestigationResult`. Make
`thinkingLevel` **optional** and delete the `?? "medium"` at `sweep.ts:131` — same defect closed,
no breaking `SweepConfig` change into the tree PRD-5 is being written in, and `?` stays a legal
condition value.

**3. `harness.ts` gains `onMetrics`.** A second always-on `agent.subscribe` tallies
`tool_execution_start` by `toolName`; `turns` is already counted. **Fire it from the existing
`finally`, not from the return value** — every throw (timeout, abort, model error, step limit)
happens after that block, so a widened return type would lose exactly the most expensive runs.
`runner.ts` attaches it to *both* the completed and failed branches.

The aggregate is already in-process — `agent.state` is public and assistant messages carry `usage`.
This recovers a number the harness currently discards, rather than reconstructing it from a
0.4–23 MB JSONL through a 370-line indexer. It also dissolves PRD-5 §18 Q2 and retires three of the
four coverage caveats in the console.

**Corpus identity.** Bootstrap writes a `_CorpusManifest` marker table into the database it just
built: `{anchorUtc, offsetMs, telemetryRevision, alertSetHash, generatedAt}`. A marker table cannot
go stale relative to the database because it dies with it — the database is volatile, which is
exactly why a generated file would drift. Expose it through a new `GET /corpus` and
`getCorpus(): Promise<CorpusIdentity | undefined>`, **not** through `/health` —
`packages/contracts/src/health.ts:8-12` records a live decision that health is operational-only.
Degrading to `undefined` means an older Mock Sentinel does not break `bun run investigate`.

`anchorUtc` sits *beside* the hash, never inside it: it moves on every bootstrap while shifting the
dataset by one constant offset, and alert ids exclude timestamps by construction. `alertSetHash` is
what catches the change that genuinely breaks the join.

Finally, add `previousAlertIds?: string[]` to the `Scenario` schema and build `byAlert` from
`[startingAlertId, ...previousAlertIds]`. One optional array is the difference between six weeks of
runs vanishing and staying joined and marked pre-revision.

---

## 8. What this deliberately does not do

- **No scored artifact for a console benchmark tab.** Given `p` (already on the artifact) and a
  score, `t = p ± √score`, and with `t ∈ {0, 0.5, 1}` that recovers the verdict exactly. A scored
  file is the answer key in a new coat, and neither guard catches it — the oxlint rule blocks
  imports and `ground-truth-isolation.test.ts` scans source text; neither sees a `Bun.file` read of
  a generated JSON. Since PRD-5 makes `apps/console/src` agent-side source, that would put the key
  inside the process the agent runs in. **The same leak applies to a PASS/FAIL artifact** — it is
  not a Brier-specific problem. The tab stays blocked on ADR 007.
- **No scoring of `discriminatingEvidence` coverage, and no per-table tally.** PRD-2 §23 forbids
  grading the trajectory; all 401 recorded `query_security_data` calls across 37 traces are distinct
  strings, so there is no invariant to match anyway. `toolCalls.query_security_data` answers "did it
  do less work for the same answer" — the actual memory hypothesis — without naming a table. The
  slope is real: once the artifact says *which tables* were touched, the next patch scores whether
  they were the right ones.
- **No `experimentId`, `repeatIndex`, `baseline|steered` enum, memory flag, `packages/bench`, or run
  store.** AGENTS.md §5 and PRD-2 §24. The derived key gets every future axis free.
- **No forcing `INVESTIGATOR_TRACE=true` for eval runs.** It writes 0.4–23 MB per investigation into
  the loop that is supposed to be cheap to repeat.

---

## 9. Sequencing

Step 0 is a hard gate. Steps 1–4 each land green on their own.

| # | What | PRD? | Unlocks |
|---|---|---|---|
| **0** | `docs/prd-6-run-comparability.md` + `docs/adr/008-comparability-record.md` + AGENTS.md §14 Phase 10. Correct the stale roadmap prose in the same PR. | **required** | everything |
| **1** | **The reader.** `scripts/evaluate/{scoring,condition}.ts` + tests + the rework of `evaluate-runs.ts`. `scripts/` only, zero producer changes. | — | model + repeat axes become honest against the artifacts already on disk; PRD-5 §4.5's skip becomes unnecessary rather than something to write and later delete |
| **2** | **Prompt identity.** `provenance.ts`, optional contract fields, `thinkingLevel` fix. | — | the prompt axis, which is today impossible in principle — and therefore the steering and memory axes |
| **3** | **Cost and effort.** `onMetrics` from the existing `finally`, `usage`/`turns`/`toolCalls`. | — | the cost column with tracing off; a 600 s timeout becomes the most expensive row instead of the cheapest |
| **4** | **Corpus identity.** `_CorpusManifest`, `GET /corpus`, `previousAlertIds`, the anchor wiring. | — | a rule edit becomes a loud mismatch instead of `no scored results`, exit 0 |
| **5** | **Re-baseline.** Not code. 14 scenarios × n=3 × 2 matched conditions = 84 investigations, ~60–90 min, ~$5–15. | — | the first defensible baseline the repo has had. Unavoidable: 31 cells under an honest key, **zero at n≥3** |
| 6 | *Optional.* An experiment manifest + runner, only if driving step 5 by hand hurts. | required if it grows | 84 runs become one command |

**Step 1 does not wait for PRD-5.** It needs nothing from it, works against today's artifacts, and
picks up `analystContext` free. The only coupling runs one way. Do coordinate the `sweep.ts`
`thinkingLevel` touch in step 2 with whoever is finishing the console compose pane.

**The console is not scheduled.** Read-only provenance rendering in `view/config.ts` is safe but
buys little, and the benchmark tab is blocked outright.

---

## 10. Open questions

1. **The terra-vs-luna result is yours to act on.** Recommendation: mark the roadmap claim
   unverified rather than deleting it, and let step 5 settle it. Running terra by default on the
   strength of the current number is not supported.
2. **Re-baseline budget.** Recommendation: yes — and **two conditions at n=3 rather than three at
   n=2**. With a measured 75-point spread on one scenario, n=2 cannot separate a model from a coin.
   If budget is tight, cut scenarios before cutting repeats.
3. **How hard is ADR 005 §2?** Fixed-size counters on the artifact are an amendment, not a slip.
   Recommendation: amend, with the bright line written into ADR 008 — *counters yes, content no*:
   no per-event records, no growth with investigation length, not replayable, cannot reconstruct
   what the agent saw. `contracts/run.ts:9-11` already conditions the addition on evaluation showing
   a need; 38 artifacts that cannot answer the roadmap's own cost question is that need.
4. **The report gets longer and the headline gets worse.** `terra: 11/14` becomes five condition
   tables, most reading "insufficient data". That is a correction, not a regression, but it will be
   read as one. Recommendation: say so in the PRD's first paragraph, and print the old band line
   beside the new skill line for at least one release.
5. **One thing this does not fix, and it caps everything above.** Ten of the 14 scenarios come from
   two incidents sharing pivot entities, and the two false positives that carry the metric's entire
   dynamic range share three byte-identical discriminating queries. `direction N/14` should be read
   as roughly six independent items, of which two do the discriminating — **and a memory-enabled
   sweep can lift the score by carrying one finding across four scenarios with no capability
   change.** That is corpus authoring; it belongs to §7. But add `cluster` and `role`/`difficulty`
   to the `Scenario` schema when §7 next opens: the information already exists in prose in three
   `evaluatorNotes` and in PRD-4 §4, it just is not readable — and without it no memory experiment
   will be interpretable.

---

## Appendix — what was verified, and how

Independently re-derived against the working tree, not taken from agent report:

- Corpus composition: 9 TP / 2 FP / 3 inconclusive; impacts 6 `confirmed-compromise`, 5 `none`,
  3 `unknown`, **0 `contained`**.
- Blind constant sweep over every integer: `tp ∈ [60,70]` → 12/14; `tp ∈ [71,100]` → 9/14;
  `tp ∈ [41,59]` → 3/14. Brier skill of the 12/14 constant: **−0.0747**.
- The two scenarios a constant fails are exactly the two false positives.
- Condition grouping of the 38 artifacts: **5 conditions, 31 cells, 24 at n=1, 7 at n=2, 0 at n≥3.**
- Matched terra-vs-luna (`think=medium`, `sub=researchDone`, 8 shared scenarios): Brier 0.1373 vs
  0.1399, wins 3–3 with 2 ties, **sign test p = 1.000**.
- The sunburst 80/15/90 spread is cross-condition; the honest same-condition figure is 15 → 90 at
  n=2.
- `sweep.ts:131` `?? "medium"` vs `sweep.ts:181` conditional omission — the artifact can claim
  `medium` for a run executed with reasoning off.
- `TELEMETRY_TIME_ANCHOR` declared at `config.ts:47`, accepted at `bootstrap.ts:50`, never passed by
  `scripts/bootstrap-sentinel-data.ts`.
- Token/cost exist per assistant message in `runs/traces/*.jsonl` (`usage.cost.total`) and nowhere
  in `runs/*.json`.
- `bun run evaluate` live output: luna `direction 9/14  impact 4/9  mean 33.8s`; terra
  `direction 11/14  impact 10/14  mean 43.8s`.

Ten major findings went through adversarial verification; nine were confirmed, one was corrected
for an overstated verb (`discriminatingEvidence` *is* executed against live telemetry by
`test/integration/telemetry.test.ts` — it is never **scored**, which is the claim that matters here).

One agent claim that is now **stale**: `bun run queue:reset` was reported as declared-but-missing.
`scripts/reset-queue.ts` has since landed in the working tree.
