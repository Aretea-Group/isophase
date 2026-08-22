# SOC Investigation Agent

An autonomous LLM agent that investigates realistic Microsoft Sentinel alerts against a local,
deterministic security lab. The analyst operates it through a terminal UI, follows the investigation
live, reviews the evidence and exact KQL, and records the final classification.

```text
Microsoft Sentinel Training Lab telemetry
              ↓
      Kusto Emulator
              ↓
       Mock Sentinel REST
              ↓
        Sentinel Client
              ↓
       Pi investigation agent
              ↓
 run artifact + transcript + evaluation
              ↓
       Analyst console (TUI)
```

The agent chooses its own investigative path. It receives the alert and available table names, then
may query security data, research the public web, or conclude from the starting evidence. A valid
`submit_investigation` tool call is the only successful outcome; there are no alert-specific
playbooks or hidden answer-key access.

PRD-1 through PRD-5 are implemented: the local Sentinel environment, autonomous investigator,
evaluation scenarios, and console operator surface. This README is the canonical setup and usage
guide. The files under `docs/` contain design history and decisions rather than a second getting
started path.

## Quick start

### Prerequisites

| Tool | Requirement |
|---|---|
| [Bun](https://bun.sh) | 1.3 or newer; runtime and package manager |
| Docker CLI with Compose v2 | Runs Kusto and Mock Sentinel |
| Model access | OpenAI, Anthropic, or Google API key, or one keyless llama-server endpoint |

The Kusto image is amd64-only. On Apple Silicon, use Colima with Apple Virtualization and Rosetta;
Podman's QEMU path does not run the emulator reliably. See the
[Kusto host notes](./infra/kusto/README.md) for the verified setup.

### Install and configure

```bash
bun install
cp .env.example .env
```

Set the provider, model, and matching API key in `.env`. The default is:

```dotenv
INVESTIGATOR_PROVIDER=openai
INVESTIGATOR_MODEL=gpt-5.6-luna
OPENAI_API_KEY=...
```

Alternatively, configure one keyless llama-server model through its OpenAI-compatible endpoint:

```dotenv
INVESTIGATOR_PROVIDER=llamacpp
INVESTIGATOR_MODEL=local-model
INVESTIGATOR_THINKING_LEVEL=off
LLAMA_SERVER_BASE_URL=https://host.example/v1
LLAMA_SERVER_MODEL=local-model
LLAMA_SERVER_CONTEXT_WINDOW=65536
LLAMA_SERVER_MAX_TOKENS=4096
```

The endpoint must implement `/v1/chat/completions` and return standard `message.tool_calls`.
Model loading, server presets, and lifecycle remain operator responsibilities. Initial support is
keyless and text-only. Reasoning is disabled per request, even when a server preset defaults it on;
model-specific reasoning levels and tool syntax embedded in message content are not interpreted.
Run artifacts record endpoint URL and model limits, so results from different server configurations
remain distinct measurements.

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
[1] Alerts   outstanding alerts from Mock Sentinel; ◆ means ground truth exists
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
r         re-run with context/model    f               record your feedback
[ and ]   switch result tabs           /               filter the focused list
s         ground-truth alerts only     a               include covered alerts
y         copy focused content         R               re-read from disk
q         quit                         ?               complete key reference
```

Starting or re-running an investigation opens an overlay because it calls the selected model
provider. It opens on the confirm strip, which defaults to Cancel; the optional context and model
fields sit above it, reached with ⇥ or ↑. The run appears immediately in `[2]`; Agent stream shows turns and tool calls as
they happen. Console-started runs always write a transcript. Cancellation persists an interrupted
artifact rather than discarding completed work.

Activity shows every tool call, including the exact KQL and result size. Verdict percentages use
the same 30–70 inconclusive band as the evaluator. Analyst classifications are stored separately in
`feedback/`; the investigator remains the only writer of `runs/`.

### Console modes

```bash
bun run console                         # existing and new runs
bun run console --fresh                 # only runs started in this session
bun run console --read-only             # artifacts only; no queue or run controls
bun run console --runs <dir>            # another artifact directory
bun run console --traces <dir>          # another transcript directory
```

### Return alerts to the queue

Queue reset archives matching run artifacts; it does not delete them. Feedback moves only when
explicitly requested.

```bash
bun run queue:reset --run <run-id>
bun run queue:reset --alert <alert-id>
bun run queue:reset --alert <alert-id> --include-feedback
bun run queue:reset --restore --run <run-id> --include-feedback
bun run queue:reset --dry-run --all
bun run queue:reset --purge --run <run-id> --yes   # destroys the artifact
```

Archiving takes an alert out of the **queue** and leaves the run in the **benchmark** — `evaluate`
reads `runs/.archive/` too. Only `--purge` destroys a measurement, it requires `--yes`, and its dry
run reports the loss in scoreable draws rather than in files.

## Other workflows

### Run the investigator directly

```bash
bun run investigate                     # all alerts, sequentially
bun run investigate --alert <alert-id>  # one alert
```

Each invocation writes `runs/<run-id>.json`. With tracing enabled, each alert also gets a JSONL
transcript under `runs/traces/`.

**Run artifacts are committed.** A run costs real money against a model with no seed, so it cannot
be re-derived — only bought again — and a benchmark that cannot be reproduced from a fresh clone is
not a benchmark. Expect `git status` to show new artifacts after an investigation. Transcripts stay
local: `runs/traces/` is gitignored and runs to hundreds of megabytes.

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
as a Brier-style skill figure beside it. Turns, tool calls and cost print as columns for analysis and
are never inputs to the score. The key hashes settings only: two runs configured identically share a
cell whether or not the agent happened to search the web, because that is a result, not a setup.

Three draws per cell is the floor at which a repeat means anything. `--gaps` counts the shortfall and
`--condition` narrows it to the conditions worth filling — unfiltered it totals every condition on
disk, including pre-config generations whose harness no longer exists.

Every run ever recorded is scored, `runs/.archive/` included. Archiving returns an alert to the
console's queue; it must not delete a measurement, and the report header fingerprints the exact set
of run ids it scored so a quoted number can be checked later.

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

Mock Sentinel exposes the boundary used by the client and investigator:

```text
GET  /health
GET  /alerts
GET  /alerts/:id
GET  /schema
POST /query        read-only KQL
GET  /corpus       which data is loaded: time anchor, telemetry revision, alert-set hash
```

Tables whose name begins with `_` are internal bookkeeping: `/schema` omits them and `/query`
rejects them, because `/schema` feeds the agent's opening context and a table listed there is a
table the agent is invited to query.

Kusto is internal. Investigator and console code must never query it directly or import Mock
Sentinel fixture repositories.

## Architecture

The system is a one-directional chain, and each hop is the *only* path to the next:

```text
   fixtures/telemetry/          pinned Training Lab CSVs, at a fixed revision
            │
            │  scripts/bootstrap-sentinel-data.ts
            ▼
   ┌───────────────────┐
   │  Kusto Emulator   │        internal — nothing downstream may address it
   └───────────────────┘
            │  KQL
            ▼
   ┌───────────────────┐        GET  /alerts  /alerts/:id  /schema
   │   Mock Sentinel   │ :8787  POST /query   (read-only KQL)
   └───────────────────┘        owns the entire domain surface; /health is operational
            │
            │  packages/sentinel-client — typed, over packages/contracts
            ▼
   ┌───────────────────┐
   │   Investigator    │        harness.ts is the only Pi boundary; five tools
   └───────────────────┘
            │
            │  writes runs/<run-id>.json, flushed after every alert
            ▼
   ┌───────────────────┐
   │   run artifact    │        the join point — both readers, neither writes
   └───────────────────┘
            │
      ┌─────┴──────┐
      ▼            ▼
   Console      scripts/evaluate-runs.ts ◄─── fixtures/scenarios/
   read-only    scores against ground truth    hidden from the agent
```

The repository is a Bun/TypeScript monorepo:

```text
apps/mock-sentinel/        REST facade, alert generation, Kusto integration
apps/investigator/         Pi harness, tools, run execution, cancellation
apps/console/              OpenTUI analyst queue and operator surface
packages/sentinel-client/  typed client for the Mock Sentinel boundary
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

## Benchmarking and ground truth

Scenarios are the answer key. Each one is a small metadata file in `fixtures/scenarios/`, layered
over the shared telemetry rather than duplicating it, recording four things:

| | |
|---|---|
| `verdict` | was the detected activity real and malicious? |
| `impact` | did it achieve anything? |
| `discriminatingEvidence` | the queries that settle it — an investigation skipping these can only be right by luck |
| `trap` | the wrong conclusion the scenario is built to catch |

`verdict` and `impact` are separate on purpose: a detection can be entirely correct about real
malicious activity that nonetheless achieved nothing, and conflating the two is the most common
triage error these scenarios expose.

**Ground truth flows one way.** The agent can never reach those files — not by import, and not by
reading them at runtime. Two guards enforce it, because either alone is insufficient: an oxlint
rule blocks static imports, and a test scans agent-side source *text* for the realistic leak, a
runtime `Bun.file(...)` no import rule can see. `scripts/` is the single exempt tree, which is why
both the evaluator and the benchmark-map generator live there. The console's `◆` marker comes from
a generated map holding ids and nothing else: knowing an alert has an answer behind it is not
knowing the answer.

**Scoring grades direction, not a target.** The investigator reports true- and false-positive
percentages; `bun run evaluate` joins those to the hidden verdict outside the agent boundary and
bands them generously — true positive at 60% or above, false positive at 40% or below, with 30–70%
read as inconclusive. Different valid investigations reach different numbers, so what is measured
is whether the agent leaned the correct way. The inconclusive band is the interesting one: it is
the only case where a confident answer in *either* direction is wrong.

The answer key and the fixture hazards that look like evidence but are not are documented in the
[scenario reference](./fixtures/scenarios/README.md).

## Configuration

All supported variables and defaults are documented in [`.env.example`](./.env.example). The main
groups are:

- Mock Sentinel and Kusto endpoints;
- provider, model, thinking level, timeouts, and turn limits;
- OpenAI, Anthropic, or Google credentials, or one keyless llama-server endpoint;
- optional Brave Search credentials;
- run, transcript, and analyst-feedback directories;
- query and tool-result size limits.

The investigator validates configuration before starting an alert. The console model picker shows
only providers for which credentials are available.

## Development

```bash
bun run fmt
bun run lint:fix
bun run check       # formatting, lint, typecheck, and all default tests
```

Tests requiring Kusto or Mock Sentinel skip explicitly when the services are unavailable. Start the
stack with `bun run infra:up` and bootstrap it to exercise those integration paths. Tests that call
a paid model are opt-in and are not part of default CI.

Do not add dependencies without reviewing the version and updating `bun.lock`. Repository-specific
implementation rules are in [`AGENTS.md`](./AGENTS.md).

## Design documents

- [Architecture](./docs/architecture.md)
- [PRD-1 — Mock Sentinel](./docs/prd-1-mock-sentinel.md)
- [PRD-2 — Core investigation agent](./docs/prd-2-Core%20Investigation%20Agent.md)
- [PRD-3 — Analyst console](./docs/prd-3-analyst-console.md)
- [PRD-4 — Ground-truth expansion](./docs/prd-4-ground-truth-expansion.md)
- [PRD-5 — Console operator surface](./docs/prd-5-console-operator-surface.md)
- [PRD-6 — Run comparability](./docs/prd-6-run-comparability.md)
- [Architecture decision records](./docs/adr/)
- [Roadmap](./docs/roadmap.md)

The Kusto and scenario READMEs are deliberately scoped reference notes for those directories. This
root README is the only project-level setup and operating guide.
