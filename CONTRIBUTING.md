# Contributing

Thank you. Two rules carry most of the weight here, and both are enforced rather than requested.

## 1. `bun run check` is the gate

```bash
bun install
bun run check       # fmt:check, lint, typecheck, test — in that order
```

CI runs exactly this on every pull request, with no credential configured, and the `main` ruleset
will not merge a pull request whose `check` run is red — the maintainer included. Tests that need
Kusto, Mock Sentinel, a tenant or a paid model skip themselves when their dependency is absent, so a
green local run without any of those is the same green CI sees. To exercise the integration
suites, start the lab (`bun run infra:up && bun run data:bootstrap`).

`bun run fmt` and `bun run lint:fix` repair what the first two stages complain about. Do not add
ESLint or Prettier, and do not add or bump a dependency without reviewing the version and updating
`bun.lock` (`AGENTS.md` §6).

## 2. An architecture change needs an ADR before code

`AGENTS.md` §15 lists when to stop and surface a decision instead of implementing it — among them
anything that alters turn-0 context, the run artifact's shape or what `evaluate` scores, because
those change the measurement and not just the code. Write a small decision record under
`docs/adr/` and get it agreed first. When an implementation ends up deviating from an approved PRD,
record the deviation in the ADR; never edit the PRD to match what was built.

New capabilities get a PRD before they get code (`AGENTS.md` §1). `docs/roadmap.md` says what is
planned; `docs/README.md` indexes every PRD and ADR with its status.

## How to send a change

1. Branch from `main`. Direct pushes to `main` are rejected.
2. Keep the commit history readable: one concern per commit, Conventional Commits style
   (`feat(console): …`, `fix(evaluate): …`, `docs: …`).
3. Open a pull request; the template asks for what changed, why, and the checklist.
4. Nothing under `runs/` or `.data/` belongs in a commit, and neither does a tenant identifier, an
   alert title or a credential. `runs/` is ignored for that reason (ADR 012).

## Where things are

`AGENTS.md` is the authoritative set of repository rules and the architecture they protect; read it
before touching `apps/` or `packages/`. `README.md` is the setup guide. `CLAUDE.md` orients a
coding agent and adds nothing a human needs.

Security issues go through [`SECURITY.md`](./SECURITY.md), never a public issue.
