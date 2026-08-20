# PRD-6 — Run Comparability

**Status:** Draft  
**Depends on:** PRD-2 — Core Investigation Agent; PRD-4 — Ground-Truth Expansion (the corpus this  
scores against)  
**Amends:** ADR 005 §2 (the run artifact gains fixed-size counters); PRD-2 §23 (regression  
infrastructure, deferred there, is built here); `AGENTS.md` §5 (the run corpus becomes durable), §9  
(the REST surface gains a sixth route), §12 (the artifact gains counters), §14 (a new phase);  
`docs/roadmap.md` §7 (the band partition moves here — §4.4)  
**Builds on:** PRD-5 — Console as an Operator Surface (Complete). Its `config.analystContext`,  
`derivedFrom` and run-level failure recording are the fields this scores; its §4.5 defensive skip is  
deleted here  
**Would produce:** ADR 008 — The Comparability Record  
**Language/runtime:** TypeScript strict mode, Bun  
**Runtime schemas:** Zod

Research backing this document: `docs/research-run-comparability.md`. Every measurement below was
re-derived against the working tree in three passes; §3.3 records what moved between them, because
what moved is itself the argument. Where they disagree, this document is the correction. The third
pass (2026-08-20, all **47** artifacts including `runs/.archive/`) is what §3 reports, and it is the
first to score the archive — which is the change §6.9 makes permanent.

---

## 1. Purpose

`bun run evaluate` reports this today:

```text
gpt-5.6-luna    direction  9/14   impact  4/9     mean 33.8s
gpt-5.6-terra   direction 10/13   impact 10/13    mean 43.2s
```

Every part of that is untrustworthy, and not because the numbers are noisy. They are **structurally
wrong**: the two tables are not two models, the denominators are not the same denominator, and a
stub that answers `65` to every alert without issuing a single query scores **12/14** — beating
both.

Note terra's `10/13`. Two hours earlier the same command printed `11/14`, because the denominator is
"scenarios this model happened to complete" and one run was archived in between. A headline whose
denominator moves on its own is the shape of the problem.

The system cannot currently answer any of the questions it was built to answer. Is terra worth ten
times luna's token price? Does analyst context help? Does thinking level? Would case memory? Each is
a comparison, and the comparison machinery does not hold the variables still.

**The goal is a measurement bed, not a report.** What this project needs is enough saved, honestly
grouped evidence to answer *which configuration is more precise* — across models, parameters
(thinking level, result budget, limits), the tool surface, the prompt, and the analyst context a
re-run carries. That is a data problem before it is a code problem, and today the data cannot
support it: measured across all 47 artifacts on disk, an honest grouping yields **32 cells and not
one of them has three draws** (§3). The code changes here exist to make the accumulating corpus
mean something; the corpus itself is the deliverable, and §11 step 5 is where it is bought.

Four things follow, and they are the whole of this PRD:

1. **Group runs by what they recorded**, not by model name — so a comparison holds every other
   variable still, and new axes (PRD-5's analyst context now, case memory later) join for free.
2. **Keep every draw.** A cell holds all repeats; nothing is overwritten and nothing is dropped.
3. **Never lose a run.** A run costs real money and is a measurement; no tool may silently remove
   one from the scored set, and the set a number was computed over is stated with the number.
4. **Score it honestly.** Partition the bands so a blind constant cannot win them, add a skill
   column beside them, and let the report say *no measurable difference* when that is the truth.

It is deliberately not a new capability: no new service, no new package, no run store, no experiment
framework. The core of it is that the comparison key is **derived from what each run recorded**
rather than assumed to be the model name, that a cell holds **every repeat** rather than the last
one, and that the run corpus is **append-only**.

## 2. Product Goal

```text
today       one table per model id, one row per scenario, last write wins
            failures dropped, repeats destroyed, denominators floating
            archiving a run silently deletes a measurement
            a blind constant scores 12/14 and beats both measured models
            the analyst-context axis has zero scoreable draws

after       one table per condition, one cell per (condition, scenario), every draw kept
            failures scored, denominators pinned to 14, coverage stated on every line
            every run ever recorded is scored; the scored set is fingerprinted
            bands partition, so the blind constant tp=65 scores 9/14 band (was 12/14)
              and -0.075 skill, printed as the baseline row under every report
            steered runs are scored and paired against the parent they were derived from
            "no measurable difference" and "insufficient data" are results the tool can state
```

## 3. The Demonstration

Everything in this section was measured 2026-08-20 against **all 47 artifacts on disk** — the 43 in
`runs/` and the 4 in `runs/.archive/`. Scoring the archive is itself one of this PRD's changes
(§6.9); it is applied here because a document about not losing measurements cannot be written from a
set that has lost some.

### 3.1 Two model tables are nine conditions

Group the artifacts by everything they actually record — provider, model, thinking level, result
budget, web-search availability, limits, submission shape, analyst context:

```text
47 artifacts    9 conditions    32 cells    24 cells at n=1    8 at n=2    0 at n>=3

  runs  covered  model              think    web   context
    14     9/14  gpt-5.6-luna       medium   on    baseline
    12     6/14  gpt-5.6-terra      ?        ?     baseline     pre-config artifacts
     8     8/14  gpt-5.6-terra      medium   on    baseline
     6     6/14  gpt-5.6-luna       ?        ?     baseline     pre-config artifacts
     2     2/14  gpt-5.6-terra      ?        ?     baseline     pre-config artifacts
     2     1/14  gpt-5.6-luna       medium   off   baseline
     1     0/14  gpt-5.6-luna       medium   on    steered      no scoreable draw
     1     0/14  claude-haiku-4-5   medium   off   steered      run-level failure
     1     0/14  gpt-5.4-mini       medium   on    steered      no scoreable draw
```

Three readings, and each is a defect below:

- **No condition covers the corpus.** The best is 9 of 14, and `direction N/M` today divides by
  whatever that condition happened to reach (**D6**).
- **Nothing has been measured three times.** 32 cells, 24 of them a single draw, none at n≥3. Every
  comparison in this repository's history rests on one sample per cell (**D2**).
- **The analyst-context axis has no data at all.** All three steered artifacts produced **zero**
  scoreable draws — one died before investigating anything, two covered no scenario with ground truth.
  PRD-5 shipped the parameter and `evaluate` skips it, so the question *does analyst context help*
  has never had a single measurement behind it (**D10**, **D22**).

### 3.2 Score only what genuinely matches, and the headline disappears

The two conditions with real overlap are terra and luna at `think=medium`, `web=on`,
`sub=researchDone`, no analyst context. Under §6.2's rule — score each draw, then average, keeping
every repeat — they share 8 scenarios:

```text
matched: think=medium · web=on · sub=researchDone · baseline        8 shared scenarios
base rate 0.75 over all 14; reference brier over the 8 covered: 0.1875

scenario                       truth           terra draws  score   luna draws  score   winner
adele-azure-destruction        inconclusive    99           0.240   95          0.202   luna
adele-sharepoint-exfiltration  true-positive   99           0.000   99          0.000   tie
adele-signin-compromise        true-positive   99           0.000   99          0.000   tie
app-credential-added           inconclusive    60           0.010   90, 95      0.181   terra
aws-backdoor-account           true-positive   99           0.000   100         0.000   luna
aws-bob-jones-readonly         false-positive   2           0.000   70          0.490   terra
aws-jane-smith-readonly        false-positive   4           0.002   35          0.122   terra
model-evasion-attempts         true-positive    8           0.846   65          0.122   luna

terra  brier 0.1373  skill +0.2675          luna  brier 0.1399  skill +0.2540
wins terra 3, luna 3, ties 2                exact two-sided sign test p = 1.000
```

The 2-scenario gap in today's headline is which model happened to run under which harness
generation. On a matched set the two are **indistinguishable**: a skill difference of 0.0135 across
eight cells that each hold one or two draws, and a sign test that could not reject a coin.

That is the honest state of the comparison, and it is why §11 step 5 exists. No amount of scoring
work produces an answer from 32 cells at n≤2.

### 3.3 The comparison moved three times while this document was being written

| pass | set | shared | terra skill | luna skill | wins | verdict printed |
|---|---|---|---|---|---|---|
| research note | `runs/` before `queue:reset` | 8 | — | — | — | terra ahead |
| PRD draft | `runs/` after `queue:reset` | 7 | +0.2426 | +0.3477 | 2–3 | luna ahead |
| this pass | `runs/` **+ `.archive/`** | 8 | +0.2675 | +0.2540 | 3–3 | tie, p = 1.000 |

Nothing about either model changed between any two rows. `bun run queue:reset` archived the run
holding terra's only draw on `app-credential-added`; both readers use a *non-recursive*
`new Bun.Glob("*.json")`, so a rename into `runs/.archive/` removes a run from the console **and**
from the evaluation report with no code change in either. Removing that one scenario moved terra's
skill by 0.025, luna's by 0.071, and widened the gap between them **elevenfold** — from 0.0095 to
0.1051. Restoring it closes the gap again.

That is **D18**, and it is the defect this PRD treats as first among equals: a benchmark whose input
set can be archived out from under it between two invocations cannot reproduce its own results. The
fix is not a warning label. It is that **`evaluate` scores every run that has ever been recorded**
(§6.9), which is what makes this third pass the one the tool will print.

Two smaller corrections the third pass forced, both worth stating rather than absorbing:

- Luna's 8-shared skill is **+0.2540**, not the +0.2770 the draft's §3.1 reported. The difference is
  §6.2 applied properly: luna has *two* draws on `app-credential-added` (90 and 95), and
  score-then-average over both is not the same as scoring one of them.
- The draft's "the ordering is decided by a single draw in a single cell" still holds, and now names
  the cell: `app-credential-added`, terra's `60`.

And once more while §6 was being written: a forty-seventh artifact appeared — a steered luna run
against an alert with no ground truth. It moved the artifact count, added a ninth condition, and
changed **no measurement in this document**, because it produced no draw. That is the distinction the
report has to make and today cannot: a set that grew and a result that moved look identical when
neither is stated. It is also why §6.9's fingerprint is over the run ids *scored* rather than the
files present, and why the corpus is committed rather than left to accumulate on one machine.

### 3.4 The bands: measured, the fix is cheap

The three bands overlap rather than partition — `TP >= 60`, `FP <= 40`, inconclusive `[30, 70]` — so
`65` is simultaneously a passing true positive and a passing inconclusive. Sweeping every constant
from 0 to 100 against the 14 scenarios:

```text
current bands   best blind constant  tp=60  ->  12/14        (tp=65 also 12/14)
partition       best blind constant  tp=60  ->   9/14
```

A stub that answers a constant and issues no query beats both measured models today. Under the
partition (`FP <= 40`, inconclusive `41–59`, `TP >= 60`) it drops to 9/14 — the nine true positives,
which is the floor any three-way band on a 9/2/3 class mix permits.

The reason PRD-4 §9 and roadmap §7 deferred this was that repartitioning would move every cell for a
second reason at once and destroy the baseline. **Measured, it moves one draw in forty:**

```text
band flips under the partition: 1 / 40 scoreable draws
  app-credential-added   inconclusive   tp=60   PASS -> FAIL   run 01a01b61 [archived]
```

Two things follow, and they point in opposite directions, which is why §6.10 lands the partition and
§6.3 lands the skill column and the report prints both:

- **The cost is one draw, so the deferral was over-cautious** — and the roadmap's claim that "none of
  the 21 scored runs to date changes verdict under it" is false once the archive is scored. It reads
  as true today only because the run that flips was archived. Fixing D18 makes it false again, so the
  two changes are entangled and belong in one PR.
- **That one draw is the corpus's best-calibrated inconclusive answer.** `tp=60` against a target of
  0.5 scores 0.010 — the lowest error in any inconclusive cell on disk — and the partition calls it
  FAIL because it sits exactly on the boundary. Every other inconclusive draw ever recorded is 72 or
  higher, or 15. A three-way band is a lossy view of a continuous number no matter where the
  boundaries go, which is the argument for the skill column rather than against the partition.

## 4. The Defects

Twenty-two, grouped by where they live. The ones marked **blocking** make a current number wrong
rather than merely absent. Line references are against the working tree at the time of writing;
`apps/investigator/src/sweep.ts` became `execute-run.ts` and `runner.ts` became
`investigate-alerts.ts` during this review, so prefer the named symbol over the line.

### 4.1 Scoring — `scripts/evaluate-runs.ts`

| # | Defect | Evidence | What goes wrong |
|---|---|---|---|
| **D1** | **blocking** — The comparison key is `model.id` alone. `provider`, `config` and `limits` are recorded and then discarded. | `:120` `model: run.model?.id ?? "unknown"`; `config` and `limits` appear zero times in the file, though `contracts/run.ts` says of `config`: *"two runs are not comparable without knowing how each was configured"* | Seven conditions render as two model rows. §2's flip is a direct consequence. |
| **D2** | **blocking** — `latestPerScenario` is last-wins, so N repeats collapse to one arbitrary row. | `:137` ``seen.set(`${row.model}::${row.scenario}`, row)`` over a list sorted only by `startedAt` | Variance — the one thing that decides whether any delta is believable — is unobservable. No count, no spread, no flag that repeats existed. |
| **D3** | **blocking** — The three bands overlap rather than partition. **Fixed here** (§6.10); the deferral to roadmap §7 is reversed, see §3.4. | `:28-30` `TP >= 60`, `FP <= 40`, inconclusive `[30,70]` | A constant `65`, issuing no queries, scores `direction 12/14`. It fails exactly the two false positives, so those two carry the metric's entire dynamic range. Measured, the partition costs 1 draw in 40 and costs the blind constant 3 (§3.4). |
| **D4** | **blocking** — `status: "failed"` results are dropped before scoring, and from the mean. | `:114` `result.status !== "completed"` → `continue`; `error` declared `:44`, read nowhere | A model that times out on 13 of 14 and completes one prints `direction 1/1` — a perfect score — with a *better* mean latency, because the 600 s timeouts are absent from the denominator. |
| **D5** | **blocking** — Run-level failures are invisible. PRD-5 added `status: "failed"` and `error` to `InvestigationRun`; `evaluate` reads neither. | `contracts/run.ts:107,116`; artifact `01a01ea6-a5f6` is `status: "failed"`, `alertCount: 0` — an anthropic run that died on a missing credential | A whole condition can fail to start and the report says nothing. |
| **D6** | major — Every denominator floats. `direction N/M` is over *scenarios this model happened to complete*; `impact k/n` is over *artifacts new enough to carry the field*; `mean` is over surviving rows. | `:172-175` | `direction 3/3` prints under the same header as `direction 10/13`, and the `/13` is itself a moving target. luna's `impact 4/9` is a fact about artifact age, not about luna. |
| **D7** | major — The join is exact string equality against a content-addressed hash, and every way it can return nothing reports identically and exits 0. | `:95` `byAlert`; `:144-147` prints `[evaluate] no scored results` | A corpus change that orphans every run is indistinguishable from a typo'd run id. |
| **D8** | major — `--compare` is cross-model unsafe, band-only, and mislabels its columns. | `pick` at `:196` filters on `runId` and never reads `model`; columns are `runId.slice(0,8)` | Comparing terra against luna prints `FIXED`/`REGRESSED` as though one had improved. 16 of the 40 run ids share an 8-char prefix with another run — it is the UUIDv7 millisecond. Impact changes, magnitude changes inside a band, and repeats are all invisible. |
| **D9** | minor — Run files are consumed via an unchecked cast with no validation. | `:86` `(await Bun.file(file).json()) as RunFile` | A syntactically broken file is already skipped at `:87`; a JSON-valid artifact missing `results` or `startedAt` throws out of the sort or the scoring loop and takes every valid run with it. |
| **D10** | **blocking** — Steered runs are *skipped* rather than shown, so analyst context — a parameter PRD-5 shipped — is unmeasurable. | `:108`, PRD-5 §4.5 | Deliberate and correct as a stopgap against last-wins (**D2**); with cells holding every draw its reason is gone. It hides the one experiment the user most wants to run. Deleting it is this PRD's first job (§6.11). |

### 4.2 Recording — the run artifact

| # | Defect | Evidence | What goes wrong |
|---|---|---|---|
| **D11** | **blocking** — The system prompt is not merely unrecorded, it is **unrecordable**. | `DEFAULT_INSTRUCTIONS` reaches the harness by module import (`execute-run.ts`, `instructions: DEFAULT_INSTRUCTIONS`); `RunConfig` has no `instructions` field; traces do not carry it either | The prompt axis cannot be measured at all. **Steering and memory are both prompt changes**, so this blocks all three of the axes this PRD exists to serve. |
| **D12** | **blocking** — `thinkingLevel` is fabricated in the artifact. | `execute-run.ts:135` writes `config.thinkingLevel ?? "medium"`; `:185` omits the key entirely when unset, so `pi-agent-core` falls back to `off` | A run executed with reasoning **off** produces an artifact claiming **medium**. This is the one place the artifact lies, and it lies about the one knob no condition on disk has ever varied. |
| **D13** | major — No tokens, cost, turns or tool calls in the artifact. | `usage.cost.total` exists per assistant message in `runs/traces/*.jsonl`; nothing in `runs/*.json` | The roadmap's own motivating question — is terra worth 10× — is unanswerable unless `INVESTIGATOR_TRACE=true`, which writes 0.16–23 MB per investigation into the loop that is supposed to be cheap to repeat. |
| **D14** | major — `webSearchConfigured` records capability, never use. | `InvestigationRunConfig.webSearchConfigured` | Two runs that differ only in whether the agent actually searched are indistinguishable; and a run with the key absent is a different condition for a reason the report cannot state. |
| **D15** | major — No corpus identity, and the one mechanism for pinning it is dead config. | `TELEMETRY_TIME_ANCHOR` declared at `mock-sentinel/src/config.ts:47`, accepted as `BootstrapOptions.timeAnchor` at `bootstrap.ts:50`, defaulted `?? new Date()` at `:157` — and never passed by `scripts/bootstrap-sentinel-data.ts` | The anchor moves on every bootstrap and no artifact records which one it ran against. The documented way to pin a reproducible corpus is unreachable. |
| **D16** | major — Nothing pins the served model version. | Artifact records `model.id` only, a moving alias | A provider re-pointing `gpt-5.6-terra` is invisible and reads as agent regression. |
| **D17** | minor — The submission schema is unversioned. | `summary.nextAction` vs `summary.researchDone`; 8 artifacts predate the change | Whether a run was scored on one axis or two has to be inferred from field presence. |

### 4.3 Inputs — corpus and run set

| # | Defect | Evidence | What goes wrong |
|---|---|---|---|
| **D18** | **blocking** — `runs/` is a mutable, unversioned input set, and the queue reuses it as storage. | `scripts/reset-queue.ts` renames into `runs/.archive/` precisely *because* both readers glob `*.json` non-recursively; 4 artifacts sit there now; §3.3 | The benchmark cannot reproduce its own result across two invocations. Returning an alert to the queue — a console operation with nothing to do with scoring — silently deletes a measurement that cost money. Three passes of this document read three different answers (§3.3). |
| **D22** | **blocking** — The analyst-context axis has **zero** scoreable draws, so a parameter that shipped in PRD-5 has never been measured once. | All three steered artifacts cover 0 scenarios: `01a01ea6` is `status: "failed"`, the other two investigated alerts with no ground truth. The single `derivedFrom` pair on disk is that failed run | *Does analyst context help* is the question the console's re-run button was built to raise, and the benchmark has no data on it and would skip it if it did (**D10**). It is also the axis case memory will arrive on (§5.1), so the gap compounds. |
| **D19** | major — Class imbalance concentrates the metric. | 9 true-positive / 2 false-positive / 3 inconclusive; impacts 6 `confirmed-compromise`, 5 `none`, 3 `unknown`, **0 `contained`** | With overlapping bands a constant scores 12/14, failing only the two FPs. `contained` is a legal answer that no scenario tests, so an agent answering it is wrong by construction on all 14. |
| **D20** | major — Scenarios are not independent measurements. | 10 of 14 are drawn from 2 incidents and share pivot entities; the two FPs share three byte-identical discriminating queries | `direction N/14` should be read as roughly six independent items, of which two discriminate. **A memory-enabled run can lift the score by carrying one finding across four scenarios with no capability change** — the exact experiment this PRD enables is the one this defect most distorts. |
| **D21** | major — A rule edit orphans history permanently. | `startingAlertId` is a content hash over rule id and projected row (ADR 004, "Alert ids are content-addressed") | A `\| project` reorder re-pins the fixture, and every prior run for that alert becomes unjoinable — reported as D7's silent zero. |

### 4.4 The Band Deferral, Reversed

An earlier draft of this document deferred **D3** to roadmap §7 on the grounds that repartitioning
would move every cell for a second reason at once and destroy the baseline — the principle PRD-4 §9
established. That reasoning is recorded here rather than deleted, because the measurement that
overturned it is the useful part:

- **The cost was assumed, not measured. Measured, it is one draw in forty** (§3.4) — and that draw
  lives in `runs/.archive/`, so the roadmap's claim that "none of the 21 scored runs to date changes
  verdict under it" holds today only because the run that flips was archived out of the set. Fixing
  D18 makes it false again. The two changes cannot be sequenced apart: whichever lands second gets
  blamed for the other's movement.
- **PRD-4 §9's principle survives intact.** What it forbids is *scoring changes and corpus authoring*
  landing together. The partition is a scoring change, and it lands with the other scoring changes —
  the skill column, the cells, the coverage denominators — in `scripts/evaluate/scoring.ts`. Corpus
  authoring (**D19**, **D20**) stays deferred, so the boundary PRD-4 drew is where it always was.
- **The band fix alone does not restore discriminating power.** After the partition the best blind
  constant still scores **9/14**. That is why it lands *beside* the skill column (§6.3) and not
  instead of it, and why the report prints both for at least one release (§6.10).

Roadmap §7's band bullet is deleted in the same PR as step 0 (§11), and ADR 008 §7 records the
reversal.

### 4.5 What Is Deliberately Not Fixed Here

**D19 and D20 are corpus authoring** and belong to roadmap §7. This PRD's obligation to them is to
make them *visible* — a report that prints `covered K/14` and a per-condition blind-constant baseline
row states its own weakness on every run.

**D21 is a re-pin that has never happened.** §9 explains why the alias list waits for a concrete
orphaned set; §6.5's exit-1 makes it loud the first time it fires.

## 5. Core Design Principles

### 5.1 The condition key is derived, never declared

The key is computed in `scripts/` by hashing what a run recorded. It is not a field on the artifact
and not an enum on a contract.

A declared taxonomy — `augmentation: ["analyst-context", "case-memory"]`, or a `conditionId` written
at run time — costs a contract edit per axis, can be computed wrongly at write time, and can never
be recomputed for the 47 artifacts already on disk. A derived key is fixed in one file and
re-applied to all history. It also means PRD-5's `config.analystContext` is picked up with **zero
code**, and a future memory field arrives free — which matters, because AGENTS.md §2 lists
cross-investigation memory under *Do not implement*, and this PRD must not build a slot for it.

### 5.2 An absent field is a value, never a wildcard

A run that did not record its thinking level renders `think=?`, and `?` never merges with `medium`.
The alternative — treating absence as "probably the default" — is how D12's fabricated `medium`
became indistinguishable from a real one.

### 5.3 Skill sits beside the bands, never instead of them

The bands are repartitioned here (§4.4, §6.10) and they still do not carry the report. A band is a
lossy view of a continuous number wherever its boundaries sit — §3.4's one flipped draw is the
corpus's *best-calibrated* inconclusive answer, marked FAIL for being one point over a line. The
PASS/FAIL column is also the only continuity the existing artifacts have, so it stays, and the
blind-constant row printing `tp=65: band 9/14 · skill −0.075` under every report is what stops
either column from being read alone.

### 5.4 Counters yes, content no

The artifact gains fixed-size integers and one usage object. It does not gain per-event records, KQL
text, tool arguments, query results or messages. Nothing added here grows with the length of an
investigation. This is the bright line ADR 008 records, and it is what keeps ADR 005 §2's "not a
trace store" true in substance while amending it in letter.

### 5.5 The scored report is never written to disk

Given `p` — already on the artifact — and a score, `t = p ± √score`, and with `t ∈ {0, 0.5, 1}` that
recovers the verdict exactly. A scored artifact is the answer key in a new coat. **The same leak
applies to a PASS/FAIL artifact**, so this is not a property of the new metric. `evaluate` prints;
it does not persist.

### 5.6 The run corpus is append-only

A run artifact is a measurement that cost money and cannot be re-derived — the model is
non-deterministic and there is no seed to pin (§9). Nothing in this repository may quietly remove one
from the scored set. The queue may hide a run from the *queue*; that is a console concern and it must
not reach into the *corpus*. Deletion exists, requires `--purge` and `--yes`, and says what it is
destroying.

This is the principle D18 violates by accident rather than by design: `queue:reset` archives into a
sibling directory *because* both readers glob non-recursively, so a queue operation is a scoring
operation. §6.9 separates them.

### 5.7 A parameter that ships is a parameter that gets measured

Analyst context shipped in PRD-5 and has zero scoreable draws (**D22**). The way that happened is
instructive: `evaluate` needed a defence against last-wins, the cheapest one was to skip steered
runs, and the axis quietly left the measurement bed. So the derived key takes *every* recorded
parameter (§5.1), the report never silently excludes a class of run, and a condition the corpus
cannot yet speak about prints `insufficient data` rather than being absent (§6.12).

## 6. Design

### 6.1 `scripts/evaluate/condition.ts` — the key

`conditionOf(run)` returns `{id, label, fields}`.

- `id` — first 6 hex of sha256 over a sorted-key `JSON.stringify` of
  `{model.provider, model.id, config, limits, provenanceKey(run)}`. Hashing the whole of `config`
  rather than named members is the point of §5.1.
- `provenanceKey` is the one deliberate exception: a **named projection** of the provenance block —
  `{promptHash, submissionHash, piVersion, servedModelId, corpus.telemetryRevision,
  corpus.alertSetHash, corpus.queryMaxRows}`. `corpus.anchorUtc` and `corpus.offsetMs` are recorded
  on the artifact and never hashed into the key, for the same reason §6.8 keeps the anchor outside
  `alertSetHash`: they move on every bootstrap, so hashing them would mint a fresh condition on
  every `bun run data:bootstrap` and no two runs either side of one would ever share a cell.
- `label` — renders only the axes that differ within the current report, e.g.
  `gpt-5.6-terra · think=medium · p=a41f · sub=researchDone · corpus=9c2e · ctx=7b2e`.
  **A label must never collapse two distinct ids.** Measured today, two conditions share the label
  `gpt-5.6-luna · think=medium · sub=researchDone` and differ only by `webSearchConfigured` — twelve
  runs with the web available and one without. Rendering them identically is the bug this rule
  exists to prevent, and `web=off` is exactly the kind of axis a reader would never think to ask
  about.
- `analystContext` renders as `baseline` when absent and `ctx=<sha256/6 of the raw text>` when
  present — never as a bare `steered` flag, and never as the text itself. Two different premises are
  two different conditions and must not share a cell; the raw text can be several paragraphs and
  belongs in the legend, not the label. It is already inside the hashed `config`, so this is a
  rendering rule, not an extra input (§6.11).
- `fields` — the full recorded set, printed once in a legend above the tables.

For pre-provenance artifacts, infer the submission shape from field presence (`sub=nextAction` when
any result carries `summary.nextAction`) and mark it `inferred` in the legend.

### 6.2 `scripts/evaluate/scoring.ts` — the score

Pure, no I/O, no scenario import.

- `targetFor(verdict)` → `true-positive: 1`, `false-positive: 0`, `inconclusive: 0.5`
- `drawScore(p, t) = (p − t)²`
- `cellScore(draws)` = **mean of the draw scores**, plus the exact decomposition
  `{bias2: (mean(p) − t)², variance: mean((p − mean(p))²)}`, where `bias2 + variance === score`.

Score-then-average is mandatory, not stylistic. Terra's `sunburst` cell holds two draws, 15 and 90,
against a target of 0.5. Averaging the *answers* first gives `(0.525 − 0.5)² = 0.0006` and ranks the
corpus's most unstable cell as near-perfect. Averaging the *scores* gives `0.141` — a factor of 226
apart. A cell that answered 15 and 90 to the same question has not answered it.

### 6.3 Skill, coverage-matched

`skill = 1 − brier / referenceBrier`, where the reference is the base rate.

**The base rate is computed over all 14 — it is a corpus property. The reference Brier is computed
over the covered scenarios only.** With an all-14 denominator against a subset numerator, a
condition that happened to cover six easy scenarios inflates from 0.531 to 0.781. `covered K/14`
prints on the same line as skill, always; skill never prints without it.

Impact stays a plain `k/n (m unscored)`. It is categorical with three reachable values and one
unreachable one (D19); a multi-class Brier would add ceremony without resolution.

### 6.4 Saying "No Difference"

- `signTest(up, down)` — exact two-sided binomial tail, ~8 lines of integer factorial, no library.
  At 7 shared scenarios it takes all 7 one way to reach `p <= 0.05`. That bar is the point.
- `noiseFloor(cells)` — computed **per condition from its own cells' measured variance, never
  pooled**. Pooling across conditions is dominated by the one bimodal `sunburst` cell, and would
  either hide real movement or invent it.
- A delta smaller than the noise floor prints as `no measurable difference`, not as a number with a
  sign.

### 6.5 The reader — `scripts/evaluate-runs.ts`

- Replace the `as RunFile` cast with `InvestigationRun.safeParse`, warn-and-skip (**D9**).
- Split the merged `continue` into three counted buckets: `no-ground-truth` (silent, correct),
  `failed` (**scored**), `no-summary` (counted and reported) (**D4**, **D6**).
- A failed draw scores as if it had answered the base rate — `drawScore(0.75, t)` — so it lands at
  exactly zero skill, needs no special case anywhere in aggregation, and prints on its own counter
  line with `error.name`. Run-level failures print as a condition that produced no draws, with the
  run-level `error.name` (**D5**).
- Group into `(conditionId, scenarioId)` cells holding **every** repeat (**D2**).
- Delete the steered-run skip (**D10**).
- Report shape:

```text
RUN SET  47 artifacts (43 runs/, 4 runs/.archive/)  fingerprint 4f1c8ad2e0b7  ·  14 scenarios
BANDS    partition: FP <= 40 · inconclusive 41-59 · TP >= 60      (legacy bands shown as band⁰)

CONDITIONS
  a41f  gpt-5.6-terra · think=medium · sub=researchDone · web=on · baseline   covered 8/14  n>=3 0/8
  9c2e  gpt-5.6-luna  · think=medium · sub=researchDone · web=on · baseline   covered 9/14  n>=3 0/9
  3d17  gpt-5.6-luna  · think=medium · sub=researchDone · web=off · baseline  covered 1/14  n>=3 0/1
  7b2e  gpt-5.6-terra · think=medium · sub=researchDone · web=on · ctx=7b2e   covered 0/14  no draws (1 run failed: InvestigationModelError)

a41f  gpt-5.6-terra · think=medium · sub=researchDone · baseline
scenario                       truth           n  draws    med  spread  band band⁰  score  bias²+var   impact  turns  tokens    $     s
sunburst-domain-inconclusive   inconclusive    2  15, 90    52     75   FAIL FAIL   0.141  0.001+0.140   1/2      9   214k   0.31  50.4
app-credential-added           inconclusive    1  60        60      —   FAIL PASS   0.010  0.010+0.000   1/1      7   181k   0.24  41.9
...
skill +0.268 (ref over 8 covered) · covered 8/14 · draws 9 · failed 0 · band-dir 5/8 · band⁰-dir 6/8
insufficient data: 8 of 8 cells at n<3
blind constant tp=65: band 9/14 · band⁰ 12/14 · skill -0.075
```

  `band⁰` is the pre-partition column and prints for one release (§6.10). Every cell where the two
  disagree is a cell the partition moved, which makes the change auditable per draw rather than only
  in aggregate — measured today that is exactly one row across the whole corpus (§3.4).

- `--compare a b` takes run **or** condition ids, pairs on shared scenarios only, prints both labels
  and a field-level diff of what actually differs, reports delta skill against the noise floor, and
  runs the sign test (**D8**). `—` for "not covered" and `✗` for "failed" render differently.
- **No exit-code gate.** At n=1 the smallest credible skill delta is large; a benchmark that cries
  wolf gets disabled. The one exit-code change: `runs.length > 0 && scored.length === 0` exits 1 and
  names the unjoined alert ids (**D7**).

### 6.6 `apps/investigator/src/provenance.ts` — what the producer records

Derived from source, not from configuration, so it does not become a fourth file reading the
environment beside `apps/mock-sentinel/src/config.ts`, `apps/investigator/src/env.ts` and
`apps/console/src/env.ts` (ADR 005 §6 owns investigator configuration).

```ts
export const INSTRUCTIONS_LABEL = "soc-triage-v2";   // legibility; the hash is the truth
export const PROVENANCE = { promptHash, submissionHash, piVersion };
```

- `promptHash` — sha256/12 over `DEFAULT_INSTRUCTIONS` **plus** each of the five tools'
  `name`, `description` and serialised `parameters` in name order, **plus** the
  `buildInitialContext` template with the alert JSON and table list elided (**D11**). An
  instructions-only hash misses a tool-description edit, which changes behaviour just as surely.

  Tool metadata is not reachable from source today: `createInvestigationTools` needs live clients,
  so hashing it would mean fabricating stubs at module load in every process that imports
  provenance. So `tools/index.ts` gains
  `export function toolDescriptors(): { name: string; description: string; parameters: TSchema }[]`,
  consumed by both the five factories and `provenance.ts`. That is the only non-trivial part of this
  file.
- `submissionHash` — **separate**, over the `submit_investigation` TypeBox schema. That is what
  actually split this corpus, and a reader needs to see which of the two moved (**D17**).
- `piVersion` — `pi-agent-core` and `pi-ai` versions, read as a static JSON import of the
  workspace `package.json` pins (`resolveJsonModule` is already on) rather than a runtime resolve of
  `node_modules`, which would trip `ground-truth-isolation.test.ts`'s caller-supplied-path scan. It
  therefore records the *declared* pin: a `bun update` inside the range moves the real version
  without moving the hash, which is a known and accepted gap. pi-ai owns both the dollar figures and
  the meaning of `thinkingLevel` (**D16** partially; the served model id is recorded when pi-ai
  reports one, and `?` otherwise).

Two runs sharing an `INSTRUCTIONS_LABEL` with different `promptHash` values is a defect the report
names explicitly.

### 6.7 Cost and effort

`InvestigateOptions` gains `onMetrics?: (m: {turns, toolCalls, usage}) => void`. A second, always-on
`agent.subscribe` tallies `tool_execution_start` by `toolName`; `turns` is already counted in the
`shouldStopAfterTurn` closure.

**Fire it from the existing `finally` that wraps `agent.prompt()`, not from the return value.**
Every throw — `InvestigationTimeoutError`, `InvestigationAbortedError`, `InvestigationModelError`,
`InvestigationStepLimitError`, `InvestigationIncompleteError` — happens *after* that block, so a
widened return type would lose exactly the most expensive runs, which is the opposite of the point
(**D4**, **D13**).

`investigate-alerts.ts` captures it into a local before the `try` and spreads it into **both** the
completed and the failed result.

The aggregate is already in-process: `agent.state` is public and assistant messages carry `usage`.
This recovers a number the harness currently discards rather than reconstructing it from a 0.16–23 MB
JSONL. It also retires three of the four coverage caveats in the console, and removes the cost half of
PRD-5 §18 Q2 — the durable-transcript half is untouched, since §5.4 keeps transcripts optional and
off by default.

`toolCalls` is a `Record` over the five closed tool names — not a bare integer, and **not** a
per-table tally. `toolCalls.query_security_data` answers *"did it do less work for the same
answer"*, which is the actual memory hypothesis, without naming a table (see §9).

### 6.8 Corpus identity

Bootstrap writes a `_CorpusManifest` marker table into the database it has just built:

```ts
{ anchorUtc, offsetMs, telemetryRevision, alertSetHash, generatedAt }
```

`alertSetHash` is sha256/12 over the sorted `systemAlertId`s it generated. `offsetMs` already exists
as `BootstrapSummary.timeOffsetMs` and is currently discarded.

A marker table cannot go stale relative to the database because it **dies with it** — the database
is volatile, which is exactly why a generated file would drift.

**It must not reach the agent.** `GET /schema` runs `.show database schema` with no allowlist
(`routes/schema.ts`), the harness holds the whole result, and `buildInitialContext` puts every table
name into the opening `<available_tables>` block — so a table added to that database is a table the
agent is invited to query. `_CorpusManifest` carries no ground truth, but a benchmarking change that
silently alters turn-0 context is a change to the thing being measured. So `GET /schema` drops table
names beginning with `_`, `POST /query` rejects them, and a test asserts that the startup table-name
list is byte-identical before and after the manifest is written. The leading underscore is the whole
convention; nothing else in `TELEMETRY_TABLES` uses one.

Exposed through a new `GET /corpus` and `getCorpus(): Promise<CorpusIdentity | undefined>` on
`SentinelApiClient`, returning `undefined` on 404 — **not** through `/health`, which
`packages/contracts/src/health.ts` records as operational-only and deliberately not an investigation
primitive. Degrading to `undefined` means an older Mock Sentinel does not break `bun run investigate`,
and the report prints `corpus unknown` rather than a fabricated match.

**`anchorUtc` sits beside the hash, never inside it.** It moves on every bootstrap while shifting the
whole dataset by one constant offset (ADR 001), and alert ids exclude timestamps from their hash by
construction. Hashing it would invalidate all history on every `infra:up` for no semantic reason.
`alertSetHash` is what catches the change that genuinely breaks the join.

Also: pass `config.TELEMETRY_TIME_ANCHOR` through in `scripts/bootstrap-sentinel-data.ts`. Two lines,
and the key stops being dead config (**D15**).

### 6.9 Keeping every run in the scored set

**The archive is scored.** `evaluate` reads `<runsDir>/*.json` **and** `<runsDir>/.archive/*.json`;
`--runs <dir>` implies `<dir>/.archive`. This is three lines and it is the whole of D18's fix. The
archive was never a scoring concept — `scripts/reset-queue.ts` moves files there to take an alert
*out of the queue*, and its own comment names the mechanism: both readers use a non-recursive glob,
"so a rename into `runs/.archive/` removes a run from the console *and* from the evaluation report
with no code change in either". The console side of that is correct and stays. The evaluation side
is the bug.

- Run ids are **deduped across both directories**, live winning, with a warning naming the id. A
  `--restore` that copies rather than moves must not double-count a draw.
- `--exclude-archive` exists for reproducing what the console sees. It is never the default, and the
  header says which set was scored.

**Deletion is loud.** `queue:reset --purge` currently requires `--yes` only for `--all`, so
`--purge --run <id>` destroys a measurement silently. It gains the same confirmation as `--all`, and
its dry-run line states what is being destroyed in the units that matter: *"purging 1 run removes 3
scoreable draws across 3 scenarios from condition a41f"*. Computing that means `reset-queue.ts`
joining to ground truth, which it already does for `--scenarios` — and `scripts/` is the one tree
exempt from both guards, so nothing moves (§8.1).

**The scored set is fingerprinted.** The header prints the artifact count, both directories, and a
sha256/12 over the sorted run ids actually scored. That is what makes a reported number quotable: a
figure quoted with its fingerprint can be checked, and a set that has changed announces itself
instead of silently producing a different answer.

**The corpus is committed.** `/runs/` leaves `.gitignore` and `/runs/traces/` takes its place, so the
run artifacts and their archive are version-controlled and the transcripts are not. The split is what
makes this cheap: 47 artifacts total **200 KB**, none over 5.5 KB, while `runs/traces/` is 126 MB for
40 transcripts.

Three things follow, and the first is the point:

- **A baseline survives a fresh clone.** Step 5 buys ~96 investigations with real money; a corpus that
  exists only on the machine that bought it is one disk failure from being bought twice. Committing
  also makes §5.6's append-only rule enforceable by review rather than by memory — deleting a
  measurement becomes a diff.
- **The run-set fingerprint becomes a git fact.** A number quoted with its fingerprint can be checked
  out and recomputed, which is what "reproduce" has to mean for a benchmark whose model is
  non-deterministic and whose corpus cannot be regenerated.
- **The working tree goes dirty on every `bun run investigate`.** That is the real cost and it is
  accepted: the artifacts *are* the deliverable, so a run showing up in `git status` is correct rather
  than noisy. `runs/traces/`, `feedback/` and the rest of the local operational data stay ignored.
- **`runs/` joins `.oxfmtrc.json`'s `ignorePatterns`**, beside `fixtures/**` and `**/*.md` and for
  the same reason those are there: a formatter must not rewrite data. Without it `bun run fmt:check`
  fails on 25 of the 47 artifacts, and "fixing" them would make the committed bytes differ from what
  `writeRunArtifact` produces — so every new run would arrive unformatted, and a measurement would be
  edited by tooling. Found by running the check, not by reasoning about it.

This amends `AGENTS.md` §5's repository shape, which is why step 0 carries the note (§11). It does
**not** change §8 guard 3: the per-generation artifact fixtures under
`apps/investigator/test/fixtures/runs/` stay the thing tests assert against, because a sweep over a
committed `runs/` would grow without bound and break on the first artifact an experiment leaves
behind.

### 6.10 The band partition

In `scripts/evaluate/scoring.ts`, beside the skill function, so the two live and are tested
together:

```ts
export const BANDS = { falsePositiveMax: 40, inconclusive: [41, 59], truePositiveMin: 60 } as const;
```

`FP <= 40`, inconclusive `41–59`, `TP >= 60` — three classes that partition `[0, 100]` with no
value satisfying two of them (**D3**).

- **Both columns print for at least one release.** `band` is the partition, `band⁰` the legacy
  `[30, 70]` inconclusive. A per-cell disagreement is a cell the partition moved; today that is one
  row in forty (§3.4). Dropping `band⁰` is a one-line follow-up once the re-baseline (§11 step 5)
  has replaced the corpus it exists to keep comparable.
- **A property test, not a literal test.** For every integer `0–100` and every verdict, exactly one
  class accepts it; and no constant scores above 9/14. Asserting `9` rather than the property would
  re-break the moment the corpus is rebalanced by roadmap §7.
- **The blind-constant row prints under every report** with both figures, because the partition
  lowers the ceiling without removing it: 9/14 is what the 9/2/3 class mix pays out for free
  (**D19**). The printed exemplar is `tp=65`, which reads `band 9/14 · band⁰ 12/14 · skill −0.075` —
  the constant that most embarrasses the *current* bands, held fixed so the row is comparable release
  to release. Two properties worth knowing about the row and neither is a defect: every constant
  from 60 to 100 scores the same 9/14 band, and the *skill*-optimal constant is `tp=75` — the base
  rate — at **exactly zero** skill, by construction of §6.3's reference. A blind answer can never
  show positive skill, which is the property that makes the row a floor rather than a target.

### 6.11 Analyst context as an axis

Deleting PRD-5's §4.5 skip (**D10**) is what lets steered runs into the report; it does not by itself
make them *comparable*, because a steered run answers a different question from its parent.

- **The premise is part of the condition**, via the hashed `config` (§5.1) and rendered `ctx=<hash6>`
  or `baseline` (§6.1). Two different premises are two conditions. This is why the key hashes the
  whole of `config` rather than named members: `analystContext` needed no schema work and neither
  will the next parameter.
- **`derivedFrom` gives a paired report.** For every derived run, print the parent cell and the child
  cell on the same scenario side by side — the draws, both scores, and the delta against the parent
  condition's noise floor (§6.4). A pair is a *matched* comparison by construction, which is worth
  more per run than anything else in this document: it holds every variable still except the one the
  analyst changed.
- **A pair that changed more than the premise is flagged, not hidden.** The single `derivedFrom` pair
  on disk is a steered re-run of a **luna** parent under `claude-haiku-4-5` — two variables at once,
  measuring neither. The report names the field-level diff and marks the pair `unmatched`. This
  settles §12 Q6 in the direction of the report noticing rather than PRD-5 constraining: the console
  should stay free to re-run anything, and the benchmark should be the thing that says what the
  re-run can support.
- **Steering does not enter the baseline.** A `baseline` condition and a `ctx=…` condition are
  distinct ids, so the blind-constant row, the skill figures and the sign test are all per condition
  and never blend the two. That is the property PRD-5's §4.5 skip was defending, obtained from the key
  rather than from an exclusion.
- **A steered condition is normally one scenario wide, and that is correct.** An analyst premise is
  written about a specific alert, so hashing the raw text means most steered conditions cover exactly
  one scenario. A condition table cannot aggregate that, and it should not try: the steering result
  is the **paired delta against the parent**, summed over pairs, and the report says so rather than
  printing a one-cell condition with a skill figure that looks like a model score. A premise reused
  verbatim across scenarios *does* group, and then it is a condition like any other.

### 6.12 Baseline readiness

The corpus is the deliverable (§1), so the tool reports how far from usable it is.

- **`n<3` is stated, never inferred.** Every cell prints its `n`; a condition prints
  `insufficient data: K of M cells at n<3`; a skill figure computed entirely from n=1 cells is
  printed with that caveat on the same line. §3.2's 0.0135 skill difference between terra and luna is
  exactly the number this stops a reader from quoting.
- **`bun run evaluate --gaps`** prints the shortfall as a work list: for each condition, which
  scenarios have fewer than three draws and how many investigations close the gap, with a total. That
  is the input to step 5, and it turns "accumulate a baseline" into a countdown a shell loop can
  drive. Machine-readable via `--gaps --json`, because the loop that consumes it should not parse a
  table.
- **Three is the floor, not the target.** It is the smallest n at which the exact sign test can move
  off `p = 1.000` within a cell and at which §6.2's variance term means anything. It is not enough to
  separate two close models; §12 Q2 keeps repeats ahead of breadth for exactly that reason.

## 7. Contract Changes

All optional, so the 47 artifacts on disk keep parsing under `writeRunArtifact`'s outgoing `.parse`.
The band partition (§6.10), the archive read (§6.9) and the steering axis (§6.11) need **no contract
change at all** — they are `scripts/`-side readings of fields that already exist, which is why they
land in step 1 against the corpus as it stands.

| # | Change | Where | Note |
|---|---|---|---|
| 1 | `provenance?: { promptHash, submissionHash, piVersion, servedModelId?, corpus?: { anchorUtc, offsetMs, telemetryRevision, alertSetHash, queryMaxRows } }` | `InvestigationRun`, `contracts/run.ts` | Optional and additive |
| 2 | `turns?: number`, `toolCalls?: Record<string, number>`, `usage?: { input, output, cacheRead, cacheWrite, totalTokens, costUsd }` | `InvestigationResult`, `contracts/run.ts` | Fixed size. `reasoning` deliberately excluded — pi-ai documents it as a subset of `output` |
| 3 | `thinkingLevel` becomes `.optional()`; delete the `?? "medium"` | `InvestigationRunConfig`; `execute-run.ts:135` | **D12**. Optional on the contract rather than required on `RunConfig`: same defect closed, no breaking interface change into the tree PRD-5 is landing in, and `?` stays a legal condition value |
| 4 | `webSearchUsed?: boolean` | `InvestigationRunConfig` | **D14**. Derived from the tool tally, so it costs nothing once §6.7 lands |
| 5 | `CorpusIdentity` + `GET /corpus` + `getCorpus()`, and `GET /schema` / `POST /query` excluding `_`-prefixed tables | `packages/contracts`, `mock-sentinel/src/routes/`, `sentinel-client` | **D15**. This is the first addition to Mock Sentinel's public surface since it was specified, so `AGENTS.md` §9's five-route list is amended too (§6.8) |

## 8. Guards That Must Hold

1. **Ground-truth isolation is unchanged.** Everything that reads `fixtures/scenarios/` stays in
   `scripts/`. `provenance.ts` and the contract changes are agent-side and touch none of it. The
   oxlint `no-restricted-imports` rule and `ground-truth-isolation.test.ts` ROOTS need no change —
   and a test asserts that.
2. **No scored artifact is written** (§5.5). A test asserts `evaluate` creates no file.
3. **`writeRunArtifact` still parses every artifact generation.** Commit one artifact per schema
   generation under `apps/investigator/test/fixtures/runs/` (pre-`impact`, `nextAction`-era, PRD-3
   lifecycle, PRD-5 `failed`/`derivedFrom`, PRD-6 provenance) and assert against those. A test that
   sweeps the live `runs/` instead is coupled to whatever a developer last ran — the opposite of
   AGENTS.md §7 — and committing the corpus (§6.9) makes that worse, not better: the sweep becomes
   non-vacuous but grows without bound and fails on the first artifact someone's experiment leaves
   behind. The sweep stays available as `bun run evaluate --runs`, not as a test.
4. **The artifact does not grow with investigation length.** A test asserts the added fields are
   scalars or fixed-key records, and that `toolCalls` keys are a subset of the five tool names.
5. **A label never collapses two condition ids** (§6.1).
6. **The scoring path is tested.** `scripts/evaluate-runs.test.ts`, flat beside
   `scripts/reset-queue.test.ts` where PRD-5 put the convention, drives the binary through the
   existing `RUNS_DIR` override against synthetic corpora in a temp dir; nothing under `runs/` is
   touched.
7. **The agent's opening context is unchanged.** A test asserts the table-name list reaching
   `buildInitialContext` is identical before and after the corpus manifest is written (§6.8).
8. **The bands partition.** A property test over every integer `0–100` and every verdict asserts
   exactly one class accepts each value, and that no blind constant exceeds 9/14 on the loaded
   corpus. Asserted as a property, not as the literal `9` (§6.10).
9. **No run leaves the scored set.** A test writes an artifact into `<runsDir>/.archive/` and asserts
   it appears in the report and in the run-set fingerprint; a second asserts a run id present in both
   directories is counted once (§6.9).
10. **Destroying a measurement requires confirmation.** A test asserts `queue:reset --purge` without
    `--yes` refuses, and that its dry-run names the draws it would remove (§6.9).
11. **A steered run is scored and paired.** A test asserts a run carrying `analystContext` produces
    draws, lands in a condition distinct from its parent's, and that a `derivedFrom` pair differing
    by more than the premise is marked `unmatched` (§6.11).

## 9. Explicitly Out of Scope

- **Scoring `discriminatingEvidence` coverage, and any per-table tally on the artifact.** PRD-2 §23
  forbids grading the trajectory, and every one of the 487 recorded `query_security_data` calls across the 39 traces on
  disk is a distinct string, so there is no invariant to match. The slope is the real reason: once the
  artifact says *which tables* were touched, the next patch scores whether they were the right ones.
  `toolCalls.query_security_data` answers the memory question without crossing it.
- **Corpus rebalancing, difficulty weights, `cluster`/`role` markers.** Roadmap §7 (§4.5). The band
  partition moved *into* this PRD (§4.4); corpus authoring did not, and that boundary is what keeps
  PRD-4 §9's rule intact.
- **A benchmark tab in the console.** ADR 006 §5 bars the console from scoring; PRD-5 makes
  `apps/console/src` agent-side source; and §5.5 blocks the pre-scored-artifact bridge that would
  otherwise make it possible. ADR 007 settled in-process execution without lifting ADR 006 §5's bar
  on console-side scoring, so the tab stays blocked there rather than here.
- **`experimentId`, `repeatIndex`, a `baseline|steered` enum, a memory flag, `packages/bench`, a run
  store.** AGENTS.md §5, PRD-2 §24, §5.1 above.
- **A sampling pin.** There is no `seed`, `temperature` or `samplingParams` anywhere in pi-ai's type
  surface. Repeats are the only variance instrument this system can have, which is why §6.2 keeps
  them all.
- **`previousAlertIds` on the `Scenario` schema.** An alias list would let a re-pinned scenario keep
  its history (**D21**), and it is one optional array. It is also the only item this PRD would build
  ahead of a failure that has never happened, which is the standard everything else here is held to
  — and the alias cannot be backfilled anyway, since it has to be written at the moment the rule
  changes, when both ids are known. §6.5's exit-1-naming-the-unjoined-ids makes the re-pin loud when
  it first fires; add the alias then, against a concrete orphaned set.
- **Forcing `INVESTIGATOR_TRACE=true` for eval runs.** §6.7 exists so this is unnecessary.

## 10. Acceptance Criteria

1. `bun run evaluate` prints one table per **condition**, with a legend naming every recorded field,
   and no two conditions render the same label.
2. A scenario run three times under one condition prints **one cell with n=3**, its draws, its
   median and its spread. No draw is discarded.
3. A run whose alerts all failed appears in the report with its `error.name` and raises the
   denominator. `direction 1/1` is unreachable while 13 alerts failed.
4. A run-level failure (`status: "failed"`, `alertCount: 0`) appears as a condition that produced no
   draws, naming its error.
5. Every skill figure prints `covered K/N` on the same line, where N is the loaded scenario count.
6. A blind-constant baseline row prints under every report, giving its band score and its skill.
   Under the partition **no constant scores above 9/14**, asserted as a property over every constant
   and every verdict rather than as a literal, so it survives roadmap §7 rebalancing the corpus.
7. `--compare` of a terra run against a luna run prints both condition labels and a field-level
   diff, and reports `no measurable difference` when the delta is inside the noise floor.
8. Two runs differing only in `promptHash` resolve to two conditions.
9. An artifact with no `config` renders `think=?` and never merges with `think=medium`.
10. A JSON-valid artifact of the wrong shape — missing `results`, or `startedAt` — is skipped with a
    warning naming the file; the rest still score.
11. `runs.length > 0 && scored.length === 0` exits 1 and names the unjoined alert ids.
12. A run started with `INVESTIGATOR_TRACE=false` carries `usage.costUsd`, `turns` and `toolCalls`
    in its artifact.
13. A run whose `thinkingLevel` was never configured records **no** `thinkingLevel`, not `"medium"`.
14. `bun run evaluate` writes no file.
15. Every committed artifact fixture, one per schema generation, parses under `InvestigationRun`.
16. The table-name list reaching `buildInitialContext` is unchanged by the corpus manifest.
17. The three bands partition `[0, 100]`: for every integer and every verdict, exactly one class
    accepts it. `tp=60` on an inconclusive scenario is FAIL, and `band⁰` prints beside `band` so the
    cell it moved is visible (§6.10).
18. A run in `runs/.archive/` is scored, appears in the report, and is inside the run-set
    fingerprint. A run id present in both directories is counted once, with a warning.
19. The header states the artifact count, both directories read, and a fingerprint over the sorted
    run ids scored — and the fingerprint changes when the set does.
20. `runs/*.json` and `runs/.archive/*.json` are tracked by git and `runs/traces/` is not, so a
    fresh clone scores the same corpus and reports the same fingerprint (§6.9).
21. `queue:reset --purge` without `--yes` refuses, and `--dry-run` names how many scoreable draws
    across how many scenarios it would destroy.
22. A run carrying `analystContext` is **scored**, lands in a condition distinct from the baseline
    one, and renders `ctx=<hash6>` — two different premises never share a cell.
23. A `derivedFrom` run prints paired against its parent on the shared scenario, with both scores and
    a delta against the noise floor; a pair differing by more than the premise is marked `unmatched`.
24. Every cell prints its `n`, and a condition with no cell at `n>=3` says so in words.
25. `bun run evaluate --gaps` prints, per condition, the scenarios below three draws and the total
    number of investigations that would close the gap; `--gaps --json` emits the same machine-readably.
26. `bun run check` is green.

## 11. Phasing

Step 0 is a hard gate. Steps 1–4 each land green on their own and each is useful alone.

| # | What | Closes | Note |
|---|---|---|---|
| **0** | This PRD + ADR 008 + an `AGENTS.md` §14 Phase 10 entry, a §12 paragraph recording that the artifact gains `provenance`, `turns`, `toolCalls` and `usage` and that nothing added may grow with investigation length, a §9 note that the REST surface gains `GET /corpus`, and a §5 note that the run corpus is append-only and committed. **Delete roadmap §7's band bullet** — the partition moves here (§4.4) and its "none of the 21 scored runs changes verdict" claim is false once the archive is scored. Correct the stale roadmap prose in the same PR. | — | AGENTS.md §1 and §14; PRD-5 took Phase 9. PRD-4 hit exactly this and stopped to write it up rather than committing |
| **1** | **The reader.** `scripts/evaluate/{condition,scoring}.ts` + `scoring.test.ts` + `scripts/evaluate-runs.test.ts` + the rework of `evaluate-runs.ts`; the archive read and run-set fingerprint; the band partition with `band⁰` beside it; the steered-run pairing; `--gaps` | D1–D10, D18, D22 | `scripts/` only, zero producer changes, and it lands against the artifacts already on disk — which is why the bands come with it rather than after (§4.4). Needs nothing from PRD-5 and picks up `analystContext` free |
| **1b** | **Deletion is loud, and the corpus is committed.** `queue:reset --purge` gains `--yes` and a dry-run line in draws-and-scenarios; `/runs/` leaves `.gitignore` in favour of `/runs/traces/`, and the 47 artifacts on disk are committed | D18 | `scripts/reset-queue.ts` and `.gitignore` only. Separable from step 1; the `.gitignore` half is worth doing **first of everything**, because until it lands every measurement is one `--purge` or one disk failure from gone |
| **2** | **Prompt and runtime identity.** `provenance.ts`, contract items 1 and 3, `INSTRUCTIONS_LABEL` | D11, D12, D17 | Unlocks the prompt axis — and therefore steering and memory. Coordinate the `execute-run.ts` touch with PRD-5 |
| **3** | **Cost and effort.** `onMetrics`, the tool tally, contract items 2 and 4 | D13, D14 | Needs ADR 008. Independent of 1, 2 and 4 |
| **4** | **Corpus identity.** `_CorpusManifest`, the `_`-prefix exclusion, `GET /corpus`, `getCorpus()`, the anchor wiring | D15 | Widest blast radius, and the only step that touches Mock Sentinel. Worth doing before a new baseline is accumulated, not before step 1 |
| **5** | **Re-baseline.** Not code, and the actual deliverable (§1). Two matched conditions × 14 scenarios × n=3 = **84** investigations, plus **12** steered — 4 scenarios × 1 premise × n=3, paired against the baseline draws already bought — for a first reading on the analyst-context axis. 96 investigations, ~90–120 min, ~$6–18 | D22 | Unavoidable: 32 cells under an honest key, **zero at n≥3**, and **zero** steered draws of any kind. Do it after steps 2 and 3 so the runs carry a prompt hash and a cost, and drive it from `evaluate --gaps --json` (§6.12) so the countdown is the tool's, not a spreadsheet's |

Step 6, an experiment manifest and runner, is deliberately deferred to *only if driving step 5 by
hand hurts*. It adds a committed root, which AGENTS.md §5 governs, and 84 runs can be a shell loop
once.

## 12. Open Questions

1. **The terra-vs-luna claim.** `docs/roadmap.md` asserts terra-class reasoning cleared a
   calibration control luna failed, at ~10× the token price. That comparison is unmatched, and the
   matched version has now given three answers in one afternoon — terra ahead, luna ahead, and a
   3–3 tie at `p = 1.000` (§3.3). **Recommendation:** mark it unverified rather than deleting it, and
   let step 5 settle it. Running terra by default on the strength of the current number is not
   supported either way, and the third pass is the least supportive of the three: on eight matched
   scenarios the skill difference is 0.0135.
2. **Re-baseline budget.** **Recommendation:** yes, and **two conditions at n=3 rather than three at
   n=2**. With a measured 75-point spread on one scenario, n=2 cannot separate a model from a coin.
   If budget is tight, cut scenarios before cutting repeats.
3. **How hard is ADR 005 §2?** Fixed-size counters are an amendment, not a slip. **Recommendation:**
   amend, with §5.4's bright line written into ADR 008. `contracts/run.ts` already conditions the
   addition on evaluation showing a need; 47 artifacts that cannot answer the roadmap's own cost
   question is that need. The honest alternative — keep cost in transcripts and force
   `INVESTIGATOR_TRACE=true` — writes 0.16–23 MB per investigation into the loop that is supposed to
   be cheap to repeat.
4. **The report gets longer and the headline gets worse — twice over.** `terra: 10/13` becomes
   several condition tables, most reading `insufficient data`, and no condition can carry a
   14-scenario headline. The partition then takes a further draw off the corpus and three off the
   blind constant. That is a correction, not a regression, but it will be read as one.
   **Recommendation:** say so in the first paragraph; print `band⁰` beside `band` and the old band
   line beside the new skill line for at least one release (§6.10); and treat step 5 as part of the
   change rather than a follow-up, because a report that reads `insufficient data` everywhere is only
   honest for as long as it takes to fix. A `--by-model` collapse flag will be wanted; add it when it
   is asked for, not before.
5. **Ordering against PRD-5 — now settled.** PRD-5 landed while this was being written, so its
   §4.5 skip exists and step 1 deletes it rather than pre-empting it, and `config.analystContext`
   and `derivedFrom` are already on disk for the derived key to pick up. Nothing here is blocked.
   The one file both touch is `execute-run.ts`, for the `thinkingLevel` fix in step 2.
6. **The cross-model derived run — now settled into §6.11.** `01a01ea6-a5f6` is a steered re-run of a
   **luna** parent under `claude-haiku-4-5`. A `derivedFrom` pair that changes two variables at once
   measures neither. The report flags a derived pair whose condition ids differ by more than
   `analystContext` and marks it `unmatched`, rather than PRD-5 constraining what a re-run may
   change — the console stays free, and the benchmark is the thing that notices.
7. **`runs/*.json` in version control — settled: yes, and it is §6.9's design rather than an open
   question.** 47 artifacts total 200 KB, none over 5.5 KB, and step 5 adds roughly another 400 KB;
   `runs/traces/` (126 MB) stays ignored, which is what makes the split cheap. A benchmark that
   cannot be reproduced from a clone is not a benchmark, and the run-set fingerprint becomes a git
   fact rather than a local one. The accepted costs are recorded there: a working tree that goes
   dirty on every `bun run investigate`, and an amendment to `AGENTS.md` §5's repository shape. The
   alternative considered and rejected was a curated `fixtures/baseline-runs/` promoted into by a new
   command — a committed root and a workflow step to avoid a `git add`.
