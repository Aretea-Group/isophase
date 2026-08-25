# CLAUDE.md

Orientation for Claude Code working in this repository.

**Precedence.** ADRs decide, [`AGENTS.md`](./AGENTS.md) constrains, this file orients. Read
`AGENTS.md` first — it holds the commands, the architecture rules, and the conditions under which
you should stop and ask for an architecture decision rather than implement. This file only adds
what no single file makes visible.

If the code surprises you, read [ADR 005](./docs/adr/005-investigation-agent-boundary.md) first: it
records six supersessions — `submit_investigation` over a BAML finalizer, a run artifact over a
trace store, five tools over one, table names over the full schema, TypeBox at the Pi boundary, and
no `agent-runtime` package.

## The chain

Each hop is the *only* path to the next. `AGENTS.md` §3 states the rules; this is the shape they
protect:

```text
fixtures/telemetry/        vendored Training Lab CSVs at a pinned revision
  → scripts/bootstrap-sentinel-data.ts
  → Kusto Emulator          internal; no consumer may address it
  → apps/mock-sentinel      the only code that talks to Kusto; owns the public surface
  → packages/sentinel-client  typed HTTP client over packages/contracts
  → apps/investigator       harness.ts drives Pi; five tools; writes runs/<run-id>.json
  → apps/console (read-only)  and  scripts/evaluate-runs.ts (joins to hidden ground truth)
```

The console is read-only by construction: `src/view/` holds pure view models with no renderer
import, and `src/ui/` is the only code that knows OpenTUI exists. PRD-5 lets it *drive* the
investigator through `InvestigationControl`, which is a different thing from writing to `runs/` —
the investigator remains the sole writer (ADR 007).

## Exactly three files read the environment

- `apps/mock-sentinel/src/config.ts` — hand-rolled `loadConfig`, called once at the entrypoint.
- `apps/investigator/src/env.ts` — `@t3-oss/env-core`, validated at *import*, so a missing key stops
  the process before the first alert rather than forty investigations into a sweep.
- `apps/console/src/env.ts` — every key defaulted, none required: the console must open a two-week-old
  run without a key for a model it will never call.

Everything else receives parsed config. Provider API keys are deliberately absent from all three
schemas — `pi-ai` reads them from the ambient environment, and the provider-aware check lives in
`apps/investigator/src/model.ts`.

## Running the Kusto Emulator on Apple Silicon

The image is amd64-only and pinned by digest. It needs Colima with Apple Virtualization + Rosetta
(`--vm-type vz --vz-rosetta`); under podman's QEMU fallback the emulator never starts serving.
`infra/docker-compose.yml` sets `DOTNET_EnableWriteXorExecute=0` and `DOTNET_TieredCompilation=0`
because Rosetta cannot service the JIT's SIGSEGV traffic.

Throttling and 60-second aborts immediately after `bun run data:bootstrap` are the cluster settling,
not a regression.

## Documents

`docs/architecture.md` predates PRD-2 and is annotated where ADR 005 supersedes it. Delivered PRDs
are two-paragraph stubs; each carries a `git show <sha>:"<path>"` pointer to its full text, so
`PRD-N §M` citations resolve through git rather than through the working tree.
