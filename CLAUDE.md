# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read first

[`AGENTS.md`](./AGENTS.md) is the implementation contract for this repository and takes precedence
over anything here — scope, phase order, architectural rules, and the conditions under which you
should stop and ask for an architecture decision rather than implement. This file only adds what it
does not cover.

Document precedence when they disagree: **ADRs > PRDs > `docs/architecture.md`**. `architecture.md`
predates PRD-2 and is annotated where ADR 005 supersedes it. If the code surprises you, read
[ADR 005](./docs/adr/005-investigation-agent-boundary.md) first — it records six supersessions.

Do not implement a roadmap feature before its PRD exists (AGENTS.md §1, §14).

## Commands

Bun is both runtime and package manager. There is no build step: workspace packages are consumed as
TypeScript **source** through their `exports`, so nothing is compiled ahead of time and `tsc` only
ever type-checks.

| Command | |
|---|---|
| `bun run check` | fmt:check → lint → typecheck → test. Every change must keep this green (AGENTS.md §6) |
| `bun test apps/console/test/view.test.ts` | a single test file |
| `bun test -t "ground-truth"` | tests whose name matches |
| `bun run infra:up` / `infra:down` / `infra:logs` | Kusto Emulator + Mock Sentinel over Docker Compose |
| `bun run data:bootstrap` | create tables and ingest telemetry; safe to re-run. Also `data:reset`, `data:verify`, `data:manifest` |
| `bun run dev:mock-sentinel` | REST facade on `:8787`, watch mode |
| `bun run investigate [--alert <systemAlertId>]` | one sweep of the agent; needs a provider key in `.env` |
| `bun run evaluate [--run <id>] [--compare <a> <b>] [--gaps]` | score runs against the hidden ground truth; `--gaps` says what the corpus still needs |
| `bun run console [--runs <dir>] [--traces <dir>]` | read-only TUI over `runs/` |

Integration suites (`**/test/integration/`) probe for their live dependency and `describe.skipIf`
themselves out with a printed reason when it is missing. `bun test` therefore stays green without
Docker — and proves nothing about them. To actually exercise them:
`bun run infra:up && bun run data:bootstrap && bun run dev:mock-sentinel`.

`oxfmt` covers source and config only; Markdown is excluded so the architecture documents are not
rewritten by tooling.

## Architecture

The system is a one-directional chain in which each hop is the *only* path to the next:

```text
fixtures/telemetry/        vendored Training Lab CSVs at a pinned revision
  → scripts/bootstrap-sentinel-data.ts
  → Kusto Emulator          internal; no consumer may address it
  → apps/mock-sentinel      the only code that talks to Kusto; owns the entire public surface
  → packages/sentinel-client  typed HTTP client over packages/contracts
  → apps/investigator       harness.ts drives Pi; five tools; writes runs/<run-id>.json
  → apps/console (read-only)  and  scripts/evaluate-runs.ts (joins to hidden ground truth)
```

Four things that no single file makes visible:

**`apps/investigator/src/harness.ts` is the Pi boundary.** It is the only file in the repository
that imports Pi, and that is deliberate — ADR 002 wanted one replaceable boundary and PRD-2 §24
ruled out a wrapper package to get it, so there is no `agent-runtime` and never will be. The harness
owns dependencies, startup context, limits and completion semantics, and knows nothing about
security. The five tools in `src/tools/` are the agent's whole capability surface;
`query_security_data` returns the raw result on purpose, because anything this layer summarises or
normalises is a playbook smuggled in through formatting (AGENTS.md §10).

**Ground truth flows one way only.** `fixtures/scenarios/` holds each scenario's verdict, the KQL
that settles it, and the trap it was built to catch. Two guards, because either alone is
insufficient: an oxlint `no-restricted-imports` rule blocks static imports, and
`apps/investigator/test/ground-truth-isolation.test.ts` scans agent-side source *text* — the
realistic leak is a runtime `Bun.file("fixtures/scenarios/…")` that no import rule can see. `scripts/`
is exempt from both; that is where the join legitimately happens. If you add a source root the agent
can reach, add it to that test's `ROOTS`.

**Exactly three files read the environment.** `apps/mock-sentinel/src/config.ts` (hand-rolled
`loadConfig`, called once at the entrypoint), `apps/investigator/src/env.ts` (`@t3-oss/env-core`,
validated at *import* so a missing key stops the process before the first alert rather than forty
investigations into a sweep), and `apps/console/src/env.ts` (every key defaulted and none required —
the console must open a two-week-old run without a key for a model it will never call). Everything
else receives parsed config. Provider API keys are deliberately absent from all three schemas:
`pi-ai` reads them from the ambient environment, and the provider-aware check lives in
`investigator/src/model.ts`.

**The run artifact is the join point.** `runs/<run-id>.json` holds per-alert outcomes keyed by
`systemAlertId`, flushed after every alert with a `status`, so an in-flight sweep is readable. It is
not a trace store (ADR 005 §2) — transcripts are separate, under `runs/traces/`, and only when
`INVESTIGATOR_TRACE=true`. Both the console and `evaluate` read it; neither writes it. The console
is read-only by construction: `src/view/` holds pure view models with no renderer import, and
`src/ui/` is the only code that knows OpenTUI exists.

PRD-6 makes `runs/` a **committed** root and adds fixed-size counters under one rule: nothing on the
artifact may grow with the length of an investigation (ADR 008 §1). `evaluate` groups runs by a
*condition* — a key derived in `scripts/` from what each run was set up with, never from what it
did — and scores the outcome against ground truth alone; cost and effort print beside the score and
never enter it. It reads `runs/.archive/` too, because archiving returns an alert to the console's
queue and must not delete a measurement (ADR 008 §8).

## Constraints worth knowing before you write code

TypeScript is strict beyond `strict: true`: `noUncheckedIndexedAccess` (indexing yields `T |
undefined`), `noPropertyAccessFromIndexSignature` (`process.env["FOO"]`, never `.FOO`),
`verbatimModuleSyntax` (`import type` is required, not stylistic), and `erasableSyntaxOnly`. Oxlint
additionally errors on `any` and on non-null assertions outside tests. Relative imports carry
explicit `.ts` extensions.

Types are inferred from schemas — Zod 4 at runtime/network boundaries, TypeBox at the Pi tool
boundary (forced by `pi-agent-core`, not preferred). Never hand-write an interface parallel to a
schema.

The Kusto Emulator image is amd64-only and pinned by digest. On Apple Silicon it needs Colima with
Apple Virtualization + Rosetta (`--vm-type vz --vz-rosetta`); podman falls back to QEMU, under which
the emulator never starts serving. `infra/docker-compose.yml` sets `DOTNET_EnableWriteXorExecute=0`
and `DOTNET_TieredCompilation=0` because Rosetta cannot service the JIT's SIGSEGV traffic.

Telemetry timestamps are shifted forward by one constant offset (`TELEMETRY_TIME_ANCHOR`) so that
relative-time KQL (`ago(1h)`) matches, while every interval in the data is preserved exactly. One
offset for the whole dataset, never one per era (ADR 001).

Bumping the pinned upstream telemetry revision is a dependency upgrade: re-vendor, run
`bun run data:manifest`, review the generated diff, then re-run the bootstrap.
