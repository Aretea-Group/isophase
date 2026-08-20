# PRD-6 — Run Comparability

**Status:** Draft  
**Depends on:** PRD-2 — Core Investigation Agent; PRD-4 — Ground-Truth Expansion (the corpus this
scores against)  
**Amends:** ADR 005 §2 (the run artifact gains fixed-size counters); PRD-2 §23 (regression
infrastructure, deferred there, is built here); `AGENTS.md` §9 (the REST surface gains a sixth
route), §12 (the artifact gains counters), §14 (a new phase)  
**Builds on:** PRD-5 — Console as an Operator Surface (Complete). Its `config.analystContext`,
`derivedFrom` and run-level failure recording are the fields this scores; its §4.5 defensive skip is
deleted here  
**Would produce:** ADR 008 — The Comparability Record  
**Language/runtime:** TypeScript strict mode, Bun  
**Runtime schemas:** Zod

Research backing this document: `docs/research-run-comparability.md`. Every measurement below was
re-derived against the working tree; §3.1 records what moved between the two passes, because what
moved is itself the argument. Where the two disagree, this document is the correction.

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
times luna's token price? Does analyst context help? Would case memory help? Each is a comparison,
and the comparison machinery does not hold the variables still.

This PRD makes runs comparable. It is deliberately not a new capability: no new service, no new
package, no run store, no experiment framework. The core of it is that the comparison key is
**derived from what each run recorded** rather than assumed to be the model name, and that a cell
holds **every repeat** rather than the last one.

## 2. Product Goal

```text
today       one table per model id, one row per scenario, last write wins
            failures dropped, repeats destroyed, denominators floating
            a blind constant scores 12/14 and beats both measured models

after       one table per condition, one cell per (condition, scenario), every draw kept
            failures scored, denominators pinned to 14, coverage stated on every line
            a blind constant scores 12/14 band and -0.075 skill, printed as the baseline row
            "no measurable difference" is a result the tool can state
```

## 3. The Demonstration

Group the run artifacts by everything they actually record — provider, model, thinking level, result
budget, web-search availability, limits, submission shape, analyst context — rather than by model
name alone. Measured 2026-08-20 against the 40 artifacts then in `runs/`:

```text
7 conditions        30 cells        24 cells at n=1        6 at n=2        0 at n>=3
```

Today's two model tables are those seven conditions collapsed into two rows. Score only the runs
that genuinely share a configuration and the headline result disappears:

```text
matched: think=medium, sub=researchDone, baseline (no analyst context), 7 shared scenarios

                              truth            terra   luna    winner
adele-azure-destruction       inconclusive       99      95    luna
adele-sharepoint-exfiltration true-positive      99      99    tie
adele-signin-compromise       true-positive      99      99    tie
aws-backdoor-account          true-positive      99     100    luna
aws-bob-jones-readonly        false-positive      2      70    terra
aws-jane-smith-readonly       false-positive      4      35    terra
model-evasion-attempts        true-positive       8      65    luna

wins terra 2, luna 3, ties 2        exact two-sided sign test p = 1.000
```

The 2-scenario gap in the headline is which model happened to run under which harness generation.

### 3.1 The same comparison moved while this document was being written

Between the research pass and this one, `bun run queue:reset` archived the run holding terra's only
draw on `app-credential-added`. Restoring `runs/.archive/` and recomputing gives the before-and-after
exactly:

```text
runs/ + .archive   8 shared   terra brier 0.1373 skill +0.2675   luna 0.1356 +0.2770   wins 3-3
runs/ (today)      7 shared   terra brier 0.1555 skill +0.2426   luna 0.1340 +0.3477   wins 2-3
```

Nothing about either model changed. Removing one scenario moved terra's skill by 0.025, luna's by
0.071, and widened the gap between them **elevenfold** — from 0.0095 to 0.1051. Whichever set you
take, the ordering is decided by a single draw in a single cell.

The research note reported this pass as *terra ahead*, from a `runs/` state that can no longer be
reconstructed. That correction is not an aside — it is the finding. A benchmark whose input set can
be archived out from under it between two invocations cannot reproduce its own results, which is
**D18**, and nobody had written it down until the document disagreed with itself.

Both measurements are defensible and neither means anything, because each rests on **one draw per
cell**. That is why §6.2 makes cells hold every draw and §6.4 makes the report refuse to claim a
difference it cannot support. The sign test read `p = 1.000` on both sets; it was the only number
that did not move.

## 4. The Defects

Twenty-one, grouped by where they live. The ones marked **blocking** make a current number wrong
rather than merely absent. Line references are against the working tree at the time of writing;
`apps/investigator/src/sweep.ts` became `execute-run.ts` and `runner.ts` became
`investigate-alerts.ts` during this review, so prefer the named symbol over the line.

### 4.1 Scoring — `scripts/evaluate-runs.ts`

| # | Defect | Evidence | What goes wrong |
|---|---|---|---|
| **D1** | **blocking** — The comparison key is `model.id` alone. `provider`, `config` and `limits` are recorded and then discarded. | `:120` `model: run.model?.id ?? "unknown"`; `config` and `limits` appear zero times in the file, though `contracts/run.ts` says of `config`: *"two runs are not comparable without knowing how each was configured"* | Seven conditions render as two model rows. §2's flip is a direct consequence. |
| **D2** | **blocking** — `latestPerScenario` is last-wins, so N repeats collapse to one arbitrary row. | `:137` ``seen.set(`${row.model}::${row.scenario}`, row)`` over a list sorted only by `startedAt` | Variance — the one thing that decides whether any delta is believable — is unobservable. No count, no spread, no flag that repeats existed. |
| **D3** | **blocking** — The three bands overlap rather than partition. | `:28-30` `TP >= 60`, `FP <= 40`, inconclusive `[30,70]` | A constant `65`, issuing no queries, scores `direction 12/14`. It fails exactly the two false positives, so those two carry the metric's entire dynamic range. |
| **D4** | **blocking** — `status: "failed"` results are dropped before scoring, and from the mean. | `:114` `result.status !== "completed"` → `continue`; `error` declared `:44`, read nowhere | A model that times out on 13 of 14 and completes one prints `direction 1/1` — a perfect score — with a *better* mean latency, because the 600 s timeouts are absent from the denominator. |
| **D5** | **blocking** — Run-level failures are invisible. PRD-5 added `status: "failed"` and `error` to `InvestigationRun`; `evaluate` reads neither. | `contracts/run.ts:107,116`; artifact `01a01ea6-a5f6` is `status: "failed"`, `alertCount: 0` — an anthropic run that died on a missing credential | A whole condition can fail to start and the report says nothing. |
| **D6** | major — Every denominator floats. `direction N/M` is over *scenarios this model happened to complete*; `impact k/n` is over *artifacts new enough to carry the field*; `mean` is over surviving rows. | `:172-175` | `direction 3/3` prints under the same header as `direction 10/13`, and the `/13` is itself a moving target. luna's `impact 4/9` is a fact about artifact age, not about luna. |
| **D7** | major — The join is exact string equality against a content-addressed hash, and every way it can return nothing reports identically and exits 0. | `:95` `byAlert`; `:144-147` prints `[evaluate] no scored results` | A corpus change that orphans every run is indistinguishable from a typo'd run id. |
| **D8** | major — `--compare` is cross-model unsafe, band-only, and mislabels its columns. | `pick` at `:196` filters on `runId` and never reads `model`; columns are `runId.slice(0,8)` | Comparing terra against luna prints `FIXED`/`REGRESSED` as though one had improved. 16 of the 40 run ids share an 8-char prefix with another run — it is the UUIDv7 millisecond. Impact changes, magnitude changes inside a band, and repeats are all invisible. |
| **D9** | minor — Run files are consumed via an unchecked cast with no validation. | `:86` `(await Bun.file(file).json()) as RunFile` | A syntactically broken file is already skipped at `:87`; a JSON-valid artifact missing `results` or `startedAt` throws out of the sort or the scoring loop and takes every valid run with it. |
| **D10** | minor — Steered runs are *skipped* rather than shown. | `:108`, PRD-5 §4.5 | Deliberate and correct as a stopgap; it hides the one experiment the user most wants to run. Deleting it is this PRD's first job. |

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
| **D18** | **blocking** — `runs/` is a mutable, unversioned input set. | `runs/.archive/` holds 4 artifacts moved by `bun run queue:reset`; §3.1 | The benchmark cannot reproduce its own result across two invocations. A measured baseline evaporates silently. |
| **D19** | major — Class imbalance concentrates the metric. | 9 true-positive / 2 false-positive / 3 inconclusive; impacts 6 `confirmed-compromise`, 5 `none`, 3 `unknown`, **0 `contained`** | With overlapping bands a constant scores 12/14, failing only the two FPs. `contained` is a legal answer that no scenario tests, so an agent answering it is wrong by construction on all 14. |
| **D20** | major — Scenarios are not independent measurements. | 10 of 14 are drawn from 2 incidents and share pivot entities; the two FPs share three byte-identical discriminating queries | `direction N/14` should be read as roughly six independent items, of which two discriminate. **A memory-enabled run can lift the score by carrying one finding across four scenarios with no capability change** — the exact experiment this PRD enables is the one this defect most distorts. |
| **D21** | major — A rule edit orphans history permanently. | `startingAlertId` is a content hash over rule id and projected row (ADR 004, "Alert ids are content-addressed") | A `\| project` reorder re-pins the fixture, and every prior run for that alert becomes unjoinable — reported as D7's silent zero. |

### 4.4 What Is Deliberately Not Fixed Here

**The bands (D3) stay as they are.** The partition (`FP <= 40`, inconclusive `41–59`, `TP >= 60`) is
owned by roadmap §7 and belongs in its own PR. Landing it here would move every cell for two reasons
at once and destroy the baseline — precisely what PRD-4 §9 refused to create. Two things §7 should
know that it currently does not:

- The roadmap's claim that *"none of the 21 scored runs to date changes verdict under it"* was
  briefly false and is true again — the run that flipped (`app-credential-added` at `tp=60`) has
  since been archived. **Which is D18, not reassurance.** Re-check it against the run set of the day.
- After the partition, the best blind constant still scores **9/14**. The band fix alone does not
  restore discriminating power. The skill column (§6.3) does, which is why it belongs here and the
  partition belongs there.

**D19 and D20 are corpus authoring** and belong to roadmap §7. This PRD's obligation to them is to
make them *visible* — a report that prints `covered K/14` and a per-condition blind-constant baseline
row states its own weakness on every run.

## 5. Core Design Principles

### 5.1 The condition key is derived, never declared

The key is computed in `scripts/` by hashing what a run recorded. It is not a field on the artifact
and not an enum on a contract.

A declared taxonomy — `augmentation: ["analyst-context", "case-memory"]`, or a `conditionId` written
at run time — costs a contract edit per axis, can be computed wrongly at write time, and can never
be recomputed for the 40 artifacts already on disk. A derived key is fixed in one file and
re-applied to all history. It also means PRD-5's `config.analystContext` is picked up with **zero
code**, and a future memory field arrives free — which matters, because AGENTS.md §2 lists
cross-investigation memory under *Do not implement*, and this PRD must not build a slot for it.

### 5.2 An absent field is a value, never a wildcard

A run that did not record its thinking level renders `think=?`, and `?` never merges with `medium`.
The alternative — treating absence as "probably the default" — is how D12's fabricated `medium`
became indistinguishable from a real one.

### 5.3 Skill sits beside the bands, never instead of them

The PASS/FAIL band column is the only continuity the existing artifacts have, and the bands belong
to §7. A row reading `12/14 PASS · skill −0.075` for the blind constant is a better argument for
the partition than silently repartitioning would be.

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
  `gpt-5.6-terra · think=medium · p=a41f · sub=researchDone · corpus=9c2e · steered`.
  **A label must never collapse two distinct ids.** Measured today, two conditions share the label
  `gpt-5.6-luna · think=medium · sub=researchDone` and differ only by `webSearchConfigured` — twelve
  runs with the web available and one without. Rendering them identically is the bug this rule
  exists to prevent, and `web=off` is exactly the kind of axis a reader would never think to ask
  about.
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
CONDITIONS
  a41f  gpt-5.6-terra · think=medium · sub=researchDone · web=on · baseline      covered  7/14
  9c2e  gpt-5.6-luna  · think=medium · sub=researchDone · web=on · baseline      covered  8/14
  3d17  gpt-5.6-luna  · think=medium · sub=researchDone · web=off · baseline     covered  1/14

a41f  gpt-5.6-terra · think=medium · sub=researchDone · baseline
scenario                       truth           n  draws        med  spread  band  score  bias²+var   impact  turns  tokens    $     s
sunburst-domain-inconclusive   inconclusive    2  15, 90        52     75   FAIL  0.141  0.001+0.140   1/2      9   214k   0.31  50.4
...
skill +0.243 (ref over 7 covered) · covered 7/14 · draws 9 · failed 0 · band-dir 5/7
blind constant tp=65: band 12/14 · skill -0.075
```

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

### 6.9 Pinning the input set

`evaluate` accepts `--runs <dir>` (it already honours `RUNS_DIR`) and prints, in the header, the
number of artifacts read, the directory, and a sha256/12 over the sorted run ids it scored.

That fingerprint is what makes a reported number quotable. It does not stop `queue:reset` from
archiving a run; it makes the archiving **visible** the next time the number is reproduced
(**D18**).

## 7. Contract Changes

All optional, so the 40 artifacts on disk keep parsing under `writeRunArtifact`'s outgoing `.parse`.

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
3. **`writeRunArtifact` still parses every artifact generation.** `runs/` is gitignored, so a test
   that sweeps it is vacuous on a fresh clone and coupled to local litter on a developer machine —
   the opposite of AGENTS.md §7. Commit one artifact per schema generation under
   `apps/investigator/test/fixtures/runs/` (pre-`impact`, `nextAction`-era, PRD-3 lifecycle, PRD-5
   `failed`/`derivedFrom`, PRD-6 provenance) and assert against those. The sweep over the live
   `runs/` stays available as `bun run evaluate --runs`, not as a test.
4. **The artifact does not grow with investigation length.** A test asserts the added fields are
   scalars or fixed-key records, and that `toolCalls` keys are a subset of the five tool names.
5. **A label never collapses two condition ids** (§6.1).
6. **The scoring path is tested.** `scripts/evaluate-runs.test.ts`, flat beside
   `scripts/reset-queue.test.ts` where PRD-5 put the convention, drives the binary through the
   existing `RUNS_DIR` override against synthetic corpora in a temp dir; nothing under `runs/` is
   touched.
7. **The agent's opening context is unchanged.** A test asserts the table-name list reaching
   `buildInitialContext` is identical before and after the corpus manifest is written (§6.8).

## 9. Explicitly Out of Scope

- **Scoring `discriminatingEvidence` coverage, and any per-table tally on the artifact.** PRD-2 §23
  forbids grading the trajectory, and every one of the 487 recorded `query_security_data` calls across the 39 traces on
  disk is a distinct string, so there is no invariant to match. The slope is the real reason: once the
  artifact says *which tables* were touched, the next patch scores whether they were the right ones.
  `toolCalls.query_security_data` answers the memory question without crossing it.
- **The band partition.** Roadmap §7 (§4.4).
- **Corpus rebalancing, difficulty weights, `cluster`/`role` markers.** Roadmap §7 (§4.4).
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
   (Today that reads `band 12/14 · skill −0.075`; both figures are a function of the overlapping
   bands §4.4 hands to roadmap §7, so the criterion is the row, not the literals.)
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
17. `bun run check` is green.

## 11. Phasing

Step 0 is a hard gate. Steps 1–4 each land green on their own and each is useful alone.

| # | What | Closes | Note |
|---|---|---|---|
| **0** | This PRD + ADR 008 + an `AGENTS.md` §14 Phase 10 entry, a §12 paragraph recording that the artifact gains `provenance`, `turns`, `toolCalls` and `usage` and that nothing added may grow with investigation length, and a §9 note that the REST surface gains `GET /corpus`. Correct the stale roadmap prose in the same PR. | — | AGENTS.md §1 and §14; PRD-5 took Phase 9. PRD-4 hit exactly this and stopped to write it up rather than committing |
| **1** | **The reader.** `scripts/evaluate/{condition,scoring}.ts` + `scoring.test.ts` + `scripts/evaluate-runs.test.ts` + the rework of `evaluate-runs.ts`, plus `--runs` fingerprinting | D1–D10, D18 | `scripts/` only, zero producer changes. Lands against the artifacts already on disk. Needs nothing from PRD-5 and picks up `analystContext` free |
| **2** | **Prompt and runtime identity.** `provenance.ts`, contract items 1 and 3, `INSTRUCTIONS_LABEL` | D11, D12, D17 | Unlocks the prompt axis — and therefore steering and memory. Coordinate the `execute-run.ts` touch with PRD-5 |
| **3** | **Cost and effort.** `onMetrics`, the tool tally, contract items 2 and 4 | D13, D14 | Needs ADR 008. Independent of 1, 2 and 4 |
| **4** | **Corpus identity.** `_CorpusManifest`, the `_`-prefix exclusion, `GET /corpus`, `getCorpus()`, the anchor wiring | D15 | Widest blast radius, and the only step that touches Mock Sentinel. Worth doing before a new baseline is accumulated, not before step 1 |
| **5** | **Re-baseline.** Not code. 14 scenarios × n=3 × 2 matched conditions = 84 investigations, ~60–90 min, ~$5–15 | — | Unavoidable: 30 cells under an honest key, **zero at n≥3**. Do it after steps 2 and 3 so the runs carry a prompt hash and a cost |

Step 6, an experiment manifest and runner, is deliberately deferred to *only if driving step 5 by
hand hurts*. It adds a committed root, which AGENTS.md §5 governs, and 84 runs can be a shell loop
once.

## 12. Open Questions

1. **The terra-vs-luna claim.** `docs/roadmap.md` asserts terra-class reasoning cleared a
   calibration control luna failed, at ~10× the token price. That comparison is unmatched, and the
   matched version has now given both signs in one afternoon (§3.1). **Recommendation:** mark it
   unverified rather than deleting it, and let step 5 settle it. Running terra by default on the
   strength of the current number is not supported either way.
2. **Re-baseline budget.** **Recommendation:** yes, and **two conditions at n=3 rather than three at
   n=2**. With a measured 75-point spread on one scenario, n=2 cannot separate a model from a coin.
   If budget is tight, cut scenarios before cutting repeats.
3. **How hard is ADR 005 §2?** Fixed-size counters are an amendment, not a slip. **Recommendation:**
   amend, with §5.4's bright line written into ADR 008. `contracts/run.ts` already conditions the
   addition on evaluation showing a need; 40 artifacts that cannot answer the roadmap's own cost
   question is that need. The honest alternative — keep cost in transcripts and force
   `INVESTIGATOR_TRACE=true` — writes 0.16–23 MB per investigation into the loop that is supposed to
   be cheap to repeat.
4. **The report gets longer and the headline gets worse.** `terra: 10/13` becomes several condition
   tables, most reading "insufficient data", and no condition can carry a 14-scenario headline. That
   is a correction, not a regression, but it will be read as one. **Recommendation:** say so in the
   first paragraph, and print the old band line beside the new skill line for at least one release.
   A `--by-model` collapse flag will be wanted; add it when it is asked for, not before.
5. **Ordering against PRD-5 — now settled.** PRD-5 landed while this was being written, so its
   §4.5 skip exists and step 1 deletes it rather than pre-empting it, and `config.analystContext`
   and `derivedFrom` are already on disk for the derived key to pick up. Nothing here is blocked.
   The one file both touch is `execute-run.ts`, for the `thinkingLevel` fix in step 2.
6. **The cross-model derived run.** `01a01ea6-a5f6` is a steered re-run of a **luna** parent under
   `claude-haiku-4-5`. A `derivedFrom` pair that changes two variables at once measures neither.
   **Recommendation:** the report should flag a derived pair whose condition ids differ by more than
   `analystContext`, rather than PRD-5 constraining what a re-run may change — the console should
   stay free, and the benchmark should be the thing that notices.
