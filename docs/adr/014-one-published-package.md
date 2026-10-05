# ADR 014 — One published package, one command surface

**Status:** Accepted

**Date:** 2026-10-02

**Implements:** PRD-11 — npm distribution and release flow

**Amends:** ADR 007 §2 (the sole-writer rule covers run artifacts, not the empty directory `init` creates); `AGENTS.md` §2 (two non-goals added), §5 (`dist/` named; `scripts/` narrows to lab tooling and the release build), and the "there is no build step" rule above §1 (development still has none; the release build is CI-only and never committed)

**Reverses:** PRD-9 §3 ("publishing to npm" leaves the non-goal list); `docs/roadmap.md` §11 is narrowed, not closed

## Context

Until PRD-11 the only way to run the investigator was a clone: `bun install`, the lab for the mock
connector, `bun run` scripts for everything else. PRD-9 made the clone presentable; it did not make
the product installable. The ask was `bunx @aretea-group/isophase init` — one command on a machine
that has never seen the repository.

That ask met three facts about this repository. The workspace members are consumed as TypeScript
source through `workspace:*`, which no consumer outside the workspace can resolve. The lab —
Mock Sentinel, the Kusto Emulator, the fixtures that carry the hidden answer key — must not ship.
And every entrypoint was its own file with its own `bun run` script, which an npm user does not
have. This record is the three choices that answer those facts, and the one rule they amend.

## Decisions

### 1. One bundle, built in CI, with the workspace as an internal detail

`@aretea-group/isophase` is a single package. `bun run build` bundles `apps/cli/src/index.ts` into
`dist/cli.js` with the four workspace members (`apps/investigator`, `apps/console`,
`packages/sentinel-client`, `packages/contracts`) inlined and every third-party package left
external; the externals are exactly the root `dependencies`. `dist/` is ignored and never
committed; the pull-request gate does not build; the release workflow does.

**The alternative was reasonable and rejected.** Publishing four `tsc`-emitted packages would have
kept each workspace member a real package. It would also have needed four trusted publishers, four
version stamps, and would have made `@soc/contracts` a public API that nobody asked for and
nothing outside this repository consumes. A bundle keeps the workspace an implementation detail
and the published surface one file.

Two measured facts shape the build and are recorded in PRD-11 §4.4: Bun's `--packages external`
also externalises `workspace:*` members, so the externals are named explicitly; and Bun's `--banner`
places the shebang after its own preamble, so the shebang is prepended after the build. The bundle
needs nothing beside it — OpenTUI's native library resolves through the external `@opentui/core`.

**Consequence for the "no build step" rule.** `AGENTS.md` said there is no build step. Development
still has none: nothing reads `dist/`, and the `bun run` scripts and the published bin share one
dispatcher. The rule now says so in two halves rather than one.

### 2. One `isophase` bin over a single command table

`apps/cli/src/commands.ts` holds the table — `init`, `investigate`, `console`, `probe`, `help` — and
both dispatch and help text read it, so the two cannot disagree. Every command's `--help` and
`help <command>` are one string by construction. The existing argument parsers are unchanged; the
dispatcher routes and nothing else.

Two scripts moved out of `scripts/` so the bundle could reach them: `scripts/console-live.ts` is
now `console --live <source>`, and `scripts/probe-defender.ts` is `probe`. `scripts/reset-queue.ts`
stays: its `--scenarios` path imports the benchmark-map builder, which reads `fixtures/scenarios/`,
and `scripts/` is the one tree both ground-truth guards exempt. `apps/cli/src` joined the
ground-truth isolation `ROOTS` instead, with no lint exemption — it is a tree the package ships.

Command modules load lazily. `init` and `help` must work before any `.env` exists, and the
investigator validates its environment at import (ADR 005 §6), so a command is imported only when
it is about to run. The console's usage text embeds its environment, and `--live` is an overlay on
`process.env` applied before the console is imported — which is why a command's usage is a function
and not a string read at load time; reading it eagerly validated the wrong environment and opened
the wrong queue, and a test now pins that.

### 3. `init` writes a `.env` and provisions nothing

`init --track defender|sentinel` writes `.env` with the track's credential lines blank, the three
artifact directories under `.data/` (ADR 009 §5, ADR 011 §13 — the live-tenant guard would
otherwise fail the first run), creates `.data/runs` and `.data/runs/traces`, validates the file
through `parseInvestigatorEnv` — the investigator's own schema, reachable as a function so the
import-time singleton stays as it was — checks the Bun version, and prints the next command. It
refuses to overwrite without `--force`. It makes no network call and never touches a tenant: no
Entra application, no service principal, no permission grant, no Azure resource. A test scans its
source for exactly that.

**Consequence for ADR 007 §2.** The investigator is the sole writer of run artifacts. Creating an
empty `.data/runs` is not writing a run artifact, and the rule is clarified rather than reversed:
it covers artifacts, not the directory that will hold them.

**`.env` is the only configuration.** A config file was considered and rejected: both apps already
validate exactly this file, and a second file would be a fourth reader of the environment and a
second place every variable has to be documented.

### 4. The mock connector stays the default and fails loudly

`SENTINEL_CONNECTOR=mock` remains the default so a lab checkout works with no credentials. From an
installed package that default meets an empty port, so both apps report — through one shared
function — that the mock connector is selected, that it needs the local lab the package does not
carry, and that `isophase init` writes a `.env` for a real tenant. The previous message prescribed
`bun run dev:mock-sentinel`, which an npm user cannot run. The connector's source says what it is.

### 5. The version is legibility, not a condition

The run artifact's provenance block carries `packageVersion`, `0.0.0` from a clone and the tag's
version from a published package. It sits outside `config` because ADR 008 §3 hashes `config`
whole and a version there would split the corpus on every release; `provenanceKey` reads named
fields and this is not one of them, which a test pins. The value is a static import of the root
`package.json`, the same way the Pi version is read, so the release stamps the version before the
build and the bundle carries it.

### 6. Deviation: a granular token publishes, not OIDC — until npm accepts immutable subjects

**What PRD-11 said.** §4.1 D4: the release workflow publishes "under `id-token: write`" through npm
trusted publishing, and "no `NPM_TOKEN` secret, ever" (§4.3; AC17). ADR 014 §1 above and the
original `release.yml` implemented exactly that, and the trusted publisher was configured on the
package naming `Aretea-Group/isophase` and `release.yml`.

**What reality refused.** GitHub issues *immutable* OIDC subject claims —
`repo:Aretea-Group@317917008/isophase@1338561688:…` — to every repository created after
2026-07-15, and this one dates from 2026-08-18. The setting cannot be disabled at repository or
organisation level. npm's token exchange accepts only the classic `repo:<owner>/<repo>:…` subject
and answers `403 OIDC permission denied for this action` after the token is minted and the
provenance statement is already in the transparency log. Measured three times on run 37279008153
on 2026-10-05; tracked as npm/cli#9969, open, no fix announced. Recorded in PRD-11 §4.4.

**What was built instead, with the user's agreement on 2026-10-05.** The `publish` job
authenticates with a granular npm access token held in the `NPM_TOKEN` repository secret, passed
to `npm publish` as `NODE_AUTH_TOKEN` on that one step and nowhere else — a test reads the
workflow back and fails if the secret appears anywhere else. `id-token: write` stays on the job
and `npm publish --provenance` is explicit, so provenance is still signed and linked to the
release commit (AC19's substance). The token is scoped to `@aretea-group/isophase` with
read-write, bypasses 2FA for CI only, and expires within 90 days, which is npm's ceiling for
write tokens: **rotation is an operator duty**, and a lapsed token fails the publish step loudly
rather than silently.

**Why not the alternatives.** Waiting for npm leaves every release manual, which is the state the
PRD exists to end. A classic or long-lived token is no longer issued by npm. Publishing from a
different, pre-cutoff repository would move the source of truth to escape a claim format.

**The trusted publisher is deleted in the meantime, not kept.** Measured on the first token
publish (2026-10-05): with `id-token: write` on the job and a trusted publisher on the package,
npm performs the OIDC exchange first, obtains a credential, and the registry rejects the publish
for the subject mismatch — it never falls back to the token. With no publisher configured the
exchange finds nothing, npm uses `NODE_AUTH_TOKEN`, and provenance is still signed through the
GitHub token (`0.1.1`'s attestation names `release.yml` and the `v0.1.1` commit).

**Reverts when.** npm/cli#9969 closes with the immutable subject accepted: re-create the trusted
publisher naming `Aretea-Group/isophase` and `release.yml`, drop the `env` from the publish step,
delete the secret, and the job is back to §1's design with no other change.

**Also changed by PRD-11 §11 A2, an amendment rather than a deviation.** The trigger moved from a
hand-published Release to release-please: on every push to `main` it keeps one release pull
request open with the version bump and `CHANGELOG.md`, and merging that pull request creates the
tag and the Release and runs `publish`. The version therefore lives in git — `package.json` is
no longer `0.0.0` and nothing stamps it — and `scripts/release-version.ts` only reads it back,
checks it against the tag, and picks the dist-tag. ADR 014 §1's "git's `package.json` stays at
`0.0.0`" consequence below is withdrawn accordingly.

## Consequences

- The published surface is `dist/cli.js`, `package.json`, `README.md` and `LICENSE`. The build
  fails if the tarball would list `fixtures/`, `apps/mock-sentinel/`, a `.env`, `.data/` or `runs/`.
- `bunx @aretea-group/isophase` needs Bun on `PATH`; npm and npx users can install it and run the
  bin through the shebang. Node without Bun is out (PRD-11 §3) — 25 source files use Bun-only APIs.
- The `@soc/*` workspace names stay; only the root package is renamed.
- ~~Git's `package.json` stays at `0.0.0`. A stale committed version can never be published.~~
  Withdrawn 2026-10-05 (§6): release-please owns the version in git, and the publish step refuses
  a version that disagrees with the tag.
- Publishing authenticates with a 90-day granular token until npm accepts immutable OIDC subjects
  (§6). Someone rotates it; the publish step fails loudly when nobody did.
