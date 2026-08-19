# PRD-3 — Analyst Console

**Status:** Complete — see `docs/adr/006-analyst-console.md` for accepted deviations  
**Depends on:** PRD-2 — Core Investigation Agent  
**Deviation:** `frontend` was an AGENTS.md §2 non-goal — scoped, not deleted, by ADR 006 §1  
**Language/runtime:** TypeScript strict mode, Bun  
**Renderer:** `@opentui/core`, imperative API  
**Runtime schemas:** Zod

---

## 1. Purpose

PRD-2 produces good investigations that nobody can read.

The agent's work is currently observable in four places, none of which answers an analyst's
questions:

```text
stdout during a run      a live tree that scrolls away and is gone
runs/<runId>.json        the verdict, and deliberately nothing else
runs/traces/*.jsonl      everything: 217-826 KB of raw Pi events, or 11-23 MB
                         when INVESTIGATOR_TRACE_STREAM is on
bun run evaluate         padded console tables, scoring only
```

The run artifact says so itself, in `apps/investigator/src/contracts/run.ts`:

> Deliberately not a tracing system. No transcript, no token counts, no tool trace, no raw KQL or
> web results — only what a later comparison against the hidden scenario metadata needs. Those can
> be added if evaluation shows a concrete need for them.

That was the right call for PRD-2. The consequence is that the four questions an analyst actually
asks — *what is it doing right now*, *which tables did it look at*, *what did it search for*, and
*what did this cost* — are answerable today only by grepping multi-megabyte JSONL by hand.

PRD-3 makes them answerable in a terminal, without changing what the agent does.

---

## 2. Product Goal

A single read-only terminal application that answers, for any investigation the system has ever
run:

```text
what is running now
          ↓
what did it conclude
          ↓
how did it get there
          ↓
what did it cost
```

The console is an observation surface. It never starts, stops, steers, or annotates an
investigation, and it holds no state the agent depends on.

---

## 3. Why This Needs an ADR

AGENTS.md §2 listed `frontend` under **Do not implement**, and §15 makes an implementation that
would introduce a roadmap non-goal an explicit stop-and-ask trigger, preferring "a small ADR over
silently changing architecture".

This is not a change of direction. `docs/architecture.md` §15 already lists **7. UI / Operations**
in the future PRD sequence, and PRD-1 §10 (`frontend`), PRD-2 §24 (`frontend/UI`) and AGENTS.md §2
all name the same thing that §14 of the architecture calls a "Nuxt frontend".

PRD-3 scopes that non-goal rather than deleting it:

```text
still out of scope     a web/product frontend, served over a network, with users
now in scope           a local, read-only operator console over run artifacts
```

`docs/adr/006-analyst-console.md` records the decision, exactly as ADR 005 §3 recorded lifting the
web-research non-goal for PRD-2. AGENTS.md §2 now carries the narrowed wording, so the past tense
above is deliberate — this PRD and that amendment land together.

---

## 4. Core Design Principles

### 4.1 The console reads files; it never drives the agent

The console opens run artifacts and transcripts and renders them. It does not import
`apps/investigator`, does not construct an `InvestigationHarness`, does not hold an API key, and
does not call Mock Sentinel to do its job.

The reason is containment. An observation tool that can also run investigations acquires the
agent's failure modes, its cost, and its credentials, and stops being safe to leave open on a
second monitor.

### 4.2 The artifact and the transcript are the contract

Two files, both already produced by PRD-2:

```text
runs/<runId>.json                      the durable outcome
runs/traces/<runId>-<alertId>.jsonl    the optional transcript
```

The console must not require a third store, a database, an index file, or a daemon. If something
cannot be recovered from those two files, either the artifact gains a field or the console does
without.

### 4.3 The view layer is replaceable

Reading, indexing and formatting are pure and testable without a terminal. Only the outermost
layer knows OpenTUI exists.

`@opentui/core` is pre-1.0 and moving fast, and this repo pins every dependency exactly for that
reason. The boundary is what makes that pin cheap to change.

### 4.4 Honest numbers, or no numbers

Transcripts are opt-in, so any aggregate the console shows is computed over a subset of runs. Every
such figure must state its coverage.

An average token count that quietly divides by the number of runs rather than the number of traced
runs is worse than showing nothing, because it looks authoritative.

This binds per-run totals, not only cross-run averages. A sweep whose alerts are only partly traced
has a partial token total, and it must be labelled as one.

---

## 5. High-Level Architecture

```text
runs/<runId>.json ──────────┐
                            ├──▶ read layer ──▶ view models ──▶ OpenTUI panes ──▶ terminal
runs/traces/*.jsonl ────────┤       (pure)        (pure)          (thin)
                            │
console environment ────────┘
```

### 5.1 Modules

```text
apps/console/
  src/
    index.ts            entry point, argument parsing, terminal lifecycle
    env.ts              the console's own configuration contract (§6.3)

    data/               discovery and parsing; imports nothing from @opentui/core
      runs.ts           discover and leniently parse runs/*.json
      trace-index.ts    streaming transcript indexer (§10)
      trace-detail.ts   seek and read one event by byte offset, on demand
      poll.ts           filesystem polling that surfaces in-flight runs (§10.2)
      stats.ts          token and cost aggregation across transcripts

    view/               pure functions; no terminal, no I/O
      run-list.ts       runs and results -> selectable rows
      verdict.ts        a summary -> rendered blocks, all three shapes (§6.1)
      activity.ts       a trace index -> the tool-call timeline
      alert.ts          the alert under investigation, from artifact and transcript (§6.1)
      transcript.ts     a trace index -> the investigation as a conversation (§8.5)
      config.ts         run and environment -> the two-column table (§8.6)
      format.ts         durations, byte and token counts, cost, the TP/FP bar, truncation

    ui/                 the only directory that knows OpenTUI exists
      app.ts            renderer, panel focus, global keymap
      panes/            one module per pane
```

`data/` and `view/` import nothing from `@opentui/core`. That is what makes them testable without a
terminal (§12), and what keeps the pre-1.0 renderer risk ADR 006 §2 accepts confined to one
directory.

### 5.2 Entry point

```text
bun run console                 read RUNS_DIR and INVESTIGATOR_TRACE_DIR from the environment
bun run console --runs <dir>    override the run artifact directory
bun run console --traces <dir>  override the transcript directory
```

Both directories default to the investigator's own defaults, `runs` and `runs/traces`, and resolve
relative to the process working directory exactly as the investigator resolves them. Argument
parsing follows the hand-rolled style of `apps/investigator/src/index.ts` rather than adding a CLI
dependency, and an unknown flag is an error rather than a silent fall-through.

---

## 6. Data Sources

### 6.1 Run artifacts

Discovered by globbing `RUNS_DIR` for `*.json`. `runId` is a UUIDv7, so lexicographic order is
chronological order.

Parsing is **lenient, not strict**. Two summary shapes exist on disk today, across the 20 artifacts
in `runs/`:

```text
{ impact, researchDone }        current                                  12 results
{ nextAction }                  written before ADR 005 §1 replaced it     8 results
```

No artifact currently mixes them, and the console must not rely on that. Each of these fields is
independently optional in `contracts/run.ts`, so a third shape is one amendment away: read every
field on its own rather than branching on a detected shape.

`scripts/evaluate-runs.ts` set this precedent with its own permissive local interfaces. A single
malformed artifact must degrade to a warning row, never an empty list.

#### The alert's own facts

Each result carries an optional `alert` block: `severity`, `startTimeUtc`, `endTimeUtc`,
`timeGenerated`, `tactics`, `techniques`, `compromisedEntity`, `alertType`.

It exists because `startedAt`/`completedAt` describe **when the agent ran**, and nothing described
**when the incident happened**. On this corpus those are five years apart — the telemetry is
historical Training Lab data, so an alert from 2021-10-23 is investigated in 2026-08-19 — which
made a verdict impossible to place in time and a list of runs impossible to order by anything an
analyst triages on.

Deliberately a subset, not a mirror of `SecurityAlertResource`: copying the whole alert would
duplicate Mock Sentinel's contract into a durable artifact and make every future alert field a
migration. Everything else stays in the transcript, which carries the alert verbatim.

The console never renders the two clocks alike. Incident times are date-first and explicitly UTC
(`2021-10-23 05:26→06:25Z`); investigation timing is only ever a clock time or a duration. Severity
renders blank rather than as a placeholder when an artifact predates this block, because most
artifacts on disk do and `???` in every row reads as a fault rather than as an absent column.

### 6.2 Transcripts

Written by `apps/investigator/src/trace.ts` when `INVESTIGATOR_TRACE=true`. Append-only JSONL, one
Pi `AgentEvent` per line with an `at` timestamp prepended.

The console derives the path from `<runId>-<alertId>.jsonl`. Both halves are hyphenated UUIDs, so
the split is at the 36-character boundary, not at the first `-`.

Everything the deep-dive view needs is here and nowhere else:

```text
tool_execution_start    toolName, args - the literal KQL, table list, search query, fetched url
tool_execution_end      isError, result.content[].text
turn_end                message.usage.totalTokens, message.usage.cost.total,
                        message.provider, message.model, message.stopReason
message_start           message.content[].text on the first one, which embeds the alert JSON
```

The nesting is not incidental and the paths above are the ones on disk, not the ones the field names
suggest. `AgentEvent` types `turn_end` as `{ type, message, toolResults }`, so every usage, cost and
model field hangs off `message`. There is no result-size field anywhere — `tool_execution_end`
carries the result itself, and the console measures it.

The alert JSON in that first message is the console's source for severity, tactics and entities.
Reading it there keeps the console a pure file reader instead of adding a live Mock Sentinel
dependency for display data.

### 6.3 Console configuration

The console has its own environment contract and reads only what it needs: where the runs and
traces are, plus display-only echoes of the investigator's settings.

It must never import `apps/investigator/src/env.ts`. That module validates and throws at import by
deliberate design (ADR 005 §6), which would make the console refuse to open a historical run
because a key for a model it is not going to call is absent.

---

## 7. Run Lifecycle

PRD-2 writes the artifact once, when the sweep ends. Nothing on disk marks a run as in flight, so
"active runs" has no data source.

PRD-3 adds a lifecycle to `InvestigationRun`, additively:

```text
status      running | completed | interrupted     optional
alertCount  how many alerts this sweep will cover optional
traceDir    where this run's transcripts landed   optional
config      thinkingLevel, resultMaxChars,        optional
            sentinelBaseUrl, webSearchConfigured
```

These are run-level fields. `InvestigationResult.status` already exists with a different enum,
`completed | failed`, and is untouched. The two must not be conflated — least of all by a schema
author looking for somewhere to put `interrupted`, which describes a sweep and not an alert.

`alertCount` is written before the first alert, and it is what makes §11's mid-sweep state
renderable. `results` only ever holds finished alerts, so without a planned total the console can
show what has completed but cannot say how much is left.

The artifact is flushed more often: once before the first alert, once after each alert through the
existing `onResult` seam, and once at the end. The SIGINT path already flushes, and now sets the
run's `status` to `interrupted`.

Two mechanics the existing code does not give for free:

- `onResult` in `runner.ts` is synchronous — `(result) => void`, called without `await` — while
  `flush()` is `async`. The per-alert flush must be serialised rather than fired and forgotten, so
  that two flushes cannot interleave and the SIGINT flush cannot race one already in flight.
- `writeRunArtifact` truncates and rewrites in place. With a reader polling the directory every
  second (§10.2), that makes torn reads routine rather than exceptional. The write becomes atomic —
  a temporary file in the same directory, then a rename over the target — so a reader sees either
  the previous artifact or the next one and never half of either. §11's parse-failure state is for
  genuinely damaged files, and must not be reachable by reading a healthy run at the wrong moment.

Every field is optional, so artifacts written before PRD-3 still parse, and
`scripts/evaluate-runs.ts` — which declares its own permissive view of the shape — is unaffected.

`config` exists for the same reason ADR 005 §2 put `model` in the artifact: two runs are not
comparable without knowing how each was configured.

`completedAt` now updates on every flush and means "last written". This is recorded in the schema
rather than left to be discovered, and §10.2 reads it as the liveness heartbeat.

---

## 8. Views

### 8.1 Runs and alerts

Runs newest first, active runs pinned above completed ones. Selecting a run lists its results;
selecting a result opens it.

A sweep can hold 151 results, so this view reads only the artifact. No transcript is opened to
render a list. Rows lead with severity, the incident date and the title; the run id moves to a
second line, because it identifies a file rather than an incident.

Pane `[1]` is the **case pane**: the selected investigation's alert, in full — severity and rule,
incident window, detection time, compromised asset, tactics, techniques, the **entity identifiers**,
the detection's own `description` as a `reason` block, and its scalar `additionalData` as `details`.
It sizes itself to what the alert actually carries, so an artifact with no transcript behind it
costs six rows rather than a screenful of blanks.

Entities are listed as `type value` pairs, not counted by type. An investigation pivots on the
account, the address and the host; "3 ip, 1 account" is not something anyone can pivot on.

The sidebar runs **`[1]` Alerts → `[2]` Runs → `[3]` Case**: what is being looked at, the run it
came from, then its facts. The alert list is always present and sizes itself to the number of
alerts, so a single-alert run costs three rows rather than nine.

The case pane deliberately does **not** carry the detection's `description`. Wrapped into 43
columns it broke mid-token — `user.account.privilege.grant within 15` — and prose that narrow is
unreadable however it is styled. It renders in pane `[4]` as `WHY THE ALERT FIRED`, where there is
room for a sentence.

Rows are **one line each**, in both list panes. The second line existed to carry the run id and the
model, and it halved how many runs fitted on screen to do it; the run id identifies a file and lives
on the `c` screen, while the model — which is what actually distinguishes two runs of the same alert
in this corpus — fits on the first line.

Both panes draw their own rows rather than using a select widget. That is what makes them colour
like the rest of the console, gives them the same background as every other pane, and puts their
scrolling under the console's control.

When the artifact predates the `alert` block, these facts are recovered from the transcript for the
**selected** investigation only — the list itself still opens nothing.

### 8.2 Verdict

The analyst-facing shape PRD-2 §15 specifies, rendered whole: the TP/FP split with both reasons,
`whatHappened`, `impact`, `keyEvidence`, and `researchDone`.

Order: the alert strip, the verdict headline, `IMPACT`, `WHY THE ALERT FIRED`, `WHAT HAPPENED`,
`ENTITIES`, then `FOR` / `AGAINST`, `KEY EVIDENCE`, `WHERE IT LOOKED` and the rule's remediation.

The headline leads because it is what an analyst opens a case for. What it must not do is stand
alone above the evidence: leading with a confidence score and nothing else is the shape practitioner
critiques of AI triage blame for analysts ratifying a number rather than weighing it. So the
narrative sits between the score and the argument that produced it, and the counter-argument is
never further from the top than the argument.

The verdict line leads with the **band as a word** — `TRUE POSITIVE`, `FALSE POSITIVE`,
`INCONCLUSIVE`, `UNSCORED` — alongside the split. `verdictBand` has classified 30-70 as inconclusive
since this PRD was written, matching the band `scripts/evaluate-runs.ts` scores against; leaving
that word unrendered made "the evidence does not separate these" something the reader had to derive
from a percentage.

`impact` is a **block of its own**, labelled as the agent's own field and glossed with the meaning
from its schema (`none` = attempted and achieved nothing, and so on). As a bare enum on the end of
the verdict line, "where does `confirmed-compromise` come from?" was a fair question with no answer
on screen — and the whole point of ADR 005 §1 adding it is that it is a *separate* judgement from
TP/FP. The four definitions are also on the `?` screen.

The two reasons are headed `FOR` and `AGAINST` rather than `TP — why` and `FP — why`. They are an
argument and its counter-argument about one conclusion, and stacking them as two independent facts
read as though the console had no view on how they related. Practitioner research on AI triage names
the failure mode directly: analysts *ratifying* a confidence score instead of weighing the evidence.
The counter-argument is the cheapest defence against it, and the agent already writes one.

Entities repeat in this pane, and tactics and techniques sit with `whatHappened` under a
`MITRE ATT&CK` label — they describe the activity the narrative describes, and `CommandAndControl ·
T1071` only reads as a technique id if you knew already. The entity repetition is deliberate: below
100 columns panes `[1]` and `[3]` are hidden and this pane is all there is.

The alert's own `remediationSteps` close the pane, labelled as coming from the detection rule. That
attribution matters: `nextAction` was removed from the submission contract (ADR 005 §1), and nothing
here should read as the agent recommending an action.

`researchDone` is displayed with equal weight to `keyEvidence`, not folded away. ADR 005 §1 added it
because "Checked X, found nothing" is a materially different claim from never having checked X, and
a view that hides it discards that distinction.

Failed investigations show `error.name` and `error.message` in place of a summary. No artifact on
disk currently contains a failed result, so this path is written defensively and tested against a
synthetic fixture.

### 8.3 Activity

The tool-call timeline for one investigation, grouped by turn, with per-turn tokens and cost.

Each call shows its tool, its argument summary, and its result size; opening one shows the full
arguments — the complete KQL as the agent wrote it — and a bounded preview of the result.

The view also answers the aggregate questions directly, without drilling in:

```text
tables    which tables were queried, and how often
web       which searches ran and which pages were fetched
errors    which calls came back as errors
```

### 8.4 Stream

For a run in progress: a live, high-level feed of turns and tool calls.

"High level" is defined as one line per turn and one per tool call — the same events `trace.ts`
already narrates to stdout, so the console and the terminal log agree rather than competing.
`trace.ts` additionally prints an assistant thinking line and closes each call with its result size;
the Stream view may fold those into the call's own line, but it shows nothing they do not.

### 8.5 Transcript

Activity answers *what did it do*. Transcript answers *why did it do that*: the same investigation
rendered as a readable conversation — the context the agent was given, what it reasoned, what it
said, what it asked for, and what came back.

Blocks appear in order and are collapsed to a couple of lines each. Opening one loads its full text
from disk, which is the on-demand half of §10.1's bargain: a 24,000-character query result costs
nothing until someone asks for it. The submission is marked as the verdict rather than rendered as
one more tool call.

It sits beside Activity rather than replacing it. The two answer different questions, and folding
the scannable tool-call index into a prose view would make "which tables did it touch" slower to
answer, not faster.

### 8.6 Configuration and cost

Two columns that are never merged: what *this run* used, taken from the artifact, and what the
*console's current environment* says, taken from its own config. They drift, and the drift is
usually the answer to "why did this run behave differently".

Cost and token aggregates state their coverage, per §4.4.

---

## 9. Layout and Interaction

### 9.1 Default layout

A Lazygit-style arrangement: numbered side panels stacked in a left column, one main panel on the
right, and a persistent key bar. Panel titles carry their focus number.

The reference width is 120 columns. The frame below is a real capture from `runs/`, not a mockup.

The left column is the **case**, not the machine. Provider, model, thinking level, turns, timeout,
tracing and spend were all on permanent display in an earlier draft of this layout, and none of them
help an analyst decide anything about an alert; they live on the `c` screen, which already carried
every one of them. The header keeps only what is true of the queue.

```text
SOC ANALYST CONSOLE    21 runs · read-only
┌─[1] Alert──────────────────────────────────┐┌─[4] d52663c4 Known malicious domain avsvmcloud.com resolved────────────┐
│▶ ✓      Known malicious…  TP 72% unknown   ││  VERDICT  ·  activity  ·  transcript  ·  stream                        │
└────────────────────────────────────────────┘│  ────────────────────────────────────────────────────────────────────  │
┌─[2] Runs───────────────────────────────────┐│                                                                       ▀│
│▶ ✓      Known malicious d… luna      TP 72%││  HIGH   incident 2020-03-20 16:52Z   asset 17.81.146.1                 │
│  ✓      Known malicious d… terra     TP 90%││                                                                        │
│  ✓      Ransomware Behavi… terra     TP 82%││  TRUE POSITIVE   TP  72%  ████████████████████████░░░░░░░░░  FP 28%    │
│  ✓      Privilege escalat… terra     TP 99%││                                                                        │
│  ✓      Phish email deliv… terra     TP 99%││  IMPACT   unknown            agent's own field, separate from TP/FP    │
│  ✓      Sign-in attempts … terra     TP 99%││           the available telemetry cannot say                           │
│  ✓      Multiple failed l… terra     TP 92%││                                                                        │
│  ✓      Known malicious d… terra     TP 15%││  WHY THE ALERT FIRED                                                   │
│  ✓      Ransomware Behavi… terra     TP 86%││  17.81.146.1 resolved avsvmcloud.com; the request was Allowed.         │
│  ✓      Privilege escalat… terra     TP 99%││                                                                        │
│  ✓      Phish email deliv… terra     TP 99%││  WHAT HAPPENED                                                         │
└────────────────────────────────────────────┘│  MITRE ATT&CK  CommandAndControl · T1071 · T1071.004                   │
┌─[3] Case — d52663c4────────────────────────┐│  At 2020-03-20 16:52:16.153 UTC, Umbrella DNS telemetry recorded       │
│ severity   HIGH  SOC-RULE-0033-KnownMali…  ││  source/internal IP 17.81.146.1 querying avsvmcloud.com for an A       │
│ incident   2020-03-20 16:52Z               ││  record through external IP 15.230.137.45. The request was Allowed     │
│ detected   2020-03-20 16:52Z               ││  and returned NOERROR; policy and identity were both HOSTNAME.         │
│ asset      17.81.146.1                     ││  Sentinel generated the High alert at the same timestamp. The          │
│ tactics    CommandAndControl               ││  available data does not identify the hostname/process behind          │
│ techniques T1071, T1071.004                ││  17.81.146.1 or show whether any subsequent C2 connection occurred.    │
│                                            ││                                                                        │
│ entities                                   ││  ENTITIES      ip 17.81.146.1 · ip 15.230.137.45                       │
│   ip       17.81.146.1                     ││                                                                        │
│   ip       15.230.137.45                   ││  FOR — TRUE POSITIVE 72%                                               │
│                                            ││  A successful NOERROR DNS lookup for avsvmcloud.com was recorded       │
│ details                                    ││  and explicitly allowed, and this domain is documented by Mandiant     │
│   Domain   avsvmcloud.com                  ││  as the SUNBURST DNS C2 coordinator. That makes the alert              │
│   Action   Allowed                         ││  materially suspicious. Confidence is reduced because the event is     │
└────────────────────────────────────────────┘└────────────────────────────────────────────────────────────────────────┘
1-4 pane j/k move [ ] tab ⏎ expand / filter y copy c config ? help q quit
```

### 9.2 Verdict, maximised

`⏎` on an alert gives the assessment the full width. Fields absent from older artifacts are marked
as absent rather than rendered empty.

```text
┌─ 6f8c3424 · Privilege escalation after sign-in for mirage@pkwork.onmicrosoft.com ───────────────── run 01a0194c ─┐
│                                                                                                                  │
│  TP  99%  ███████████████████████████████████████████████████████████████████████████████████████░  FP 1%        │
│  impact  confirmed-compromise            50.2s            openai/gpt-5.6-terra            2026-08-19 09:14:13Z   │
│                                                                                                                  │
│  WHAT HAPPENED                                                                                                   │
│  At 07:36:10Z on 2026-08-19, mirage@pkwork.onmicrosoft.com signed into Okta from 198.51.100.42 (Moscow, RU). …   │
│                                                                                                                  │
│  KEY EVIDENCE                                                                    6 items                         │
│  1  Okta: six successful events from 198.51.100.42 between 07:36:10Z and 07:40:10Z                               │
│  2  AWS CloudTrail: Mirage from 198.51.100.42 created backdoor-svc, an active access key (AKIAI99ATTACKKEY)      │
│  3  AWS CloudTrail: the same actor opened an all-protocol 0.0.0.0/0 security-group rule                          │
│  4  GCP Audit: Mirage from 198.51.100.42 created backdoor-svc-gcp                                                │
│  5  Palo Alto telemetry attributes 10.0.1.50/win11a to Mirage: 124-port scan at 07:30Z                           │
│  6  MailGuard delivered a high-confidence phish to Mirage at 06:50:37Z                                           │
│                                                                                                                  │
│  RESEARCH DONE — including the lines that came back empty                        7 items                         │
│  ·  Reviewed complete Okta activity for Mirage and 198.51.100.42                                                 │
│  · Queried Entra sign-in telemetry for Mirage and 198.51.100.42; no matching Entra sign-in records were present. │
│  ·  OfficeActivity was sampled for related activity but its available records were historical/unrelated          │
│                                                                                                        ▼ 4 more  │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 ] Activity   [ Stream   j/k scroll   y copy   ⎋ back   q quit
```

### 9.3 Activity — the tool-call deep dive

Timeline on the left, the selected call in full on the right. This is where §8.3's requirements
become concrete: the exact KQL the agent wrote, verbatim.

```text
┌─[4] Activity · cc6430ca ────────────────────────────────────────────────────────────────── 4 turns · 11 calls ───┐
│ #   at         tool                  summary                     │  query_security_data                          │
│ ─────────────────────────────────────────────────────────────────│  ───────────────────────────────────────────  │
│ turn 1  09:11:52 →  2,820 tok  $0.0096                           │  call_LCLR1c2q…   09:12:02.460 → +6.4s        │
│  1  09:11:56  get_security_schema   3 tables · 5,081 ch          │  ok · 1,757 chars                             │
│  2  09:11:56  query_security_data   SecurityEvent · 1,059 ch     │                                               │
│  3  09:11:56  query_security_data   SecurityAlert · 336 ch       │  KQL                                          │
│ turn 2  09:12:02 →  4,902 tok  $0.0107                           │  SecurityEvent                                │
│  4  09:12:02  query_security_data   SecurityEvent · 1,525 ch     │  | where Computer =~ "SOC-FW-RDP"             │
│ ▶5  09:12:02  query_security_data   SecurityEvent · 1,757 ch     │      and EventID == 4624                      │
│  6  09:12:02  query_security_data   CommonSecurityLog · 467 ch   │  | where TimeGenerated between (              │
│ turn 3  09:12:08 →  6,644 tok  $0.0120                           │      datetime(2021-10-23 04:30:00Z) ..        │
│  7  09:12:08  query_security_data   SecurityEvent · 2,685 ch     │      datetime(2021-10-23 08:30:00Z))          │
│  8  09:12:08  query_security_data   SecurityEvent · 410 ch       │  | summarize by Account, IpAddress            │
│  9  09:12:08  query_security_data   SecurityEvent · 3,606 ch     │                                               │
│ 10  09:12:08  query_security_data   SecurityEvent · 478 ch       │  RESULT  (first 4 KB of 1,757)                │
│ turn 4  09:12:21 → 10,564 tok  $0.0211                           │  {"tables":[{"name":"PrimaryResult",          │
│ 11  09:12:21  submit_investigation  TP 94 / FP 6 · terminate     │   "columns":[{"name":"Account","type":…       │
│ ─────────────────────────────────────────────────────────────────│                                               │
│ tables  SecurityEvent ×8  CommonSecurityLog ×1  SecurityAlert ×1 │                                               │
│ web     no web_search / web_fetch calls in this investigation    │  ⏎ full result   y copy KQL                   │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 j/k move   ⏎ expand   [ ] tab   y copy KQL   ⎋ back   q quit
```

The `tables` and `web` footer lines answer "which tables did it look at, what did it search for"
without opening a single call.

### 9.4 Stream — a run in progress

One line per turn and one per tool call, matching the shape `trace.ts` already narrates to stdout so
the console and the terminal log agree rather than competing.

```text
┌─[4] Stream · 00f7a521 · Ransomware Behavior on srv-dc01 ─────────── ● running · 1m12s · following ──┐
│  09:26:15  agent start                                                                              │
│  ├─ turn 1                                    2,714 tok   $0.0094                                   │
│  │  · Ransomware on a domain controller — start with process creation and service installs…         │
│  │  → get_security_schema        SecurityEvent, DeviceProcessEvents, CommonSecurityLog              │
│  │  ← get_security_schema        6,204 chars                                                        │
│  ├─ turn 2                                    5,881 tok   $0.0131                                   │
│  │  → query_security_data        SecurityEvent | where Computer =~ "srv-dc01" and EventID == 4688 … │
│  │  ✗ query_security_data        ERROR  Semantic error: 'DeviceProcessEvents' could not be resolved │
│  │  ← query_security_data        3,412 chars                                                        │
│  ├─ turn 3                                    streaming…                                            │
└─────────────────────────────────────────────────────────────────────────────────────────────────────┘
 F follow   j/k scroll   [ ] tab   ⎋ back
```

### 9.5 Configuration and cost

Two columns that are never merged, per §8.6.

```text
┌─ Configuration ──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              THIS RUN  01a0194a              CURRENT ENV                                         │
│  provider / model            openai / gpt-5.6-terra          openai / gpt-5.6-terra                              │
│  thinking level              medium                          medium                                              │
│  max turns                   50                              50                                                  │
│  timeout                     600 s                           600 s                                               │
│  result char budget          40,000                          40,000                                              │
│  sentinel base url           http://localhost:8787           http://localhost:8787            ● reachable        │
│  brave web search            configured                      BRAVE_API_KEY set                                   │
│  tracing                     on → runs/traces                INVESTIGATOR_TRACE=true                             │
│                                                                                                                  │
│  DATA SOURCES                                                                                                    │
│  Mock Sentinel REST          /alerts  /alerts/:id  /schema  /query        22 tables · 1,168 columns              │
│  Public web                  Brave Search API, https-only fetch, 24,000 char cap                                 │
│                                                                                                                  │
│  TOKENS & COST         over 19 traced runs of 20                                                                 │
│  billed tokens / inv         avg  24.9k        min  18.2k        max  41.6k                                      │
│  cost / inv                  avg  $0.0535      min  $0.0391      max  $0.0912                                    │
│  turns / inv                 avg  4.2          min  3            max  9                                          │
│  tool calls / inv            avg  11.4         min  6            max  23                                         │
│  total spend, all runs       $1.02                                                                               │
│  ! 1 run has no trace — its tokens are not counted (INVESTIGATOR_TRACE was off)                                  │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

The final line is required, not decorative. It is §4.4 made visible.

### 9.6 Responsive behaviour

```text
≥ 100 columns    two columns, as above
 60-99 columns   single column; side panels stack, main panel takes full width
< 60 columns     "terminal too narrow" message instead of corrupted boxes
```

```text
SOC ANALYST CONSOLE                    terra · trace ON · 20 runs · read-only
┌─[2] Runs────────────────────────────────────────────────────────────────┐
│ ● 01a0195a  Ransomware Behavior on srv-dc01           turn 3   running  │
│ ▶ 01a0194a  Multiple failed logon attempts…      TP 94  none   28.4s    │
│   01a01958  Known malicious domain avsvmcloud…  TP 90  unknown 58.1s    │
│   01a01957  Privilege escalation after sign-in  TP 99  compro… 32.4s    │
└─────────────────────────────────────────────────────────────────────────┘
┌─[4] cc6430ca · Multiple failed logon attempts against SOC-FW-RDP────────┐
│  TP 94%  ██████████████████████████████████████████████████░░░  FP 6%   │
│  impact none · 28.4s · 4 turns · 11 calls · 24.9k tok · $0.053          │
│                                                                         │
│  Telemetry independently confirms a concentrated 4625 burst against     │
│  SOC-FW-RDP, not a single mistyped password. …                          │
└─────────────────────────────────────────────────────────────────────────┘
 1-4 pane  j/k  ⏎ expand  [ ] tab  ? help  q quit
```

### 9.7 Keymap

| Key | Action |
| --- | --- |
| `1` `2` `3` `4` | focus Alerts, Runs, Case, Main |
| `j` `k` / `↓` `↑` | move within the focused panel |
| `g` `G` | first / last item |
| `⏎` | expand: a call's arguments in Activity, a block's full text in Transcript. Nothing else |
| `⎋` | back one level, then clear the filter |
| `[` / `]` | previous / next main-panel tab — Verdict · Activity · Transcript · Stream |
| `/` | filter the focused list |
| `f` `e` | Activity only: filter by tool, errors only — *not implemented* |
| `F` | Stream only: toggle follow |
| `y` | copy the focused pane; on an open call, the exact KQL |
| `r` | force a re-read from disk |
| `?` | help overlay |
| `q` / `Ctrl-C` | quit, restoring the terminal |

Panel-level keys are handled by a global listener that runs before the focused component and calls
`stopPropagation()` when it consumes a key, so `g` switching panes never leaks into a list.

`⏎` used to walk inwards through the panes. It was removed: `1`-`4` already move focus and say so
unambiguously, while "inwards" is a model the reader has to be told. What is left is the one thing
with no other route — the arguments behind a call, which is where the exact KQL lives.

The **tab strip is a row inside pane `[4]`**, not a suffix on its title. A box title is a plain
string, so the active tab could only be marked with punctuation, and at the far right of a long
alert title that is not something anyone notices. As a row it is coloured, and the active tab is
the one thing in it that is.

The `/` filter is the only text input in the application. There is no other keystroke anywhere that
mutates anything.

While the filter is open it takes every printable key, including `q` — which would otherwise quit
the console halfway through typing "query". Only `Ctrl-C` still exits. Filtered lists report their
match count in the pane title (`/brute 1/5`), because a filter that matches nothing is otherwise
indistinguishable from an empty runs directory, and this is the one control here that can make runs
disappear.

`y` copies over OSC 52 rather than through a host clipboard binary, so it works over SSH, which is
where a console like this actually runs. On an open call it copies the arguments alone: an
escalation write-up carries a "queries used, for reproducibility" field, and retyping KQL out of a
terminal is how that field ends up empty.

### 9.8 Colour and state

Colour is limited to the 16-colour palette, and **never carries meaning on its own** — every state
also has a glyph. Terminals get screenshotted, pasted into tickets, and read over shoulders on
projectors, and a verdict that is only distinguishable by hue does not survive any of that.

| State | Glyph | Colour |
| --- | --- | --- |
| run in progress | `●` + spinner | cyan |
| completed | `✓` | default |
| failed | `✗` | red |
| TP ≥ 60 — act on it | filled bar | red |
| FP ≥ 60 — probably noise | filled bar | green |
| 30–70, evidence does not separate | bar + `INCONCLUSIVE` | yellow |
| impact `confirmed-compromise` | — | red |
| impact `contained` | — | yellow |
| impact `none` / `unknown` | — | dim |
| tool call errored | `✗` | red |
| run claims to be running, but has stopped moving | `◌` | dim |
| no transcript for this run | `·` | dim |
| focused panel | brighter border | cyan border |

The 30–70 band matches the inconclusive band `scripts/evaluate-runs.ts` already scores against, so
the console and the evaluator describe the same run the same way. The band is rendered as a word
rather than as a tilde, which is a plainer statement of the same thing.

**How colour is carried.** `view/` never names a colour — that would put the palette on the wrong
side of §4.3 — so it emits a `Tone` per span and `ui/theme.ts` maps tones to the palette. Every pane
goes through that path, including the two lists, which draw their own rows for exactly this reason.

Beyond the state table above, tone also separates **structure** from content, which is the part that
decides whether a dense pane can be read at all:

| Role | Tone | Why |
| --- | --- | --- |
| section headings | `heading`, bold | they were `dim`, which made the most structural text on screen the hardest to read |
| field labels | `label` | legible on a dark background; `dim` is for asides only |
| detection severity | `severity-high` / `-medium` / `-low` | a value the rule recorded, not a judgement the console is making |
| query calls | `accent` | `query_security_data` is the investigation; the rest is scaffolding |
| tool errors, failed runs | `failed` | |
| the selected row | `selected` background across the full row | a marker glyph alone reads weakly in a dense list |

Nothing in the interface is styled to imply a recommendation. PRD-2 §15 leaves final disposition
with the analyst, and an interface that renders one outcome as more approved-looking than another
quietly takes that back.

---

### 9.9 Terminal ownership

The console takes the alternate screen and raw mode, and must hand both back on every exit path:
normal quit, `SIGINT`, `SIGTERM`, and an unhandled exception. An observation tool that leaves a
terminal unusable after it crashes is worse than no tool at all.

ADR 006 §2 records that OpenTUI's own teardown was verified against a real pty — it entered and left
the alternate screen exactly once and restored the cursor. The console still owns these handlers,
because a crash in console code is not OpenTUI's to catch.

---

## 10. Trace Reading Constraints

Transcripts are large enough that naive reading is a defect, not a performance nuance.

There are two size regimes and the console handles both. `INVESTIGATOR_TRACE_STREAM` is off by
default, and the 12 transcripts on disk written that way run 217-826 KB. The 7 written with it on
run 11-23 MB, because each `message_update` carries the whole partial message rather than the delta.
Measured on `runs/traces/01a0191c-…-d52663c4-….jsonl`, one of those, 16.5 MB over 1,752 lines:

```text
message_update    1,636 lines    96.4% of bytes    largest such line   18,917 bytes
agent_end             1 line     the transcript over again, and the longest line in the file
```

Across all 20 transcripts on disk the largest line of each kind is `agent_end` 174,595 B,
`turn_end` 70,042 B, `message_start` 45,689 B, `message_end` 45,687 B, `message_update` 20,272 B.

The requirements below are written for the larger regime, and hold in both.

Requirements:

- The console must never read a whole transcript into memory as a string, and must never
  `JSON.parse` a `message_update`, `message_end` or `agent_end` line. `message_end` is on that list
  because nothing reads it — usage comes from `turn_end` — yet it is 494 lines across the corpus,
  the largest 45,687 bytes, parsed and discarded on every pass. `message_start` is parsed only
  until the first user message has been located, which is the one that embeds the alert.
- Each line's event type is taken from its first 120 bytes. `trace.ts` writes every record as
  `{"at":"<iso>","type":"<name>",…}` — which held for all 1,752 lines of that file — so the
  **first** `"type":"` occurrence is the event's own type. It has to be the first: a
  `message_update` carries a nested `assistantMessageEvent.type` inside the same prefix.
- Transcripts are indexed lazily. A run list opens no transcripts; an alert opens one.
- Aggregate cost and token figures need every transcript, so they are computed in the background
  and displayed as partial until complete.
- Token and cost totals sum `message.usage` from `turn_end` events only. The assistant's
  `message_end` reports the same turn's usage — measured, 24,930 tokens and $0.0535 from each on
  `01a0194a-…-cc6430ca-….jsonl` — so counting both doubles the figure. `message_start` carries a
  zeroed placeholder rather than a copy, and `agent_end` replays every message a third time, which
  is a second reason not to parse it.
- The console reads files the investigator is still appending to. It must consume only whole lines
  and hold trailing partial bytes until more arrive.

---

### 10.1 What the console retains

Indexing a transcript produces a compact index, never the events themselves:

```ts
interface ToolCall {
  seq: number; at: string; toolCallId: string; toolName: string;
  args: unknown;                                  // small: the KQL, table list, query, url
  endedAt?: string; isError?: boolean;
  resultChars?: number; resultPreview?: string;   // preview is bounded
  resultOffset?: number; resultLength?: number;   // seek here for the full result, on demand
}

interface Turn {
  index: number; at: string; usage?: Usage; stopReason?: string;
  provider?: string; model?: string;
  thinkingPreview?: string; textPreview?: string;   // bounded; the rest is read from `entry`
  entry?: { offset: number; length: number };       // the turn_end line, for the Transcript view
}

interface TraceIndex {
  path: string; runId: string; alertId: string;
  startedAt: string; endedAt?: string;
  complete: boolean;            // an agent_end line exists
  turns: Turn[]; toolCalls: ToolCall[];
  totals: { totalTokens: number; cost: number };
  nextOffset: number;           // byte offset after the last complete line, for resuming a tail
}
```

A full tool result is never held in memory. `resultOffset` and `resultLength` let the detail pane
read one event back from disk when the analyst opens it. That is the difference between a console
with a bounded footprint and one that grows with the size of whatever queries the agent happened to
run.

### 10.2 Following a run in progress

The console polls; it does not use `fs.watch`. Polling is indifferent to how a platform coalesces
append notifications, and the alternative makes the console's correctness depend on filesystem
notification semantics for no benefit at this scale.

```text
~500 ms   stat the active transcript; if it grew, read from nextOffset to EOF and merge
~1 s      rescan the run directory for new or updated artifacts
```

A run counts as active when its artifact says `status: "running"` (§7) or — for a run started before
that field existed — when its transcript has no `agent_end` line and has grown recently.

`status: "running"` is a claim about a process that may no longer exist. A sweep killed outright
never writes `completed` or `interrupted`, so on its own the flag would pin a dead run to the top of
§8.1 permanently. A run whose `completedAt` has not moved for several minutes, and whose transcript
is not growing, is shown as stale rather than active — reported as "last written HH:MM" rather than
silently reclassified as finished, because the console cannot know which it was.

---

## 11. Degraded and Empty States

Every one of these is a designed state with explanatory text, not a blank panel:

```text
no runs at all              name the command that produces one
run has no transcript       say tracing was off for that run, and how to enable it
run is mid-sweep            show what has completed, and `alertCount` minus those as pending
run claims to be running    say stale, and when the artifact was last written (§10.2)
artifact will not parse     name the file and the validation failure, keep the rest usable
terminal too narrow         say so instead of rendering corrupted boxes
```

---

## 12. Testing Requirements

`runs/` is gitignored, so the console commits its own trimmed fixtures, under
`apps/console/test/fixtures/`.

Priority:

1. transcript indexing — tool calls, turns, token and cost totals; that `message_update` and
   `agent_end` lines are skipped by type rather than parsed; and that usage counted from `turn_end`
   is not counted a second time from `message_end`;
2. artifact reading — current shape, legacy `nextAction` shape, a failed result, a corrupt file;
3. formatting — the TP/FP bar, durations, truncation at narrow widths;
4. the investigator's new optional fields — an artifact carrying none of them still parses, one
   carrying `status: "interrupted"` and an `alertCount` above its result count renders as a partial
   sweep, and a run-level `status` is never read as a result-level one;
5. pane rendering — `createTestRenderer` from `@opentui/core/testing` renders panes with no terminal
   attached and `captureCharFrame()` returns the frame as plain text, so layouts are snapshot-tested
   rather than smoke-tested. `mockInput` drives the §9.7 keymap and `resize()` exercises the §9.6
   breakpoints.

Rendering tests load the OpenTUI native binary and are guarded so they skip with an explicit message
when it is unavailable, matching how `apps/mock-sentinel/test/integration/*` guards on Kusto.
`bun test` stays green without one.

The live-tail path (§10.2) needs a sweep running while the console reads it, so it is verified by
hand rather than in `bun test`. That gap is deliberate and worth stating: a regression in following
an in-flight run will surface as a stalled pane, not a red test.

---

## 13. Acceptance Criteria

PRD-3 is complete when:

- A developer can open the console against an existing `runs/` directory with no other services
  running.
- The console never writes to `runs/`, never calls a model provider, and never calls Mock Sentinel.
- Runs are listed newest first, with in-flight runs distinguished from finished ones.
- A run whose artifact says `running` but which has stopped moving is shown as stale, not active.
- Selecting a run lists its per-alert results with the verdict visible without drilling in.
- A mid-sweep run shows its finished alerts and how many remain pending.
- A completed investigation renders its full assessment, including `researchDone`.
- A legacy artifact carrying `nextAction` and no `impact` or `researchDone` renders without error.
- A failed investigation renders its error instead of a summary.
- An investigation with a transcript exposes every tool call, its arguments, and its result size.
- The exact KQL the agent wrote is readable in full.
- Web searches and fetched URLs are listed for investigations that used them.
- Tables queried are summarised per investigation without opening individual calls.
- An investigation without a transcript renders its verdict and states that tracing was off.
- A run in progress appears in the console from its artifact alone, with tracing off, and updates
  as each alert completes; with tracing on, its turns and tool calls also stream as the transcript
  grows. Neither needs a restart.
- Per-run and per-investigation token and cost figures are shown for traced investigations.
- Token and cost figures state their coverage: an aggregate says how many runs it covers, and a
  partly traced sweep's own total is labelled partial.
- Run configuration is shown as recorded in the artifact, separately from the console's current
  environment.
- Every investigation shows when the *incident* happened, not only when it was investigated, and the
  two are never rendered in the same format.
- An investigation records its alert's severity, tactics, techniques and compromised asset, and they
  are visible without opening a transcript.
- An artifact written before the `alert` block still renders, recovering those facts from its
  transcript when one exists and leaving the columns blank when it does not.
- The selected alert's triage facts are readable without opening a transcript, whether or not its
  run investigated more than one alert.
- The full agent trace is readable as an ordered conversation — context, reasoning, assistant
  messages, tool calls and results — with any block expandable to its full text.
- The largest transcript on disk — 23 MB — opens without loading the file into memory.
- A malformed artifact does not prevent the remaining runs from being listed.
- An artifact rewritten while the console is polling never renders as a parse failure.
- The terminal is restored on quit, on interrupt, and on an unhandled error.
- `bun run fmt:check`, `bun run lint`, `bun run typecheck` and `bun test` stay green.
- `bun run evaluate` continues to work against artifacts written by the updated investigator.

---

## 14. Explicitly Out of Scope

PRD-3 does not include:

```text
web frontend
network service
authentication/RBAC
multi-user or remote access

starting, stopping, aborting or re-running investigations
editing, annotating or overriding a verdict
analyst TP/FP feedback capture

ground-truth scoring or expected-vs-actual comparison
cross-run diffing
regression dashboards
export or reporting

alert browsing independent of a run
live Mock Sentinel queries
ad-hoc KQL execution

trace database
persistent console state
cross-investigation memory
```

Analyst feedback capture is roadmap item 2 and deliberately excluded: recording an analyst's
decision makes the console a system of record, which is a different product with different
durability requirements.

Ground-truth scoring stays in `scripts/evaluate-runs.ts`. `fixtures/scenarios/` is loaded through
`apps/mock-sentinel/src/scenarios/scenarios.ts`, and the `no-restricted-imports` rule in
`.oxlintrc.json` bans every path from reaching either of them, with `overrides` exempting exactly
two: `scripts/**`, so the evaluation join can happen, and `apps/mock-sentinel/**`, which owns the
loader. Bringing scoring into the console would mean moving that loader into a package, which is a
boundary change PRD-3 does not need to make.

ADR 006 §5 treats a second reason as the stronger one. PRD-2 §20 makes ground-truth isolation a
property of the system rather than a habit, and the fewer code paths that can reach the answer key,
the cheaper that property is to keep true.

### Met, with these deviations

All of the above hold. Four things ended up different from the design above, each recorded in
ADR 006:

| Designed | Shipped | Why |
|---|---|---|
| Pane `[1]` a status readout; `[3]` the alert list | `[1]` alerts, `[2]` runs, `[3]` case facts | Both always-visible surfaces carried no security information, while every value in them was already on the `c` screen (ADR 006 §9). |
| `SelectRenderable` for both lists | Rows drawn as `Line[]` | The widget forced two lines per item, painted its own background and typed its option text as plain strings, so no colour could reach a row (ADR 006 §8). |
| `⇥` / `⇧⇥` cycles tabs; `⏎` opens the selection | `[` / `]` cycles tabs; `⏎` only expands | `⇥` is the terminal's own focus key, and `1`-`4` already move focus unambiguously. |
| `f` `e` filter Activity by tool and errors | Not implemented | No investigation on the corpus has produced enough calls for either to earn its keybinding. |

Two things in §9 were specified and are **not** built: the Activity `f`/`e` filters above, and the
`●` run-in-progress spinner (the glyph is drawn; it does not animate).

---

## 15. Roadmap Notes Created by PRD-3

Candidates for later independent work, based on demonstrated need.

### Human feedback

The console is the obvious place to capture an analyst's disposition, and roadmap item 2 wants it.
It is excluded here because a read-only tool has no write path, no schema for a decision, and no
story for where that decision lives. Adding one is a PRD, not a feature.

### Evaluation surface

If comparing a verdict against `fixtures/scenarios/` becomes routine, the scenario loader should
move into a package and the console can grow an evaluation view. That move widens the set of code
that can reach the answer key, so it owes §14's isolation argument an answer rather than an
oversight. Until then the split between `bun run evaluate` and the console is the honest one:
scoring is a scripted, ground-truth-aware job, and the console is not ground-truth-aware by design.

### Trace format

The console is the first consumer to read transcripts programmatically, and it has to work around
`agent_end` repeating the whole transcript and `message_update` dominating byte size. If a second
consumer appears, that is the signal to revisit AGENTS.md §12's deferred trace store rather than
to keep adding readers that compensate.

---

## 16. Final PRD-3 Boundary

PRD-3 can be summarised as:

```text
runs/<runId>.json  +  runs/traces/*.jsonl  +  the console's own environment
                    ↓
            lenient read layer
                    ↓
        pure view models (no terminal)
                    ↓
             OpenTUI panes
                    ↓
   active runs · verdicts · tool calls · cost
```

The console adds no capability to the agent and no data the agent did not already produce. Its
entire value is that the work PRD-2 does becomes legible.

If a question cannot be answered from the artifact, the transcript, or the console's own
configuration, PRD-3's answer is to say so in the interface, not to reach for a new data source.
