## Roadmap

### 1. Durable State — Case Memory, Human Feedback, Resumable Execution

Three capabilities that were deliberately cut, consolidated because they share one obstacle: all
three need state that outlives a single investigation, and none of them is worth that state yet.
PRD-10 §3 fences all three out and sends them here.

**What was removed, and what remains.** PRD-10 Phase 0 deleted the console's analyst-feedback
capture — `apps/console/src/drive/` and the `feedback/` root — because it collected records nothing
ever read. The vocabulary it carried survived: `AnalystClassification` and the 30,000-character
Sentinel comment bound now live in `@soc/contracts` (PRD-10 §4.1 D7), so the four-value taxonomy does
not have to be re-derived from Microsoft's documentation when this is picked up. Removing `drive/`
also returned the console to having no filesystem write primitive at all.

**Case memory and tenant context.** Durable, tenant-specific context improving future
investigations without replaying previous agent conversations: curated tenant knowledge, searchable
previous investigations, human-confirmed outcomes. `scripts/evaluate/condition.ts` is already built
for it — the comparison key is derived from `config`, hashed whole, so a memory field becomes a
scoreable axis with no change there. The prompt-hash provenance in
`apps/investigator/src/provenance.ts` exists partly for the same reason.

**Human feedback.** The analyst's final verdict and corrections, fed into case memory and into
evaluation. This is the input side of the above and has no value without it — which is why PRD-10
removed the half that shipped alone.

**Resumable execution.** PRD-10 §4.1 D3 rejected a durable-execution runtime (Temporal-style
workflows, crash-resumable mid-run state) and the reason should be read before anyone adds one: a
crash mid-investigation leaves no artifact in `runs/`, so the next poll re-picks that alert. **The
idempotency key already provides crash recovery.** What a durable runtime would add is resumption
*within* a run — not restarting an investigation that died at turn 30 — which only becomes worth a
server when a single run is expensive enough that repeating it hurts.

**Before building any of it**, note that `@earendil-works/pi-agent-core` already ships the
distillation machinery: `compact`, `shouldCompact`, `generateSummary`, `DEFAULT_COMPACTION_SETTINGS`
and a `harness/session/` module. `apps/investigator/src/harness.ts` imports none of them. Whoever
picks this up should start there rather than hand-rolling compaction.

### 2. Human Feedback

**Merged into §1.** Kept as a heading because other documents cite `roadmap §N` by number and
renumbering would silently break them.

### 3. Security Schema & Context Optimization

Improve how the agent discovers and consumes large security-data schemas as environments grow.

Potential capabilities:

* Schema caching
* Schema search
* Automatic relevant-schema selection
* Context budgeting

PRD-8 raised the pressure here without triggering it. With two sources active, startup context
lists both the Sentinel workspace tables and the Defender advanced hunting table set. **PRD-8 §7 Q2
is answered: about 4,751 tokens for both table-name blocks** (37 Defender + 833 live workspace
tables), so `AGENTS.md` §15's oversized-startup-schema stop-and-ask did not fire and PRD-8 Phase 2
proceeded.

That figure supersedes the ~274 tokens first recorded in `research-defender-api.md` §9.9, which was
measured against Mock Sentinel's 23 tables where the question asks about a Sentinel *workspace*. The
correction does not change the verdict — 4,751 tokens is under half what one query result may spend,
and the live two-source run showed no ill effect — but it removes the "two small tenants" reasoning
this section previously rested on.

What it exposes instead is a signal-quality problem rather than a budget one: of those 833 workspace
tables, roughly ten held any data, so the agent is invited to query hundreds of empty ones. That, and
what `get_security_schema` costs once the agent pulls column lists, are the halves this section still
exists to solve.

### 4. Safe Web Search Harness

Strengthen the boundary between the investigation agent and untrusted public internet content.

Potential capabilities:

* Prompt-injection protection
* Explicit treatment of web content as untrusted data
* Sanitization or isolation of retrieved content
* Controlled result size and context usage
* Safe handling of malicious or adversarial web content
* Maintain a constrained search interface without exposing arbitrary network access


### 5. Assessment Contract — What the Console Cannot Show

PRD-3's console pass surfaced four gaps that no amount of rendering can close, because the data is
not in the submission. Each needs a change to `InvestigationSummarySchema`
(`apps/investigator/src/contracts/summary.ts`) and therefore its own PRD.

Potential capabilities:

* **Evidence citations.** `keyEvidence` is `string[]`. An analyst reading "one matching event in
  `solarigate_beacon_umbrella_CL`" cannot get from that claim to the query that produced it — the
  KQL is two levels away in the Activity tab with nothing linking them. Carrying the `toolCallId`
  per evidence item would make the link real. This is the capability competing products lead with.
* **An incident timeline.** Every ground-truth scenario is a sequence — `session.start →
  privilege.grant → api_token.create → mfa.factor.deactivate`, four minutes — and `whatHappened` is
  prose that happens to contain the times. Reconstructing a timeline is a core T2 artefact, and the
  console cannot derive one without interpreting query results, which AGENTS.md §10 forbids.
* **Benign True Positive.** The TP/FP split cannot express "the detection is correct and the
  activity was authorised", which is one of the most common real classifications. Microsoft Sentinel
  closes incidents on five classifications (`True Positive – suspicious activity`, `Benign Positive
  – suspicious but expected`, two `False Positive` variants, `Undetermined`). ~~Nothing in the
  current contract maps onto them, which also blocks any future write-back.~~ **Corrected
  2026-09-16 (PRD-10 §4.1 D7):** four of the five now live in `@soc/contracts` as
  `AnalystClassification`, lifted out of the console's feedback capture before it was deleted. What
  is still missing is the *agent's* ability to reach one — `InvestigationSummarySchema` remains
  TP/FP — and that is what this item is about. Write-back itself is no longer blocked: PRD-10 §4.1
  D5 publishes findings as an additive comment and deliberately sets no classification.
* **Alternative hypotheses, enumerated.** `fpReason` is a strong partial — it is already more than
  the shipping AI-SOC products expose — but the published evaluation checklists ask for hypotheses
  listed individually with the evidence that rejected each.

### 6. Console as an Operator Surface

Give the console a write path, so an analyst can act on what they are reading rather than switching
to a second terminal to do it.

Potential capabilities:

* **Browse alerts that have never been investigated.** The console currently lists runs; it cannot
  see the 148 alerts with no run against them. This means reading `/alerts` from Mock Sentinel.
* **Start an investigation for the selected alert**, and **re-run** one — the same alert, same
  configuration, to see whether the verdict is stable, which is currently a manual `bun run
  investigate --alert <id>` and a mental diff.
* **Re-run with analyst-supplied context**: "this host is a scanner", "this account belongs to a
  contractor who left last week". The agent has no way to be told something the telemetry does not
  say, and that is the most common reason a human overrules it.
* **Promote that context to memory**, so the next investigation of a related alert starts with it.

**This reverses PRD-3's central design decision, and should not be done casually.** §4.1 is "the
console reads files; it never drives the agent", and §4.2 makes the artifact and the transcript the
entire contract — which is what lets the console have no provider key, no network, and no way to
corrupt a run. Every capability above breaks one of those. PRD-3 §14 excludes all four by name.

So this needs its own PRD, and it owes answers to questions PRD-3 got to avoid:

* **Where does a run execute?** A child process the console owns dies with the console. A daemon is
  a new service, and AGENTS.md §2 has no room for one. Neither is obviously right.
* **What happens to the read-only guarantee?** It is currently absolute and testable. A console that
  writes needs a narrower claim that is still worth making — "it writes only through the
  investigator, never to `runs/` directly" is a candidate.
* **Two consoles, one runs directory.** Artifacts are flushed per alert and rewritten in place;
  nothing today arbitrates two writers.
* **Ground-truth isolation must survive.** PRD-2 §20 makes it a property of the system. A console
  that can start a run is agent-side code, and the `no-restricted-imports` rule and
  `ground-truth-isolation.test.ts` need to cover it.

Overlaps two items above rather than replacing them: analyst-supplied context is the write half of
**§2 Human Feedback**, and promoting it to something durable is **§1 Case Memory**. This item is the
surface; those two are the substance behind it.

**Implemented by PRD-5 — Console as an Operator Surface**, which answers all four questions above:
the run executes in the console process behind a supervisor (§5.1), the read-only guarantee is
replaced by an absence-of-primitive claim plus named seams (§14), two consoles are a non-problem
because no run artifact is ever written by anyone but its own run (§4.3), and `apps/console/src`
joined the ground-truth isolation `ROOTS` — load-bearing rather than hygienic, since in-process
execution makes console source agent-side source. The follow-ups formerly left in **§10** are now
complete as part of PRD-5.

### 7. Evaluation at Scale

Exercise the investigator beyond the six alerts that have ground truth, and close the verification
gaps PRD-2 left open.

Potential capabilities:

* Run the full 154-alert sweep — aggregate failure rate, cost and step-limit behaviour at scale are
  currently unknown, since every run to date has covered a single alert
* Exercise the investigation timeout, which is implemented and wired but has never fired
* Expand ground-truth coverage beyond six scenarios — **owned by PRD-4**
* ~~Fix the overlapping scoring bands.~~ **Moved to PRD-6** (§4.4, §6.10; ADR 008 §7). The claim
  that "none of the 21 scored runs to date changes verdict under it" was measured and is false once
  `runs/.archive/` is scored — one draw flips, `app-credential-added` at `tp=60`, and it read as
  true only because that run had been archived out of the set. PRD-4 §9's rule is intact: what it
  forbids is scoring changes landing with *corpus authoring*, and the partition landed with the
  other scoring changes while the corpus items below stayed here
* Score whether an investigation covered the ground its scenario says settles it. Every fixture
  carries `discriminatingEvidence` — the queries a correct investigation cannot skip — and nothing
  reads it; `scenarios.test.ts` only asserts the array is non-empty. Trace-level coverage would
  measure this, and would require eval runs to set `INVESTIGATOR_TRACE=true`. Weigh against PRD-2
  §23's rule that the trajectory must not be graded
* Widen false-positive coverage. PRD-4 found three verified benign identities — `bob.jones` and
  `jane.smith`, both now false-positive scenarios, and `deploy-svc` / `deploy-pipeline`, which is
  still unused. That is the whole supply: every rule and connector filters for adverse conditions,
  and the tables that look like baseline are the Adele compromise (PRD-4 §3). Going beyond three
  identities needs telemetry from outside the Training Lab, which amends ADR 001 and needs its own
  decision record
* Spot-check alerts that have no ground truth, to catch reasoning failures the six scenarios
  structurally cannot see
* Model-tier comparison as a product question. **Unverified** — the claim that terra-class reasoning
  cleared a calibration control luna failed, at roughly ten times the token price, rests on an
  unmatched comparison. Matched under PRD-6's condition key it has given three answers in one
  afternoon and currently reads a 3–3 tie at `p = 1.000` across 8 shared scenarios (PRD-6 §3.2,
  §3.3). PRD-6 §11 step 5 settles it; running terra by default is not supported either way until
  then

### 8. Alert Grouping and Incident Correlation

The system investigates each alert in isolation and never learns that several of them are one
incident. AGENTS.md §2 lists `alert grouping` under **Do not implement**; PRD-4's trace analysis is
the first concrete evidence for why it eventually matters.

Upstream documents the corpus's 2026 telemetry as a single ten-stage attack chain — phishing,
endpoint execution, credential dumping, Okta takeover, exfiltration, then AWS and GCP escalation.
The agent does not traverse it. Measured across the twenty traces in `runs/traces/`:

* zero of four `ransomware-srv-dc01` runs queried `OktaV2_CL`, `AWSCloudTrail`, `GCPAuditLogs` or
  MailGuard — the identity compromise that led to the ransomware was never looked at
* one of three `mirage-account-takeover` runs touched any CrowdStrike table
* each run scopes to the entity named in its own alert and stops there

Every one of those investigations is defensible on its own, and triage does work one alert at a
time — so this is not a defect in PRD-2. It is the ceiling of per-alert investigation: roughly
ninety alerts drawn from one intrusion produce ninety unrelated verdicts, and none of them says an
intrusion occurred.

Potential capabilities:

* Group alerts into incidents by shared entity, time proximity or attack chain
* Carry findings from one investigation into related ones without re-querying the same evidence
* An incident-level verdict, distinct from the per-alert verdicts that compose it
* Fold correlated duplicates rather than paying for each separately — 107 of the 154 alerts are two
  vendor views of the same 54 endpoint events, which the system currently investigates twice
* Evaluation that scores an incident rather than an alert, which needs ground truth expressed at
  incident level and therefore builds on the cluster structure PRD-4 introduces

Depends on **§1 Case Memory** for anything that carries findings between investigations, and is the
main consumer of **§7 Evaluation at Scale** — grouping is hard to justify until a sweep has shown
what the duplicate-investigation cost actually is.

### 9. Benchmarking Surface

Turn "run this scenario again" into "compare these runs", on a stable key, in the console.

PRD-5 builds the loop — a queue that marks the fourteen alerts with ground truth behind them, a key
to start one, `bun run queue:reset` to put it back, and a re-run that can carry analyst context and a
chosen model. It deliberately builds none of the comparison, and records three things so that this
work can: the scenario id, `derivedFrom`, and `config.analystContext`.

The gap it leaves is concrete. `evaluate-runs.ts` keys `latestPerScenario` on
`${model}::${scenario}` last-wins, so a scenario has exactly one row per model and every earlier run
of it is invisible — which is the wrong shape for a tool whose purpose is repetition. PRD-5 papers
over the immediate hazard with a three-line skip of runs carrying analyst context, so a steered
re-run cannot silently displace an honest one. That guard hides information rather than showing it,
and it is the first thing this work should delete.

Potential capabilities:

* Key on `${model}::${scenario}::${baseline|steered}` rather than dropping rows, so a steered run
  appears **beside** its baseline instead of in place of it, and the headline `direction N/M` is
  computed over baselines only
* Variance across repeats of the same scenario and model. PRD-4 measured one scenario swinging
  80/15/90 on the same alert and model; with one row per key, that is currently unobservable
* A benchmark tab in the console — scenarios down, models across, a cell per pair showing direction,
  impact, spread across repeats and cost. Read-only over the same artifacts `evaluate` reads
* Lineage rendering: a derived run shown under its parent with the premise that was added and the
  delta it produced, in both the console and the report
* Cost and latency as first-class columns. Model-tier comparison is a product question — terra-class
  reasoning cleared a calibration control that luna failed, at roughly ten times the token price —
  and it is currently answered by reading two reports side by side
* Whether analyst context helps. The one experiment nobody can run today: same scenario, same model,
  with and without a stated premise, scored against the same key

Depends on **PRD-5** for the queue, the reset loop and the recorded fields. Overlaps **§7 Evaluation
at Scale**, which owns the scoring-band fix and ground-truth expansion — this item assumes those
land there rather than here, and is about the comparison surface on top of them.

### 10. Completed PRD-5 Follow-Ups

These items shipped with PRD-5 rather than moving to a later console PRD: analyst-facing
classification terminology, one exported Tab traversal exception list, the
duplicate-spend warning, `queue:reset --include-feedback`, and a queue-focused `[3] Case` pane that
follows the active alert. `console --fresh` adds a non-destructive session view that hides existing
runs but shows newly launched ones. Cancellation was also exercised against a real in-flight
`openai/gpt-5.6-luna` investigation; the persisted run was `interrupted` and its active result
failed with `InvestigationAbortedError`. See PRD-5 §19 for the dated live evidence.
