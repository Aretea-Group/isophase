<h1><img src="./assets/isophase.svg" width="48" height="48" alt="" align="middle"> Isophase</h1>

**An autonomous agent that triages your security alerts while nobody is watching, and writes what it
found onto the case.**

Point it at a Microsoft Defender tenant and leave it running. It polls for new alerts, investigates
each one — querying your telemetry, researching the public web, reaching its own conclusion — and
adds its findings as a comment on the alert's incident, where the analyst working that case will see
it without knowing this tool exists. It never closes an alert, sets a classification, or takes a
response action; it does the reading and hands you the result.

```text
Microsoft Defender XDR ──→ Graph security API ──┐
                                                │
Real Sentinel workspace ──→ Azure Monitor Logs ─┼→ Security data sources
                                                │   (ordered set, one primary)
Training Lab telemetry ───→ Mock Sentinel REST ─┘         ↓
  (local lab, no cloud account)                  Pi investigation agent
                                                          ↓
                                    run artifact  ←─────────────────→  findings comment
                                          ↓                            on the incident
                            Analyst console (TUI, optional)
```

The agent chooses its own investigative path. It receives the alert and available table names, then
may query security data, research the public web, or conclude from the starting evidence. A valid
`submit_investigation` tool call is the only successful outcome; there are no alert-specific
playbooks or hidden answer-key access.

**The console is optional in both directions.** Absent, the loop runs unattended. Attached, it shows
live runs, cancels one, and detaches again without stopping the loop.

**There is also a local lab**, and it needs no cloud account: Training Lab telemetry in a Kusto
emulator, 154 alerts, a hidden ground-truth answer key and a scoring harness. That is how you develop
on this and measure whether a change made the agent better. It is not needed to *run* the agent.

This README is the canonical setup and usage guide; the files under `docs/` contain design history
and decisions rather than a second getting started path.

**You do not need the local lab to use this against a real tenant.** Install the package and point
it at your tenant; the lab is for people changing the agent.

## Install

With [Bun](https://bun.sh) 1.3 or newer on your `PATH`, in an empty directory:

```bash
bunx @aretea-group/isophase init --track defender   # or --track sentinel
```

That writes a `.env` with the blanks to fill in, creates `.data/runs/`, checks the file against the
investigator's own schema and the Bun version, and prints the next command. It creates nothing in
your tenant — no app registration, no service principal, no permission — and makes no network
call. Fill in the credential and the model key, then:

```bash
bunx @aretea-group/isophase probe               # Defender: confirms consent, records what the tenant supports
bunx @aretea-group/isophase investigate --watch # the product: poll, investigate, record
```

`npm i -g @aretea-group/isophase` gives you a plain `isophase` on the path instead of `bunx …`; the
rest of this README writes it that way. The bin needs Bun to run either way — `npx` works, Node
alone does not.

| Command | What it does |
|---|---|
| `isophase init` | write `.env` and the working directories for a Defender or Sentinel tenant; `--track`, `--force` |
| `isophase investigate` | investigate one alert with `--alert <id>`, or run the unattended loop with `--watch` |
| `isophase console` | the operator console; `--live <source>` points it at a real tenant, `--attach` at a running loop |
| `isophase probe` | check a Defender credential's consent and record what the tenant supports |
| `isophase help` | list the commands, or `help <command>` for one; `--help` works everywhere, `--version` too |

The package is Track A only. The local lab — Mock Sentinel, the Kusto emulator, the fixtures and
the scoring harness — is clone-only and is what the rest of this page calls Track B.

## Choose your path

Two ways in. Neither is a subset of the other, and most people only ever want one.

| | **Track A — your own tenant** | **Track B — the local lab** |
|---|---|---|
| Use it to | investigate real alerts in Microsoft Defender XDR or Microsoft Sentinel | customise the agent, or score it against 14 scenarios whose answers are known |
| Install | `bunx @aretea-group/isophase init` | `git clone`, then `bun install` |
| Needs | Bun, a model API key, a read-only tenant credential | the same, plus Docker |
| Docker, Kusto, bootstrap | **no** | yes |
| Slow step | your tenant admin granting consent | ~10 minutes of local setup |
| Writes to | `.data/`, never the repository | `runs/`, ignored by version control |

If you want both, do Track A first.

## Common setup

Track A's `.env` comes from `isophase init`. Track B's comes from the clone:

```bash
bun install
cp .env.example .env
```

Either way, set the provider, model, and matching API key in `.env`. The default is:

```dotenv
INVESTIGATOR_PROVIDER=openai
INVESTIGATOR_MODEL=gpt-5.6-luna
OPENAI_API_KEY=...
```

A self-hosted model works too, through any OpenAI-compatible `/v1` endpoint that returns standard
`message.tool_calls`:

```dotenv
INVESTIGATOR_PROVIDER=llamacpp
INVESTIGATOR_MODEL=qwen3.8-27b
LLAMA_SERVER_BASE_URL=https://host.example/v1
LLAMA_SERVER_MODEL=qwen3.8-27b
```

Supply all four, plus the context and token limits; [`.env.example`](./.env.example) documents each
one and the optional bearer token, which is never written to a run artifact. The file `init` writes
carries the same variables with their defaults in comments. Run artifacts record
the endpoint, the limits and the reasoning profile, so two server configurations stay distinct
measurements. That file is the reference for every other variable too. The investigator validates
its configuration before the first alert, so a missing key stops the process rather than surfacing
forty investigations into a sweep; the console's model picker shows only providers whose
credentials are present.

## Track A — point it at your own tenant

No Docker. No emulator. No fixtures. No clone. You need [Bun](https://bun.sh) 1.3 or newer, a model
API key, and a read-only credential for one tenant. Start with `isophase init --track defender` or
`--track sentinel` from [Install](#install); it writes the `.env` the rest of this section fills in,
with every artifact directory already under `.data/`.

**Microsoft Defender XDR** is the shortest route, because it needs no workspace id. Create the app
registration and grant consent following
[`docs/defender-setup.md`](./docs/defender-setup.md) — that is the slow step, and it needs a tenant
administrator. Then fill in the four lines `init --track defender` left blank in `.env`:

```dotenv
SECURITY_SOURCES=defender
DEFENDER_TENANT_ID=<tenant-guid>
DEFENDER_CLIENT_ID=<application-client-guid>
DEFENDER_CLIENT_SECRET=<local-secret>
```

**Microsoft Sentinel** instead, through Azure Monitor Logs — the identity needs the workspace-scoped
`Log Analytics Data Reader` role, and for local development you may sign in with `az login` rather
than configuring a service principal. `init --track sentinel` leaves these for you:

```dotenv
SENTINEL_CONNECTOR=azure
AZURE_LOG_ANALYTICS_WORKSPACE_ID=<workspace-guid>
```

Check a Defender credential without spending a token on a model, then start the loop:

```bash
isophase probe                  # confirms consent and records what the tenant supports
isophase investigate --watch    # the loop; set PUBLISH_FINDINGS=true in .env to write findings back
```

From a clone the same two are `bun run probe:defender` and `bun run investigate --watch`; the
`bun run` scripts and the package share one dispatcher. A Sentinel credential has no probe — the
clone's live smoke test (`AZURE_SENTINEL_LIVE_TEST=true bun test
packages/sentinel-client/test/integration/azure.test.ts`) is the check there.

That is the whole product path: the loop polls Defender for alerts created inside
`WATCH_ALERT_WINDOW`, investigates each one exactly once, and records the finding.

**If nothing appears in `.data/runs/` after a few minutes, check the window first.**
`WATCH_ALERT_WINDOW` defaults to `PT6H`, and on a quiet tenant a six-hour window is routinely
empty — a first start sees one window's worth of alerts and no more, so six months of backlog is
invisible. Set `WATCH_ALERT_WINDOW=P30D` and try again. In watch mode it **overrides**
`DEFENDER_ALERT_WINDOW`; widening that one instead changes nothing.

**The loop prints nothing between starting an alert and finishing it.** A first run against a real
tenant looks hung for a minute or two and is not — watch `.data/runs/` rather than the terminal, or
set `INVESTIGATOR_TRACE=true` to see each turn as it happens.

Set `WATCH_SPEND_CEILING_USD` before leaving it running — unattended means nobody notices the bill.
Only `investigate --watch` reads it: the one-shot `isophase investigate` has no dollar cap, just
`INVESTIGATOR_MAX_TURNS`.

**Writing findings back needs two things, and the permission is only one of them.** Set
`PUBLISH_FINDINGS=true` *and* grant `SecurityIncident.ReadWrite.All` — see
[`docs/defender-setup.md`](./docs/defender-setup.md), which explains what that permission buys and
what it costs. The flag defaults to off deliberately, so that choosing a connector never starts
commenting on a live tenant as a side effect.

With either one missing, everything else still works and the finding stays in `runs/` — the log
says `published … via local`, which means the run artifact, not the portal.

`RUNS_DIR` must sit under `.data/` for any live tenant — run artifacts can contain tenant data, and
the investigator refuses to start otherwise. `init` sets it, the trace directory and the control
socket there already.

Attach the console to a running loop, and detach again, without stopping it:

```bash
isophase console --attach .data/runs/control.sock --runs .data/runs
```

`--runs` must match the loop's `RUNS_DIR`, and `--attach` must match its `WATCH_CONTROL_SOCKET`;
neither derives from the other. Quit the console with `q` — it detaches and the loop keeps going.

| Variable | Default | What it does |
|---|---|---|
| `WATCH_POLL_INTERVAL_MS` | `300000` | how often to poll |
| `WATCH_ALERT_WINDOW` | `PT6H` | how far back each poll looks; overrides `DEFENDER_ALERT_WINDOW` |
| `WATCH_SPEND_CEILING_USD` | unset | stop when this much has been spent; `--watch` only |
| `WATCH_SKIP_STATUSES` | empty | vendor status values to skip, e.g. `resolved` |
| `WATCH_MAX_FAILURES_PER_ALERT` | `2` | park an alert after this many failures |
| `WATCH_CONTROL_SOCKET` | `runs/control.sock`; `init` sets `.data/runs/control.sock` | where a console attaches |
| `PUBLISH_FINDINGS` | `false` | **write findings to the source's case.** Off unless set |

`WATCH_SKIP_STATUSES` is empty on purpose: a wrong default silently skips alerts. The loop prints
the status values it saw in its first cycle, so set it from your tenant's own vocabulary.

If your alerts live in Microsoft Sentinel, they are reachable here only if the workspace is
onboarded to the Defender portal — `isophase probe --only I` tells you whether it is.

Or open the console against the tenant instead of running the loop:

```bash
isophase console --live defender           # Defender XDR
isophase console --live sentinel           # a real Log Analytics workspace
isophase console --live defender,sentinel  # both; the first named produces the alerts
```

Use `--live` rather than a bare `isophase console` — it sets the source and both artifact
directories together, which is what keeps tenant data under ignored `.data/` and out of the
repository. The details are in
[Open the console against a live tenant](#open-the-console-against-a-live-tenant), and the full
configuration for each source is under [Security data sources](#security-data-sources).

**If the queue is empty, check the window before concluding anything is broken.**
`DEFENDER_ALERT_WINDOW` defaults to `P7D`, and a tenant whose detections are older than seven days
reports `0 alert(s)` and exits successfully. Widen the window, or reach a known alert directly with
`isophase investigate --alert <id>`.

That is Track A. Everything below about Kusto, telemetry and scenarios belongs to Track B and you
can skip it.

## Track B — the local lab

Adds a deterministic security environment with known answers, so you can change the agent and
measure whether it got better.

### Prerequisites

| Tool | Requirement |
|---|---|
| [Bun](https://bun.sh) | 1.3 or newer; runtime and package manager |
| Docker CLI with Compose v2 | Runs Kusto and Mock Sentinel |
| Model access | OpenAI, Anthropic, or Google API key, or one llama-server endpoint |

The Kusto image is amd64-only. On Apple Silicon, use Colima with Apple Virtualization and Rosetta;
Podman's QEMU path does not run the emulator reliably. See the
[Kusto host notes](./infra/kusto/README.md) for the verified setup. This is the step most likely to
cost you time, and it is the reason Track A exists.

### Start the lab

```bash
bun run infra:up
bun run data:bootstrap
curl -s localhost:8787/health | jq
```

`data:bootstrap` creates 22 Kusto tables, ingests the pinned Microsoft Sentinel Training Lab
telemetry, generates alerts, and verifies representative data and scenario queries. It is safe to
run again. The emulator stores data inside its container, so bootstrap again after the container is
removed — `infra:down` followed by `infra:up` leaves an engine with no database at all.

Until that bootstrap completes, `/health` answers `503` with `dependencies.database: "down"`. That
is the expected reading of an unseeded stack, not a fault: the endpoint reports whether Mock
Sentinel can actually serve, and an engine with no `SentinelLab` cannot. Integration suites gate on
it and skip themselves rather than failing on empty results.

### Open the console

```bash
bun run console --fresh
```

`--fresh` is a clean session view: it hides runs that existed when the console opened without
deleting or modifying them. All alerts begin in the queue, and investigations started during the
session move into the Runs pane normally.
## Using the analyst console

The console is the primary way to operate the system:

```text
[1] Alerts   outstanding alerts from the primary source; ◆ means ground truth exists
[2] Runs     investigations visible in this session, newest first
[3] Case     facts for the active queue alert or selected run
[4] Main     Verdict · Agent stream · Activity · Transcript
```

The `◆` marker reveals only that an evaluation scenario exists. It never exposes the scenario id,
expected verdict, or other answer-key content.

### Common keys

```text
1–4       focus a pane                 j/k or arrows   move the selection
n         investigate an alert         x               cancel an active run
r         re-run with context/model    F               follow the agent stream
[ and ]   switch result tabs           /               filter the focused list
s         ground-truth alerts only     a               include covered alerts
y         copy focused content         R               re-read from disk
q         quit                         ?               complete key reference
```

Starting or re-running an investigation opens an overlay, because it calls the selected model
provider. It opens on the confirm strip, which defaults to Cancel; the optional context and model
fields sit above it, reached with ⇥ or ↑. The run appears immediately in `[2]`; Agent stream shows turns and tool calls as
they happen. Console-started runs always write a transcript. Cancellation persists an interrupted
artifact rather than discarding completed work.

Activity shows every tool call, including the exact KQL and result size. Verdict percentages use
the same 30–70 inconclusive band as the evaluator. The console writes nothing to disk at all — the
investigator remains the only writer of `runs/`.

### Console modes

```bash
bun run console                         # existing and new runs
bun run console --fresh                 # only runs started in this session
bun run console --read-only             # artifacts only; no queue or run controls
bun run console --runs <dir>            # another artifact directory
bun run console --traces <dir>          # another transcript directory
```

### Open the console against a live tenant

```bash
isophase console --live defender           # Defender XDR
isophase console --live sentinel           # a real Log Analytics workspace
isophase console --live defender,sentinel  # both; the first named produces the alerts
bun run console:live defender              # the same, from a clone
```

Use `--live` rather than a bare console, which resolves whatever `.env` names — on a checkout set
up for the local lab that is Mock Sentinel, so the queue reports it unreachable and the connector
looks broken when it is merely unselected. `--live` sets the source and both artifact directories
together (`.data/defender-runs`, `.data/azure-runs`, or `.data/live-runs` for a mixed run), which is
what keeps tenant data out of the repository, and forwards every other flag untouched.

It deliberately does not set `DEFENDER_ALERT_WINDOW`: that is a fact about a tenant's detection
cadence, not about running live, so it belongs in `.env` beside the credentials.

### Return alerts to the queue

Queue reset archives matching run artifacts; it does not delete them. Feedback moves only when
explicitly requested.

```bash
bun run queue:reset --run <run-id>
bun run queue:reset --alert <alert-id>
bun run queue:reset --restore --run <run-id>
bun run queue:reset --dry-run --all
bun run queue:reset --purge --run <run-id> --yes   # destroys the artifact
```

Archiving takes an alert out of the **queue** and leaves the run in the **benchmark** — `evaluate`
reads `runs/.archive/` too. Only `--purge` destroys a measurement, it requires `--yes`, and its dry
run reports the loss in scoreable draws rather than in files.

## Security data sources

The full configuration for each source, and what changes when more than one is active. Track A
above is the short version of the first two.

### Use Microsoft Defender XDR

Defender is reached through the Microsoft Graph security API: alerts from `alerts_v2`, telemetry
from advanced hunting. It runs alone — no Sentinel credential, no workspace, no Mock Sentinel
process — or alongside Sentinel with one of them producing alerts.

The app registration needs the Graph **application** permissions `SecurityAlert.Read.All` and
`ThreatHunting.Read.All`, with admin consent granted.
[`docs/defender-setup.md`](./docs/defender-setup.md) is the walkthrough.

```dotenv
SECURITY_SOURCES=defender
DEFENDER_TENANT_ID=<tenant-guid>
DEFENDER_CLIENT_ID=<application-client-guid>
DEFENDER_CLIENT_SECRET=<local-secret>

RUNS_DIR=.data/defender-runs
INVESTIGATOR_TRACE_DIR=.data/defender-runs/traces
```

All three credentials are required together and there is **no developer fallback** — unlike Azure,
`az login` is not a verified path to `ThreatHunting.Read.All`. A partial group is rejected by name.

Any run with Defender active refuses artifact paths outside ignored `.data/`, even when Sentinel is
`mock`, because a mixed run may carry tenant data. Those runs are unscored by construction, since
evaluation joins to the local scenario corpus: standalone Defender investigates, it does not
benchmark.

`DEFENDER_ALERT_WINDOW` (default `P7D`) bounds the queue, because `alerts_v2` supports no `$orderby`
and "the newest 500" is therefore not expressible. More than 500 in the window is refused with the
count rather than truncated; an empty window is not an error and reports `0 alert(s)`.

Before a real investigation, run the model-free live check shown in Track A. It loads the tenant's
advanced-hunting schema, runs an aggregate query, checks that invalid KQL returns the engine's own
diagnostic, and round-trips one alert when the window holds one — printing `round trip not
exercised` otherwise, since an empty queue is a property of the tenant. It writes no artifact.

### Use a real Microsoft Sentinel workspace

The selected Microsoft Entra identity needs the workspace-scoped `Log Analytics Data Reader` role.
Role assignment can take time to propagate. This project does not create identities, secrets or
role assignments and never writes to Azure.

Set the connector, workspace and local artifact paths in `.env`:

```dotenv
SENTINEL_CONNECTOR=azure
AZURE_LOG_ANALYTICS_WORKSPACE_ID=<workspace-guid>

RUNS_DIR=.data/azure-runs
INVESTIGATOR_TRACE_DIR=.data/azure-runs/traces
```

For a service principal, also set the complete credential group:

```dotenv
AZURE_TENANT_ID=<tenant-guid>
AZURE_CLIENT_ID=<application-client-guid>
AZURE_CLIENT_SECRET=<local-secret>
```

For local development, omit all three and sign in with `az login` or `Connect-AzAccount`; the
connector tries Azure CLI before Azure PowerShell. A complete service-principal group is used
exclusively, and a partial one is rejected rather than falling back to a personal account.

`AZURE_LOG_ANALYTICS_WORKSPACE_ID` is the Workspace ID shown on the workspace, not its name or ARM
resource ID. Workspace shared keys authorize ingestion, not queries, and are not supported. Azure
runs refuse artifact paths outside ignored `.data/`.

A live workspace returns its whole table catalogue, not only the tables holding data — one lab
workspace listed 833 where about ten held anything, against Mock Sentinel's 23. Only table names
reach the agent's opening context, so the cost is ~4,500 tokens, noisier than a local run suggests
but small beside the 40,000 characters one query result may spend. The connector lists at most 500
alerts and fails visibly rather than truncating.

Run the model-free live boundary check before a real investigation:

```bash
AZURE_SENTINEL_LIVE_TEST=true \
  bun test packages/sentinel-client/test/integration/azure.test.ts
```

Two tests. The first loads workspace schema, queries `SecurityAlert` and checks that invalid KQL
returns an actionable diagnostic. The second round-trips one alert and fails when the workspace
holds none — a fact about the tenant, since Sentinel writes `SecurityAlert` rows only once an
analytics rule fires. Neither calls a model or writes an artifact.

### Use several sources at once

```dotenv
SECURITY_SOURCES=defender,sentinel
PRIMARY_ALERT_SOURCE=defender
```

The primary is the only source that produces alerts; every active source stays queryable through
the `source` parameter on the schema and query tools, which defaults to the primary. With more than
one source active, `PRIMARY_ALERT_SOURCE` is required rather than guessed — primacy is a configured
role, not a property of a connector. Moving it changes which product's detections start an
investigation, and the run artifact records both the primary and the ordered active set, so two
runs over different source sets are different measurement conditions.

## Other workflows

### Run the investigator directly

```bash
bun run investigate                     # all alerts, sequentially
bun run investigate --alert <alert-id>  # one alert
```

Each invocation writes `runs/<run-id>.json`, and with tracing enabled a JSONL transcript under
`runs/traces/`. Both are ignored by version control: an artifact is *your* measurement of *your*
agent, and the repository ships the benchmark, not anyone's results (ADR 012).

### Evaluate runs

Evaluation joins run results with hidden scenario metadata outside the agent boundary. It prints;
it never writes a scored file, because a score plus the agent's own percentage recovers the verdict
and that would put the answer key on disk.

```bash
bun run evaluate                                   # every condition
bun run evaluate --run <run-id>                    # one run
bun run evaluate --compare <a> <b>                 # two runs, or two condition ids
bun run evaluate --gaps [--json]                   # what is missing before the corpus can answer
bun run evaluate --gaps --condition <id> ...       # ...for the conditions you intend to fill
bun run evaluate --runs <dir>                      # score a different set (implies <dir>/.archive)
bun run evaluate --exclude-archive                 # score only what the console's queue sees
```

Three words carry the report:

| | |
|---|---|
| **draw** | one investigation of one alert — one answer, one `tpPercent` |
| **condition** | everything a run was *set up* with: model, thinking level, limits, prompt hash, corpus, analyst premise. Runs sharing a condition are comparable |
| **cell** | one `(condition, scenario)` box, holding **every** draw. Nothing is overwritten and nothing is dropped |

A condition is the grouping key, not a thing being scored. **What is scored is the outcome against
ground truth** — the agent's `tpPercent` versus the scenario's true verdict, as a pass/fail band and
a Brier-style skill figure beside it. Turns, tool calls and cost print as columns for analysis and
never feed the score. The key hashes settings only, so two identically configured runs share a cell
whether or not the agent happened to search the web — that is a result, not a setup.

Three draws per cell is the floor at which a repeat means anything; `--gaps` counts the shortfall
and `--condition` narrows it to the conditions worth filling. Every run on disk is scored,
`runs/.archive/` included, and the report header fingerprints the exact set of run ids it scored.

### Operate the local data stack

```bash
bun run infra:up          # Kusto + Mock Sentinel
bun run infra:logs
bun run infra:down        # removes the Kusto container, and with it the database

bun run data:bootstrap   # create, ingest, and verify
bun run data:verify      # verify without ingesting
bun run data:reset       # drop and rebuild the database
bun run data:manifest    # regenerate telemetry and benchmark manifests
```

Mock Sentinel exposes `GET /health`, `/alerts`, `/alerts/:id`, `/schema`, `/corpus`, and
`POST /query` for read-only KQL. Tables whose name begins with `_` are internal bookkeeping:
`/schema` omits them and `/query` rejects them, because `/schema` feeds the agent's opening context
and a table listed there is a table the agent is invited to query.

Kusto is internal. Investigator and console code must never query it directly or import Mock
Sentinel fixture repositories.

## Architecture

Each hop in the chain at the top of this file is the *only* path to the next one.

The investigator is the only writer of `runs/`, and the only thing that writes to a tenant. The
console reads artifacts and — when attached to a running loop over its control socket — drives that
loop without owning the runs.

The repository is a Bun/TypeScript monorepo:

```text
apps/mock-sentinel/        REST facade, alert generation, Kusto integration
apps/investigator/         Pi harness, tools, run execution, cancellation
apps/console/              OpenTUI analyst queue and operator surface
packages/sentinel-client/  Mock and Azure implementations of the Sentinel capability
packages/contracts/        shared Zod network contracts
fixtures/telemetry/        pinned Training Lab telemetry
fixtures/scenarios/        hidden evaluation answer key
scripts/                   bootstrap, evaluation, benchmark map, queue reset
infra/                     Docker Compose and Kusto configuration
docs/                      architecture, PRDs, ADRs, and research notes
```

Important boundaries:

- Consumers reach Sentinel only through `packages/sentinel-client`.
- `apps/investigator/src/harness.ts` is the only Pi agent boundary.
- Zod validates runtime and network contracts; TypeBox is used only where Pi requires it.
- The agent cannot import, read, or receive `fixtures/scenarios/` content.
- Web content is untrusted data and is returned to the model in a provenance envelope.
- Run artifacts contain structured outcomes, not hidden chain-of-thought.

## Benchmark your own agent

The benchmark is two things, and both ship with this repository: **Microsoft's Sentinel Training
Lab telemetry**, a realistic corpus of security logs, and **14 scenarios** written over it — each
one an attack, or a benign lookalike, whose correct answer is known. Point any agent at the same
alerts and score it the same way.

Each scenario records four things:

| | |
|---|---|
| `verdict` | was the detected activity real and malicious? |
| `impact` | did it achieve anything? |
| `discriminatingEvidence` | the queries that settle it — an investigation skipping these can only be right by luck |
| `trap` | the wrong conclusion the scenario is built to catch |

Verdict and impact are separate on purpose: a detection can be entirely correct about real malicious
activity that nonetheless achieved nothing, and conflating the two is the most common triage error
these scenarios expose.

**Scoring grades direction, not a target.** The investigator reports true- and false-positive
percentages; `bun run evaluate` joins those to the hidden verdict outside the agent boundary and
bands them generously — true positive at 60% or above, false positive at 40% or below, 30–70% read
as inconclusive. Different valid investigations reach different numbers, so what is measured is
whether the agent leaned the correct way. The inconclusive band is the interesting one: it is the
only case where a confident answer in *either* direction is wrong.

**Ground truth flows one way.** The agent can never reach the answers — not by import, not by
reading them at runtime. Two guards enforce it, because either alone is insufficient: an oxlint rule
blocks static imports, and a test scans agent-side source *text* for the leak an import rule cannot
see, a runtime `Bun.file(...)`. `scripts/` is the single exempt tree, which is why the evaluator
lives there. The console's `◆` marker comes from a map holding ids and nothing else: knowing an
alert has an answer behind it is not knowing the answer.

The scenarios, and the fixture hazards that look like evidence but are not, are documented in the
[scenario reference](./fixtures/scenarios/README.md).

## Development

```bash
bun run fmt
bun run lint:fix
bun run check       # formatting, lint, typecheck, and all default tests
```

Tests needing Kusto or Mock Sentinel skip explicitly when those services are unavailable; start the
stack with `bun run infra:up` to exercise them. Tests that call a paid model or a live tenant are
opt-in, so `bun run check` needs no credential. Do not add dependencies without reviewing the
version and updating `bun.lock`.

The `bun run` scripts and the published `isophase` bin share one dispatcher, `apps/cli`:
`bun run investigate` is `bun apps/cli/src/index.ts investigate`, and there is no build step for
development. `bun run build` is the release build — one bundle in ignored `dist/` — and is run by
CI only. Releases are release-please's: merging the release pull request it keeps open on `main`
creates the tag and the GitHub Release and publishes `@aretea-group/isophase` to npm (PRD-11,
ADR 014).
Repository-specific implementation rules are in [`AGENTS.md`](./AGENTS.md).

## Design documents

[`docs/README.md`](./docs/README.md) indexes every PRD, decision record and research note, with a
one-line status for each. The three worth opening first:

- [Architecture](./docs/architecture.md) — the system as built
- [Decision records](./docs/adr/) — what changed course, and why
- [Roadmap](./docs/roadmap.md) — what is not built yet

The Kusto and scenario READMEs are scoped reference notes for their directories. This root README is
the only project-level setup and operating guide. [`CONTRIBUTING.md`](./CONTRIBUTING.md) is how to
send a change; [`SECURITY.md`](./SECURITY.md) is how to report a vulnerability privately.

## Licence and acknowledgements

The project is released under the [MIT licence](./LICENSE), copyright Aretea Group and
contributors.

The telemetry under `fixtures/telemetry/` is Microsoft's Sentinel Training Lab data, vendored
unmodified from [`Azure/Azure-Sentinel`](https://github.com/Azure/Azure-Sentinel) and carrying
Microsoft's own copyright under its separate [MIT licence](./fixtures/telemetry/LICENSE); see
[`fixtures/telemetry/SOURCE.md`](./fixtures/telemetry/SOURCE.md) for the pinned revision and the
trademark notice.
