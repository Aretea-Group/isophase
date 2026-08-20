# Console Write Path — Design Research

**Status:** Research note. Not a PRD. One part has since been built — the in-flight display work in §3, flow 2.
**Scope:** Roadmap §6 "Console as an Operator Surface", narrowed to four flows, with case memory
out of scope.
**Would become:** `docs/prd-5-console-operator-surface.md` + `docs/adr/007-console-write-path.md`,
`AGENTS.md` §14 Phase 9.

---

## 1. The answer: yes, and it is cleaner than it looks

**It is possible, it needs no new dependency, no new service and no schema rewrite, and it is roughly
800–1000 new lines against a 5,384-line console.**

The reason it is clean has nothing to do with boundary discipline. It is that `apps/investigator` is
*already a complete program that takes an alert id and does the whole job*, configured entirely
through environment variables — thirteen validated keys, every one defaulted
(`apps/investigator/src/env.ts`). The console does not need to learn anything about agents, Pi,
provider keys or tool loops. It needs to learn two things: how to run a command, and how to display a
run that has not finished yet.

That is why spawning the existing CLI wins, and the argument does not depend on ADR 006 at all —
spawning is *also* the least code. If PRD-3 §4.1 were struck from the record tomorrow, this design
would barely change. The boundary properties survive as a side effect of the cheapest implementation,
which is the strongest kind of boundary to have.

### What it costs

| Flow | New code | Where |
|---|---|---|
| 1 — alert queue | ~220 lines | `data/alerts.ts`, `view/coverage.ts`, `ui/panes/queue.ts` |
| 2 — start a run | ~230 lines, of which the ~200-line pending-result half is **already built** | `drive/spawn.ts`, the compose overlay |
| 3 — re-run with context | ~60 investigator lines, reuses the overlay | `parseArgs` (+15), `context.ts`, `instructions.ts`, `contracts/run.ts` |
| 4 — record a classification | ~90 lines | `drive/feedback.ts`, one schema, a Verdict-pane block |

Nothing in the existing console is rewritten. `data/` and `view/` stay pure. The renderer stays behind
`ui/`. `apps/investigator` gains flags and three optional artifact fields and is otherwise untouched.

### The hard things — one now solved, two left

Everything else is typing.

1. ~~**Displaying a run that has no finished alerts.**~~ **Solved and shipped**, ahead of the rest of
   this note. It was the largest unknown in the estimate and it came in at ~200 lines. §3, flow 2
   records the spike that measured it and what landed.
2. **Text input focus.** `set visible(value)` ends with `if (this._focused) { this.blur(); }` — it
   blurs **only the renderable it is called on**, with no recursion into descendants. The natural
   implementation therefore produces an unrecoverable keymap lockup: after ⎋ hides the overlay the
   mode guard stays true forever and every key is typed into an invisible buffer. §5 has the fix.
3. **The queue's place in the control flow.** Settled: it is pane `[1]`, top-left — see §3, flow 1.
   What remains is the selection model, because pane `[1]` currently belongs to the selected run and
   the queue belongs to no run at all.

### What is ceremony, and can be cut

If the roadmap is overruling PRD-3 — which is what roadmap §6 exists to do — then `CONSOLE_ALLOW_WRITES`,
the per-session run cap and most of the amendment ledger are ritual. Cut them.

Keep the four gates in §2.2 only because they are one-liners that **pass today against unchanged
source**, so they cost nothing and go red on the first accidental write. That is worth having whether
or not anyone cares about the ADR.

### Two things that are not governance

These would survive binning every ADR in the repository, because they are bugs rather than boundaries.

- **Do not add `--context-file`.** `bun run investigate --alert <id> --context-file fixtures/scenarios/<x>.json`
  loads the verdict, the discriminating KQL and the evaluator notes straight into model context. One
  flag, one line, and invisible to every guard that exists — the isolation regex only fires when
  "scenarios" appears literally inside the call, and oxlint sees no import. Take `--context <text>` on
  argv or stdin instead. Detail in §2.4.
- **Seeded runs must not silently replace honest rows in `bun run evaluate`.** `latestPerScenario` is
  last-wins on `${model}::${scenario}` (`scripts/evaluate-runs.ts:122-128`), so the first time anyone
  presses `e` on a scenario alert and types "this host is a scanner", that run becomes *the* row for
  its model and scenario and the honest one disappears. This got more urgent, not less, now that PRD-4
  is complete: it corrupts the answer key that work just finished building.

---

## 2. What this reverses, and what it owes

Roadmap §6 says the work "reverses PRD-3's central design decision, and should not be done casually",
then lists four questions it owes answers to. This section is those answers. It is *documentation of a
decision*, not an argument against making it — the roadmap is the forward-looking authority and it has
already decided.

One correction to the roadmap's own framing, because it changes what there is to protect. Roadmap §6
calls the read-only guarantee *"currently absolute and testable"*. It is absolute; it is **not tested**.
Grepping `apps/console/src` for `Bun.write`, `Bun.spawn`, `writeFileSync`, `appendFileSync`,
`mkdirSync`, `node:fs`, `node:child_process` and `fetch(` returns exactly two hits, both false
positives: a template literal reading `` `${view.fetches.length} fetch(es)` `` at
`apps/console/src/ui/panes/main.ts:218`, and a prose comment describing what the *investigator* does at
`apps/console/src/data/trace-index.ts:129`. The only assertions containing the words "read-only" check
that help text contains the phrase (`apps/console/test/render.test.ts:83`, `:297`).

So the guarantee is upheld today by the fact that nobody has written a write yet. The first increment
is not a loss of safety — it is the first time the property is machine-checked at all.

### 2.1 Where does a run execute?

**Recommendation: a spawned child process running the existing investigator CLI, with an explicitly
enumerated environment.** Not in-process, not a daemon, not a shared runner package.

```ts
Bun.spawn([process.execPath, "apps/investigator/src/index.ts", "--alert", id, ...flags], {
  cwd: repoRoot,                  // derived from import.meta.dir, never process.cwd()
  env: buildChildEnv(cfg),        // literal enumerated map, never {...process.env}
  stdin: "ignore",
  stdout: Bun.file(outPath),
  stderr: Bun.file(errPath),      // separate files — never one file, never "pipe", never "inherit"
})
```

The alternatives lose on their own terms. **In-process** violates ADR 006 §3 on the exact example the
ADR names, puts the provider key in the TUI, makes the console the writer of `runs/`, and lets an
OpenTUI 0.5.x renderer bug kill a paid long-running investigation. **A daemon** is banned in one word
by PRD-3 §4.2 and adds a *second* writer to `runs/` unless the CLI is retired — more concurrency
exposure, not less. **`packages/investigation-runner`** is rejected by name at `AGENTS.md:149-151`; if
the console only spawns, the package buys nothing, and if it imports, every in-process objection
returns with an extra package attached.

Three things about this model need to be written down rather than assumed, because the first pass of
this research got all three wrong.

**The enumerated env does not contain credentials, and must not be sold as if it does.** Bun loads
`.env` in the *child's own runtime* at its `cwd`, so every variable in the repo-root `.env` reaches
the child regardless of what the parent passes. What the allow-list actually buys is that the console
contributes no variable it did not name — determinism, and no console-side configuration bleeding into
agent-side code. The provable claim is narrower: *no file under `apps/console/src` names a provider
credential variable, and the console passes none to the child; the child resolves its own credential
inside its own Bun runtime.* That is exactly the arrangement `apps/investigator/src/env.ts:36-38`
already documents — provider keys are deliberately absent from the schema because pi-ai reads them
from the ambient environment, and the provider-aware check lives in `model.ts`.

There is a dilemma inside this that ADR 007 owes a paragraph. Because nothing is forwarded, the key
must live in the repo-root `.env`. An ordinary `export OPENAI_API_KEY=… && bun run investigate` setup
works from the CLI and fails for every console-started run. The mitigation is not a fix: `drive/spawn.ts`
*stats* (never reads) `<repoRoot>/.env` and disables the start key with a one-line reason when it is
absent.

**Startup failures are the model's biggest obligation.** Unknown model, unreachable Sentinel and
unknown alert id each exit 1 with *only stderr and zero files*. The ordering in
`apps/investigator/src/index.ts` is unambiguous: `resolveModel` at `:79` and the alert fetch at `:94-97`
both precede `runId` at `:99` and the first flush at `:155`. A console that only polls `runs/` shows
nothing at all for the four most likely mistakes. So the seam returns `{pid, exited, outPath, errPath}`,
`State` gains a `children` map, and a non-zero exit raises a **durable** status line — `state.notice`
cannot carry it, because it is cleared unconditionally on the next keypress at
`apps/console/src/ui/app.ts:748`.

**The child does not die with the console.** Roadmap §6's premise — *"a child process the console owns
dies with the console"* — is factually wrong; a `Bun.spawn` child survives parent exit in plain,
`unref()` and `detached: true` modes alike. Whatever quit semantics ship, the guarantee text must
describe them rather than repeat that premise. The recommendation is a one-line confirm on `q` naming
the live-child count, then `SIGINT` to each, which produces an `interrupted` artifact the existing
`classifyRun` already renders. Two windows must be named rather than implied: the investigator
registers its `SIGINT` handler at `index.ts:159`, *after* the first flush, so a kill before that leaves
nothing (and this cannot be fixed by moving the registration — before `runId` exists there is nothing
to flush); and `process.on("uncaughtException", …)` at `app.ts:991-993` exits without touching
`children`, so a crashed console orphans its runs unless that path is extended.

### 2.2 What replaces the read-only guarantee?

The roadmap's candidate — *"it writes only through the investigator, never to `runs/` directly"* —
should be rejected, because no source scan can reason about which **path** a write targets. An
absence-of-primitive claim plus named seams is strictly stronger and trivially checkable:

> `apps/console/src` contains no filesystem write primitive and no subprocess spawn anywhere except
> the single seam directory `apps/console/src/drive/**`, and no network primitive anywhere except the
> single module `apps/console/src/data/alerts.ts`. Every byte the console writes lands under
> `feedback/` or `.console/logs/`; it never writes under `runs/`. The investigator remains the sole
> writer of `runs/*.json` and `runs/traces/**`. The console reaches Mock Sentinel only through the
> Sentinel Client, through an `AlertReader` narrowed to `listAlerts` and `getAlert` — never Kusto,
> never ad-hoc KQL. No file under `apps/console/src` names a provider credential variable.

The network clause has to be a *named-module* claim rather than an absence claim, because flow 1 puts
`client.listAlerts()` outside the seam. And the `AlertReader` narrowing is load-bearing rather than
tidy: `SentinelApiClient` also exposes `query(kql)` and `getSchema()`, and PRD-3 §14 excludes *"live
Mock Sentinel queries"* and *"ad-hoc KQL execution"* on consecutive lines. Handing `data/` the whole
client compiles ad-hoc KQL into the console, ungated, from the first increment.

```ts
export type AlertReader = Pick<SentinelApiClient, "listAlerts" | "getAlert">;
```

**Five gates. Four of them pass today**, against unchanged source, which is why they land before any
write code exists — they then go red on the first write anyone adds, including the intended one,
forcing the seam to be named in a diff rather than assumed.

1. `apps/console/test/write-isolation.test.ts` — call-syntax regexes over `apps/console/src`, with
   `drive/**` and `data/alerts.ts` excluded per-pattern. It must not copy `ground-truth-isolation.test.ts`'s
   naive substring style: `"truncate"` would hit the console's own text helpers in eight files, and
   `/fetch\s*\(/` hits `main.ts:218`. Run call checks against comment- and string-stripped text and
   import checks against raw text.
2. Seam unit tests over the pure parts of `drive/`. `buildChildEnv` asserted by **exact key-set
   equality**, `buildRunSpec` by argv tables including hostile inputs, `feedbackPath` by
   path-traversal cases. This gate exists precisely because gate 1 must exclude `drive/**` — the one
   directory that can do harm.
3. `.oxlintrc.json` gains an `apps/console/**` override banning `**/investigator/**`. **ADR 006 §3 is
   enforced by nothing today** — there is no `investigator` pattern anywhere in `.oxlintrc.json`. The
   trap: oxlint `overrides` *replace* rather than merge, so an override listing only the investigator
   pattern would silently disable the scenarios ban for the console with lint still green. Both base
   pattern groups must be repeated verbatim.
4. `ground-truth-isolation.test.ts` — `ROOTS += "apps/console/src"`. **Verified: passes today, 8/8,
   with zero console changes.** No forbidden needle appears anywhere in console source, and 19 console
   `.ts` files clear the `>10` guard-the-guard floor on their own.
5. Runtime needle rejection in the investigator — the only guard in the whole design that covers a
   runtime *input* rather than source text. See §2.4.

What is **not** proven, and must be declared rather than glossed: that the console process holds no
credential (it does, from `.env`, exactly as today); that `.env` variables do not reach the child (they
do); that the child dies with the console (it does not); that a crashed console cleans up (it does
not); and that an operator cannot leak the answer key by typing.

### 2.3 Two consoles, one runs directory

**This is largely a non-problem, and the reason is worth writing down rather than leaving as an open
worry.** Nothing arbitrates and nothing needs to: each run gets its own UUIDv7 filename, the temp file
is pid-tagged and renamed atomically (`run-artifact.ts:24-27`), feedback is keyed `(runId, alertId)`,
and readers already quarantine per-file failures with a one-second retry (`data/runs.ts:106-112`). The
only genuine conflict is anyone-versus-the-investigator-that-owns-a-given-artifact, and that is designed
away by never writing into a run artifact you did not create.

The corollary is the strongest argument against putting feedback *inside* the run artifact. The
investigator's flush rebuilds the whole artifact from its in-memory `collected` array at every alert
boundary and never reads the file back (`index.ts:107-128`), and `writeRunArtifact` runs
`InvestigationRun.parse` (`run-artifact.ts:14`) whose `z.object` strips unknown keys — so a feedback
field written by anyone not also editing the schema vanishes with no error, mid-sweep. That is the only
design in this whole analysis that would genuinely need file locking, which is a reason to reject it
rather than to add locks.

### 2.4 How ground-truth isolation survives

Extending `ROOTS` is the easy half and it passes today. The hard half is that a console which can start
an agent introduces the first path by which *runtime input* reaches agent-side code — and the existing
guards only scan source text.

The sharpest instance is a design idea that has to be killed on sight. A `--context-file <path>` flag
would put the first operator-controlled arbitrary file read into `apps/investigator/src` — the one
directory whose entire security property is that it cannot reach the answer key — and **neither
existing guard can see it**. Today agent-side code reads no file by a caller-supplied path. The
isolation test's runtime guard is `/(?:Bun\.file|readFile|readFileSync|import)\s*\(\s*[^)]*scenarios/i`,
which fires only when the literal string "scenarios" appears *inside the call*, so `Bun.file(args.contextFile)`
passes; and oxlint sees no import. Once the flag exists,
`bun run investigate --alert <id> --context-file fixtures/scenarios/<x>.json` loads the verdict, the
discriminating KQL and the evaluator notes straight into model context.

So: `--context <text>` on argv or stdin only, never a path. Plus a ten-line runtime rejection in the
investigator that fails the run if the analyst text contains any FORBIDDEN needle, sharing the list with
`ground-truth-isolation.test.ts:20-27`. Plus a new isolation assertion that agent-side source contains
no path-parameterised file read — a `Bun.file(` or `readFile(` whose argument is not a string literal —
so the flag cannot be reintroduced by someone who did not read this document.

The residual is honest and should be stated: an operator with filesystem access to `fixtures/scenarios/`
can defeat their own evaluation by pasting prose. The mitigation is that `config.analystContext` is
recorded in the artifact, so contamination is visible after the fact, and that seeded runs are excluded
from the default evaluation report (§4, change 8).

---


---

## 3. The four flows

### Flow 1 — an alert queue

**Where it lives: pane `[1]`, top-left. Decided.** An earlier draft of this note argued for an
overlay `Screen` on a width argument. That was overthought, and one measurement settles it: across the
37 artifacts in `runs/`, **36 have exactly one alert and none has more than one**. Pane `[1]` "Alerts
in run" is therefore a one-row list in every run this project has ever produced — ADR 006 §9 only made
it always-visible so that `1`-`4` would stop being a lie. It is the lowest-earning real estate in the
console, and a 145-row queue is the highest-earning.

So `[1]` becomes the queue permanently, and the alerts-within-a-run fold into the `[2]` row, which
`runLabel` already handles: `if (run.results.length === 1 && first?.alertTitle) return first.alertTitle`
(`view/run-list.ts:110-115`). Three boxes stay three boxes, no height arithmetic moves, `Focus` stays
`1|2|3|4`. When sweeps arrive (roadmap §7), `[2]` rows expand with ⏎ into their alerts rather than a
fourth box appearing.

The cost is a selection model. Pane `[1]` currently addresses *the selected run's* alerts through
`state.resultIndex`; the queue addresses alerts belonging to no run. §3.5 works through what that
changes.

**Naming.** `AlertStatus` is already `Unknown|New|Resolved|Dismissed|InProgress`
(`packages/contracts/src/alerts.ts:31`). A pane headed "Open alerts" listing an alert whose own JSON
says `Resolved` is a live collision. Call it **`[4] Alerts — no run`** and render the vendor status
verbatim in its own column.

**The join is cheap and should not get a paragraph in the PRD.** `view/coverage.ts`, pure, folds the
already-resident `state.runs` into `Map<alertId, CoverageState>` over four states — `no-run`,
`in-flight`, `investigated`, `attempted`. `attempted` (results exist but every one is `status:"failed"`)
is load-bearing: hiding a crashed investigation from the queue is the one outcome that silently loses
work.

**Read once, not on a timer.** A one-second poller against `/alerts` is 262 KB/s over loopback forever,
to watch a corpus that only changes on `bun run data:bootstrap`, in a TUI left open all day — and a
Sentinel restart would flap the degraded banner once a second. Fetch on entering the screen and on `r`.

**Degraded states** matter more than usual here, because today 100% of console sessions run with no
Sentinel at all. `SentinelApiError{code:"unreachable"}` → *"start it with `bun run dev:mock-sentinel`"*;
`upstream_unavailable` → *"Sentinel is up, Kusto is down"*; `ZodError` → *"the corpus and the console are
out of step"*. Parse strictly: `listAlerts()` is `AlertListResponse.parse(...)` with no raw-payload
accessor (`client.ts:37-40`), so a lenient per-element fallback is unbuildable through the sanctioned
client — and unnecessary, since these alerts are generated by our own rules from pinned telemetry, so
drift is our bug and should be loud.

**Counts carry their caveat.** The header says *"N alerts with no run — note 107 of the 151 are two
vendor views of 54 events"*. A bare "145" overstates outstanding work by roughly fifty, and PRD-3 §4.4
forbids exactly that kind of authoritative-looking number. Dedupe itself is not built: `AGENTS.md:49`
lists alert grouping under Do-not-implement, and `vendorOriginalId` is broken in the vendored CSV
anyway, so any dedupe would be a corpus-fitted heuristic.

**Keys.** `a` toggles the queue. `/`, `j/k/g/G` and `r` extend rather than gain siblings. `y` on a
queue row copies `bun run investigate --alert <id>` via the existing OSC 52 path (`app.ts:938`) — **this
is the cheap fallback that delivers most of flow 2's value with the absolute read-only guarantee
untouched, and it is the thing to keep if writes get cut.**

### 3.5 The selection model — what the queue changes in the control flow

Pane `[1]` today shows **the selected run's alerts**. The queue shows **alerts that belong to no run**.
Those are different collections, of different things, with different actions — and every consequence
below follows from that one fact.

**What does not change.** `Focus` stays `1|2|3|4`. `Screen` stays `dashboard | config | help` — the
queue needs no new screen, and only the compose overlay for flows 2–4 adds one. `visibleRuns()`,
`currentRun()`, `loadTrace()`, `resolveTracePath`, the transcript index, the tail, `applyRuns` and both
pollers are untouched. So is the whole `[2]`/`[3]`/`[4]` path for a selected run.

**1. A second collection in `State`.** `alerts: QueueAlert[]`, `queueIndex`, `queueScroll`, and an
`alertsError?: string` for the degraded case. `state.alertScroll` — which today scrolls the run's alert
list — is repurposed or retired with it.

**2. `moveSelection`'s `focus === 1` branch splits, and this is the sharpest change.** Today both the
`focus === 1` and `focus === 2` branches end in `void loadTrace()` (`app.ts:707-731`). A queue alert has
no run, therefore no transcript, therefore nothing to load. The branch stops calling `loadTrace()` and
instead just re-renders. Getting this wrong is the bug to expect: moving in the queue would either
throw away the transcript of whatever run is selected in `[2]`, or leave `[4]` showing a stale
investigation while `[1]` points somewhere else entirely.

**3. `mainBody()` gains a top-level branch.** With the queue focused, `[4]` should show the selected
alert's own facts — description, entities, tactics — not the selected *run's* verdict tabs. `/alerts`
returns the whole `SecurityAlertResource`, and `view/alert.ts`'s `alertLines` already renders exactly
this for `[3] Case`; it is the same renderer at a wider width. `onTabs` must be false in that state, so
the tab strip disappears, and `[`/`]` become inert rather than silently cycling tabs behind an alert
that has none.

**4. The height arithmetic changes, in the one way ADR 006 §9 warns about.** `alertsHeight` is currently
`min(ALERTS_MAX_HEIGHT, max(3, results.length + 2))` (`app.ts:474`) — sized to the *contents*, which is
fine for a one-row list and wrong for a 145-row queue. It becomes a fixed share of the sidebar, exactly
as the case pane was fixed for the same reason: a pane that resizes while you are navigating past it
moves the list under your own keypress.

**5. Small, mechanical.** `clampSelection()` gains `queueIndex`. `filterTarget: 1` keeps its shape but
now means "the queue", so `resultHaystack` gains a `queueHaystack` sibling over title, severity, entity
and vendor status. `copyFocused`'s `focus === 1` branch copies queue rows instead of result rows. `r`
refetches the queue when `[1]` has focus. `helpLines()` relabels `1`. Startup focus arguably moves from
`2` to `1`, since the queue is now the thing you open the console to look at.

**6. `resultIndex` loses its pane, and mostly does not care.** With `[1]` given to the queue, nothing
drives `resultIndex` from the sidebar any more. For 36 of 37 runs on disk it is always `0`, so it simply
pins there and the run row in `[2]` names the alert. Multi-alert sweeps lose per-alert selection until
`[2]` rows grow ⏎-expansion — a real but currently theoretical loss, since no such run exists yet.
Worth stating in the PRD rather than discovering during roadmap §7's 151-alert sweep.

---

### Flow 2 — start an investigation

`n` on the queue selection. Free today; the consumed set is Ctrl-C, `q`, `/`, `y`, `1`-`4`, `j`/down,
`k`/up, `g`, `G`, `[`, `]`, `c`, `?`, `F`, `r`, ⏎, ⎋.

A confirmation overlay names the alert, the model, **the Sentinel URL the child will be given**, and the
fact that this calls a paid provider — plus, derived from data already on screen with no grouping model,
a duplicate-spend warning: *"N other alerts share this `compromisedEntity` within ±1s; M have a run."*
The confirm strip defaults to **Cancel**; a modal dismissed by whatever key the analyst was already
holding is theatre. ⏎ confirms, ⎋ cancels — and ⎋ must never be the only cancel, given the ~40 ms
escape-parser latency already documented at `render.test.ts:398-413`.

**Display is real work, not a free ride, and this is where the first pass of this research was most
wrong.** The claim that "the run appears within one poll tick and tails with zero new display code" is
false for exactly the runs this PRD creates. The investigator writes `results` only when an alert
*finishes*, so a console-started single-alert run has `results: []` for its entire lifetime — up to
`INVESTIGATOR_TIMEOUT_MS`, 600 s. Console-side, everything keys off a finished result:

| Site | Behaviour with `results: []` |
|---|---|
| `loadTrace()` `app.ts:343-348` | early-returns; no `pollTrace` tail ever starts |
| `resolveTracePath` `data/stats.ts:42-57` | needs an `alertId` that only exists in `results` |
| tab bar `app.ts:526` | `currentResult() !== undefined` → hidden |
| pane [1] `app.ts:509` | "no finished alerts yet" |
| pane [4] `app.ts:620-626` | "Run … has no finished alerts yet." |
| run row `view/run-list.ts:97-110` | falls through to "(no alerts yet)", no verdict column |

`test/live.test.ts` passes today only because its fixture writes a *finished* result alongside a growing
transcript — the sweep case, not the single-alert case. What does survive unchanged is the `●` glyph,
because `classifyRun` falls back to `completedAt`. The row exists; it is content-free.

**Spike result — measured, then built.** A zero-results artifact was written by hand into a scratch
`runs/` and the console opened against it. It confirmed the table above: the run *did* appear in `[2]`
with a `◌` glyph and `0/1 done`, but **there was no tab bar at all**, so Verdict, Activity, Transcript
and Stream were not empty but *unreachable*, and `[3] Case` said "no alert recorded" — the analyst
could not see which alert was running, let alone watch it.

The important finding is that these are not nine independent bugs. They are **one missing row observed
from nine places**, because `visibleResults()` is the single addressing path to an alert and everything
downstream goes through `currentResult() = visibleResults()[state.resultIndex]`. A twelve-line union in
that one function restored eight of them at once — the tab bar returned, the transcript tail started,
and `[3] Case` populated itself from the transcript for free. Three cosmetic defects survived, all in
pure view code: a green `✓` on a running alert, `UNSCORED TP —%` where it should say what the agent is
doing, and `(no alerts yet)` in the run row, because `runLabel` reads `run.results` directly and bypasses
the derived layer.

**This is now built** (`plannedAlerts` on the artifact; `pendingResults` / `resultsWithPending` /
`isPending` in `view/run-list.ts`; `progressBody` in `ui/panes/main.ts`), and it came in at ~200 lines
with all three cosmetic defects fixed. The shipped design improves on the spike in two ways worth
recording: the synthesis lives in the pure `view/` layer rather than inline in `app.ts`, so it is
snapshot-testable; and `plannedAlerts` carries `{alertId, alertTitle}` rather than a bare id, so an
in-flight alert can be *named* on screen with tracing off, when no transcript exists to recover a title
from. `pendingResults` is also correctly gated on `run.status === "running"`, so a finished or
interrupted run never grows phantom rows.

Acceptance still owes `live.test.ts` a **zero-results in-flight artifact**, rather than a re-triggered
copy of the existing fixture, which is the sweep case.

Two smaller things. `applyRuns` preserves selection by runId across every poll (`app.ts:961-975`), so a
new run appears but is not selected — the analyst's row shifts down under them; add a one-shot
`state.pendingRunId`. And identifying the child's run wants a distinctive `RUN_ID=<uuid>` marker
*scanned* for with a bounded timeout, not "the first stdout line" — `console.info` fires at
`index.ts:68-70` before `runId` exists at `:99`, and a failed start writes no stdout at all.

**Cost.** `INVESTIGATOR_MAX_TURNS` and `INVESTIGATOR_TIMEOUT_MS` are per-investigation; there is no
monetary or count ceiling anywhere in the repo. Hence `CONSOLE_MAX_RUNS_PER_SESSION` (default 5) and a
**start-one-alert-only** rule — no "start a sweep" button in this PRD.

### Flow 3 — re-run with analyst context

**This does not resume a conversation. It starts a derived new run** carrying an analyst premise in its
initial context and a `derivedFrom` pointer.

Resumption is *mechanically ready*, which is worth recording because it is the natural assumption to
test. `initialState` accepts a partial `AgentState`, and `AgentState.messages` is settable
(`pi-agent-core/dist/agent.d.ts:6`, `dist/types.d.ts:289-301`); `agent_end` carries
`messages: AgentMessage[]` — a complete replayable transcript (`dist/types.d.ts:377-378`). It is
nevertheless the wrong choice here for three independent reasons: it depends on `INVESTIGATOR_TRACE`,
which defaults to **false**, so in the standard configuration there is nothing to resume from; making
that work reopens ADR 005 §2, `AGENTS.md` §12 and PRD-3 §15's explicit warning that a second
programmatic trace consumer is the signal to revisit the deferred trace store, not to add readers; and
the recovered transcript carries no system prompt, so a continuation after any prompt drift is a
different agent wearing the old transcript.

**The model picker is dropped, and this is not a cosmetic cut.** There is no implementable source of
model ids under the stated constraints: console dependencies are `@opentui/core`, `@t3-oss/env-core`
and `zod`; ADR 006 §3 forbids importing the investigator; the list exists only inside pi-ai
(`models.getModels(provider)`, `model.ts:34-37`). The replacement is one escalation target,
`INVESTIGATOR_ESCALATION_MODEL`, read from the console's own env block beside the `INVESTIGATOR_MODEL`
it already displays, and one key meaning "re-run this on the escalation tier". That is the real analyst
move, it needs no model list, and it keeps arbitrary model selection where it already works for free —
the CLI plus env, which the spawned child honours with zero investigator changes.

Dropping it also lets `--model`/`--provider` go, which removes a whole bug class: passing the escalation
model as `INVESTIGATOR_MODEL` in the child's env means `resolveModel` (`index.ts:79`) and the flush
closure's `model:` field (`index.ts:123`) read the same source and **cannot desynchronise**. A flag
threaded into one and not the other would write an artifact that lies about which model ran — and
`latestPerScenario` keys on `${model}::${scenario}` (`evaluate-runs.ts:122-128`), so the mislabelled row
would silently displace the right one in the only report anyone reads.

**Trust boundary.** The premise gets its own `<analyst_context>` envelope from `buildInitialContext`,
plus a paragraph in `instructions.ts` beside the existing untrusted-web block. The standing order is
narrow: analyst context may assert environment facts the telemetry cannot show — ownership,
authorisation, business context — and may direct scope; it may **not** set a verdict, and a stated
verdict is a hypothesis to test. Sanitise the envelope delimiters out of the embedded copy, cap the
length, and store the raw text in the artifact so the sanitisation is auditable. This closes a real
hole: ADR 005 §3's accepted injection residual is bounded by "a human still adjudicates", and
analyst-pasted text removes exactly that bound, in a corpus that is 90% one phishing-led intrusion
whose MailGuard alerts carry attacker text verbatim.

**Evaluation protection is a hard gate, same increment.** Without it, the first time anyone presses `e`
on a scenario alert and types "this host is a scanner", that seeded run becomes *the* row for its
model+scenario in `bun run evaluate` and the honest run disappears silently — poisoning the exact
measurement PRD-4 exists to make trustworthy. `scripts/evaluate-runs.ts` must exclude seeded runs from
`latestPerScenario` unless `--include-seeded` is passed. **If that filter cannot ship with flow 3, flow
3 does not ship.**

`e` is free, and specifically unclaimed: PRD-3 §9 reserved it for an Activity error filter that §14's
deviation table records as never implemented.

**If scope must be cut, cut this flow, not flow 1.** It is the least proven and most expensive, and no
shipping vendor documents a re-run-with-a-hint capability. It is defensible here as a controlled
experiment — PRD-4 measured one scenario swinging 80/15/90 on the same alert and model — rather than as
triage.

### Flow 4 — record a classification

The brief was *"initially a stub, but wired so it can later feed memory"*, and the research's first pass
grew that into a system of record with a 4×4 vocabulary, an invented memory schema and two
`evaluate-runs` changes. Corrected downward:

```ts
AnalystFeedback = {
  schemaVersion: 1,
  runId, alertId, at,
  classification: "TruePositive" | "BenignPositive" | "FalsePositive" | "Undetermined",
  comment?: string,                        // cap 30_000 — Sentinel's own documented bound
  analyst?: string,
  agentAssessment: { tpPercent, model },   // frozen
}
```

"Wired for memory" is satisfied by three things that cost nothing to keep: `schemaVersion`, the
analyst's own free-text words, and a stable `(runId, alertId)` key. Dropped: `classificationReason`
(nobody has used the four classifications in anger yet), `memoryCandidate` (its `scope: "entity"` value
is entity-scoped carryover between investigations — roadmap §8, which `AGENTS.md:49` lists under
Do-not-implement, and `AGENTS.md:147` says *"Do not create empty future-capability packages"*, which is
the same thing at field granularity), `promoteToMemory`, and a `source="analyst|memory"` attribute on
the envelope, which would bake injection-at-turn-0 into the prompt and commit the memory PRD before it
exists.

**Freezing `agentAssessment` is not optional** — the record otherwise points at a file rewritten in
place, and six months later would say the analyst disagreed with a verdict that is no longer there.

**`evaluate-runs.ts` is not touched by flow 4.** The tempting justification — analyst labels as a cheap
source of ground truth for the other 145 alerts — does not survive PRD-4 §7: no benign-true-positive
verdict exists in `ScenarioVerdict`, so the headline value `BenignPositive` has no target and would
collapse onto `false-positive`. Worse, ground truth here is a pinned scenario file whose `startingAlertId`
resolves against the live database by a test; a JSON sidecar written by whoever pressed `d` after reading
the agent's verdict is an un-blinded opinion with an obvious anchoring path. Promoting a label to ground
truth is a scenario-authoring act owned by PRD-4's process, not a console side effect.

**Storage: `feedback/<runId>-<alertId>.json`**, a new root outside `runs/`. Not `runs/feedback/`:
`.gitignore:27-32` documents `runs/` as *"the durable output of a run, but local to a developer's
experiments — regenerate with `bun run investigate`"*, so `rm -rf runs/` is a documented-safe action, and
storing the only copy of unreproducible human judgement inside it is a straightforward error. A separate
root also makes *"the console never writes under `runs/`"* literally true, rather than resting on the
accident that `new Bun.Glob("*.json").scanSync` is non-recursive — verified: a directory holding
`a.json`, `feedback/b.json` and `c.jsonl` matches `a.json` alone. Assert that non-recursion as a
regression test anyway, so that widening `readRuns` or the evaluate loader to `**/*.json` later goes red.

`drive/feedback.ts` writes it directly. Spawning a process to write 200 bytes buys a rhetorical
guarantee, not a real one; the invariant that survives verbatim is the one that matters — **the
investigator remains the sole writer of `runs/*.json` and `runs/traces/**`.**

`d` for classification, deliberately not `f`, which sits one shift-key from `F` (follow) on the same screen
where `F` is meaningful.

**Flow 3 and flow 4 never touch.** The analyst's classification never enters the agent's context; the
analyst's premise never sets a verdict. Collapsing that split produces an agent that agrees with whatever
it is told and an evaluation harness measuring nothing.

---

## 4. Contract changes

| # | Change | Where | Backward compatibility |
|---|---|---|---|
| 1 | ~~`plannedAlertIds?: string[]`~~ → **shipped** as `plannedAlerts?: {alertId, alertTitle}[]` on `InvestigationRun` | `contracts/run.ts:117-119`; the flush closure at `index.ts:118-121`, beside `alertCount` | Optional; every existing artifact parses unchanged. The artifact recorded how *many* alerts, never *which* — without it the queue cannot mark in-flight alerts, and `n` on an alert a live sweep is about to pick up buys a duplicate paid investigation. The title travels with the id so the artifact stands alone with tracing off |
| 2 | `derivedFrom?: {runId, alertId}` | `contracts/run.ts`; lenient mirror in `data/runs.ts` | Optional, additive. No `kind` field — a model swap with no analyst text is neither "rerun" nor "context", and "what changed" is a diff of `model`/`config`, both already in the artifact. A derived run **must** get a fresh runId: transcripts are keyed `<runId>-<alertId>` and opened with `appendFileSync`, so reusing one concatenates two transcripts and double-counts cost |
| 3 | `analystContext?: string` inside `InvestigationRunConfig` | `contracts/run.ts`; a row in `view/config.ts` | Optional. Storing the **raw** text is what makes the injection mitigation auditable and lets `evaluate-runs` detect a seeded run |
| 4 | CLI: `--context <text>` (or stdin), `--derived-from <runId>`, `--trace`, and a `RUN_ID=` stdout marker | `index.ts:24-48` (`parseArgs` already rejects unknown options) | Purely additive. **No `--context-file`** (§2.4), **no `--model`/`--provider`** (§3, flow 3) |
| 5 | Runtime rejection of FORBIDDEN needles in `--context` | `index.ts`, needles shared with `ground-truth-isolation.test.ts:20-27` | New behaviour, no existing caller affected |
| 6 | `buildInitialContext(alert, tableNames, analystContext?)` + `<analyst_context>` envelope + one `instructions.ts` paragraph | `context.ts:14-27`, `harness.ts`, `instructions.ts:38-40` | Optional third argument. `AGENTS.md` §10 needs **no** change — this arrives as a user turn, not a sixth tool |
| 7 | `AnalystFeedback` schema + `feedback/` root | producer schema in contracts; lenient mirror in `data/feedback.ts`; writer in `drive/feedback.ts` | New directory outside `runs/`, invisible to `readRuns` and the evaluate loader by construction |
| 8 | `evaluate-runs.ts`: seeded runs excluded from `latestPerScenario` unless `--include-seeded`; lineage grouping on `derivedFrom.runId` | `evaluate-runs.ts:47-52`, `:121-128` | Opt-in; existing invocations produce identical rows, since no current artifact carries `config.analystContext`. **Hard gate on flow 3** |
| 9 | `apps/console/package.json` gains `@soc/sentinel-client` and `@soc/contracts` | — | No new third-party dependency; both are existing pinned workspace packages. Keeps the network primitive inside `packages/sentinel-client/src`, already inside the isolation ROOTS |
| 10 | Console env: `CONSOLE_ALLOW_WRITES` (default false), `CONSOLE_MAX_RUNS_PER_SESSION` (5), `INVESTIGATOR_ESCALATION_MODEL`, `FEEDBACK_DIR`, `CONSOLE_LOG_DIR` | `env.ts:4-33`; the *"Display only"* comment is rewritten | Every key still defaulted, none required — a console opened against a two-week-old run still opens with no environment at all. **Honest limitation:** the flag gates writes only; flow 1 falsifies `index.ts:17-18`'s "never calls Mock Sentinel" regardless |
| 11 | Gates: `ROOTS += "apps/console/src"`; `apps/console/**` oxlint override | `ground-truth-isolation.test.ts:17`; `.oxlintrc.json` | See §2.2. Verified to pass today |
| 12 | Guarantee text: three strings and two tests move together | `app.ts:445` (header badge), `app.ts:96` (`helpLines`), `console/src/index.ts:17-18` (usage), `render.test.ts:83`, `:297` | Keep the header badge and make it state-dependent (`read-only` / `writes enabled`) rather than replacing it with a live count — 107 of 151 alerts being two views of 54 events makes any bare count the least honest number available, and PRD-3 §4.4 forbids exactly that in the most authoritative position on screen |
| 13 | `AGENTS.md` §2, §12, §14 (Phase 9) + ADR 007 | — | §2's *"a local read-only analyst console is in scope from PRD-3"* → *"a local operator console … (read-only) and PRD-5 (write path through the investigator, ADR 007)"*. §2's "cross-investigation memory" and "human-feedback retrieval" lines stay **unchanged**, cited as the reason feedback is recorded but never consumed. §14 Phase 7's acceptance clause breaks in **two** places — flow 1 breaks *"reads … only"* exactly as the write path breaks *"never writes"*. **ADR 006 §3 joins the `Amends:` ledger**: the contract widens from two file formats to five channels (argv, exit code, stderr, a stdout marker, env names), and because the console may not import the investigator, the widened contract is pinned by *investigator-side* tests |

---

## 5. Deliberately not built

No daemon. No `packages/investigation-runner`. No in-process `InvestigationHarness`. No transcript
replay or `initialState.messages` resumption. No Pi session module. No `steer()`/`followUp()`. No fifth
sidebar pane. No unified work-item list. No feedback field inside the run artifact. No separate lineage
file. No file locking. No hand-rolled text editor. No `$EDITOR` shell-out. No `@opentui/keymap`. No
second poller. No CrowdStrike dedupe. No triage status/owner store. No memory. No new third-party
dependency.

Three dead ends are worth recording so they are not re-explored:

- **Pi's `AgentHarness` is fatal at the pinned 0.84.2.** `prompt`, `steer`, `followUp`, `resume`,
  `abort`, `compact`, `runToCompletion` and `lanes` all reject with `HarnessNotImplemented`, and
  `create` throws the moment the session holds any record. The data model is right; re-check on upgrade.
- **`steer()`/`followUp()` do not model the flow** — flow 3 extends a *finished* investigation — and
  would not work even for a live run, since `shouldStopAfterTurn` returns true on submission and the
  loop emits `agent_end` before polling the follow-up queue.
- **`@opentui/keymap`'s stated blocker is wrong.** ADR 006 §2 records it as unusable because it
  peer-depends on React or Solid; at 0.5.4 those peers are marked optional. That correction belongs on
  the record — but "the ADR's reason was inaccurate" is not a reason to adopt a second pre-1.0
  dependency and rewrite `onKey`, the highest-risk file in the console, in the same PRD that adds a
  write path.

On the input primitives, the good news is that **no new dependency is needed**. `@opentui/core` 0.5.4
exports `TextareaRenderable`, `InputRenderable`, `SelectRenderable` and `TabSelectRenderable` from the
bare specifier `app.ts:1-8` already imports — verified in `renderables/index.d.ts`.

The trap is focus. `set visible(value)` ends with `if (this._focused) { this.blur(); }` — it blurs
**only the renderable it is called on**, with no recursion into descendants. Hiding a modal Box therefore
leaves its Textarea focused and still consuming keys, and using `renderer.currentFocusedEditor !== null`
as the mode guard produces an **unrecoverable keymap lockup**: after ⎋ hides the overlay the guard stays
true forever, `q`/`1`-`4`/`j`/`k` never reach their handlers again, and every key is typed into an
invisible buffer. So `state.mode` is authoritative, exactly two functions touch renderable focus
(`closeCompose()` and `focusField(n)`), and 0.5.4 ships no focus traversal at all — no `focusNext`,
`focusPrevious` or `tabIndex` anywhere in the public surface — so Tab/Shift-Tab join a
stop-propagation exception list that lives in one exported array a test can assert exhaustively.

---

## 6. Open questions

1. ~~**Queue as an overlay `Screen`, or a visible fifth sidebar pane?**~~ **Decided: pane `[1]`,
   top-left.** The overlay recommendation was overthought and is withdrawn — 36 of 37 runs on disk
   carry exactly one alert, so the pane it displaces was never earning its space. What this opens
   instead is the selection model, §3.5.
2. **On quit with a live console-started run: kill it or leave it running?** Recommendation: kill, with
   a confirmation naming the count. The counterargument — an expensive investigation should not die
   because you closed a viewer — is real and gets stronger the moment sweeps are startable.
3. **Do you accept "extend" as a derived new run on a single env-configured escalation model, rather
   than a conversation continuation with a model picker?**
4. **Feedback: one file per `(runId, alertId)` with last-write-wins, or one file per record with full
   correction history?** Recommendation: per-subject. Both PRD-3 §14's "system of record" objection and
   roadmap §2's word "corrections" cut toward history.
5. **Is `CONSOLE_ALLOW_WRITES` plus a per-session cap worth the ceremony for a POC?** It keeps the
   *write* half of the guarantee literally true for every existing invocation, and it is the only cost
   ceiling in the repo. It does not keep the network half true.
6. **Should console-started runs force `INVESTIGATOR_TRACE=true`?** Without it, the Stream and
   Transcript tabs are empty for exactly the runs the analyst just started and is watching. With it,
   console-started and CLI-started runs diverge in observability and aggregate coverage, and PRD-3 §4.4
   requires that to be stated. Lean yes-and-say-so-on-screen.
7. **Should recording a `BenignPositive` classification offer to start a derived run seeded with that
   comment?** One keystroke, and it is where memory would eventually live — but it couples "overrule the
   verdict" to "steer the agent", which flow 4 deliberately keeps apart. Recommendation: not in this PRD.

---

## 7. Sequencing

**The ordering blocker is gone.** PRD-4 is complete and holds Phase 8, so this is Phase 9 and nothing
stands in front of it. That mattered for a substantive reason rather than a procedural one: PRD-4's
central finding was that a constant `tpPercent: 65` scored 6/6 against the old bands, so before it
landed, nothing shipped here could have been *shown* to improve anything. Now it can — which is also
exactly why the seeded-run exclusion in increment 3 is not optional.

The four increments below are independent enough to stop after any one of them.

**Increment 0 — the guards, before any write code exists.** All four pass *today* against unchanged
source, which is exactly why they land first: they then go red on the first write anyone adds, forcing
the seam to be named in a diff rather than assumed. (a) `ROOTS += "apps/console/src"` — one line,
verified 8/8. (b) The `apps/console/**` oxlint override, with both base pattern groups repeated verbatim
and a probe proving a scenarios import from console source still errors. (c)
`write-isolation.test.ts` against the console as it stands. (d) Fix `loadTrace`'s early return, which
neither clears `state.alertFacts` nor calls `render()` (`app.ts:338-350`) — latent today, visible the
moment either a queue selection or a zero-results run exists. **Increment 0 is independently valuable
and could be committed even if the rest is never built.**

**Increment 1 — the queue, still literally write-free.** The two workspace dependencies, `data/alerts.ts`
with the `AlertReader` narrowing, `view/coverage.ts`, the `queue` Screen and `a`, the three degraded
states, the count-with-caveat, and `y`-copies-the-CLI-command (`plannedAlerts` is already done).
The console still writes nothing and spawns nothing, so the header badge and `helpLines()` do not
change — except `console/src/index.ts:17-18`'s "never calls Mock Sentinel", which must. **This
increment delivers flow 1 whole and is the one to protect if scope is cut.**

**Increment 2 — the seam and flow 2.** `drive/spawn.ts`, the compose overlay, `n`, the synthetic pending
result across six call sites, the `children` map with exit-code capture and stderr tail, the `RUN_ID=`
scan, quit-with-live-children, `CONSOLE_ALLOW_WRITES` and the session cap, and the narrowed guarantee
text. Acceptance is `live.test.ts` extended with a zero-results in-flight artifact, triggered by a
keypress on an injected fake starter.

**Increment 3 — flows 3 and 4.** The investigator CLI flags and runtime needle rejection, the
`<analyst_context>` envelope and sanitisation, `derivedFrom` and `config.analystContext` through both
mirrors, the `↳` lineage rendering, `INVESTIGATOR_ESCALATION_MODEL` and `e`, `drive/feedback.ts` and
`d`, and **both** `evaluate-runs.ts` changes.

**Where this sits relative to the roadmap.** §6 says of itself that *"analyst-supplied context is the
write half of §2 Human Feedback, and promoting it to something durable is §1 Case Memory. This item is
the surface; those two are the substance behind it."* Scoping memory out is what makes the surface
implementable ahead of §1 — but flow 4 still touches §2, so the PRD must state explicitly that it
**records and does not consume**, with `AGENTS.md` §2's "cross-investigation memory" and
"human-feedback retrieval" lines left unamended as the reason. Flows 1 and 2 need no memory. Flow 3 is
the one that looks independent and secretly leans on it: retyping "this host is a scanner" every
investigation is precisely the toil §1 exists to remove, and the PRD must not claim it fixes that.

---

## Appendix — what was verified, and how

Verified directly against the working tree and the pinned dependencies:

- Console source contains zero ground-truth needles and 19 `.ts` files, so `ROOTS += "apps/console/src"`
  passes today, 8/8, including the guard-the-guard floor.
- Console source contains no write or spawn primitive; the only two grep hits are a template literal at
  `ui/panes/main.ts:218` and a prose comment at `data/trace-index.ts:129`.
- `.oxlintrc.json` contains no `investigator` pattern — ADR 006 §3 is enforced by nothing.
- `@opentui/core` 0.5.4 exports `TextareaRenderable`, `InputRenderable`, `SelectRenderable`,
  `TabSelectRenderable` from the bare specifier; ships no focus traversal.
- `set visible` blurs only `this`, with no recursion into descendants.
- `pi-agent-core` 0.84.2: `AgentState.messages` is settable, `initialState` is a partial `AgentState`,
  `agent_end` carries `messages: AgentMessage[]`; `AgentHarness` throws `HarnessNotImplemented`.
- `new Bun.Glob("*.json").scanSync` is non-recursive.
- `.gitignore:27-32` documents `/runs/` as regenerable developer scratch.
- `evaluate-runs.ts:122-128` keys `latestPerScenario` on `${model}::${scenario}`, last-wins.
- `investigator/src/env.ts:36-38` deliberately omits provider keys from the schema; `model.ts` does the
  provider-aware check.
- `investigator/src/index.ts`: `resolveModel` (`:79`) and the alert fetch (`:94-97`) both precede
  `runId` (`:99`) and the first flush (`:155`); the `SIGINT` handler registers at `:159`.

Reported by research agents and **not** independently re-verified here — treat as needing a spike before
they go into a PRD: Bun's `.env` loading behaviour in a spawned child at various `cwd`s; child survival
after parent exit in all three spawn modes; the 262 KB `/alerts` payload and the alert status
distribution; the 0.047 ms coverage-join measurement; `@opentui/keymap`'s `peerDependenciesMeta`; and
pi-ai's cross-model `transformMessages`.
