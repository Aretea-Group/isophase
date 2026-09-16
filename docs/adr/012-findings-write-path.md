# ADR 012 — The findings write path and unattended operation

**Status:** Accepted

**Date:** 2026-09-16

**Implements:** PRD-9 — Unattended Investigation and Findings Write-Back

**Reverses:** `AGENTS.md` §2 ("What stays out is … the Defender incidents API (§1), **any write path**, and Defender ground truth or scoring") — the write path half only. The Defender incidents API stays out, and Defender runs stay unscored.

**Amends:** ADR 009 §1 ("Azure Monitor Logs is the single data plane" — read-side; a write plane now sits beside it); ADR 011 §1 (Graph gains one write operation); ADR 010 §1 (`SecurityDataSource` is no longer the only source-neutral capability); PRD-5 §14 (the console's write-isolation carve-out is retired, not widened)

**Extends:** ADR 007 (`InvestigationControl` gains its second consumer — the unattended loop — as its own comment anticipated)

## Context

PRD-9 fixed the shape in conversation before any code existed. Implementation nonetheless met four
things the document could not have known, and this record exists for those: an ADR that only
restated the PRD would be a second copy of a decision rather than a record of one.

Where this contradicts PRD-9 §4.2, **this document wins and the PRD stays as written** — that is the
rule PRD-9's own header inherits from `create-prd`, and a PRD edited to match the code is no longer
evidence of what was agreed.

## Decisions

### 1. `FindingsPublisher` lives in `@soc/sentinel-client`, not `@soc/contracts`

PRD-9 §4.2 says "One method, in `@soc/contracts`". It is not there.

`@soc/contracts` holds Zod *data* schemas and nothing else — `SecurityAlert`, `QueryResponse`,
`SchemaTable`. The read capability it pairs with, `SecurityDataSource`, lives in
`@soc/sentinel-client` beside its three implementations. Following §4.2 literally would have put the
first capability interface in a package that has none, and split one capability across two packages
for the first time.

`AnalystClassification` and `ALERT_COMMENT_MAX_CHARS` *did* go to `@soc/contracts` (PRD-9 D7), which
is the same rule applied consistently: they are data, and the interface is not.

### 2. `publishFindings` takes rendered text, not an `InvestigationSummary`

PRD-9 §4.2 writes the signature as `publishFindings(alertRef, summary)`. The implementation is
`publishFindings(alert, body: string)`.

`InvestigationSummary` is a **TypeBox** type in `apps/investigator/src/contracts/summary.ts` —
TypeBox because `pi-agent-core` forces it at the tool boundary (ADR 005 §5). Naming it in
`@soc/sentinel-client` would point a package at the app that consumes it, reversing the dependency
direction the whole chain rests on.

Rendering is also not a connector's judgement. How this project's assessment should read to an
analyst is a product decision; it lives in `apps/investigator/src/publish.ts`, and it is the place
the §3 fence is actually enforced — `renderFindings` states a likelihood and sets no classification,
with a test asserting the forbidden words are absent.

### 3. Truncation is detected by "received equals the requested cap", not by `$count`

PRD-9 AC19 asks the loop to report truncation "with the `$count` and the number received".
`$count` is not available to it.

`SecurityDataSource.listAlerts(limit?)` returns `SecurityAlert[]`. The Defender connector requests
`$count=true` and discards it; surfacing it would mean widening the source-neutral interface with a
count that Mock Sentinel, Azure Sentinel and the fixture source have no notion of — a Defender
concept pushed into a contract three other implementations must answer.

The loop instead passes an explicit limit and treats *receiving exactly that many* as the signal.
It is source-neutral, needs no interface change, and catches the same failure: a window holding more
alerts than one page can return, where the remainder are invisible rather than queued. The reported
numbers are the cap and the count received; `$count` itself is not among them.

### 4. One named read seam in the investigator, for `runs/` only

`apps/investigator/test/ground-truth-isolation.test.ts` forbids any runtime file read by a computed
path anywhere in `apps/investigator/src/`. `seen-alerts.ts` needs one: the deduplication half of
PRD-9 D10 reads `runs/*.json` at watch startup, and that read is what lets the loop keep no cursor
of its own.

The guard now names that one file, in the pattern `write-isolation.test.ts` already uses for its
single network seam, and asserts the file still exists so a rename cannot silently re-open the tree.
Three conditions justify it and all must hold: it reads only `env.RUNS_DIR`, which this process
already writes to; it runs in the CLI adapter before any investigation starts and returns a
`Set<string>`, never a path; and nothing in the harness, the tools or the prompt can reach it.

**This is the weakening to watch.** The guard's value is that its exception list is short, and a
second entry should be argued for as hard as this one.

### 5. The seen-set carries two things, and a failure releases one of them

Not in PRD-9 at all, and subtle enough that it was a bug before it was a decision.

`seenAlertIds` holds alerts with an artifact on disk (seeded at startup) *and* alerts the loop has
in flight (claimed just before `start`, because `start` returns immediately and the next pass would
otherwise start the same alert again). On `run_failed` the claim is released; on parking it is
released too, so the cycle report says *parked* rather than *already run*.

Without the release, `maxFailuresPerAlert` is unreachable and one transient error drops an alert for
the process lifetime. Across processes the artifact still wins — a failed run wrote one — so
retrying is bounded to a single process, which is what AC10 asks for.

### 6. `alerts_v2` does not accept a comment, and PRD-9 §4.2's Graph publisher cannot be built

**Measured 2026-09-16** by `bun run probe:defender --only I --write-probe`, against the live tenant,
on alert `snd726887c-…`:

| Call | Result |
|---|---|
| `PATCH /security/alerts_v2/{id}` with `{comments:[{comment}]}` | **200** |
| `comments` in that response | `[]` |
| `GET /security/alerts_v2/{id}` immediately after | `comments: []` |

`comments` is **returned as a property by both calls**, so this is not a projection artifact and
`$expand=comments` would not change it — the research note's §492 question about `$select`/`$expand`
is not what is happening here. Graph accepted the request and discarded the field.

PRD-9 §4.2 specifies the Graph publisher as *"`PATCH /security/alerts_v2/{id}` against the alert's
`comments` collection"*. **That does not work, and no payload shape makes it work** — a 200 that
persists nothing is not a shape problem.

This is PRD-8 §4.1 D12 earning its place: the rule that forbids connector code before a probe runs
is the only reason this was found before a publisher was written against it rather than after.

**Decided 2026-09-16: publication targets the incident.** `POST /security/incidents/{id}/comments`,
with `incidentId` read off the alert the investigation already fetched.

`AGENTS.md` §2 excluded "the Defender incidents API" and is narrowed rather than reversed, because
ADR 011 §1's stated reason does not reach this. Verbatim:

> It stays out because an incident is a different investigation unit — a group of alerts — and the
> run artifact, the evaluation join and the console queue are all keyed on one alert id

Writing a comment does not make an incident an investigation unit. The run stays keyed on one alert;
only the comment's destination changes. What remains excluded is reading incidents to *drive*
investigation — enumerating an incident's alerts, or scoring one.

Two consequences worth stating rather than discovering:

- **The permission widens.** `SecurityIncident.ReadWrite.All` permits updating any incident in the
  tenant; this project uses one additive comment from it. Graph offers no comment-only scope, so the
  restraint is this project's fence rather than Entra's — and the object it guards now groups many
  alerts rather than being one. `docs/defender-setup.md` says so in those terms.
  `SecurityAlert.ReadWrite.All` is dropped: it buys nothing.
- **Alerts fan into incidents.** One incident collects one comment per investigated alert, so
  roadmap §8's per-alert-verdict ceiling — "ninety alerts drawn from one intrusion produce ninety
  unrelated verdicts" — becomes visible on the analyst's incident page rather than only in the run
  corpus. That is honest and it is also the most likely source of "this tool is noisy". The probe
  measures the ratio per tenant so the judgement is made against a number.

**No connector code exists yet.** PRD-8 §4.1 D12 forbids it until the probe has run against a real
incident, and that rule has now paid for itself once in this very section. `scripts/probe-defender.ts`
section I carries the probe (I4–I6); `LocalFindingsPublisher` remains the only implementation until
it answers.

### 7. The Defender connector is the Graph publisher, selected by capability and opt-in

`DefenderClient` implements `FindingsPublisher` alongside `SecurityDataSource` rather than a
parallel class existing beside it. `#request` already owns the cached token, the timeout and the
error mapping; duplicating them would acquire a second token per run to say the same thing twice.

Selection is a **capability** check — `selectPublisher` asks whether the primary source has a
`publishFindings`, never what kind it is — so `AGENTS.md` §3's ban on branching investigation flow
on source kind holds unchanged.

Publication is **opt-in via `PUBLISH_FINDINGS`, default off**. Choosing a connector must not start
commenting on someone's live incidents as a side effect: `docs/defender-setup.md` presents the
read-only permission pair as a complete configuration, and a run that began writing because
`SECURITY_SOURCES` changed would make a liar of that page. The permission is the second gate.

### 8. An incident comment is capped at 1,000 characters, and the renderer has a short form

**Measured 2026-09-16** on a live publish, not documented anywhere this project found:

```
Maximum comment length is 1000 characters, received 2913.
```

Phase 0 lifted `ALERT_COMMENT_MAX_CHARS = 30_000` from Sentinel's documented *alert* comment bound
and PRD-9 §4.2 used it for publication. That bound is real and applies to a different object. The
incident limit is thirty times smaller, and assuming one covered both is what produced this error
against a real tenant.

Two things follow:

- **The publisher declares its own limit.** `FindingsPublisher.maxBodyChars` is optional and set by
  the destination, because only the destination knows. `LocalFindingsPublisher` declares none.
- **The renderer re-renders short rather than truncating long.** `renderBrief` keeps the verdict,
  the narrative, the strongest evidence and the disclaimer, and drops the rest. Cutting the full
  body at 1,000 characters would have removed its tail — which is where the evidence and the
  "status and classification are unchanged" sentence live — leaving an analyst the confident opening
  with none of the qualification.

This is the second time in one phase that a 200 or a documented number turned out not to mean what
it appeared to. Both were caught by running against a real tenant rather than by reading; neither
would have been caught by a unit test written from the same assumption as the code.

### 9. Five defects found by review, and what they change

`review-prd` ran against the finished implementation and found seven defects; five were fixed and
two are recorded below as open. None was caught by the 582 tests that were green at the time, and
three were only visible against a live tenant or in a real artifact. They are recorded here rather
than in PRD-9 because the PRD described the intended behaviour correctly — the code did not.

**The watch alert window never reached the query.** `index.ts` set
`InvestigatorConfig.alertWindow`, which `execute-run.ts` uses *only* to stamp the artifact. The
window that filters the poll belongs to the connector and comes from `DEFENDER_ALERT_WINDOW`.
Measured on the operator's tenant: `.env` carried `P90D`, so every run in this project's history
polled ninety days while recording whatever `WATCH_ALERT_WINDOW` said, and `assertWatchWindow` —
the whole of AC18 — validated a number with no effect. **D10's first bullet was not implemented.**
Fixed by overriding at the source factory, where the connector is built.

**Every network-published run ended on disk as `status: "running"`.** `publishThenFlush` fires from
`onResult` and its first `await` is the network, so its flush landed after the terminal one and last
write won. Confirmed on four real artifacts: both `local` runs ended `completed`, both
`defender-graph` runs ended `running`. The console renders those as never finishing. Fixed by
awaiting pending publications before the terminal flush.

**`PUBLISH_FINDINGS` was documented nowhere a reader looks.** The README named the *permission* as
the gate; the flag defaults to off. A reader who followed the README exactly got the local publisher
and a log line reading `published … via local`. **The Purpose in PRD-9 §1 was unreachable through
the documented path.** Fixed in the README; `.env.example` still needs it — that path is denied to
this tooling.

**Quitting an attached console shut down the watch process.** `app.ts` called `control.shutdown()`,
correct reasoning for PRD-5 when every control was in-process, wrong once `--attach` makes it
remote. AC14 was green because its test calls `disconnect()`, which the console never called. Fixed
by adding an optional `detach()` to `InvestigationControl`, implemented only where the runs belong
to someone else.

**SIGINT skipped every cleanup path, and SIGTERM was unhandled.** `process.exit(130)` ran in the
same tick as `controller.abort()`, so no interrupted flush, no shutdown of in-flight runs, no socket
close. The alert stayed in `plannedAlerts`, which counts as seen — **consumed and never retried,
the exact inverse of D3**. Fixed with a bounded grace period; a second signal still exits at once.

**Still open**, and deliberately not fixed here because each is a design question rather than a slip:

- **An ordinary investigation failure never reaches parking.** `InProcessControl` emits
  `run_failed` only on a supervisor fault; a model timeout arrives as `run_completed` with a failed
  *result*. AC10's retry path cannot fire for the common case.
- **One `listAlerts` failure ends the daemon.** No try/catch, no backoff — §4.2 promises backoff and
  there is none. A single Graph 429 at 03:00 stops the loop.

**And one claim in this document was itself false.** §3 above said "the loop instead passes an
explicit limit"; `InvestigationControl.listAlerts()` takes no limit parameter and the connector
always requests `$top=501`. The truncation branch can only fire at exactly 500, and above the cap
the connector throws into a loop with no handler. AC19 is unproven and the mechanism is
near-unreachable; correcting the design is left to a later phase rather than patched here.

### 10. A sweep that produced nothing is `failed`, and reaches the parking machinery

**Amends** PRD-3 §7's status vocabulary and `apps/investigator/src/contracts/run.ts`.

`InvestigationRun.status` documented `failed` as "the sweep that died before it could investigate
anything", deliberately a different axis from per-result status. `finalStatus` therefore never
inspected results, and a sweep whose every alert timed out was written `completed`. Three things
followed, none of them intended:

- the console drew a **green tick** over a failed investigation, because `classifyRun` keys on run
  status;
- `InProcessControl` emitted `run_completed`, so the watch loop added the alert to `seenAlertIds`
  and **cleared its failure counter** — `maxFailuresPerAlert` and PRD-9 AC10's parking could never
  fire for a model timeout, which is the commonest failure there is;
- nothing reading the run alone could distinguish a successful sweep from a wholly failed one.

`failed` now means **the sweep has nothing to show**: it died before investigating, *or* it ran and
no alert inside it succeeded. Partial success stays `completed` — one alert failing out of five is
not a failed sweep. `InProcessControl` emits `run_failed` for it, after the `aborted` check so a
cancelled run is still `run_cancelled`.

**Verified safe before changing it**, because the corpus is append-only: `scripts/evaluate/report.ts`
guards `run.status === "failed" && run.results.length === 0`, so a run *with* failed results never
trips it, and every scoring path keys on result status. `apps/console/src/data/runs.ts` types the
field as a loose string and already maps `failed` → `✗`. No consumer needed rewriting.

Two smaller repairs travel with it. A startup-failure artifact now records the alert it was for —
`alerts` is still empty on that path, so the artifact could not say, and the console had no result
row to offer a re-run against. And `openCompose("rerun")` falls back to a sweep's single planned
alert, so `r` finally works on the failure class a retry most obviously fixes; a multi-alert sweep
still refuses, because re-running "it" would mean guessing which.

### 11. The loop backs off; the connector still never retries

**Narrows** ADR 011 §9 and PRD-7 §8 without weakening either.

`watch.ts` called `listAlerts()` bare. One Graph 429 at 03:00 propagated out of `runWatch`, and
`index.ts` printed a line and exited 1 — against a PRD-9 §4.2 that promised backoff and a §7 that
required it be observable. Neither was built, and **PRD-9 has no acceptance criterion for backoff at
all**, which is why nothing caught its absence.

The apparent conflict with ADR 011 §9 is not one. That section forbids the **connector re-issuing a
request**, for a stated reason: advanced hunting's quota is a shared per-tenant CPU allowance, so a
retry deepens the outage for every other consumer. Delaying the loop's **next scheduled poll** has
the opposite effect — it sends strictly fewer requests than the configured cadence. Nothing in
`packages/sentinel-client/` changed.

`apps/investigator/src/backoff.ts` classifies a failed poll:

- **throttled** (429) waits the full ceiling immediately. Graph documents the quota as resetting on
  a fifteen-minute cycle, so a shorter wait spends a request that cannot succeed.
- **transient** (`unreachable`, `upstream_unavailable`, `internal_error`) backs off exponentially
  with full jitter, capped at `WATCH_BACKOFF_MAX_MS`.
- **permanent** (401/403/404/400) **stops the loop** with a non-zero exit. An expired secret does not
  heal, and a loop that polls through one looks alive while doing nothing — which is worse than
  stopping, because nobody investigates a healthy-looking process. PRD-9 §3 puts deployment
  artifacts out of scope, so exiting is the only signal a supervisor can act on.

Three implementation notes that are not obvious:

- Classification is **structural, never `instanceof`**. `socket/server.ts` serialises a rejection to
  `{name, message}` and the client rebuilds a plain `Error`, so a remote control's failure carries no
  `.code` — an `instanceof` check would misclassify every socket-delivered failure, which is exactly
  the configuration an attached console runs in.
- **Anything unrecognised is treated as transient.** Stated so it can be disagreed with: the daemon
  is slower to surface a novel permanent fault, but it survives an error shape Microsoft adds later.
- **Backoff widens the window invariant.** `assertWatchWindow` enforced `window ≥ k × interval`, but
  backing off widens the *effective* gap between polls — so a loop safe at startup could let alerts
  age out precisely when the tenant was least able to say so. The assertion is now against
  `max(pollInterval, backoffCeiling)`, and raising the ceiling past the window is refused at startup.

**Empty-queue backoff is dropped deliberately.** PRD-9 §4.2 promised it; one poll against a 150/min
budget is cheap, and slowing down makes a new alert wait longer for no saving. Recorded here rather
than left looking unimplemented.

## Consequences

`AGENTS.md` §2's "any write path" non-goal is gone and §3 gains a write-side rule: investigation
control flow reaches the publisher through `FindingsPublisher` and never branches on which
implementation is behind it, exactly as it already does for reads.

PRD-5 §14's write-isolation claim is *stronger*, not weaker: `apps/console/src` now contains no
filesystem write primitive at all, because PRD-9 Phase 0 removed the `drive/` seam it used to
except.

The measured tenant answers that PRD-9 §10 asked for are recorded. Q2: `alerts_v2` returns alerts
with `serviceSource: microsoftSentinel`, so this workspace is onboarded to the Defender portal and
D8 holds — one Graph publisher covers both products. Q1: the write probe has since run, and the
answer is no — `comments` is not `PATCH`-writable app-only on `alerts_v2`, which is §6 above. That
probe stays opt-in because a Graph comment cannot be deleted.
