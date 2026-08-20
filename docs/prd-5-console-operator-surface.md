# PRD-5 — Console as an Operator Surface

**Status:** Complete
**Depends on:** PRD-2 — Core Investigation Agent; PRD-3 — Analyst Console; PRD-4 — Ground-Truth Expansion
**Reverses:** PRD-3 §4.1 ("the console reads files; it never drives the agent"); ADR 006 §3 (the console may not import the investigator)
**Produces:** ADR 007 — Console Control Surface
**Language/runtime:** TypeScript strict mode, Bun
**Runtime schemas:** Zod at runtime/network boundaries, TypeBox at the Pi tool boundary

Research backing this document: `docs/research-console-write-path.md`. That note recommends spawning
the investigator CLI; §5.1 below records why this PRD decides otherwise, and what changed.

---

## 1. Purpose

The console can see everything the agent has done and nothing the agent could do next.

Starting an investigation means leaving the console, typing `bun run investigate --alert <id>` in a
second terminal, and switching back to watch a directory poll. Choosing *which* alert to investigate
is worse: the console lists runs, so the 145 alerts with no run against them are invisible to it. An
analyst picks the next alert by reading a JSON payload out of `curl`.

Three consequences, all observed rather than hypothesised:

> **On the alert counts below.** Figures come from `docs/research-console-write-path.md` and predate
> PRD-4's new analytics rules; the roadmap says 154 where that note says 151. Nothing in this PRD
> depends on the exact number, but re-measure after `bun run data:bootstrap` before quoting one on
> screen — §7 requires the count to carry its caveat, and a stale count is exactly what PRD-3 §4.4
> forbids.

**The corpus is barely explored.** Across the 37 artifacts in `runs/`, 36 investigate exactly one
alert and none investigates more than one. Nothing about the console makes a second alert easier to
reach than the first.

**The most common human correction has nowhere to go.** The agent cannot be told anything the
telemetry does not say — "this host is a scanner", "that account belongs to a contractor who left
last week". PRD-4 measured one scenario swinging 80/15/90 across runs on the same alert and the same
model; there is no way to test whether a stated premise stabilises it.

**Disagreement is not recorded anywhere.** An analyst who reads a verdict and concludes it is wrong
closes the terminal. That judgement is the scarcest data this project produces and none of it is
kept.

Underneath all three is one structural fact: `apps/investigator/src/main()` is a CLI, not a callable
unit. Its 146 lines bind argv, a module-level environment singleton, a `SIGINT` handler and
`console.info` to the only code path that can start an investigation. Nothing else can invoke it
without becoming a shell.

## 2. Product Goal

```text
today       console lists 37 runs; 145 alerts invisible; starting a run means a second terminal;
            no way to state a premise; no record of analyst disagreement;
            main() callable only as a process
after       [1] is a queue of alerts with coverage state, the fourteen with ground truth marked
            and filterable; `n` starts an investigation on the selection; `e` re-runs one with an
            analyst premise and a chosen model; `d` records a classification; `bun run queue:reset`
            returns alerts to the queue so the same scenario can be run again;
            executeRun() is a function, the CLI is a 60-line adapter over it
```

**The scope line.** This PRD is an *ingest-and-rerun loop*: see the alerts worth running, run one,
put it back, run it again. It is not a measurement surface. Comparing those runs — baseline against
steered, model against model, repeat against repeat — is roadmap §9, and §4.5 records exactly what
this PRD stores so that work is possible without redoing anything here.

## 3. Why This Needs an ADR

PRD-3 §4.1 is *"the console reads files; it never drives the agent"*, and §4.2 makes the artifact
and the transcript the entire contract. That is what lets the console hold no provider key, open no
socket, and be incapable of corrupting a run. ADR 006 §3 adds that no code under `apps/console/**`
imports `apps/investigator/**`.

This PRD breaks both. It owes ADR 007, and ADR 007 owes three things the roadmap asked for:

**Where a run executes.** Decided: in the console process, behind a supervisor (§5.3). §5.1 records
the alternative and the condition that would reverse this.

**What replaces the read-only guarantee.** Not "it writes only through the investigator" — no source
scan can reason about which *path* a write targets. The replacement is an absence-of-primitive claim
plus named seams (§14).

**One correction for the record.** ADR 006 §3 justifies the import ban by saying
`apps/investigator/src/env.ts` "validates at import and throws" when a provider key is absent. It
cannot: no provider key is declared in that schema (`env.ts:37-39`) and every declared key is
`.default()` or `.optional()`, so a *missing* variable cannot throw. A malformed one still can. The
ban may be worth keeping on other grounds; that stated ground is stale. Separately, `.oxlintrc.json`
contains no `investigator` pattern, so the ban is enforced by nothing today.

## 4. Core Design Principles

### 4.1 The control surface is the contract; the topology is an implementation detail

The console depends on an `InvestigationControl` interface, never on `executeRun` directly. In-process
execution is one implementation of that interface. A spawned child or a queue worker is another, and
swapping it must not change a line of console code. This is the single decision that keeps a later
API or web surface cheap, and it costs nothing to make now.

### 4.2 The queue is a derived view, never a store

"Alerts with no run" is `listAlerts()` folded against the run artifacts already in memory. A pure
function over two things the console reads anyway. It holds no state, owns no invalidation, and is
correct across a restart for free. Introducing a queue *table* — even an in-memory one — would make
the console the owner of a truth it does not produce, and every drift bug after that is ours.

### 4.3 The investigator remains the sole writer of `runs/`

In-process execution does not change who writes. Every artifact under `runs/` and every transcript
under `runs/traces/` is written by `executeRun` and by nothing else. The console's own writes are
analyst feedback under `feedback/`, and the reset command's renames under `runs/.archive/`.

### 4.4 Analyst context is a hypothesis, never a verdict

A premise supplied by an analyst may assert environment facts the telemetry cannot show — ownership,
authorisation, business context — and may direct scope. It may not set a verdict, and a stated
verdict is a hypothesis to be tested. Collapsing this produces an agent that agrees with whatever it
is told, and an evaluation harness measuring nothing.

### 4.5 Record what a later benchmark will need; measure nothing here

This PRD builds the loop — see an alert with ground truth behind it, run it, reset, run it again —
and deliberately builds none of the comparison on top. Benchmarking models against scenarios needs a
stable key, a baseline-versus-steered distinction, and a surface to read it on; that is its own
piece of work (roadmap §9) and doing it here would make this PRD about two things.

What this PRD owes that work is only that the data survive in a comparable shape: a scenario id the
queue can display and a later report can key on, `derivedFrom` so a re-run points at its parent, and
`config.analystContext` so a steered run is distinguishable from a clean one after the fact. All
three are recorded and none is interpreted.

**One defensive exception, and it is not benchmarking.** `latestPerScenario` is last-wins on
`${model}::${scenario}` (`evaluate-runs.ts:122-128`), so without a guard the first steered re-run
silently replaces the honest row for that scenario in the existing report. `evaluate` therefore
skips runs carrying `config.analystContext` — three lines, no flag, no report change, no new
columns. It exists to stop this PRD corrupting a measurement PRD-4 just finished building, not to
start a new one. Roadmap §9 replaces it with something that shows both rows instead of hiding one.

---

## 5. Architecture

### 5.1 The decision: in-process behind a supervisor

`docs/research-console-write-path.md` recommends spawning the CLI, on the grounds that it is also the
least code. Two things in this PRD's scope reverse that.

**Flow 3 needs a model list.** The research note dropped the model picker because the list exists
only inside pi-ai (`models.getModels(provider)`), which ADR 006 §3 put out of reach. That constraint
is being lifted here, so the picker becomes buildable — and "re-run this on a different model" is
half of what flow 3 is for.

**Live events without trace files.** In the spawn design, the Stream and Transcript tabs are empty
for exactly the run the analyst just started, unless console-started runs force
`INVESTIGATOR_TRACE=true` — which then makes console-started and CLI-started runs diverge in
observability and in aggregate cost coverage. In-process, `onEvent` is a direct feed and the
divergence does not arise.

**What this costs, stated plainly.** A child process cannot take the console down; an in-process run
can. `apps/console/src/ui/app.ts:1033` installs `uncaughtException` → `process.exit(1)`, so today an
unhandled rejection anywhere would destroy the renderer and lose a paid investigation mid-flight.
The run supervisor (§5.3) reduces this to best-effort containment, not elimination. In-process runs
also do not survive quitting the console, where a spawned child would.

**The condition that reverses this decision:** if losing runs to console faults or to quit becomes a
real cost in practice, `SpawnControl` implements the same interface and the console does not change.

### 5.2 `executeRun` — the decomposition

`main()` splits into a callable core and a thin CLI adapter.

```ts
// apps/investigator/src/execute-run.ts
export interface InvestigatorConfig {
  /* the values main() reads off `env` today: sentinel url/timeout, provider, model,
     thinkingLevel, maxTurns, timeoutMs, resultMaxChars, brave settings, webFetchTimeoutMs,
     runsDir, trace, traceDir, traceStream */
}

export interface InvestigatorDeps {
  sentinel: SentinelApiClient;
  webSearch: WebSearchClient;
  webFetch: WebFetchClient;
  model: Model<Api>;
  streamFn: StreamFn;
  /** Injected so a later store is a parameter, not a rewrite. Defaults to `writeRunArtifact`. */
  write?: (directory: string, run: InvestigationRun) => Promise<string>;
}

export interface RunOptions {
  /** Caller-supplied. See below — this is not a cosmetic change. */
  runId: string;
  alertId?: string;
  analystContext?: string;
  derivedFrom?: { runId: string; alertId: string };
  onResult?: (result: InvestigationResult) => void;
  onProgress?: (run: InvestigationRun) => void;
  onEvent?: (alert: SecurityAlertResource, event: AgentEvent) => void;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export async function executeRun(
  config: InvestigatorConfig, deps: InvestigatorDeps, options: RunOptions,
): Promise<InvestigationRun>;
```

`apps/investigator/src/index.ts` keeps `parseArgs`, the `env` read, the `SIGINT` handler,
`console.info` and the exit codes, and becomes a ~60-line adapter. **CLI behaviour is unchanged.**

**`runId` is an input, not generated inside.** Today it is minted at `index.ts:99`, *after*
`resolveModel` (`:79`) and the alert fetch (`:94-97`), both of which can throw. Three things follow
from moving it to the caller, and the third is the one that matters:

1. The console knows the id of the run it started, immediately, with no marker to scan for. The
   research note's `RUN_ID=<uuid>` stdout protocol and its bounded-timeout scan disappear entirely.
2. `contracts/run.ts:86` is `z.string().min(1)`, not a UUID, so no schema change is required.
3. **A startup failure can now be recorded.** Today an unknown model, an unreachable Sentinel or a
   bad alert id produces stderr and exit 1 with *zero files* — the four most likely mistakes are
   invisible to any reader of `runs/`. With the id known up front, `executeRun` flushes a `failed`
   artifact instead. This is what makes the queue's `attempted` state honest.

### 5.3 `InvestigationControl` — the surface the TUI drives

```ts
// apps/investigator/src/control.ts
export interface InvestigationControl {
  listAlerts(): Promise<SecurityAlertResource[]>;
  listModels(): ModelChoice[];
  start(request: StartRequest): RunHandle;      // returns immediately; the run proceeds in background
  cancel(runId: string): void;
  subscribe(listener: (event: ControlEvent) => void): () => void;
  live(): LiveRun[];
}

export interface StartRequest {
  runId: string;
  alertId: string;
  model?: { provider: string; id: string };
  analystContext?: string;
  derivedFrom?: { runId: string; alertId: string };
}
```

**`ControlEvent` is a domain union, not `AgentEvent`.** Pi's event type must not cross this
boundary: `harness.ts` is the only file in the repository that imports Pi (ADR 002, ADR 005), and
handing `AgentEvent` to the console would make the console the second. The harness maps Pi's events
into a small serializable union — `run_started`, `alert_started`, `turn`, `tool_call`,
`tool_result`, `assistant_text`, `alert_completed`, `run_completed`, `run_failed` — which is also
what lets an API stream them later without redesign.

### 5.4 The run supervisor

`InProcessControl` wraps every run so that no fault inside one reaches the renderer:

- each run's promise is caught at the supervisor, and a fault marks *that run* failed and emits
  `run_failed`;
- `process.on("unhandledRejection")` is installed and attributes a rejection to the active run where
  it can, rather than letting the default policy terminate the process;
- the console's existing `uncaughtException` handler (`app.ts:1033`) is narrowed so an error
  originating inside a run does not exit — the terminal-restoration path it exists for is kept for
  everything else.

This is best-effort. An OOM or a native crash still takes the process. Say so on screen rather than
implying otherwise.

### 5.5 Modules

| Module | Role |
|---|---|
| `apps/investigator/src/execute-run.ts` | `executeRun` — the callable core (§5.2) |
| `apps/investigator/src/control.ts` | `InvestigationControl`, `ControlEvent`, `InProcessControl`, the supervisor |
| `apps/investigator/src/index.ts` | CLI adapter over `executeRun`; behaviour unchanged |
| `apps/console/src/data/alerts.ts` | the only network primitive in the console; `AlertReader` narrowing |
| `apps/console/src/view/coverage.ts` | pure: alerts × runs → coverage state |
| `apps/console/src/drive/feedback.ts` | the only filesystem write primitive in the console |
| `apps/console/src/ui/app.ts` | the overlay for flows 2–4, kept beside its focus state and key handling |
| `scripts/reset-queue.ts` | `bun run queue:reset` (§11) |

`apps/console/package.json` gains `@soc/investigator`, `@soc/sentinel-client` and `@soc/contracts` —
all existing workspace packages, no new third-party dependency.

---

## 6. Cancellation

Today `SIGINT` never cancels an investigation. `index.ts:165-173` flushes an `interrupted` artifact
and calls `process.exit(130)`; the Agent stops because the process stops, mid-`await`. A callable
seam has no process to kill, so cancellation has to be built. It is three layers:

1. **Harness.** Accept an external `AbortSignal` alongside the existing timeout timer, which already
   bridges to `agent.abort()` (`harness.ts:127-130`). The trap is the error ladder at
   `harness.ts:141-153`: an external abort does not set the local `timedOut` flag, so it falls past
   the timeout branch and lands on `errorMessage !== undefined` → `InvestigationModelError`. A
   user pressing a key would be recorded as a provider outage. A new `InvestigationAbortedError` and
   a branch above the `errorMessage` check.
2. **The per-alert loop.** `agent.abort()` stops the current investigation only; the loop in
   `investigate-alerts.ts` proceeds
   to the next alert. A signal check between alerts, so the run actually stops.
3. **Sweep.** A cancelled run flushes `interrupted`, not `completed`.

**This changes the artifact's meaning, and the change is an improvement.** Today the in-flight alert
is never recorded, because the process dies mid-await. A graceful abort records it as a failed
result with `InvestigationAbortedError`, so a cancelled run says which alert it was on.

Verified in `pi-agent-core@0.84.2`: `abort()` triggers the run's own `AbortController`
(`dist/agent.js:202-203`) and `handleRunFailure` sets `stopReason: "aborted"` (`:349-357`), so
`prompt()` resolves rather than rejects — which is what the harness's timeout branch already assumes.

---

## 7. Flow 1 — the alert queue

**Pane `[1]` becomes the queue.** Across the 37 artifacts on disk, 36 hold exactly one alert, so
"Alerts in run" is a one-row list in every run this project has produced. It is the lowest-earning
pane on screen and a 145-row queue is the highest-earning. Three boxes stay three boxes; `Focus`
stays `1|2|3|4`. Alerts within a run fold into the `[2]` row, which `view/run-list.ts:158-166`
already handles.

**Coverage is a fold, in `view/coverage.ts`, pure:** `no-run`, `in-flight`, `investigated`,
`attempted`. `attempted` — results exist and every one is `status: "failed"` — is load-bearing:
hiding a crashed investigation from the queue is the one outcome that silently loses work.
`in-flight` reads `plannedAlerts` (already shipped) plus `control.live()`.

`investigated` additionally carries a `baseline: boolean` — false when every run covering the alert
carried analyst context. This is queue honesty rather than benchmarking: without it the pane reports
an alert as handled when the only thing that ever ran against it was a steered experiment, in the
one view an analyst uses to decide what to work on next. One boolean, one glyph; it interprets
nothing and feeds no score.

**Scenario alerts are marked, and this is the pane's main job.** Fourteen of the 151 alerts have
ground truth behind them, and those are the ones worth running twice. The queue marks them with a
`◆`, and `s` filters the list down to them — which is the loop this PRD exists
to make possible: see the fourteen, pick one, run it, `queue:reset`, run it again.

**The mapping arrives as a generated artifact, never by reading the fixtures.** A generator in
`scripts/` — the one tree exempt from both ground-truth guards — emits
`fixtures/benchmark-map.generated.json` containing **ids and nothing else**:

```json
[{ "scenarioId": "app-credential-added", "alertId": "8dff45f5-e145-5576-5328-765837705a72" }]
```

No verdict, no `discriminatingEvidence`, no trap, no evaluator notes. The field is `alertId`, never
`startingAlertId` — that string is itself a forbidden needle (`ground-truth-isolation.test.ts:20-27`),
so a map using the fixtures' own field name would fail the guard it is designed to respect. The same
artifact serves `queue:reset --scenarios` (§11), so there is one mapping, generated once, with one
place to be wrong. A missing file degrades to "no markers" rather than an error, because the console
must still open with nothing configured.

**Why derived rather than read directly, and this is a consequence of §5.1.** Choosing in-process
execution makes `apps/console/src` agent-side source: the console process *is* the process the agent
runs in. Adding it to the isolation `ROOTS` therefore stops being hygiene and becomes load-bearing,
and the console must not name the fixtures at all. Ids-only in a generated file means even a bug
cannot surface a verdict.

**Read once, not on a timer.** Fetch on entering the queue and on `r`. A one-second poll against
`/alerts` is 262 KB/s over loopback forever, to watch a corpus that only changes on
`bun run data:bootstrap`.

**Naming.** `AlertStatus` is already `Unknown|New|Resolved|Dismissed|InProgress`
(`packages/contracts/src/alerts.ts:31`), so a pane headed "Open alerts" listing an alert whose own
JSON says `Resolved` is a live collision. The pane is **"[1] Alerts — no run"** and renders the vendor
status verbatim in its own column.

**Counts carry their caveat.** 107 of the 151 alerts are two vendor views of 54 events, so a bare
"145" overstates outstanding work by roughly fifty — precisely what PRD-3 §4.4 forbids. The header
states the caveat. Dedupe itself is not built.

**Degraded states**, because today 100% of console sessions run with no Sentinel at all:
`unreachable` → *"start it with `bun run dev:mock-sentinel`"*; `upstream_unavailable` → *"Sentinel is
up, Kusto is down"*; `ZodError` → *"the corpus and the console are out of step"*.

**Selection model.** Pane `[1]` addresses alerts belonging to no run, where it used to address the
selected run's alerts. The sharp consequence: `moveSelection`'s `focus === 1` branch must stop
calling `loadTrace()` (`app.ts:742-784`, the branch at `:762-769`) — a queue alert has no run and therefore no transcript, and
getting this wrong either discards the transcript of the run selected in `[2]` or leaves `[4]`
showing a stale investigation. `alertsHeight` becomes a fixed share of the sidebar rather than
content-sized (`app.ts:502`): a pane that resizes while you navigate past it moves the list under
your own keypress. `clampSelection`, `filterTarget: 1`, `copyFocused` and `helpLines` follow
mechanically.

---

## 8. Flow 2 — start an investigation

`n` on the queue selection. A confirmation overlay names the alert, the model, the Sentinel URL, the
fact that this calls a paid provider, and a duplicate-spend warning derived from data already on
screen: *"N other alerts share this `compromisedEntity` within ±1s; M have a run."* The confirm strip
defaults to **Cancel**; ⏎ confirms, ⎋ cancels, and ⎋ is never the only cancel given the ~40 ms
escape-parser latency documented at `render.test.ts:407`.

`x` cancels a running investigation from `[2]`, via `control.cancel(runId)`. **Not `c`** — that is
already the configuration screen (`app.ts:886-890`), and this PRD must not silently rebind a key an
analyst already uses.

**Display is already built.** `plannedAlerts` on the artifact and `pendingResults` /
`resultsWithPending` / `isPending` in `view/run-list.ts`, with `progressBody` in `ui/panes/main.ts`,
landed ahead of this PRD. Without them a single-alert run is a content-free row for its entire
lifetime, because `results` is empty until an alert *finishes*.

**Two things this flow must still handle.** `applyRuns` preserves selection by runId across every
poll (`app.ts:1007-1021`), so a newly started run appears without being selected and the analyst's row
shifts down under them — a one-shot `state.pendingRunId` fixes it. And an in-process run appears in
`control.live()` immediately and in `runs/` a second later via `pollRuns`: **merge by runId**, or
every started run renders twice.

**Cost.** `INVESTIGATOR_MAX_TURNS` and `INVESTIGATOR_TIMEOUT_MS` are per-investigation; there is no
count or monetary ceiling anywhere in the repository. `CONSOLE_MAX_CONCURRENT_RUNS` (default 2) and a
**one alert per start** rule — no "start a run" button in this PRD.

---

## 9. Flow 3 — extend an investigation

**This does not resume a conversation. It starts a derived new run** carrying an analyst premise and
a `derivedFrom` pointer. Resumption is mechanically available — `initialState` is a partial
`AgentState`, `AgentState.messages` is settable, `agent_end` carries the full message list — and is
still the wrong choice: it depends on `INVESTIGATOR_TRACE`, which defaults to false, and a recovered
transcript carries no system prompt, so a continuation after any prompt drift is a different agent
wearing the old transcript.

`e` opens the compose overlay with two fields: the premise, and the model.

**The model picker is in scope** because §5.1 makes `models.getModels(provider)` reachable. One
constraint on it is not negotiable: **`executeRun` takes the model as a parameter and writes that same
value into the artifact.** Today `resolveModel` (`index.ts:79`) and the artifact's `model:` field
(`:123`) read the same `env` and cannot desynchronise; a picker threaded into one and not the other
would produce an artifact that lies about which model ran — and `latestPerScenario` keys on
`${model}::${scenario}` (`evaluate-runs.ts:122-128`), so a mislabelled row silently displaces the
right one.

**Trust boundary.** The premise gets an `<analyst_context>` envelope from `buildInitialContext` and a
paragraph in `instructions.ts` beside the existing untrusted-web block, stating §4.4's rule. Envelope
delimiters are sanitised out of the embedded copy, length is capped, and the **raw** text is stored
in `config.analystContext` so the sanitisation is auditable. This closes a real hole: ADR 005 §3's
accepted injection residual is bounded by "a human still adjudicates", and analyst-pasted text
removes exactly that bound in a corpus that is 90% one phishing-led intrusion whose MailGuard alerts
carry attacker text verbatim.

**No path ever reaches agent-side code.** The console passes a string; there is no `--context-file`
and no CLI flag taking a path. This matters because today no agent-side code reads a file by a
caller-supplied path, and the ground-truth isolation test's runtime guard only fires when the literal
string "scenarios" appears inside the call — `Bun.file(args.contextFile)` would pass it. A new
isolation assertion forbids a path-parameterised read in agent-side source, so the flag cannot be
reintroduced by someone who has not read this document.

**What flow 3 owes evaluation is one defensive line, not an architecture.** `config.analystContext`
is recorded, and `evaluate` skips runs that carry it so a steered re-run cannot displace an honest
row (§4.5). Comparing a steered run against its baseline — which is the interesting question — is
roadmap §9, not this PRD.

---

## 10. Flow 4 — record a classification

`d`, deliberately not `f`, which sits one shift-key from `F` (follow) on the same screen.

```ts
AnalystFeedback = {
  schemaVersion: 1,
  runId, alertId, at,
  classification: "TruePositive" | "BenignPositive" | "FalsePositive" | "Undetermined",
  comment?: string,                      // cap 30_000 — Sentinel's own documented bound
  analyst?: string,
  agentAssessment: { tpPercent, model },  // frozen
}
```

"Wired for memory" is satisfied by three things that cost nothing: `schemaVersion`, the analyst's own
words, and a stable `(runId, alertId)` key. **Freezing `agentAssessment` is not optional** — the
record otherwise points at a file rewritten in place, and six months later would say the analyst
disagreed with a verdict that is no longer there.

**Storage: `feedback/<runId>-<alertId>.json`, a new root outside `runs/`.** `.gitignore:30-32`
documents `runs/` as regenerable developer scratch, so `rm -rf runs/` is a documented-safe action and
storing the only copy of unreproducible human judgement inside it is a straightforward error. It also
keeps *"the console never writes under `runs/`"* literally true.

**Feedback never enters the run artifact.** `executeRun` rebuilds the whole artifact from its in-memory
`collected` array at every alert boundary and never reads the file back, and `writeRunArtifact` runs
`InvestigationRun.parse`, whose `z.object` strips unknown keys — so a feedback field written by
anyone not also editing the schema vanishes with no error, mid-run.

**`evaluate-runs.ts` does not consume feedback.** An analyst label written after reading the agent's
verdict is an un-blinded opinion with an obvious anchoring path, and `BenignPositive` has no
counterpart in `ScenarioVerdict` (PRD-4 §7) so it would collapse onto `false-positive`. Promoting a
label to ground truth is a scenario-authoring act, not a console side effect.

**Flows 3 and 4 never touch.** The classification never enters the agent's context; the premise never
sets a verdict.

---

## 11. Queue reset — `bun run queue:reset`

Testing any of flows 1–3 twice on the same alert requires putting that alert back in the queue.
Because the queue is derived (§4.2), that means removing the run artifacts that cover it — which is
today a hand-written `rm` against a UUID filename the analyst has to find first.

**Archive, do not delete, by default.** A run costs real money to reproduce. Both readers use a
**non-recursive** glob — `apps/console/src/data/runs.ts:138` and `scripts/evaluate-runs.ts:80-82` are
each `new Bun.Glob("*.json")` over the runs directory — so renaming an artifact into
`runs/.archive/` removes it from the console *and* from the evaluation report with **zero code
change in either**. Transcripts move to `runs/traces/.archive/` alongside.

```
bun run queue:reset --alert <systemAlertId>   # every run covering that alert
bun run queue:reset --run <runId>             # one run
bun run queue:reset --scenarios               # every run covering a ground-truth startingAlertId
bun run queue:reset --all --yes               # everything; --yes required
bun run queue:reset --restore [...]           # move back out of .archive/
bun run queue:reset --purge [...]             # delete instead of archive
bun run queue:reset --include-feedback [...]  # apply the same operation to matching feedback
bun run queue:reset --dry-run [...]           # print the plan, touch nothing
```

Four constraints:

- **It lives in `scripts/`.** Not only because it is a dev tool: `scripts/` is the one tree exempt
  from both ground-truth guards, and `--scenarios` resolves through the same generated benchmark map
  the queue uses (§7) — which is itself produced in `scripts/`. In any other directory, reading the
  fixtures to build that map is a leak.
- **It never touches `feedback/`.** Analyst judgement is not reproducible and does not live under
  `runs/` (§10). `--include-feedback` archives it too, explicitly.
- **It refuses to operate outside the configured runs directory**, and resolves every path against
  it. A reset command that can be pointed at an arbitrary directory is a delete command.
- **The name is `queue:reset`, not `data:reset`.** `data:reset` already exists and means re-ingest
  the telemetry.

An alert covered by an archived run returns to `no-run` on the next queue refresh, with no console
change at all.

---

## 12. Layout and Interaction

PRD-3 §9 owns the console's layout and keymap. This section states only what changes, and is
deliberately as concrete as that one: the two defects this PRD is most likely to ship are a rebound
key and a focus trap, and both are avoided by writing them down rather than by care.

### 12.1 The keymap, whole

The console's consumed set today is `Ctrl-C`, `q`, `/`, `y`, `1`–`4`, `j`/`↓`, `k`/`↑`, `g`, `G`,
`[`, `]`, `c`, `?`, `F`, `r`, `⏎`, `⎋`. This PRD adds five, all currently free:

| Key | Where it applies | Action |
|---|---|---|
| `s` | `[1]` queue | filter to alerts that have ground truth, and back |
| `n` | `[1]` queue | start an investigation on the selection — opens the confirm overlay |
| `e` | `[2]` runs, `[4]` verdict | extend: re-run with an analyst premise and a chosen model |
| `d` | `[2]` runs, `[4]` verdict | record a classification |
| `x` | `[2]` runs | cancel the selected running investigation |

**`c` is not available.** It toggles the configuration screen (`app.ts:886-890`). Cancel is `x`.
`d` rather than `f`, which sits one shift-key from `F` (follow) on the same screen. No key changes
meaning, and no key gains a second meaning on a different pane except `e` and `d`, which act on
"the current run" and are inert when there is none.

`KEY_BAR` (`app.ts:143`) gains `n start` and drops nothing — it is already near a terminal width's
worth, so `⏎ expand` moves into `?` help. `helpLines()` (`app.ts:91-115`) gains the five keys, and
its last line — *"The console is read-only. Nothing here writes to runs/."* — is replaced per §13
row 12.

### 12.2 Layout

Three boxes stay three boxes. Nothing moves; `[1]` changes what it holds.

```text
┌─ [1] Alerts — no run ───────────┐┌─ [4] ────────────────────────────────┐
│ GT  sev  alert                  ││  Verdict · Activity · Transcript ·   │
│ ●   HIGH Ransomware on SRV-DC01 ││  Stream                              │
│     MED  Sign-in from 175.45…   ││                                      │
│ ●   HIGH Credentials added to…  ││                                      │
├─ [2] Runs ──────────────────────┤│                                      │
│ ✓  gpt-5.6-luna  ransomware…    ││                                      │
│ ●  gpt-5.6-luna  adele-signin…  ││                                      │
├─ [3] Case ──────────────────────┤│                                      │
│ …                               ││                                      │
└─────────────────────────────────┘└──────────────────────────────────────┘
```

`alertsHeight` (`app.ts:502`) stops being content-sized. It is currently
`min(ALERTS_MAX_HEIGHT, max(3, results.length + 2))`, which is right for a one-row list and wrong
for a 145-row queue: a pane that resizes while you navigate past it moves the list under your own
keypress. It becomes a fixed share of the sidebar, as the case pane already is, with
`RUNS_MIN_HEIGHT` still honoured so `[2]` cannot be squeezed out.

**Startup focus moves from `2` to `1`.** The queue is what the console is now opened to look at.

### 12.3 Narrow mode — the queue must survive it

**This is a defect the PRD would otherwise ship.** Below `NARROW_WIDTH` (100 columns) the sidebar
stacks and pane `[1]` is hidden outright: `alertsHeight = narrow ? 0 : …` (`app.ts:502`) and
`alertsBox.visible = !narrow` (`app.ts:526`). That is correct today, when `[1]` is a one-row list
duplicating what `[2]` already says. It is wrong the moment `[1]` is the queue, because hiding it
also removes the only route to `n` — a narrow terminal would be able to read investigations and not
start them.

**Decision: `[1]` and `[3]` swap narrow-mode behaviour.** `caseBox` is hidden narrow today
(`app.ts:457`) and `alertsBox` is not — that inverts. `[3] Case` is recoverable at any width by
focusing `[4]`, which renders the same alert facts through `alertLines`; the queue is not
recoverable at all. So narrow keeps `[1]` and `[2]`, drops `[3]`, and the queue is given at most
`ALERTS_MAX_HEIGHT` rows with `[2]` taking the remainder.

Below `MIN_WIDTH` (60) the existing "terminal too narrow" panel (`app.ts:448`) is unchanged, and
must also refuse to start a run rather than presenting an unreachable confirm overlay.

### 12.4 The compose overlay

One overlay serves flows 2, 3 and 4, because they differ only in fields:

| Flow | Key | Fields | Confirm |
|---|---|---|---|
| 2 start | `n` | none — a summary and a confirm strip | `Start` / **`Cancel`** |
| 3 extend | `e` | premise (textarea), model (select) | `Run` / **`Cancel`** |
| 4 classification | `d` | classification (select), comment (textarea), analyst (input) | `Save` / **`Cancel`** |

It is a centred `BoxRenderable` over `[4]`, not a fourth pane and not a new `Screen` — `Screen`
stays `dashboard | config | help`. **The confirm strip defaults to `Cancel` in every case**: a modal
dismissed by whatever key the analyst was already holding is theatre. `⏎` confirms, `⎋` cancels, and
`⎋` is never the only cancel, given the ~40 ms escape-parser latency documented at
`render.test.ts:407`.

For flow 2 the summary names the alert, the model, the Sentinel URL the run will be given, the fact
that this calls a paid provider, and the duplicate-spend warning from §8.

**Renderables.** `@opentui/core` 0.5.4 ships `TextareaRenderable`, `InputRenderable`,
`SelectRenderable` and `TabSelectRenderable` — verified present in the pinned package. No new
dependency, and `@opentui/keymap` is still not adopted (§17).

### 12.5 Focus — the trap, and the rule that avoids it

This is the one part of this PRD with a known landmine and a known fix, and it must be implemented
exactly.

**The defect in the library.** `Renderable`'s `set visible(value)` ends with
`if (this._focused) { this.blur(); }` — verified directly in the pinned 0.5.4 build. It blurs **only
the renderable it is called on**, with no recursion into descendants. Hiding a modal `Box` therefore
leaves its `Textarea` focused and still consuming every keystroke.

**The failure it produces is unrecoverable, not cosmetic.** The natural implementation guards the
keymap on `renderer.currentFocusedEditor !== null`. After `⎋` hides the overlay, that guard stays
true forever: `q`, `1`–`4`, `j` and `k` never reach their handlers again, and every key the analyst
presses is typed into an invisible buffer. The only exit is killing the terminal.

**The rule, in four parts:**

1. **`state.mode` is authoritative**, never renderer focus. `mode: "browse" | "compose"`. `onKey`
   branches on it before anything else, exactly as it already branches on `state.filtering`
   (`app.ts:800-816`) — which is the same pattern working correctly today for the one text input
   the console already has.
2. **Exactly two functions touch renderable focus**: `focusField(n)` and `closeCompose()`.
   `closeCompose()` blurs every field explicitly, by name, before hiding the box — it does not rely
   on `set visible` to do it. Nothing else in the codebase may call `.focus()` or `.blur()`.
3. **Tab traversal is ours.** 0.5.4 ships no focus traversal at all — no `focusNext`,
   `focusPrevious` or `tabIndex` anywhere in its public types, verified. `Tab` and `Shift-Tab` move
   between fields via `focusField`, and join a stop-propagation exception list held in **one
   exported array** so a test can assert it exhaustively.
4. **`⎋` always exits compose**, from any field, in one press — it is checked in the `mode ===
   "compose"` branch before any field handler sees it.

A test opens the overlay, hides it, and asserts that a subsequent `q` still reaches the quit
handler. That single assertion is the regression guard for the whole class.

### 12.6 Colour and state

PRD-3 §9.8's rule holds unchanged: **colour never carries meaning on its own**, because these panes
get screenshotted into tickets and read on projectors. Every new state gets a glyph in `view/`, and
`ui/theme.ts` maps meaning to colour in one place through `toneColor`.

The queue's coverage states reuse the existing palette and the existing `RUN_GLYPH` vocabulary
(`view/run-list.ts:14-19`) rather than inventing a second one:

| Coverage state | Glyph | Tone | Reads as |
|---|---|---|---|
| `no-run` | ` ` | — | nothing has been tried |
| `in-flight` | `●` | `running` | a run has it now |
| `investigated` | `✓` | `ok` | a completed investigation exists |
| `investigated`, `baseline: false` | `✓·` | `dim` | only steered runs — see §4.5 |
| has ground truth | `◆` | `accent` | an answer exists for this alert; **not what it is** |
| `attempted` | `✗` | `failed` | every run against it failed |

The `◆` column is toned `accent` and blank for every alert with no ground truth. **It is a marker,
never the id** — see §19. No new colour is added to `COLOR`.

### 12.7 What this section does not change

`Focus` stays `1|2|3|4`. `Screen` stays `dashboard | config | help`. `visibleRuns()`,
`currentRun()`, `loadTrace()`, `resolveTracePath`, the transcript index, the tail, and both pollers
are untouched, as is the whole `[2]`/`[3]`/`[4]` path for a selected run. The renderer stays behind
`ui/`; `data/` and `view/` stay pure and snapshot-testable.

---

## 13. Contract changes

| # | Change | Where | Backward compatibility |
|---|---|---|---|
| 1 | `runId` becomes an input to the run | `execute-run.ts`, `index.ts:99` | Internal. `contracts/run.ts:86` is `z.string().min(1)`, so no schema change |
| 2 | `status` gains `failed` | `contracts/run.ts:98`; **and a `failed` branch in `classifyRun`** (`view/run-list.ts:63-78`) | Additive to the enum. Lets a startup failure be recorded (§5.2). A *cancelled* run reuses `interrupted` — it is the same thing. The console's mirror is already lenient (`data/runs.ts:46`, `:62` are `z.string().optional()`), so the artifact parses — but `classifyRun` has no `failed` case and falls through to `traceGrowing === true ? "running" : "completed"`, so without the branch a startup failure renders as a **completed** run, which is the exact opposite of this change's purpose |
| 3 | `error?: {name, message}` on `InvestigationRun` | `contracts/run.ts` | Optional, additive. `status: "failed"` says a run died before investigating anything; this says why. Distinct from `InvestigationResult.error`, which is one alert failing inside a run that ran. Without it AC2's "an error naming the model" has nowhere to live |
| 4 | `derivedFrom?: {runId, alertId}` | `contracts/run.ts`; lenient mirror in `data/runs.ts` | Optional, additive. A derived run **must** get a fresh runId: transcripts are keyed `<runId>-<alertId>` and opened with `appendFileSync`, so reusing one concatenates two transcripts and double-counts cost |
| 5 | `analystContext?: string` in `InvestigationRunConfig` | `contracts/run.ts:78`; a row in `view/config.ts` | Optional. Storing the **raw** text is what makes the sanitisation auditable and lets `evaluate` detect a seeded run |
| 6 | `buildInitialContext(alert, tableNames, analystContext?)` + `<analyst_context>` envelope + one `instructions.ts` paragraph | `context.ts`, `harness.ts`, `instructions.ts` | Optional third argument. Arrives as a user turn, not a sixth tool, so AGENTS.md §10's five-tool surface is unchanged |
| 7 | `evaluate-runs.ts` skips runs carrying `config.analystContext` | `evaluate-runs.ts:47-52` (`RunFile`), `:96-101` | Three lines, no flag, no report change. Existing invocations produce byte-identical output, since no current artifact carries the field. Purely defensive (§4.5); the real design is roadmap §9 |
| 8 | `fixtures/benchmark-map.generated.json` + its generator | `scripts/generate-benchmark-map.ts`, wired into `bun run data:manifest` | New generated artifact carrying **ids only** — `{scenarioId, alertId}` and nothing else. Field is `alertId`, never `startingAlertId`, which is a forbidden needle in `ground-truth-isolation.test.ts:20-27`. Absent file degrades to "no markers", never an error |
| 9 | `AnalystFeedback` schema + `feedback/` root | producer schema in contracts; lenient mirror in `data/feedback.ts`; writer in `drive/feedback.ts` | New directory outside `runs/`, invisible to `readRuns` and the evaluate loader by construction |
| 10 | Console env: `CONSOLE_MAX_CONCURRENT_RUNS` (2), `FEEDBACK_DIR`, `RUNS_ARCHIVE_DIR` | `apps/console/src/env.ts` | Every key still defaulted, none required — the console must still open a two-week-old run with no environment at all |
| 11 | `queue:reset` script entry | root `package.json` scripts | Additive; `data:reset` keeps its existing meaning (re-ingest telemetry) |
| 12 | Guarantee text: the console is no longer read-only | `app.ts:115`, `app.ts:475`, `apps/console/src/index.ts:17-18`, `render.test.ts:83`, `render.test.ts:297` | The header badge becomes state-dependent rather than a live count: 107 of 151 alerts being two views of 54 events makes any bare count the least honest number available in the most authoritative position on screen |

---

## 14. Guards that must hold

The read-only guarantee is replaced by an absence-of-primitive claim plus named seams, which is
strictly stronger than "it writes only through the investigator" because no source scan can reason
about which path a write targets:

> `apps/console/src` contains no filesystem write primitive except in `drive/**`, and no network
> primitive except in `data/alerts.ts`. Every byte the console writes lands under `feedback/`; it
> never writes under `runs/`. `executeRun` remains the sole writer of `runs/*.json` and
> `runs/traces/**`. The console reaches Mock Sentinel only through an `AlertReader` narrowed to
> `listAlerts` and `getAlert` — never Kusto, never ad-hoc KQL. No file under `apps/console/src` names
> a provider credential variable.

```ts
export type AlertReader = Pick<SentinelApiClient, "listAlerts" | "getAlert">;
```

The narrowing is load-bearing rather than tidy: `SentinelApiClient` also exposes `query(kql)` and
`getSchema()`, and handing `data/` the whole client compiles ad-hoc KQL into the console from the
first increment.

Four gates. **Two pass today against unchanged source**, which is why they land before any write code
exists — they then go red on the first write anyone adds, forcing the seam to be named in a diff:

1. `apps/console/test/write-isolation.test.ts` — call-syntax regexes over `apps/console/src`, with
   `drive/**` and `data/alerts.ts` excluded per-pattern. It must not copy
   `ground-truth-isolation.test.ts`'s substring style: `"truncate"` hits the console's own text
   helpers in eight files, and `/fetch\s*\(/` hits `ui/panes/main.ts:218`. Run call checks against
   comment- and string-stripped text.
2. `ground-truth-isolation.test.ts` — `ROOTS += "apps/console/src"`. Console source contains zero
   forbidden needles and 19 `.ts` files, so it clears the guard-the-guard floor on its own.
   **In-process execution makes this load-bearing rather than tidy**: under §5.1 the console process
   is the process the agent runs in, so console source is agent-side source. This is also why the
   benchmark mapping is a generated ids-only artifact (§7) rather than a read of `fixtures/`.
3. A new isolation assertion: **the investigator** contains no path-parameterised file read — a
   `Bun.file(` or `readFile(` whose argument is not a string literal (§9). Scoped to
   `apps/investigator/src` rather than to every root, because the console reads run artifacts and
   transcripts by paths it computes from its own configuration — that is its job, and those paths
   come from the console's env, never from a model or an operator. The investigator is the tree
   where a handed-in path would reach the agent. Run against comment-stripped text, so the rule can
   be documented in the file that enforces it.
4. Seam unit tests over the pure parts of `drive/`: `feedbackPath` by path-traversal cases, and the
   reset command's path resolution by hostile inputs. This gate exists precisely because gate 1 must
   exclude `drive/**` — the one directory that can do harm.

Note what is **not** claimed: that the console process holds no credential (it does, and now uses
it); that a crashed console cleans up (best-effort, §5.4); or that an operator cannot leak the answer
key by typing it into the premise field. The residual on the last one is that
`config.analystContext` is recorded, so contamination is visible after the fact, and seeded runs are
excluded from the default report.

---

## 15. Acceptance criteria

- [x] **AC1** — Given the existing CLI invocation `bun run investigate --alert <id>`, When it runs
      after `main()` is decomposed, Then its stdout, exit code and written artifact are unchanged
      from before the decomposition. _(test: integration)_
- [x] **AC2** — Given a `InvestigatorConfig` naming an unknown model, When `executeRun` is called with a
      supplied `runId`, Then a `runs/<runId>.json` exists with `status: "failed"` and an error
      naming the model — rather than the zero files produced today. _(test: integration)_
- [x] **AC3** — Given an artifact with `status: "failed"`, When the console lists runs, Then it is
      classified `failed` and not `completed`, and it is not silently dropped into `unreadable`.
      _(test: unit)_
- [x] **AC4** — Given a running investigation, When `control.cancel(runId)` is called, Then the
      run stops before the next alert, the artifact is flushed `interrupted`, and the in-flight
      alert is recorded as a failed result with `InvestigationAbortedError` — not
      `InvestigationModelError`. _(test: integration)_
- [x] **AC5** — Given a set of alerts and a set of run artifacts, When `coverage()` folds them, Then
      an alert whose only run has every result `status: "failed"` is `attempted`, not
      `investigated`. _(test: unit)_
- [x] **AC6** — Given Mock Sentinel is not running, When the queue pane is opened, Then it shows a
      degraded banner naming `bun run dev:mock-sentinel` and the console remains fully usable for
      historical runs. _(test: unit)_
- [x] **AC7** — Given focus on the queue pane, When the selection moves, Then `loadTrace()` is not
      called and the transcript of the run selected in `[2]` is still displayed. _(test: unit)_
- [x] **AC8** — Given `fixtures/benchmark-map.generated.json`, When it is generated, Then it
      contains only `scenarioId` and `alertId` pairs, names no forbidden needle, and every
      `alertId` resolves to a live alert. _(test: integration)_
- [x] **AC9** — Given the queue pane and a generated benchmark map, When `s` is pressed, Then the
      list filters to the fourteen alerts with ground truth and each shows a neutral marker; and
      given the map file is absent, Then the queue opens with no markers and no error.
      _(test: unit)_
- [x] **AC10** — Given an alert whose only covering run carried analyst context, When coverage is
      folded, Then it is `investigated` with `baseline: false`. _(test: unit)_
- [x] **AC11** — Given a terminal narrower than `NARROW_WIDTH`, When the console renders, Then the
      queue pane is visible and `n` is reachable, and `[3] Case` is the pane that hides.
      _(test: unit)_
- [x] **AC12** — Given a queue selection, When `n` is pressed and confirmed against an injected fake
      control, Then a run appears in `[2]` within one poll, is selected, and is rendered exactly
      once despite also arriving via `pollRuns`. _(test: e2e)_
- [x] **AC13** — Given the compose overlay has been opened and then closed with `⎋`, When `q` is
      pressed, Then the quit handler runs — the keymap is not captured by a hidden field.
      _(test: unit)_
- [x] **AC14** — Given the full keymap, When asserted against the consumed-key set, Then no key
      carries two meanings on the same pane, `c` still opens configuration, and the Tab
      stop-propagation exception list matches the exported array exactly. _(test: unit)_
- [x] **AC15** — Given an in-process run whose harness throws an unhandled rejection, When the
      supervisor observes it, Then the run is marked failed, `run_failed` is emitted, and the
      console process does not exit. _(test: integration)_
- [x] **AC16** — Given a re-run started with model B while the console's env names model A, When the
      artifact is written, Then `model.id` is B in both the resolved model and the recorded field.
      _(test: unit)_
- [x] **AC17** — Given analyst context containing an `<analyst_context>` delimiter, When it is
      embedded, Then the delimiter is sanitised in the prompt and the raw text is preserved in
      `config.analystContext`. _(test: unit)_
- [x] **AC18** — Given a run carrying `config.analystContext`, When `bun run evaluate` runs, Then
      that run is skipped and the honest run for that model and scenario is still the reported row;
      and given no run carries the field, Then the report is byte-identical to today's.
      _(test: integration)_
- [x] **AC19** — Given a completed investigation, When `d` records a classification, Then
      `feedback/<runId>-<alertId>.json` is written with a frozen `agentAssessment`, and re-reading
      the run artifact shows it unmodified. _(test: integration)_
- [x] **AC20** — Given a run artifact covering alert X, When `bun run queue:reset --alert X` runs,
      Then the artifact and its transcript are under `runs/.archive/` and `runs/traces/.archive/`,
      `readRuns` no longer returns it, `evaluate` no longer scores it, and X is `no-run` on the next
      queue refresh. _(test: integration)_
- [x] **AC21** — Given `bun run queue:reset --restore --alert X`, When it runs after AC20, Then the
      artifact and transcript are back in place and byte-identical. _(test: integration)_
- [x] **AC22** — Given `bun run queue:reset` with any argument that would resolve outside the
      configured runs directory, When it runs, Then it either refuses or contains the path inside
      that directory, and never touches anything beyond it. _(test: unit)_
- [x] **AC23** — Given `apps/console/src` with `drive/**` and `data/alerts.ts` excluded, When
      `write-isolation.test.ts` scans it, Then no filesystem write, subprocess spawn or network
      primitive is found. _(test: unit)_
- [x] **AC24** — Given `ROOTS` extended with `apps/console/src`, When
      `ground-truth-isolation.test.ts` runs, Then it passes, including the guard-the-guard file-count
      floor. _(test: unit)_
- [x] **AC25** — Given `apps/investigator/src`, When scanned with comments stripped, Then no
      `Bun.file(` or `readFile(` call takes a non-literal argument. _(test: unit)_

---

## 16. Phasing

Each increment is independently shippable and each has an exit criterion. Stopping after any one
leaves the repository in a coherent state.

**Increment 0 — guards, before any write code exists.** Gates 2 and 3 from §14 against unchanged
source — gate 1 needs `data/alerts.ts` to exist and gate 4 needs `drive/`, so both land with the
increments that create them — plus the latent `loadTrace` early-return bug (`app.ts:376-380` neither clears
`state.alertFacts` nor calls `render()` — invisible today, visible the moment a queue selection
exists). *Exit: AC24 green, `bun run check` green, no behaviour change.*

**Increment 1 — the decomposition.** `executeRun`, caller-supplied `runId`, injectable writer, the
`failed` status, and cancellation (§6). The CLI is a thin adapter. No console change at all. *Exit:
AC1, AC2, AC4 green.*

**Increment 2 — the queue, still write-free.** `scripts/generate-benchmark-map.ts` and the ids-only
map, `data/alerts.ts`, `view/coverage.ts`, the `GT` column and `s` filter, the selection model,
the narrow-mode swap and the coverage glyphs (§12.2, §12.3, §12.6), degraded states, the count
caveat. The console still writes nothing and starts nothing; only
`apps/console/src/index.ts:17-18`'s "never calls Mock Sentinel" changes. **This is the increment to
protect if scope is cut.** *Exit: AC3, AC5–AC11 green.*

**Increment 3 — the control surface and flow 2.** `control.ts`, the supervisor, the compose overlay
with the focus rules of §12.5 — `state.mode`, the two focus functions, the Tab exception array —
`n` and `c`, the `pendingRunId` fix, the live/`runs/` merge, the concurrency cap, the guarantee text.
*Exit: AC12–AC15 and AC23 green.*

**Increment 4 — flows 3 and 4, plus reset.** The model picker, the `<analyst_context>` envelope and
sanitisation, `derivedFrom` and `config.analystContext` through both mirrors, `e`, `drive/feedback.ts`
and `d`, `scripts/reset-queue.ts`, and the three-line `evaluate` skip (§4.5) — not the benchmark
architecture, which is roadmap §9. *Exit: AC16–AC22 and AC25
green.*

`queue:reset` is listed last but has no dependency on flows 3 or 4 — pull it forward into increment 2
if the test loop starts hurting before then, which it likely will.

---

## 17. Explicitly out of scope

- **Benchmarking, and the ground-truth architecture behind it.** No baseline-versus-steered
  comparison, no scoring changes, no lineage report, no benchmark tab. This PRD records a scenario
  id, `derivedFrom` and `config.analystContext` and interprets none of them (§4.5). The one
  `evaluate` change is a three-line defensive skip so a steered run cannot corrupt the existing
  report — it is not the design, and roadmap §9 replaces it. **This is the deliberate split: the
  queue is an ingest-and-rerun loop, benchmarking is a measurement surface, and conflating them
  would make this PRD about two things.**
- **A queue store.** No database, no table, no persisted work-item state. §4.2. The one thing a
  derived view can never hold is analyst triage state — "I looked at this and it is not worth
  running". If that is wanted it is a small additive side file in the pattern `feedback/` sets, not
  a redesign.
- **A web UI or an HTTP API.** `InvestigationControl` is designed so one is cheap later; none is
  built here.
- **Cross-investigation memory.** Flow 4 **records and does not consume**. Promoting analyst context
  to something durable is the substance behind this surface, and it is a separate PRD.
- **Sweeps from the console.** One alert per start.
- **Conversation resumption**, `steer()` / `followUp()`, and Pi's `AgentHarness` — the last throws
  `HarnessNotImplemented` at the pinned 0.84.2 for every method. Re-check on upgrade.
- **Alert grouping / dedupe.** `vendorOriginalId` is broken in the vendored CSV, so any dedupe would
  be a corpus-fitted heuristic. The count carries its caveat instead (§7).
- **Analyst labels as ground truth.** §10.
- **A per-run cost meter.** The concurrency cap is the only ceiling this PRD adds.
- **A second pre-1.0 dependency.** `@opentui/core` 0.5.4 already exports `TextareaRenderable`,
  `InputRenderable`, `SelectRenderable` and `TabSelectRenderable` from the bare specifier the console
  imports today. `@opentui/keymap` is not adopted — ADR 006 §2's stated reason for rejecting it (a
  hard React/Solid peer) is wrong at 0.5.4, where those peers are optional, but rewriting `onKey`,
  the highest-risk file in the console, in the same PRD that adds a write path is not a trade worth
  making.

---

## 18. Open questions

1. **On quit with a live in-process run: block, kill, or warn?** In-process runs cannot survive quit,
   so the choice is between a confirmation naming the count and a silent kill. Recommendation: a
   one-line confirm on `q`. If losing runs to quit turns out to hurt, that is the signal to implement
   `SpawnControl` (§5.1) rather than to add machinery here.
2. **Should console-started runs force `INVESTIGATOR_TRACE=true`?** In-process, live events reach the
   console without it, so the tabs are populated either way — but with tracing off there is no
   durable transcript for a run the analyst may want to re-read tomorrow, and aggregate cost coverage
   stays partial. Lean yes, and say so on screen.
3. **`--restore` semantics when the same alert has several archived runs.** Restore all, or the most
   recent? Recommendation: all, since the archive is per-run and selective restore is what `--run`
   is for.
4. **Feedback: one file per `(runId, alertId)` with last-write-wins, or full correction history?**
   Recommendation: per-subject. Both PRD-3 §14's "system of record" objection and roadmap §2's word
   "corrections" cut toward history.
5. **Does the `[2]` pane need ⏎-expansion into a run's alerts before runs arrive?** With `[1]`
   given to the queue, `resultIndex` loses its pane. For 36 of 37 runs on disk it pins at 0 and
   nothing is lost; multi-alert runs lose per-alert selection until `[2]` rows expand.

---

## 19. What Changed During Implementation

Recorded as PRD-4 §11 does, so the document and the code do not silently diverge. Increments 0–4 are
built; every item below was found by building rather than by reading.

**Gate 3 was scoped down, because it could not hold as written (§14).** "Agent-side source contains
no path-parameterised file read" fails immediately against `apps/console/src`: the console reads run
artifacts and transcripts by paths it computes from its own configuration, which is its entire job.
Scoped to `apps/investigator/src` — the tree where a handed-in path would actually reach the agent —
and run against comment-stripped text so the rule can be documented in the file that enforces it.
`AC25` narrowed to match.

**Increment 0 cited a gate that cannot exist yet.** It listed gates 2 and 4; gate 4 tests `drive/`,
which increment 4 creates. Corrected to gates 2 and 3, the two that scan unchanged source.

**`InvestigationRun` needed an `error` field** (§13 row 3). `status: "failed"` says a run died
before investigating anything and there was nowhere to say why, so AC2's "an error naming the model"
had nothing to bind to.

**`resolveModel` moved inside `executeRun`.** AC2 is unsatisfiable if the caller resolves the model
first — the failure happens before the run is entered and no artifact can be written. Moving it in
also makes §9's anti-desync requirement structural rather than a matter of discipline:
`config.modelId` is the single source for both the model that runs and the model the artifact
records. `deps.resolveModel` is the test seam.

**The queue pane is titled `[1]`, not `[4]`.** §7 inherited "[4] Alerts — no run" from a draft in
which the queue was a different pane. It *is* pane `[1]`; the title now says so.

**The sidebar shares were rebalanced, and the pending count moved.** A 50% case pane plus a 40%
queue left the runs pane below its floor, which a render test caught. Now case 30%, queue 35%, runs
the remainder above `RUNS_MIN_HEIGHT`. The pending-alerts count moved from the `[1]` title to `[2]`,
because it describes a *run* and `[1]` no longer shows one.

**`render()` guards on `closed`.** An async load — the alert corpus, a transcript, a control event —
can resolve after the renderer is destroyed, and OpenTUI throws `TextBuffer is destroyed` rather
than ignoring it. In tests that surfaced as failures in *other files*, because a stray interval
outlives the app that created it.

**The console does not construct the agent's tool clients.** An earlier cut had
`apps/console/src/index.ts` importing `BraveSearchClient` and `HttpWebFetchClient` from the
investigator, which is a wider seam than §5.5 describes. `InProcessControl` now builds them from a
`web` config block, and `@soc/investigator` exports `./control` and `./run` only.

**Three PRD-3 tests encode behaviour this PRD changes**, and were updated rather than relaxed: `/`
now filters whatever pane has focus and the console opens on the queue, so the two run-list filter
tests select `[2]` first; and the in-flight assertion moved from the word "running" — which came
from pane `[1]`'s per-alert row — to `0/1 done` and the `[2]` pending count, where the same fact now
lives.

**`within()` contains rather than refuses an absolute segment.** `join(base, "/etc/passwd")` folds
the leading slash into the root, so the path lands inside `runs/` instead of escaping. Containment
is the property that matters and the behaviour is safe, but AC22 said "refuses and writes nothing",
which overstated it — reworded, and the test asserts the containment explicitly so that swapping
`join` for `resolve` later would go red rather than silently becoming a real escape.

**Verified end to end against live infrastructure**, not only by unit test: a CLI run on one alert
with `gpt-5.6-luna` (37.3 s, TP 95%, transcript written, scored by `bun run evaluate`); the console
queue fetching the live corpus, folding coverage and filtering to ground truth with `s`; and the
full `queue:reset --alert` → alert returns to `no-run` → `--restore` loop. The console queue case is
kept as `apps/console/test/integration/queue.test.ts`, which probes for Mock Sentinel and skips with
a printed reason when it is absent, as the other integration suites here do. It deliberately does
not start an investigation — that calls a paid provider, and a test suite is not a place to spend
money.

**`sweep` was renamed to `run` throughout the code.** The artifact type was already
`InvestigationRun`, the id `runId` and the directory `runs/`, so "sweep" was the outlier inside its
own file — `execute-run.ts` exported `RunStatus`, not `SweepStatus`. Now: `executeRun` in
`src/execute-run.ts`, with `InvestigatorConfig` (standing setup — model, limits, directories, reused
for the process lifetime) split from `RunOptions` (per invocation — runId, alertId, premise,
callbacks). Deliberately **not** `RunConfig`, which would have sat beside `contracts/run.ts`'s
`InvestigationRunConfig` meaning the opposite thing (input versus the recorded subset); and
deliberately not `src/run.ts`, which would have been ambiguous next to `run-artifact.ts`. Shipped
PRDs and ADRs keep the old word: they are dated records of what was decided, and editing them to
match a later vocabulary would make them lie.

**`runner.ts` followed, because leaving it would have undermined the rule.** With "run" meaning the
batch, a function called `runAlerts` that performs the *per-alert* loop uses the outer unit's verb
for the inner unit's job — the sharpest remaining decoy. It is now
`investigate-alerts.ts` / `investigateAlerts` / `InvestigateAlertsOptions`, giving the ladder
**`executeRun` → `investigateAlerts` → `harness.investigate()`**, where each rung is named for the
unit it operates on. Moved with `git mv` so the rename shows in history rather than as a delete and
an add. It is the one committed file this rename touches; PRD-3 §10.2 and ADR 006 §4 still say
`runner.ts`, and are left as written for the reason above.

**Driving the flows by keypress found four defects that no unit test would have.** The overlay had
never rendered until `apps/console/test/drive.test.ts` existed; running it against a real model then
found the rest.

1. **`state.status` was set in five places and rendered in none.** It exists precisely because
   `state.notice` is cleared by the next keypress, so a failed start needs something durable —
   and every one of those messages was being silently discarded. The key bar now falls back
   notice → status → keys.
2. **The model picker offered a wishlist, not a capability.** `buildModels()` registers openai,
   anthropic and google so the provider is a configuration choice rather than a code change — which
   made the raw catalogue a list of every model those three vendors publish, regardless of whether
   this machine holds a key for any of them. Two bugs fell out of that: the picker defaulted to
   index 0, alphabetically an Anthropic model, so `e` + confirm silently switched provider; and
   choosing any unconfigured entry produced a run that died at `resolveModel` having spent a start.

   `listModels()` is now `listAvailableModels()`, filtered by `getAuth` — the same predicate
   `resolveModel` uses, so "offered" and "runnable" cannot drift apart — probed once per provider
   rather than once per model. On this machine that is 38 openai models and nothing else, where the
   old list offered all three catalogues. It is async, so the console caches it in `state.models` at
   startup beside the alert corpus rather than probing credentials on every draw. With no provider
   configured at all the overlay says *"no provider credential configured — this run would fail"*
   instead of presenting an empty field. The picker also opens on the *configured* model, since
   flow 3 is "the same alert, same configuration".

   The `n` overlay checks the same list: it used to print `INVESTIGATOR_MODEL` unconditionally, so
   it would present a paid confirmation for a model there was no key for and let the analyst learn
   about it from a failed artifact. It now says *"not available with the configured credentials"*
   and replaces "This calls a paid provider" with "This run would fail before it investigates
   anything". `state.modelsLoaded` separates "the probe has not finished" from "nothing is
   runnable", so a slow probe never renders as a missing credential.
3. **The compose overlay rendered under the selected run's title and tab strip**, so a modal about a
   *queue* alert appeared to belong to whatever run was selected. `mainTitle()` and the tab strip
   now yield to compose.
4. **The console waited for `run_started` to learn about a run it had just started synchronously.**
   A control implementation that did not emit would leave the run invisible and therefore
   unselectable, uncancellable and unextendable. `confirmCompose` now takes `control.live()`
   immediately.

Defect 2 produced a useful accident: the derived run failed at `resolveModel` and left a `failed`
artifact naming the cause, which is AC2 working in the wild rather than in a test.

**The queue leaked the answer key, and the pane title was false.** Both found by looking at the
rendered pane rather than at the code.

- **The `◆` column used to print the scenario id.** §7 claimed "that an alert has an answer behind it
  is not the answer" — untrue of this corpus. Eleven of the fourteen ids encode their verdict:
  `sunburst-domain-inconclusive` states it outright, `aws-backdoor-account` / `ransomware-srv-dc01` /
  `mirage-account-takeover` say true-positive, `aws-bob-jones-readonly` says false-positive. Painting
  those down the triage pane hands the analyst the verdict before they open the alert, and stops the
  queue reading like the vanilla alert list Sentinel would show. It is a neutral `◆` now. The
  integration test asserts no scenario id appears anywhere in the queue pane — deliberately keyed on
  the ids rather than on words like "backdoor", which legitimately appear in alert display names
  because the corpus really does contain an account called `backdoor-svc`.
- **The pane was titled "Alerts — no run" while showing alerts that had runs**, marked `✓` — a
  contradiction visible in the first screenshot anyone took. It now reads `[1] Alerts — 137/151 no
  run`, which is the useful number, and the dedupe caveat §7 requires moved into `?` alongside a
  legend for the coverage glyphs, which were previously unexplained anywhere.

**Three changes after seeing the pane in use.**

- **A started alert leaves the queue.** It stayed, with its glyph changed, which asked the analyst
  to track one item in two panes. `[1]` now shows outstanding work — never run, or run and every
  attempt failed — and `a` includes the covered ones. `attempted` deliberately counts as
  outstanding: it has a run, but the run produced nothing, and treating "has a run" as "done" is
  how a crashed investigation disappears. This also makes the pane title true, which the earlier
  retitle had papered over from the wrong side.
- **`[4]` shows the selected alert, which §7 specified and the first cut never built.** It renders
  the API payload parsed — title, the detection's own `description` under WHY THE ALERT FIRED,
  severity with the rule id, the incident window, asset, tactics, techniques, entities and the
  vendor's own remediation steps. `alertLines` alone was not enough: it omits the description by
  design, because it is built for the 43-column case pane where prose breaks mid-token. Two bugs
  fell out of building it — severity rendered as the alert *type* (`enrichWithAlertJson` only fills
  severity when the base claims `source: "none"`), and the tab strip stayed visible over a pane that
  has no tabs.
- **Tab order and naming.** `verdict · agent stream · activity · transcript`. The stream sits beside
  the verdict because those are the two an analyst watches while a run is live; activity and
  transcript are for going back over a finished one. "stream" alone did not say whose.

**An empty queue has three causes and they are not interchangeable.** It said "press r to load
alerts" with 154 alerts loaded and the filters excluding all of them — sending the analyst to reload
data they already had. It now distinguishes not-yet-loaded, no-match, nothing-outstanding, and
every-ground-truth-alert-has-a-run, the last of which names `a` and `queue:reset` as the ways
forward. A read-only console also opens on `[2]` rather than on a queue it can never populate.

**Every action was bound to the wrong subject, and none of them checked.** `n` read the queue's
cursor, `e` and `d` read the selected run — regardless of which pane the analyst was actually
working in. Pressing `d` while reading an un-run alert in `[1]` therefore filed a verdict against
whatever run happened to be selected in `[2]`: a classification recorded against an investigation the
analyst had not looked at, with no indication anything was wrong. `n` from `[2]` started the queue's
cursor for the same reason.

They are now scoped to `state.mainSource` and refuse rather than retarget, naming the pane that
would make the action valid. `d` additionally refuses on a run still in flight — there is no verdict
yet to agree or disagree with, and `agentAssessment` would freeze an empty one. This is the same
defect as the `4` key changing what `[4]` was about; both came from reading focus where the subject
was meant.

**The PRD-5 follow-ups were completed in this increment.** The `⇥`-traversal exceptions are exported
as one asserted constant; the start overlay warns about exact-entity alerts within ±1 second and
shows how many already have a run; and `queue:reset --include-feedback` explicitly moves matching
feedback. Analyst-facing copy now says *classification*, while `d` retains its key. `[3] Case`
follows the active queue alert and returns to the selected run when `[2]` becomes active.

**Verified live on 2026-08-20 with `openai/gpt-5.6-luna`.** The TUI started run
`01a01f3d-1942-7000-9be8-ea4e4428e34b` for alert
`83df9c3c-0c07-c473-51d4-811cea88ce49`, displayed four active agent turns and tool calls, and then
accepted `x` while the model was still working. The UI moved through `cancelling` to `cancelled`;
the artifact persisted `status: "interrupted"` and the active result failed with
`InvestigationAbortedError`. The same session exercised the duplicate warning, forward and reverse
Tab traversal, queue-following Case pane, and recording an `Undetermined` classification. The
isolated run and its matching feedback were then archived and restored together with
`queue:reset --include-feedback`.

`bun run console --fresh` provides a non-destructive clean session view. It hides run artifacts
that existed when the console opened, so their alerts return to `[1]`; investigations launched in
that session appear in `[2]` and leave the queue through the normal coverage path. It does not
archive, delete, or rewrite prior artifacts.

The mode was verified live against an isolated directory containing the earlier cancelled run:
the console opened with `0 runs` and 154 alerts, then starting Luna run
`01a01f41-e679-7000-9f9b-c8b36b12f227` changed the view to `1 run` and removed that alert from the
queue. The pre-existing artifact remained hidden and unchanged.
