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
| Model-provider API key | OpenAI, Anthropic, or Google; configure one in `.env` |

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

### Start the lab

```bash
bun run infra:up
bun run data:bootstrap
curl -s localhost:8787/health | jq
```

`data:bootstrap` creates 22 Kusto tables, ingests the pinned Microsoft Sentinel Training Lab
telemetry, generates alerts, and verifies representative data and scenario queries. It is safe to
run again. The emulator stores data inside its container, so bootstrap again after the container is
removed.

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
```

## Other workflows

### Run the investigator directly

```bash
bun run investigate                     # all alerts, sequentially
bun run investigate --alert <alert-id>  # one alert
```

Each invocation writes `runs/<run-id>.json`. With tracing enabled, each alert also gets a JSONL
transcript under `runs/traces/`.

### Evaluate runs

Evaluation joins run results with hidden scenario metadata outside the agent boundary.

```bash
bun run evaluate                  # latest baseline run per model and scenario
bun run evaluate --run <run-id>   # one run
bun run evaluate --compare a b    # compare two runs
```

### Operate the local data stack

```bash
bun run infra:up          # Kusto + Mock Sentinel
bun run infra:logs
bun run infra:down

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
```

Kusto is internal. Investigator and console code must never query it directly or import Mock
Sentinel fixture repositories.

## Architecture

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

The scenario metadata keeps verdict and impact separate: malicious activity can be real while
achieving no impact. More details about the answer key and fixture hazards live in the
[scenario reference](./fixtures/scenarios/README.md).

## Configuration

All supported variables and defaults are documented in [`.env.example`](./.env.example). The main
groups are:

- Mock Sentinel and Kusto endpoints;
- provider, model, thinking level, timeouts, and turn limits;
- OpenAI, Anthropic, or Google credentials;
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
- [Architecture decision records](./docs/adr/)
- [Roadmap](./docs/roadmap.md)

The Kusto and scenario READMEs are deliberately scoped reference notes for those directories. This
root README is the only project-level setup and operating guide.
