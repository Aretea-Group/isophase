# AGENTS.md — Isophase

The implementation contract for coding agents working in this repository.

**Precedence.** ADRs decide, this file constrains, `CLAUDE.md` orients. Where an ADR and this file
disagree the ADR wins and this file is stale — fix it here rather than working around it.

Section numbers are an interface: `AGENTS.md §N` is cited from other documents and from source.
Append new sections; never renumber or reuse one. Gaps in the numbering are deliberate.

## Commands

| | |
|---|---|
| `bun run check` | fmt:check → lint → typecheck → test. Every change must keep this green |
| `bun test <file>` | one test file. `bun test -t "<name>"` matches by test name |
| `bun run infra:up` / `infra:down` / `infra:logs` | Kusto Emulator + Mock Sentinel over Docker Compose |
| `bun run data:bootstrap` | create tables and ingest telemetry; safe to re-run. Also `data:reset`, `data:verify`, `data:manifest` |
| `bun run dev:mock-sentinel` | REST facade on `:8787`, watch mode |
| `bun run investigate [--alert <systemAlertId>]` | one sweep of the agent; needs a provider key in `.env` |
| `bun run evaluate [--run <id>] [--compare <a> <b>] [--gaps]` | score runs against the hidden ground truth |
| `bun run console [--runs <dir>] [--traces <dir>]` | read-only TUI over `runs/` |

There is no build step for development: workspace packages are consumed as TypeScript **source**
through their `exports`, so `tsc` only ever type-checks. The release build (`bun run build`,
PRD-11, ADR 014) bundles the `isophase` bin into `dist/`, is run by CI only, and is never
committed — `dist/` is ignored, and nothing in development reads it. Integration suites under `**/test/integration/` probe for
their live dependency and `describe.skipIf` themselves out with a printed reason — `bun test` stays
green without Docker and proves nothing about them.

## 1. Mission

Build the smallest end-to-end system in which an autonomous LLM agent can investigate a realistic
mocked Microsoft Sentinel alert.

Do not implement a roadmap feature before its PRD exists.

## 2. Current Scope

In scope: a TypeScript/Bun monorepo; the Mock Sentinel REST service over a Kusto Emulator loaded
with Training Lab telemetry; Mock and Azure Sentinel connectors behind the alert-oriented tabular
security data-source boundary (ADR 010), plus an in-memory non-KQL fixture that exists only to prove
that boundary (ADR 010 §6); a read-only Microsoft Defender XDR connector over the Graph security API,
with several sources active in one investigation and exactly one of them producing alerts (ADR 011);
the investigation runtime and its Pi integration; the five agent tools
(§10); structured submission as the Definition of Done; run artifacts and evaluation against the
hidden scenario metadata; and a local operator console.

Out of scope — these are the non-goals other documents cite:

- cross-investigation memory;
- human-feedback retrieval;
- generalized ingestion;
- SOAR forwarding;
- web/product frontend — a *local operator console* is in scope from PRD-3 and PRD-5 (ADR 006 §1,
  ADR 007);
- RBAC/authentication;
- `init` provisions nothing in a tenant — no Entra application, service principal, permission
  grant or Azure resource; it writes a `.env`, creates local directories and makes no network call
  (PRD-11 §3, ADR 014);
- the lab is not published — `apps/mock-sentinel`, `fixtures/`, `infra/` and the benchmark tooling
  under `scripts/` stay clone-only; the npm package is Track A only (PRD-11 §3, ADR 014);
- threat intelligence;
- alert grouping;
- multi-tenancy;
- production HA;
- ~~a live second-SIEM connector~~ — **reversed by ADR 011.** Microsoft Defender XDR is a live second
  product, in scope and delivered. What stays out is merging or deduplicating alerts across sources
  (ADR 011 §4), ~~the Defender incidents API (§1), any write path,~~ and Defender ground truth or
  scoring — Defender runs are unscored by construction.
  **Narrowed by ADR 013:** reading incidents *as an investigation unit* stays out — a run is keyed
  on one alert id (ADR 011 §1). Writing one additive comment to an alert's incident is in scope and
  is the only write this system performs; `PATCH`-ing the alert itself was measured and discards the
  field (ADR 013 §6).

Delivery status is not kept here — see [`docs/README.md`](./docs/README.md).

## 3. Architecture Rules

The system is a one-directional chain in which each hop is the only path to the next. These are the
rules an implementation can actually violate.

### Security data-source boundary

Investigation consumers reach the active sources through `SecurityDataSource` and their immutable
query profiles (ADR 010 §4, ADR 011 §3). Mock Sentinel, Azure Sentinel and Microsoft Defender are
concrete connectors in `@soc/sentinel-client`; their transport and native contracts do not enter
investigation control flow.

Startup selects an ordered set of sources with exactly one primary. The primary is the only source
that produces alerts (`listAlerts`, `getAlert`, `getCorpus`); every active source is queryable
(ADR 011 §4). Primacy is a configured role, not a property of a connector.

Never:
- import Mock Sentinel fixture repositories from investigator code;
- query Kusto directly from investigator code;
- couple the agent runtime to Mock Sentinel URLs;
- branch investigation control flow on source **kind**, connector or query language.

`sources.get(id)` is routing and is allowed — ADR 011 §5 narrows ADR 010 §4's "no source-id branch"
to the rule that was load-bearing. `if (kind === "defender")` inside investigation control flow stays
forbidden.

### Agent boundary

Use `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`. Not the deprecated
`@mariozechner/pi-*` packages.

`apps/investigator/src/harness.ts` is the single Pi boundary ADR 002 asks for and the only file that
imports Pi. Do not implement a custom LLM/tool `while` loop without an ADR documenting a concrete Pi
limitation, and do not wrap the harness in a package — that is the generic agent framework §2 and
PRD-2 §24 exclude.

### Investigation strategy

The agent owns the investigative path. Do not implement alert-specific deterministic playbooks, and
do not force a security-data query — the agent may conclude the starting alert is sufficient.

### Ground truth flows one way

`fixtures/scenarios/` is reachable from `scripts/` and from nothing the agent can touch. Two guards,
because either alone is insufficient: an oxlint `no-restricted-imports` rule blocks static imports,
and `apps/investigator/test/ground-truth-isolation.test.ts` scans agent-side source *text* for the
runtime `Bun.file` read no import rule can see. Adding a source root the agent can reach means adding
it to that test's `ROOTS`.

### Contracts

Zod 4 for runtime and network validation — REST, configuration, run artifacts. TypeBox at the Pi
tool boundary, which is forced rather than preferred: `pi-agent-core` types `AgentTool.parameters` as
a TypeBox `TSchema` and offers no Zod path (ADR 005 §5). BAML is deferred (ADR 005 §1).

Never hand-write a TypeScript interface parallel to a schema that already generates the type.

## 4. Technology Baseline

TypeScript `strict` on Bun and Bun workspaces; Hono for REST; Zod 4; Pi Agent Core + Pi AI with
TypeBox via `pi-ai`; `@t3-oss/env-core`; OpenTUI for the console; Kusto Emulator over Docker Compose;
Oxlint, Oxfmt, `tsc --noEmit`, `bun test`. Versions live in `package.json`.

Do not introduce ESLint or Prettier.

## 5. Repository Shape

```text
apps/         mock-sentinel/  investigator/  console/  cli/
packages/     sentinel-client/  contracts/
fixtures/     telemetry/  scenarios/  benchmark-map.generated.json
infra/        docker-compose.yml  kusto/
scripts/      bootstrap, evaluate, benchmark map, queue reset, the release build
docs/         architecture.md  roadmap.md  prd-*.md  adr/
runs/         run artifacts, archive and transcripts; ignored, never committed (ADR 012)
dist/         CI-only build output of `bun run build`; ignored, never committed (ADR 014)
```

Do not create empty future-capability packages. `agent-runtime`, `persistence` and `testkit` are
deliberately absent.

`runs/` is ignored and never committed. ADR 012 records why, reversing ADR 008 §8: a run artifact
is this checkout's measurement of its own agent, and since PRD-7 and PRD-8 it may carry live tenant
data, so the repository ships the benchmark inputs under `fixtures/` and nobody's results. Inside
the working tree the corpus is still append-only — a run is a measurement bought with real money
against a model that exposes no seed, and nothing may remove one from the scored set as a side
effect. `runs/.archive/` takes an alert out of the *queue* and is still scored. Transcripts under
`runs/traces/` are optional, off by default and megabytes apiece.

## 6. Quality Rules

`bun run check` must stay green — `fmt:check`, `lint`, `typecheck`, `test`, in that order.

TypeScript is strict beyond `strict: true`: `noUncheckedIndexedAccess`,
`noPropertyAccessFromIndexSignature` (`process.env["FOO"]`, never `.FOO`), `verbatimModuleSyntax`
(`import type` is required), `erasableSyntaxOnly`. Oxlint errors on `any` and on non-null assertions
outside tests. Relative imports carry explicit `.ts` extensions. Oxfmt covers source and config only
— Markdown is excluded so the architecture documents are not rewritten by tooling.

## 7. Testing Policy

Test deterministic boundaries: the telemetry bootstrap, Mock Sentinel REST contracts, the Sentinel
client, query error propagation, the investigation runner, and ground-truth isolation.

Do not mock KQL with query-string conditionals (`if query contains "CommonSecurityLog" -> canned
response`) — use the Kusto Emulator for integration behavior. Tests needing a paid or live LLM are
opt-in and excluded from default CI.

## 8. Training Lab Data Rules

Training Lab telemetry comes from a pinned Azure-Sentinel revision; never consume unpinned `master`.
Bootstrap creates the database and schemas, ingests, validates representative tables and rows, and
fails clearly on drift. Timestamps are shifted by one constant `TELEMETRY_TIME_ANCHOR` offset for the
whole dataset so relative-time KQL matches while every interval is preserved exactly — one offset,
never one per era (ADR 001).

Bumping the revision is a dependency upgrade: re-vendor, `bun run data:manifest`, review the
generated diff, re-run the bootstrap. Do not deploy Azure to obtain the telemetry unless ADR 001 is
amended because a dataset cannot be reproduced locally.

## 9. Mock Sentinel API

`apps/mock-sentinel/src/routes/` is the public surface and `packages/contracts` is its schema — read
those rather than a copy kept here. Three rules that the code does not state:

- Mock Sentinel owns the REST facade; Kusto is internal and no consumer may address it.
- Tables whose name begins with `_` are infrastructure: `/schema` drops them and `/query` rejects
  them. The agent's opening context is built from the names `/schema` returns, so a table added to
  that database would otherwise be a table the agent is invited to query — and a change to turn-0
  context is a change to the thing being measured.
- Return useful query errors. Never silently rewrite invalid KQL.

## 10. Agent Tooling

Five tools, and they are the agent's whole capability surface: `get_security_schema`,
`query_security_data`, `web_search`, `web_fetch`, `submit_investigation` (PRD-2 §9, extended by
ADR 005). A valid `submit_investigation` call is the Definition of Done; Pi validates it
against the tool schema first, so an invalid submission returns to the model as a correctable
error (ADR 005 §1).

`query_security_data` returns the raw tabular result. Do not summarise, extract or normalise it —
anything this layer emphasises is a playbook smuggled in through formatting. Its description and
lazy syntax guidance come from the selected query profile, not from this layer.

Web content is untrusted: it returns inside a provenance envelope and the system prompt
standing-orders it as data rather than instructions (ADR 005 §3).

Do not add semantic tools such as `get_user` or `investigate_signin`. Add a tool only when a real
investigation failure demonstrates the need.

Each investigation starts with system instructions, the source-neutral alert including its
source-native evidence, the available table names, and the tools. The full schema is fetched once
and held by the harness; only table names enter model context, because 22 tables and 1,168 columns
would spend the window before the agent knows what matters (ADR 005 §4).

## 14. Implementation Order

Phases 1–13 are delivered. Status lives in [`docs/README.md`](./docs/README.md); what each phase
decided lives in its ADR. New work gets a PRD before it gets code (§1).

One measurement discontinuity is worth knowing before reading `runs/`: PRD-8 moved the prompt hash,
so Sentinel runs written from 2026-08-25 are a different condition from runs written before it, and
`evaluate` will not compare across the boundary. ADR 011 §14 records why that was accepted.

## 15. When to Stop and Ask

Stop and surface the decision rather than implementing, if:

- Training Lab assets cannot map into Kusto without material semantic loss;
- the Kusto Emulator differs from required Sentinel KQL behavior in a way that breaks the experiment;
- Pi cannot support a required agent, tool or context behavior;
- a second investigation capability is needed outside the alert-oriented, tabular, read-only query
  boundary ADR 010 approved;
- the full schema becomes too large for useful startup context;
- an implementation would require a roadmap feature listed as a §2 non-goal;
- a change would alter turn-0 context, the run artifact's shape, or what `evaluate` scores — those
  change the measurement, not just the code.

Prefer a small ADR over silently changing architecture. When implementation deviates from an
approved PRD, record it in the ADR — never edit the PRD to match what was built.
