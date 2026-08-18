# SOC Investigation Agent

An autonomous investigation agent for T1+ SOC alerts, built against a local,
deterministic Microsoft Sentinel-like environment.

The implementation contract for coding agents is [`AGENTS.md`](./AGENTS.md).
The architecture baseline is [`docs/architecture.md`](./docs/architecture.md).

## Status

**Phase 3 — Mock Sentinel REST API. Complete.**
([PRD-1 §4.2–4.5](./docs/prd-1-mock-sentinel.md), AGENTS.md §14.)

`bun run data:bootstrap` takes a cold emulator to 22 populated tables — 25,130 rows
across 1,168 columns — in about two seconds, from telemetry vendored at a pinned
upstream revision. It verifies row counts, per-column population, the schema Kusto
itself reports, and representative scenario queries, and fails with every problem
listed rather than the first.

The full Sentinel surface is live:

```text
GET  /health          operational only
GET  /alerts          151 alerts, ARM-shaped
GET  /alerts/:id
GET  /schema          22 tables, read from the engine
POST /query           read-only KQL
```

Next is Phase 4, the Sentinel Client.

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
packages/contracts/     Zod contracts crossing the REST boundary
fixtures/telemetry/     vendored Training Lab CSVs (MIT, pinned revision)
fixtures/scenarios/     evaluation metadata, hidden from consumers
scripts/                bootstrap and manifest generation CLIs
infra/                  docker-compose + Kusto Emulator notes
docs/                   architecture, PRDs, ADRs
```

Packages are consumed **as TypeScript source** via workspace `exports`; nothing is
compiled ahead of time.

New packages are created when a milestone needs them, not in advance
(AGENTS.md §5). `packages/sentinel-client`, `packages/agent-runtime`,
`packages/persistence`, `packages/testkit` and `baml_src/` therefore do not exist
yet.

## Architectural boundaries

Two rules are enforced by tooling rather than convention:

- **Mock Sentinel internals are private.** An `oxlint` `no-restricted-imports`
  rule fails the build if anything outside `apps/mock-sentinel` imports its
  source. Consumers must go through HTTP, and later the Sentinel Client.
- **Configuration is validated once.** Only `apps/mock-sentinel/src/config.ts`
  reads the environment; everything else receives a parsed `Config`.

## Contracts

Per [ADR 003](./docs/adr/003-contract-boundaries.md):

- **Zod 4** validates runtime and network boundaries.
- **BAML** owns LLM prompt/output contracts, and arrives with the assessment slice.

Types are inferred from schemas. Do not hand-write parallel interfaces.
