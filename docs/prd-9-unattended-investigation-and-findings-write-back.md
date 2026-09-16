# PRD-9 — Unattended Investigation and Findings Write-Back

**Status:** Approved

**Depends on:** PRD-5 — Console as an Operator Surface; PRD-8 — Microsoft Defender Data Source
**Produces:** ADR 012 — The findings write path and unattended operation
**Amends:** ADR 009 §1 ("Azure Monitor Logs is the single data plane" — read-side only; a write plane is added beside it); ADR 011 §1 (Graph gains one write operation); `AGENTS.md` §2, §3, §5
**Reverses:** `AGENTS.md` §2 ("What stays out is … the Defender incidents API (§1), **any write path**, and Defender ground truth or scoring")
**Language/runtime:** TypeScript `strict` on Bun; no new runtime dependency
**Runtime schemas:** Zod 4 for the publication contract and the control protocol; TypeBox stays confined to the Pi tool boundary (ADR 005 §5)

## 1. Purpose

Eight PRDs in, nothing this system produces reaches the person who has to act on it. Every verdict
lands in `runs/*.json` and a local TUI. An analyst working the same alert in their security portal
sees none of it, and has no way to discover that an investigation happened at all.

The work is also entirely hand-cranked. Investigating *n* alerts costs *n* human actions — one
`bun run investigate --alert <id>` or one console keypress each. The mock corpus holds 154 alerts;
the live tenant produces them on its own schedule, and nobody is watching at 03:00.

And the system cannot currently be run by anyone but its authors. The documented front door is
`bun run infra:up` and `bun run data:bootstrap`: a Kusto Emulator on an amd64-only image, Colima
with Apple Virtualization and Rosetta, a pinned telemetry revision. A reader who has a Microsoft
Defender tenant and no Docker has no path through the README at all, even though `@soc/investigator`
depends on nothing but `@soc/contracts` and `@soc/sentinel-client` and needs none of it.

Why now: the project is being released as open source, and this is the minimum scope at which a
stranger can get value from it.

## 2. Goals

- A stranger points this at their own tenant and it investigates new alerts unattended, with
  findings landing on the alert in their portal.
- Run mode requires Bun and tenant credentials and nothing else. The Kusto Emulator, the fixtures
  and the telemetry bootstrap are develop-mode only. Bun is the runtime the software is written in
  and is not optional; the emulator exists only to fake a data source a tenant user already has.
- The console is optional in both directions: absent, the loop runs; attached, it has the same
  control PRD-5 shipped.
- The evaluation bench — ground truth, scoring, the `runs/` corpus — still works unchanged for
  contributors.

## 3. Non-Goals

- **Cross-investigation / case memory.** State management, concurrency and memory distillation are
  disproportionate at this scope. → the consolidated roadmap entry written in Phase 0.
- **Human feedback capture.** `feedback/` and `apps/console/src/drive/` are removed, not left in
  place collecting records nothing reads. → the same roadmap entry.
- **A durable-execution runtime** (Temporal-style workflows, crash-resumable mid-run state). → the
  same roadmap entry, recording that the idempotency key already provides crash recovery (§4.1 D3).
- **Closing alerts, or setting `status`, `classification`, `determination`, or any remediation
  action.** This PRD writes information and nothing else. This is the fence most likely to be
  crossed during implementation, because every comment invites "and set the classification while
  we're here." → permanently out; a future PRD would need its own decision record.
- **Standalone (non-onboarded) Microsoft Sentinel workspaces.** Their alerts are unreachable from
  `alerts_v2`, and the Sentinel REST API that serves them is documented as being retired
  (`research-defender-api.md` §119). Onboarded Sentinel needs no separate work — its alerts are in
  `alerts_v2` with `serviceSource: microsoftSentinel`. → out; revisit only if the retirement stalls.
- **TCP sockets, remote attach, or authentication on the control channel.** Unix domain socket,
  local machine, single user. → keeps `AGENTS.md` §2's no-RBAC and no-multi-tenancy lines intact.
- **Deployment artifacts** — container images, Azure Functions, systemd units. The user starts a
  process. → the roadmap, if demand appears.
- **Richer assessment content** — evidence citations, incident timelines, enumerated alternative
  hypotheses. Tempting precisely because this PRD writes prose into a case. → roadmap §5, which
  already owns the `InvestigationSummarySchema` changes each would need.
- **Reacting to alert lifecycle transitions** — re-investigating a re-opened alert, noticing a
  reassignment, following a merge into an incident. The loop acts on creation only (§4.1 D11).
  Re-investigation in particular is an unbounded cost multiplier that deserves weighing on its own
  terms. → the roadmap, beside case memory.
- **Alert grouping and incident correlation.** → roadmap §8.
- **Security schema and context optimization.** → roadmap §3.

## 4. Design

### 4.1 Decisions (locked)

**D1. Write-back is one interface — `FindingsPublisher` — with two implementations, local and
Graph.** The local implementation is what lets the entire loop run with no tenant, which is what
makes the open-source on-ramp work. It is *not* justified by a future Sentinel implementation: see
D8.

**D2. The unattended loop is a role of the investigator binary, consuming `InvestigationControl`.**
ADR 007 already names a non-in-process implementation as the intended second one — "a spawned child
or a queue worker is another, swappable without the caller changing." A fourth app would also make a
fourth file read the environment, and `CLAUDE.md` records that there are exactly three.

**D3. No durable-execution runtime.** A crash mid-investigation leaves no artifact in `runs/`, so
the next poll re-picks that alert. The idempotency key is the crash recovery, which is why the
Temporal-class machinery that is standard for long-running agents is not warranted here. Recorded so
nobody adds one later reasoning from first principles.

**D4. Control is a unix domain socket, and `RemoteInvestigationControl` implements the existing
`InvestigationControl`.** `ControlEvent` is already a plain discriminated union — it was made
deliberately not Pi's `AgentEvent` because that type is "meant to become an API surface" — so the
protocol is seven request/response methods and one event stream. No console code changes.

**D5. Publication is additive and reversible — a comment, never a state change.** It is what makes
the loop safe to run unattended, and it keeps roadmap §5's assessment-contract work out of scope.

**D6. The memory code is removed; the memory capability goes to the roadmap.** These are two
separate statements and both hold. The *code* — `drive/feedback.ts`, the `feedback/` directory and
every consumer in §8 — is deleted rather than left in place collecting records nothing reads, which
is a dead end at this scope and is filesystem-write code in the layer meant to be optional. The
*capability* — case memory, tenant context, human feedback — is written into the consolidated
roadmap entry in Phase 0 and remains a legitimate future direction. Removing `drive/` also returns
the console to having no filesystem write primitive at all, retiring PRD-5 §14's write-isolation
carve-out.

**D7. `AnalystClassification` moves to `@soc/contracts` rather than leaving with the feature.** The
four-member vocabulary and the 30,000-character comment bound were derived from Sentinel's own
documented limits; re-deriving them later is the waste. This also makes roadmap §5's claim that
"nothing in the current contract maps onto them" stale, and Phase 0 corrects it.

**D8. Onboarded Sentinel needs no separate publisher.** Its alerts are returned by `alerts_v2`, so
one Graph implementation covers Defender-native and onboarded-Sentinel alerts through the same
`PATCH` and the same permission. Tenants onboarding Sentinel after 2025-07-01 are onboarded
automatically (`research-defender-api.md` §122).

**D9. The write permission is `SecurityAlert.ReadWrite.All`, granted as an *application* permission
on one Entra app registration, with admin consent — and the service-principal concept is
documented.** Not delegated: the loop runs unattended with no signed-in user. `docs/defender-setup.md`
already documents this shape for the two read permissions PRD-8 needed, tenant-free by construction;
the write permission extends that page rather than starting a second one. The page must state, for a
reader setting this up in their own tenant, what each permission buys and why the set is minimal —
a new user should not have to infer least privilege from a list of scopes.

**D10. New alerts are found by a sliding window plus artifact deduplication — no cursor, no
watermark file.** `SecurityDataSource.listAlerts(limit?)` takes no time argument; the Defender
connector filters `createdDateTime ge (now − alertWindow)` with `$top` capped at 500 and
`$count=true`. That window, intersected with "has no run artifact", *is* the definition of new, and
it needs no persistent state of its own — which is what keeps D6's removal of state management
honest. Three constraints follow and are load-bearing rather than incidental:

- **Watch mode overrides the alert window.** The `P7D` default suits one-shot backfill; a polling
  loop needs a window sized to its interval. Startup asserts `window ≥ k × interval`, because an
  alert created between two polls that falls outside the window is never investigated at all.
- **Truncation is detected and reported, never silent.** `P7D` against the 500 cap in a busy tenant
  returns an arbitrary 500 with no `$orderby`: the loop then either re-lists the same 500 and
  starves, or sees a different 500 each cycle and coverage becomes random. `$count` is already
  requested; compare it to what arrived and say so when the cap bites.
- **The watermark is `createdDateTime`, not `lastUpdateDateTime`.** One investigation per alert; an
  alert that churns after being investigated is not re-investigated. Currently implicit in the
  connector, stated here because the loop makes it observable — and because of the hazard in §4.2:
  the loop's own `PATCH` bumps `lastUpdateDateTime`, so watermarking on it would make the loop
  re-investigate its own comments until the spend ceiling stopped it.

**D11. The loop reacts to alert *creation* only. No lifecycle transition ever triggers work.** An
alert already closed when first seen is skipped; one closed, re-opened, reassigned, merged into an
incident or edited after its investigation causes nothing. §3 already excludes managing case
lifecycle, and reacting to lifecycle transitions *is* lifecycle management — re-investigation on
re-open goes to the roadmap, where its unbounded cost can be weighed on its own terms.

The skip filter is a configured set of vendor status strings the operator supplies
(`WATCH_SKIP_STATUSES`), never a hardcoded comparison: `SecurityAlert.status` is verbatim from the
source (ADR 010 §2, "source taxonomies remain strings"), so `status !== "resolved"` in the loop
would be a branch on source kind in disguise, which `AGENTS.md` §3 forbids. **It defaults to empty**
— a wrong default silently skips alerts, which is worse than a visible cost — and the loop reports
the distinct status values it saw in its first cycle so the operator configures it from their own
data rather than guessing.

**D12. Publication lives inside `executeRun`, so every caller publishes — the loop and a
console-launched run alike.** One action, one behaviour, regardless of who started it. The
alternative was for only the loop to publish, which makes "investigate this alert" mean two
different things depending on the entry point and leaves a console-launched investigation invisible
to the analyst working the case. Re-running an alert from the console therefore writes to the case
too; the marker in §4.2 is what stops that becoming a second comment.

### 4.2 Design details

**`FindingsPublisher`.** One method, in `@soc/contracts`:

```text
publishFindings(alertRef, summary) -> caseRef
```

`alertRef` identifies the alert in its own source's vocabulary; `caseRef` is what the publisher
wrote, so the run artifact can record where the finding went. The investigator holds the interface
and never branches on which implementation is behind it — the rule `AGENTS.md` §3 already applies to
reads.

- **Local** records the publication into the run artifact and writes nothing external. It is the
  default, so a clone with no credentials still exercises the whole path.
- **Graph** issues `PATCH /security/alerts_v2/{id}` against the alert's `comments` collection, using
  the `ClientSecretCredential` and transport PRD-8 already established.

Publication failure must never lose an investigation: the run artifact is written regardless and
records the failure, because the artifact is the durable output and the comment is a copy.

**Publication is idempotent, and the mechanism is a marker.** The comment carries a stable
identifying prefix, and the publisher reads the alert's existing comments before writing. Without a
marker "no duplicate comment" (AC6) is not implementable — a retry after a partial failure, or a
re-run of the same alert, has nothing to recognise its own previous write by. The local publisher
holds the same contract against the run artifact's publication block.

**The loop.** A watch role on the investigator binary, consuming `InvestigationControl` and adding
no second execution path. Per cycle:

1. `listAlerts()` against the primary source, which returns alerts created inside the configured
   sliding window (D10).
2. Compare the returned count against `$count` and report truncation if the cap bit.
3. Drop every alert that already has a run artifact. The seen-set is built once at startup from
   `runs/` and updated as runs complete — not a directory scan per cycle.
4. Start what remains, under the existing `maxConcurrent` ceiling.
5. Publish each result through `FindingsPublisher`.
6. Sleep for the poll interval, or back off.

Steps 1 and 3 together are the whole definition of "new", and neither writes state. The startup
assertion `window ≥ k × interval` is what makes step 1 complete rather than lossy; without it an
alert created between two polls can age out of the window before any poll sees it.

**The alert lifecycle, exhaustively.** Most of these are "do nothing", recorded as decisions rather
than left as omissions (D11):

| Event | Loop behaviour | Why |
|---|---|---|
| Alert created | investigated once | the normal path |
| Already closed when first seen | skipped, per `WATCH_SKIP_STATUSES` | paying to investigate what a human already closed is the most expensive failure mode |
| Closed after our investigation | nothing; the comment stays | we do not manage lifecycle |
| Re-opened after our investigation | nothing | re-investigation is unbounded in cost and is roadmap work |
| Reassigned | nothing | not ours to track |
| Merged into an incident | nothing; the comment stays on the alert | alert grouping is a non-goal |
| Deleted | nothing; the orphan run artifact is harmless | |
| Any field updated | nothing | the watermark is `createdDateTime` |

**Hazard — the loop can feed itself.** Publishing issues a `PATCH`, which bumps the alert's
`lastUpdateDateTime`. A future change of the watermark from `createdDateTime` to
`lastUpdateDateTime` would therefore make every published alert look new again, and the loop would
re-investigate its own comments until the spend ceiling halted it. The field choice in D10 is load
bearing for this reason, not for tidiness.

**First start against a tenant with history.** A new operator sees one window's worth of alerts and
no more; six months of backlog is invisible. This is intended — the window is the only knob, and
widening it once is the answer rather than a separate backfill mode — but it surprises people, so
the setup documentation states it.

Four further properties, none of which exist today: a **spend ceiling** (unattended means nobody
notices the bill), **poison-pill parking** (an alert that always fails must not retry forever),
**backoff** against both throttling and an empty queue, and **graceful shutdown** through the
`AbortSignal` PRD-5 §6 already threads.

> **Amended by ADR 012 §11.** Backoff against *throttling* shipped; backoff against an *empty queue*
> was dropped deliberately — one poll against a 150/min budget is cheap, and slowing down makes a new
> alert wait longer for no saving. Parking also needed §4.1's status change (ADR 012 §10) before it
> could fire at all: a model timeout arrived as `run_completed`, so the alert was recorded as seen. Bounded concurrency is not on that list because
`InProcessControlOptions.maxConcurrent` already provides it.

**The control socket.** The watch process listens on a unix domain socket; the console connects
through `RemoteInvestigationControl`. Wire format is newline-delimited JSON validated by Zod on both
ends, which is the repo's existing contract tool for REST, configuration and run artifacts. The
protocol surface is exactly `InvestigationControl`: `listAlerts`, `listModels`, `listTools`, `start`,
`cancel`, `live`, `shutdown` as request/response, and `subscribe` as a server-to-client stream.
`RunHandle.settled` is the only non-serializable member and is reconstructed client-side by
resolving when a terminal event for that `runId` arrives.

**Develop mode and run mode.** The split is already true at the dependency level — `@soc/investigator`
depends on `@soc/contracts` and `@soc/sentinel-client`, and neither reaches Docker, Kusto or the
fixtures. What is missing is the front door: `SENTINEL_CONNECTOR` defaults to `mock`, and the
documented commands lead with `infra:up` and `data:bootstrap`. Phase 5 changes the defaults and the
documentation, not the architecture.

## 5. Phasing

**Phase 0 — Subtract, and start the clock.** Remove `apps/console/src/drive/` and the `feedback/`
capture path with every consumer listed in §8; lift `AnalystClassification` into `@soc/contracts`;
write one consolidated roadmap entry covering case memory, human feedback and durable execution;
state the `SecurityAlert.ReadWrite.All` requirement so admin consent can begin in parallel.

*Exit:* `bun run check` is green with `drive/` absent, and the permission requirement is with the
operator.

**Phase 1 — `FindingsPublisher` and its local implementation.** The contract in `@soc/contracts`, the
local publisher, and the wiring through `executeRun` that records publication into the run artifact.
No tenant required.

*Exit:* an investigation against Mock Sentinel produces a run artifact whose publication block names
the local publisher and a `caseRef`.

**Phase 2 — Probe, then the Graph publisher.** Extend `scripts/probe-defender.ts` to settle two
questions against a real tenant — whether `comments` is `PATCH`-writable app-only, and whether the
workspace is onboarded, by asking whether `alerts_v2` returns anything with
`serviceSource: microsoftSentinel` — then implement against what it measured, per PRD-8 §4.1 D12.

*Exit:* a findings comment written by the agent is visible on a real alert in the portal.

**Phase 3 — The headless loop.** The watch role: poll, skip alerts with runs, start under the
existing concurrency ceiling, publish, back off, sleep. Adds the spend ceiling, poison-pill parking
and graceful shutdown from §4.2.

*Exit:* one unattended sweep of Mock Sentinel investigates every alert exactly once and halts on the
configured spend ceiling.

**Phase 4 — The control socket.** The socket server in the watch process, the Zod protocol schemas,
and `RemoteInvestigationControl`. The console attaches over it with no change to its panes.

*Exit:* a console attaches to a running watch process, shows a live run it did not start, cancels it,
and detaches without stopping the loop.

**Phase 5 — The run-mode front door.** Defaults, entry points, and setup documentation for a reader
with a tenant and only Bun installed. Extends `docs/defender-setup.md` with the write permission and
the service-principal concept from D9 — one app registration, application permissions, what each
permission buys — plus the Sentinel-onboarding prerequisite for anyone whose alerts live there.

*Exit:* a clean clone, Bun, and one tenant credential reach a first published finding by following
the README alone.

## 6. Success criteria / Metrics

| Measure | Today | Target | How measured |
|---|---|---|---|
| Findings reaching a security portal | 0 | every completed investigation, or a recorded failure | the publication block in `runs/*.json`, joined against the portal in Phase 2 |
| Human actions to investigate *n* alerts | *n* | 1 (start the loop) | count of invocations in the Phase 3 sweep |
| Console control over an in-flight run | full (PRD-5) | unchanged after Phase 4 | AC12–AC14; Phase 3 is a deliberate, temporary regression |
| Steps from clean clone to first finding, Bun only | not reachable | the README's numbered list | AC16, executed on a machine with no Docker or Colima |
| Alerts in the window left uninvestigated | undefined — no loop exists | zero, or a reported truncation | AC18, AC19 |

The third row exists to make the Phase 3→4 regression explicit rather than discovered. Shipping
Phase 3 without Phase 4 leaves the console able to observe completed runs but not to cancel or
watch them live.

## 7. Observability

Unattended means nobody is watching, so the loop must be legible from its output alone.

- One structured line per cycle: alerts seen, alerts skipped as already-run, started, published,
  failed, spend to date against the ceiling.
- One line per publication: `runId`, `alertId`, publisher, `caseRef` or the failure — and whether
  the marker found an existing comment and skipped.
- The distinct alert status values seen in the first cycle, so `WATCH_SKIP_STATUSES` is configured
  from the operator's own data rather than guessed (D11), plus a count of alerts skipped per cycle
  by that filter — a skip that is never reported is indistinguishable from an alert nobody saw.
- Parked alerts named when parked, with the failure count that parked them — a silent park is
  indistinguishable from an alert nobody ever saw.
- Backoff entered and left, with the reason, so throttling is distinguishable from an empty queue.
- The existing per-run `onMetrics` (PRD-6 §6.7) continues to carry turns, tool calls and cost; the
  loop aggregates rather than replacing it.

## 8. Legacy removal checklist

Every consumer of the feedback capture path that must migrate or be deleted in Phase 0:

- [x] `apps/console/src/drive/feedback.ts` — deleted; `drive/` disappears with it
- [x] `apps/console/src/ui/app.ts` — the Verdict-pane classification block and its key bindings
- [x] `apps/console/src/view/format.ts` — feedback rendering helpers
- [x] `apps/console/src/env.ts` — the feedback directory key
- [x] `apps/console/test/drive.test.ts` — deleted
- [x] `apps/console/test/write-isolation.test.ts` — the `drive/` exclusion is removed, tightening
      the claim rather than loosening it
- [x] `apps/console/test/queue.test.ts` — feedback-dependent assertions
- [ ] `packages/contracts/src/errors.ts` — feedback error variants
- [x] `scripts/reset-queue.ts` and `scripts/reset-queue.test.ts` — the `--include-feedback` flag
- [ ] `feedback/` directory and its one record — removed from the working tree
- [x] `AGENTS.md` §5 — the `feedback/` line in the repository shape
- [x] `AnalystClassification` and the 30,000-character comment bound — **lifted** to
      `@soc/contracts`, not deleted (§4.1 D7)
- [x] `docs/roadmap.md` §5 — the claim that nothing in the contract maps onto Sentinel's
      classifications is stale once D7 lands; correct it

## 9. Acceptance criteria

- [x] **AC1** — Given the console source tree after Phase 0, When the write-isolation scan runs,
      Then no filesystem write primitive exists under `apps/console/src` and `drive/` is absent.
      _(test: unit)_
- [x] **AC2** — Given `@soc/contracts`, When `AnalystClassification` is imported, Then it exports
      exactly `TruePositive`, `BenignPositive`, `FalsePositive` and `Undetermined`. _(test: unit)_
- [x] **AC3** — Given an investigation completed with the local publisher, When the run artifact is
      written, Then it records a publication block naming the local publisher and a `caseRef`.
      _(test: integration)_
- [x] **AC4** — Given a publisher that throws, When an investigation completes, Then the run
      artifact is still written and records the publication failure. _(test: unit)_
- [x] **AC5** — Given a tenant credential holding `SecurityAlert.ReadWrite.All`, When the Graph
      publisher publishes findings for an alert, Then the comment is retrievable from `alerts_v2`
      for that alert. _(test: integration)_
- [x] **AC6** — Given findings already published for an alert, When the same run publishes again,
      Then no duplicate comment is created. _(test: integration)_
- [x] **AC7** — Given a source with *n* alerts and no existing runs, When the loop completes one
      sweep, Then exactly *n* runs exist and each alert appears in exactly one. _(test: integration)_
- [x] **AC8** — Given an alert that already has a run artifact, When the loop polls, Then it is not
      investigated again. _(test: unit)_
- [x] **AC9** — Given a configured spend ceiling reached mid-sweep, When the loop next considers an
      alert, Then it halts and reports the ceiling instead of starting it. _(test: unit)_
- [x] **AC10** — Given an alert whose investigation has failed the configured number of times, When
      the loop next polls, Then that alert is parked and named in the output, and is not retried in
      the same process lifetime. _(test: unit)_
- [x] **AC11** — Given a loop with runs in flight, When `SIGINT` arrives, Then those runs are
      cancelled and their artifacts record the interruption. _(test: integration)_
- [x] **AC12** — Given a running watch process, When a console attaches, Then it lists live runs and
      receives `ControlEvent`s for a run it did not start. _(test: integration)_
- [x] **AC13** — Given an attached console, When it cancels a run the loop started, Then that run is
      cancelled and the loop continues to the next alert. _(test: integration)_
- [x] **AC14** — Given an attached console, When it detaches, Then the loop continues and its
      in-flight runs still complete. _(test: integration)_
- [x] **AC15** — Given a socket file left by a dead watch process, When a new watch process starts,
      Then it reclaims the socket rather than failing to start. _(test: unit)_
- [x] **AC16** — Given a clean clone, Bun, and one tenant credential, When a reader follows the
      README alone, Then a finding is published to their portal. _(test: e2e)_
- [x] **AC17** — Given run mode configured with tenant credentials only, When the loop starts, Then
      it polls without reading any fixture, Kusto or Mock Sentinel configuration. _(test: integration)_
- [x] **AC18** — Given a poll interval and an alert window where `window < k × interval`, When the
      watch role starts, Then it refuses to start and names both values. _(test: unit)_
- [x] **AC19** — Given a source returning more alerts than the list cap within the window, When the
      loop completes a cycle, Then it reports the truncation with the `$count` and the number
      received, rather than proceeding silently. _(test: unit)_
- [x] **AC20** — Given `WATCH_SKIP_STATUSES` naming a status and an alert carrying it, When the loop
      polls, Then that alert is not investigated; and Given the set is empty, Then no alert is
      skipped for its status. _(test: unit)_
- [x] **AC21** — Given an alert with a run artifact whose status has since changed to any other
      value, When the loop polls, Then it is not investigated again. _(test: unit)_
- [x] **AC22** — Given an alert already carrying a comment with the publisher's marker, When
      publication runs again for that alert, Then no second comment is written and the existing one
      is reported. _(test: integration)_
- [x] **AC23** — Given a first cycle against a source, When it completes, Then the distinct alert
      status values observed are reported, so `WATCH_SKIP_STATUSES` can be configured from real
      data. _(test: unit)_
- [x] **AC24** — Given a poll that fails transiently, When the loop continues, Then it waits before
      polling again, reports the reason and the delay, and the next successful poll reports that
      backoff ended. _(test: unit)_
- [x] **AC25** — Given a poll rejected for a reason that will not resolve itself — an unconsented or
      expired credential — When the loop handles it, Then it stops rather than polling on, and names
      what to fix. _(test: unit)_
- [x] **AC26** — Given a sweep in which no investigation succeeded, When the artifact is written,
      Then the run's own status is `failed` and the control reports `run_failed`, so the alert
      reaches the parking path rather than being recorded as seen. _(test: unit)_

## 10. Open questions

- ~~**Q1 — Is `comments` `PATCH`-writable app-only on `alerts_v2`?**~~ **Resolved 2026-09-16: no.**
  `PATCH` returns 200 and discards the field. Publication targets the alert's incident instead —
  see ADR 012 §6, which records the measurement and the decision.
- ~~**Q2 — Is the operator's Sentinel workspace onboarded to the Defender portal?**~~ **Resolved
  2026-09-16: yes.** `alerts_v2` returns alerts with `serviceSource: microsoftSentinel`, confirming
  §4.1 D8 — one Graph publisher covers both products.
- **Q3 — What is the spend ceiling's unit and default?** Per sweep, per day, or per run; and in
  tokens or currency. Phase 3 must choose one before AC9 is testable. Not architecturally
  significant.
- ~~**Q4 — Does publication belong inside `executeRun` or beside it?**~~ **Resolved 2026-09-16:**
  inside. Every caller publishes, including a console-launched run — see §4.1 D12.

## 11. References

- ADR 007 — Console control surface: `InvestigationControl`, and the intent that a non-in-process
  implementation would follow
- ADR 009 §1 — Azure Monitor Logs as the read data plane, and its rejection of the incident ARM API
  "for this slice"
- ADR 011 §1, §4 — Graph as the Defender data plane; one primary source produces alerts
- PRD-5 §5.1, §5.3, §6, §8, §14 — in-process execution, the control interface, cancellation,
  `maxConcurrent`, and the write-isolation claim this PRD tightens
- PRD-6 §6.7 — per-run metrics the loop aggregates
- PRD-8 §4.1 D12 — probe before connector code, against a real tenant
- `docs/research-defender-api.md` §86, §119, §122, §125, §395, §492 — the `PATCH` endpoint, the
  Sentinel onboarding gate and its retirement note, automatic onboarding after 2025-07-01, the
  `ReadWrite` permission, the `comments` property, and the open probe question
- `docs/defender-setup.md` — the existing Entra app registration and read-permission page that D9
  extends with the write permission and the service-principal concept
- `docs/research-console-write-path.md` — the write-path spike, including the unresolved "a daemon
  is a new service" question this PRD answers
- `docs/roadmap.md` §1, §2, §5, §8 — case memory, human feedback, the assessment contract, and
  alert grouping
