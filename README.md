# SOC Investigation Agent

An autonomous investigation agent for T1+ SOC alerts, built against a local,
deterministic Microsoft Sentinel-like environment.

The implementation contract for coding agents is [`AGENTS.md`](./AGENTS.md).
The architecture baseline is [`docs/architecture.md`](./docs/architecture.md).

## Status

**Phases 4–7 — Sentinel Client, Core Investigation Agent and Analyst Console. Complete.**
Phase 6 — evaluation — is in progress; follow-up work is in
[`docs/roadmap.md`](./docs/roadmap.md).
([PRD-2](./docs/prd-2-Core%20Investigation%20Agent.md), [PRD-3](./docs/prd-3-analyst-console.md),
[ADR 005](./docs/adr/005-investigation-agent-boundary.md), [ADR 006](./docs/adr/006-analyst-console.md),
AGENTS.md §14.)

`bun run data:bootstrap` takes a cold emulator to 22 populated tables — 25,130 rows
across 1,168 columns — in about two seconds, from telemetry vendored at a pinned
upstream revision. It verifies row counts, per-column population, the schema Kusto
itself reports, and representative scenario queries, and fails with every problem
listed rather than the first.

The full Sentinel surface is live:

```text
GET  /health          operational only
GET  /alerts          154 alerts, ARM-shaped
GET  /alerts/:id
GET  /schema          22 tables, read from the engine
POST /query           read-only KQL
```

An autonomous agent investigates those alerts:

```bash
bun run investigate                     # every alert, sequentially
bun run investigate --alert <alert-id>  # one alert
```

Each invocation writes `runs/<run-id>.json` with a TP/FP assessment per alert,
keyed by `systemAlertId` so it joins directly to the hidden scenario fixtures.
The agent gets the alert, the table names, read-only KQL, public web research and
a structured submission — and decides for itself what to look at. There is no
playbook (PRD-2 §2).

A valid `submit_investigation` is the only way an investigation succeeds; a
confident closing message is not a result (PRD-2 §16).

Requires a provider key — see [`.env.example`](./.env.example). Set
`INVESTIGATOR_TRACE=true` to capture the full agent transcript per investigation.

Runs are scored against the hidden scenario fixtures, outside the agent:

```bash
bun run evaluate                  # scorecard vs ground truth, by model
bun run evaluate --compare a b    # diff two runs
```

## Analyst console (TUI)

Start the local services and open the console:

```bash
bun run infra:up
bun run console
```

The normal view loads existing artifacts from `runs/` and the alert queue from Mock Sentinel. Use
`--fresh` for a clean, non-destructive session: runs that existed when the console opened are hidden,
all alerts return to the queue, and investigations started during that session appear normally.

```bash
bun run console --fresh                 # hide earlier runs for this session
bun run console --read-only             # inspect artifacts without an alert queue or run controls
bun run console --runs <dir>            # use another artifact directory
bun run console --traces <dir>          # use another transcript directory
```

The four panes are:

```text
[1] Alerts   outstanding work from the live alert corpus; ◆ means ground truth exists
[2] Runs     investigations visible in this session, newest first
[3] Case     facts for the active queue alert or selected run
[4] Main     Verdict · Agent stream · Activity · Transcript
```

Useful keys:

```text
1–4       focus a pane                 j/k or arrows   move the selection
n         investigate the alert        x               cancel an active run
e         re-run with analyst context  d               record an analyst classification
[ / ]     switch result tabs           /               filter the focused list
s         ground-truth alerts only      a               include covered alerts in the queue
y         copy the focused content      ?               open the complete key reference
q         quit
```

Starting or extending a run opens a confirmation overlay because it calls the configured model
provider. The new run immediately moves from `[1]` to `[2]`; Agent stream shows its turns and tool
calls live. Console-started runs always record transcripts. `x` interrupts the active investigation
and persists the partial artifact, while `d` writes the analyst's classification separately under
`feedback/`.

The `◆` marker reveals only that an evaluation scenario exists, never its id or expected verdict.
Activity exposes every tool call and exact KQL; `y` copies the selected content. Verdict percentages
use the same 30–70 inconclusive band as `bun run evaluate`.

To put selected alerts back into the outstanding queue, archive their runs. Feedback is untouched
unless explicitly included:

```bash
bun run queue:reset --run <run-id>
bun run queue:reset --alert <alert-id> --include-feedback
bun run queue:reset --restore --run <run-id> --include-feedback
```

See [PRD-5](./docs/prd-5-console-operator-surface.md),
[PRD-3](./docs/prd-3-analyst-console.md), and
[ADR 006](./docs/adr/006-analyst-console.md).

### What it has answered so far

> Can an autonomous LLM investigator, with general access to security telemetry and
> public research, produce useful T1/T2 assessments without predefined playbooks?

Yes at `gpt-5.6-terra`, no at `gpt-5.6-luna`, on an identical prompt, tool set and
contract. Terra reached the correct direction on 5 of the 6 ground-truth scenarios
including the one the fixtures designate as the calibration control, found a
multi-host intrusion without being told to look past the alert's named entity, and
declined to treat a vendor `false_positive` label as evidence. Luna failed that
control and scoped every one of its sixteen queries to the single named host.

Read the numbers with care: n=6 is too small to tune against. Two impact judgements
flipped in opposite directions between runs differing only in wording that does not
touch impact, so single-point score movements are variance rather than signal.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| [Bun](https://bun.sh) | ≥ 1.3.0 | runtime *and* package manager; there is no Node build step |
| Docker CLI + Compose v2 | any | `docker compose` must resolve |
| Colima | with `--vm-type vz --vz-rosetta` on Apple Silicon | the Kusto Emulator is amd64-only and needs Rosetta, not QEMU — see [`infra/kusto/README.md`](./infra/kusto/README.md) |

On Apple Silicon, the verified container host is Colima with Apple Virtualization +
Rosetta. Podman does not work: it falls back to QEMU, under which the Kusto Emulator
never starts serving.

```bash
brew install colima docker docker-compose
colima start --vm-type vz --vz-rosetta --memory 6 --cpu 4
docker run --rm --platform linux/amd64 alpine uname -m   # must print x86_64
```

## Quickstart

```bash
bun install
cp .env.example .env
bun run check           # format, lint, typecheck, test
bun run dev:mock-sentinel
curl -s localhost:8787/health | jq
```

Local infrastructure:

```bash
bun run infra:up        # kusto + mock-sentinel
bun run infra:logs
bun run infra:down
```

## Alerts

The Training Lab ships **no alert data**, so alerts are produced the same two ways
real Sentinel produces them ([ADR 004](./docs/adr/004-alert-api-shape.md)):
19 scheduled analytics rules running KQL over the telemetry, and connector mappers
translating vendor alert tables. Every alert is therefore derived from data that is
actually present — none is hand-written.

They are served ARM-shaped over `/alerts` **and** stored as a real 35-column
`SecurityAlert` table, so the same alert is reachable by REST and by KQL and the two
cannot diverge.

`POST /query` refuses control commands. The Kusto query endpoint executes them, so
that guard is the only boundary, not defence in depth.

## Scenarios

[`fixtures/scenarios/`](./fixtures/scenarios/) holds the evaluation answer key
(PRD-1 §5): a starting alert, the queries that settle it, and the verdict a competent
analyst should reach. **No route serves it**, and a test asserts that.

`verdict` and `impact` are recorded separately on purpose — a detection can be
entirely correct about real malicious activity that achieved nothing, and conflating
the two is the triage error the set exists to catch.

## Telemetry

The Microsoft Sentinel Training Lab CSVs are vendored under `fixtures/telemetry/`
at a pinned revision (MIT; provenance and per-file checksums in
[`fixtures/telemetry/SOURCE.md`](./fixtures/telemetry/SOURCE.md)). Load them with:

```bash
bun run data:bootstrap   # create tables and ingest; safe to re-run
bun run data:reset       # drop the database first
bun run data:verify      # check an existing database, ingest nothing
bun run data:manifest    # regenerate column types after a revision bump
```

The loader is not a copy of the upstream PowerShell one. It preserves original
event timestamps instead of restamping every row to `now()`, so relative event
ordering — the thing an investigation actually reasons about — survives. Each file
declares its own date convention, because the lab does not use a single one and a
global assumption silently scatters the data across eight months
([ADR 001](./docs/adr/001-training-lab-kusto.md)).

Bumping the pinned upstream revision is a dependency upgrade: re-vendor, run
`bun run data:manifest`, review the generated diff, then re-run the bootstrap.

## Quality gates

Every change must keep `bun run check` green (AGENTS.md §6):

```bash
bun run fmt:check       # oxfmt
bun run lint            # oxlint --deny-warnings
bun run typecheck       # tsc --noEmit
bun test
```

`bun run fmt` and `bun run lint:fix` apply the fixable subset.

Tests that assert on telemetry run against a real Kusto Emulator — the data is only
reachable through it, so there is no faked query engine anywhere (AGENTS.md §7).
They skip with an explicit message when none is running, so `bun test` stays green
without Docker; start one with `bun run infra:up` to actually exercise them.

Formatting covers source and config files only — Markdown is excluded so the
architecture documents are not rewritten by tooling.

## Layout

```text
apps/mock-sentinel/     REST facade — owns the entire public surface of the mock
  src/routes/           /health, /alerts, /schema, /query
  src/alerts/           rules, connectors, entity building, ARM projection
  src/kusto/            HTTP client for the emulator; the only thing that talks to it
  src/telemetry/        manifest, CSV normalisation, ingestion, verification
  src/scenarios/        answer-key loader — never routed
apps/investigator/      the autonomous agent
  src/harness.ts        the only file in the repo that imports Pi
  src/tools/            the five agent capabilities
  src/clients/          Brave search and guarded page fetch
apps/console/           analyst queue and investigation operator console (TUI)
  src/data/             lenient readers for artifacts and transcripts
  src/view/             pure view models — no terminal, no renderer import
  src/ui/               the only code that knows OpenTUI exists
packages/sentinel-client/  typed client for the REST boundary
packages/contracts/     Zod contracts crossing the REST boundary
fixtures/telemetry/     vendored Training Lab CSVs (MIT, pinned revision)
fixtures/scenarios/     evaluation metadata, hidden from consumers
runs/                   run artifacts and traces (gitignored)
scripts/                bootstrap, manifest generation, and run evaluation
infra/                  docker-compose + Kusto Emulator notes
docs/                   architecture, PRDs, ADRs
```

Packages are consumed **as TypeScript source** via workspace `exports`; nothing is
compiled ahead of time.

New packages are created when a milestone needs them, not in advance
(AGENTS.md §5). `packages/agent-runtime`, `packages/persistence`,
`packages/testkit` and `baml_src/` therefore do not exist — and `agent-runtime`
deliberately never will, since `harness.ts` is already the single replaceable Pi
boundary ADR 002 asked for ([ADR 005 §7](./docs/adr/005-investigation-agent-boundary.md)).

## Architectural boundaries

Two rules are enforced by tooling rather than convention:

- **Mock Sentinel internals are private.** An `oxlint` `no-restricted-imports`
  rule fails the build if anything outside `apps/mock-sentinel` imports its
  source. Consumers must go through HTTP, and later the Sentinel Client.
- **Configuration is validated once.** Only `apps/mock-sentinel/src/config.ts` and
  `apps/investigator/src/env.ts` read the environment; everything else receives a
  parsed config. The investigator validates at import, so a missing key stops the
  process before the first alert rather than partway through a sweep.
- **The agent cannot reach ground truth.** `fixtures/scenarios/` holds each
  scenario's verdict, the KQL that settles it, and the trap it was built to catch.
  An `oxlint` rule blocks importing it, and
  `apps/investigator/test/ground-truth-isolation.test.ts` scans agent-side source
  for any reference or runtime read — the lint rule alone would miss
  `Bun.file(...)`. Evaluation joins the two in `scripts/`, outside the agent.

## Contracts

Per [ADR 003](./docs/adr/003-contract-boundaries.md):

- **Zod 4** validates runtime and network boundaries — REST, configuration, run
  artifacts.
- **TypeBox** owns the Pi tool boundary: tool parameters and the submission
  contract. Not a preference — `pi-agent-core` types `AgentTool.parameters` as a
  TypeBox `TSchema` and offers no Zod path
  ([ADR 005 §5](./docs/adr/005-investigation-agent-boundary.md)). It is re-exported
  by `pi-ai`, so it adds no dependency.
- **BAML** is deferred. The agent submits its own assessment through a validated
  tool call instead ([ADR 005 §1](./docs/adr/005-investigation-agent-boundary.md)).

Types are inferred from schemas. Do not hand-write parallel interfaces.
