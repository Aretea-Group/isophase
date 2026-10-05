# PRD-11 — npm distribution and release flow

**Status:** Approved

**Depends on:** PRD-9 — Open-source release readiness; PRD-10 — Unattended Investigation and Findings Write-Back
**Produces:** ADR 014 — One published package, one command surface
**Amends:** ADR 007 §2 (clarified: the sole-writer rule covers artifacts, not the empty directory `init` creates); `AGENTS.md` §2 (two non-goals added), §5 (`scripts/` narrows to lab tooling; `dist/` named), and the "there is no build step" paragraph above §1; `docs/roadmap.md` §11 (narrowed, not closed)
**Reverses:** PRD-9 §3 ("publishing to npm" leaves the non-goal list)
**Language/runtime:** TypeScript `strict` on Bun; Bun stays the only runtime. No new runtime dependency; `npm` 11.5.1+ is used in CI for the publish step only
**Runtime schemas:** Zod 4, unchanged. One optional field is added to the run artifact's provenance block

## 1. Purpose

Track A — pointing the agent at a real Defender or Sentinel tenant — needs no Docker, no emulator
and no fixtures, and the README has said so since PRD-10. It still asks an operator to clone a
repository and install a language runtime, which `docs/roadmap.md` §11 already names as "the wrong
shape for someone whose job is responding to alerts rather than building software". Every
entrypoint is a `bun run` script that exists only inside the clone.

Two further symptoms follow from the repository's state on 2026-10-02. Every workspace package is
`private` at version `0.0.0`, the repository carries one tag (`prd-8-full-text`) and no GitHub
Release, so nothing an operator runs carries a version: a run artifact cannot name the Isophase that
produced it, and a bug cannot be reported against one. And there is no release event at all, so a
fix reaches nobody who is not tracking `main` by hand.

PRD-9 §3 left "publishing to npm" out of the open-source release, and roadmap §11 listed a compiled
binary and a container as the two candidate packagings. This PRD takes a third path those two did
not consider, and narrows §11 rather than closing it: an npm package answers "no clone" but still
asks for a runtime.

## 2. Goals

1. A Track A operator with Bun installed reaches a running loop against their tenant with three
   commands and no clone: `bunx @aretea-group/isophase init`, edit `.env`,
   `isophase investigate --watch`.
2. Every published version is traceable: `isophase --version` prints it, each run artifact records
   it, a GitHub Release carries its notes, and npm provenance links the tarball to the commit.
3. Publishing is token-free and reproducible: a published GitHub Release is the only trigger, the
   job runs the same `bun run check` gate as every pull request, and no long-lived npm credential
   exists anywhere — not in the repository, not in its secrets.
4. The clone keeps working unchanged for the lab. The root `bun run` scripts call the same command
   dispatcher the package ships, so the two paths cannot drift.

## 3. Non-Goals

- **Running on Node without Bun.** The investigator uses Bun APIs in 25 source files (file I/O, the
  unix control socket, `Bun.serve`, `Bun.spawn`, `Bun.argv`) and OpenTUI on Node needs 26.4+ with an
  experimental FFI flag. That is a port, not packaging. Goes to `docs/roadmap.md` as a new item,
  with that file count as its starting cost.
- **A compiled binary or a container image.** Stays in `docs/roadmap.md` §11, which this PRD narrows:
  the open question there is whether `bun build --compile` carries OpenTUI's native assets, and Phase
  0 here answers the bundling half of it as a side effect.
- **`init` provisioning anything.** No Entra app registration, no service principal, no role
  assignment, no admin consent, no Azure resource. A bootstrap command that writes to a tenant is
  infrastructure automation with side effects nobody asked for. This becomes a standing non-goal in
  `AGENTS.md` §2, not just here.
- **A configuration file beyond `.env`.** `init` writes `.env`; nothing reads YAML or TypeScript
  configuration. If a non-secret settings file is ever wanted, it is a loader that feeds
  `process.env` before `env.ts` validates — the three environment readers named in `CLAUDE.md` stay
  three. Goes to `docs/roadmap.md`.
- **Publishing the lab.** Mock Sentinel, `fixtures/`, `scripts/evaluate-runs.ts`, the benchmark map,
  the Kusto bootstrap. Track B stays clone-only, and `AGENTS.md` §5 says so.
- ~~**Automated changelogs or version-bump pull requests.** The Release notes are the changelog. Can be
  added later without changing the trigger; no document needed.~~ → reversed 2026-10-05, §11 A2:
  release-please keeps `CHANGELOG.md` and opens the version-bump pull request.
- **Changing the environment defaults.** `SENTINEL_CONNECTOR=mock` and `SECURITY_SOURCES=sentinel`
  stay the defaults so a zero-configuration lab checkout keeps working. The package fails loudly
  instead (§4.1 D5).
- **Node-side consumers of the package as a library.** The bundle exposes a `bin` and no `exports`.
  Importing `@aretea-group/isophase` is unsupported by construction.

## 4. Design

### 4.1 Decisions (locked)

- **D1 — One bundled package, built in CI only.** `@aretea-group/isophase` is a single package whose
  `dist/` is produced by `bun build --target=bun` with the four workspace members
  (`apps/investigator`, `apps/console`, `packages/sentinel-client`, `packages/contracts`) inlined and
  every third-party dependency left external. `dist/` is `.gitignore`d (already) and never
  committed. Rationale: publishing four `tsc`-emitted packages would need four trusted publishers and
  expose `@soc/contracts` as a public API nobody asked for; a single bundle keeps the workspace an
  internal detail. `AGENTS.md`'s "there is no build step" becomes "no build step for development;
  the release build is CI-only and never committed". **ADR-shaped**: it changes the repository
  shape and amends a rule, and the alternative was reasonable. _(ADR 014)_
- **D2 — `.env` is the only configuration.** `init` writes `.env` from the same template
  `.env.example` already is, with the chosen track's variables uncommented. Rationale: both apps
  already validate exactly this file; a config file is a fourth reader and a second place every
  variable has to be documented.
- **D3 — One `isophase` bin, one command table.** The bin dispatches `init`, `investigate`,
  `console`, `probe`, `help`, plus `--help` on the bin and on every subcommand and `--version`. A single table of commands drives both dispatch and help text so they cannot
  disagree. Existing argument parsers and flags are unchanged; `scripts/console-live.ts` becomes
  `console --live <source>` and `scripts/probe-defender.ts` becomes `probe`, both moving out of
  `scripts/` so the bundle can reach them. `scripts/reset-queue.ts` stays where it is: its
  `--scenarios` path imports the benchmark-map builder, which reads `fixtures/scenarios/`, and
  `scripts/` is the one tree both ground-truth guards exempt (AGENTS.md §3, ADR 006 §5). Rationale:
  an npm user has no `bun run` scripts, and four entry files with four parsers are routing, not
  product. Same ADR as D1. _(ADR 014)_
- **D4 — ~~A published GitHub Release is the only publish trigger.~~ Merging release-please's
  release pull request is the only publish trigger** (amended 2026-10-05, §11 A2).
  `.github/workflows/release.yml` ~~runs on `release: published`, checks out the tag, runs
  `bun run check`, builds, stamps `package.json`'s version from the tag (refusing anything that is
  not `vX.Y.Z` or `vX.Y.Z-<pre>`), and publishes with `npm publish --access public` under
  `id-token: write`. Git's `package.json` stays at `0.0.0` so a stale committed version can never
  be published.~~ runs on every push to `main`: release-please keeps one release pull request open
  with the version bump and the changelog and, when it merges, creates the tag and the Release;
  the `publish` job then checks out that tag, runs `bun run check`, builds, and publishes with
  `npm publish --access public --provenance`. Authentication is the granular token recorded as a
  deviation in ADR 014 §6, not OIDC. Pre-release
  versions publish under the `next` dist-tag so `bunx @aretea-group/isophase` never resolves to
  one. Rationale: ~~a pushed tag is cheap and reversible; a published Release is a deliberate click
  with notes attached, and those notes are the changelog this repository does not otherwise keep.~~
  the user's instruction; the release pull request is the deliberate click, and it carries the
  changelog.
- **D5 — The mock connector stays the default and fails loudly.** When `SENTINEL_CONNECTOR=mock` is
  selected and `SENTINEL_BASE_URL` does not answer, the investigator and the console report that
  the mock connector is selected, that it needs the local lab, and that `init` writes a `.env` for a
  real tenant — instead of today's "start it with `bun run dev:mock-sentinel`". The connector's
  source gains a comment stating it is the lab's HTTP client and is inert without Mock Sentinel.
  Rationale: the user's instruction; changing the default would break every lab checkout.
- **D6 — What `init` does, and nothing else.** Writes `.env` (refusing to overwrite without
  `--force`) with `RUNS_DIR=.data/runs`, `INVESTIGATOR_TRACE_DIR=.data/runs/traces` and
  `WATCH_CONTROL_SOCKET=.data/runs/control.sock` set explicitly — ADR 009 §5 and ADR 011 §13 make
  the investigator and the console refuse to start against a live tenant unless both artifact
  directories sit under `.data/`, so a template that left the `runs/` defaults in place would fail
  on its first run — creates those directories, validates the written file with the
  investigator's own schema plus a Bun version check, and prints the next command for the chosen
  track. `--track defender|sentinel` selects the template; absent, it asks. The schema is reached
  through a function, not the module: `apps/investigator/src/env.ts` validates at import and throws
  (ADR 005 §6), and `init` runs before any `.env` exists, so the schema moves into an exported
  `parseInvestigatorEnv(source)` that the import-time singleton calls. The singleton's behaviour is
  unchanged. Creating the empty `.data/runs` directory is not writing a run artifact; ADR 007 §2's
  sole-writer rule concerns artifacts and ADR 014 says so. Rationale: the user's fence, see §3.
- **D7 — The README gains an Install section before "Choose your path".** The `bunx` line, `init`,
  and the command table appear before any mention of `git clone`. Track A is rewritten around the
  package; Track B is unchanged.
- **D8 — The version lands in the run artifact's provenance block, not in `config`.** ADR 008
  derives the comparison key from `config` hashed whole; a version there would split the corpus on
  every release. Provenance is where legibility fields already live.

### 4.2 Assumptions (load-bearing)

- ~~The npm scope is `@aretea`.~~ → corrected 2026-10-02: `@aretea/sdk` (0.1.0-alpha.1, created
  2026-03-27) belongs to a third party at `aretea-ai/aretea`. The scope is `@aretea-group`, free on
  npm as of 2026-10-02.
- ~~The published artifact is the unbuilt TypeScript source, consistent with "no build step".~~ →
  corrected 2026-10-02: consumers cannot resolve `workspace:*` dependencies on private packages, so
  a CI build step bundles them (D1).
- The first publish of `0.1.0` is performed by the user from their machine with an npm token and
  2FA. Every later version publishes through the workflow. Someone owns the `aretea-group` npm org
  and that account (§10 Q1).
- Bun is a runtime requirement of the published package. npm and npx users can install it and run
  the bin because the shebang hands it to Bun; without Bun on `PATH` the bin fails at the shebang,
  and `init` is the only place that can explain why.
- The four bundled workspace members have no runtime read of a path inside the repository.
  Verified by grep on 2026-10-02: the only `import.meta.url` path resolutions are in
  `apps/mock-sentinel` (fixtures) and `scripts/console-live.ts` (which D3 moves). Every other path
  (`RUNS_DIR`, `INVESTIGATOR_TRACE_DIR`, `BENCHMARK_MAP_PATH`) is resolved against the working
  directory, and the console already treats an absent benchmark map as "no markers", not an error.
- Adding one optional field to the provenance block does not change ADR 008's comparison key (D8).
- The `@soc/*` workspace names stay as they are; only the root package is renamed. Renaming them
  would change imports and nothing else.

### 4.3 Design details

**Package shape.**

```text
@aretea-group/isophase
  package.json        name, version 0.0.0 in git, "bin": { "isophase": "dist/cli.js" },
                      "files": ["dist", "README.md", "LICENSE"], engines.bun >= 1.3
  dist/cli.js         the dispatcher and everything it reaches, bundled
  dist/*.js           any worker or asset Phase 0 shows OpenTUI needs beside the bundle
```

Published dependencies are the externals the bundle imports: `@earendil-works/pi-agent-core`,
`@earendil-works/pi-ai`, `@opentui/core`, `@azure/identity`, `@t3-oss/env-core`, `zod`, `hono` is
**not** among them (Mock Sentinel only). `@opentui/core`'s per-platform native packages arrive as its
optional dependencies, so `bunx` fetches the right one.

**The command surface.** One source file, `apps/cli/src/commands.ts`, holds the table; the bin and
`help` both read it.

| Subcommand | Today | Flags | Ships because |
|---|---|---|---|
| `init` | — | `--track defender\|sentinel`, `--force` | goal 1 |
| `investigate` | `apps/investigator/src/index.ts` | `--alert <id>`, `--watch` | the product |
| `console` | `apps/console/src/index.ts` | `--runs`, `--traces`, `--fresh`, `--read-only`, `--attach`, `--live <source>` | optional TUI; `--live` absorbs `scripts/console-live.ts` |
| `probe` | `scripts/probe-defender.ts` | `--only`, `--pace-ms`, `--skip-table-probe`, the write-probe pair | the consent check Track A runs first |
| `help` | — | `[command]` | goal 1; also `--help` everywhere |
| `--version` | — | | goal 2 |

Out of the table, and therefore out of the package: `evaluate`, `queue:reset`, `data:*`,
`infra:*`, `dev:mock-sentinel`. The root `package.json` scripts for `investigate`, `console`,
`console:live` and `probe:defender` are re-pointed at the dispatcher (goal 4); `queue:reset` keeps
its `scripts/` entry.

**A fourth agent-reachable root.** `apps/cli/src` is a tree the bundle ships, so it joins `ROOTS`
in `apps/investigator/test/ground-truth-isolation.test.ts` (AGENTS.md §3) and gets no
`no-restricted-imports` exemption. `probe-defender.ts` imports nothing restricted, verified
2026-10-02, so the move is lint-clean.

**The release workflow.**

```text
you:     git tag v0.1.1 && git push origin v0.1.1
you:     gh release create v0.1.1 --notes "..."         (or the GitHub UI)
GitHub:  release.published
Actions: release.yml
           1. actions/checkout at the release tag
           2. oven-sh/setup-bun; actions/setup-node >= 22.14 (npm >= 11.5.1 for OIDC)
           3. bun install --frozen-lockfile
           4. bun run check                                 the pull-request gate, unchanged
           5. bun run build                                 dist/; fails if the tarball lists fixtures/
           6. stamp version from the tag; refuse a malformed tag
           7. npm publish --access public [--tag next]      OIDC; provenance automatic
npm:     @aretea-group/isophase@0.1.1
```

`permissions: { contents: read, id-token: write }` on the job. No `NPM_TOKEN` secret, ever. The
trusted publisher on npmjs.com names `Aretea-Group/isophase` and the file `release.yml` exactly;
renaming the workflow means reconfiguring the publisher, so the name is part of the contract.

**Bootstrapping, once.** npm cannot configure a trusted publisher on a package that does not exist.
`0.1.0` is therefore a manual `npm publish` by the user from the tagged commit, with 2FA; the
trusted publisher is configured immediately after, and `0.1.1` is the first workflow publish (Phase
3's exit).

**Where the version comes from at runtime.** The build stamps the tag's version into the bundle's
`package.json`; the dispatcher reads its own `package.json` for `--version`, and `provenanceFor*`
in `apps/investigator/src/provenance.ts` records the same value as `packageVersion`. From the clone
the value is `0.0.0`, which is honest: a clone has no version.

**The loud mock failure (D5).** The message, shared by investigator and console:

```text
The mock Sentinel connector is selected (SENTINEL_CONNECTOR=mock) but nothing answers on
http://localhost:8787. The mock connector needs the local lab, which is not part of this package.
For a real tenant, run `isophase init` to write a .env for Defender or Sentinel.
```

### 4.4 Platform facts

- **Verified 2026-10-02** — a package whose `bin` targets a `.ts` file with a `#!/usr/bin/env bun`
  shebang runs under `bunx` and under `npx --no-install`, both printing the expected output.
  Measured with a throwaway package installed from a local tarball. So npm/npx users can run the
  bin with Bun on `PATH`; AC3 and AC4 lean on this.
- **Verified 2026-10-02** — `@aretea-group` returns `{"error":"Scope not found"}` from
  `registry.npmjs.org/-/org/aretea-group/package`, and `@aretea-group/isophase` returns 404.
  `@aretea` is taken (see §4.2).
- ~~**Verified 2026-10-02** — npm trusted publishing (OIDC) needs npm CLI 11.5.1+ and Node 22.14+;
  provenance is generated automatically for a public package from a public repository; the
  configured workflow filename must match exactly. `bun publish` has no OIDC support. The publish
  step therefore uses npm even though everything else uses Bun. AC14–AC17 lean on this.~~ →
  **corrected 2026-10-05**: every requirement above holds and the workflow meets them, but npm's
  token exchange rejects this repository's identity. GitHub issues *immutable* OIDC subject claims
  (`repo:Aretea-Group@317917008/isophase@1338561688:…`) to every repository created after
  2026-07-15 — this one dates from 2026-08-18 — and the setting cannot be disabled at repository or
  organisation level. npm's registry only accepts the classic `repo:<owner>/<repo>:…` subject and
  answers `403 OIDC permission denied for this action` after the token is minted and provenance is
  already signed to the transparency log. Measured on run 37279008153 of `release.yml` for
  `v0.1.1`, three attempts, with the trusted publisher configured exactly as §4.3 says. Tracked as
  [npm/cli#9969](https://github.com/npm/cli/issues/9969), open, no fix announced. ~~AC19 and AC20
  are blocked on it; AC14–AC18 are unaffected and proven.~~ Unblocked 2026-10-05 by the token
  deviation (ADR 014 §6): `0.1.1` published from run 37285405958 with provenance whose source
  digest is the `v0.1.1` commit `6835f88`. One more fact measured on the way: while a trusted
  publisher exists on the package, npm tries the OIDC exchange first and never falls back to the
  token, so the publisher had to be deleted for the token to be used.
- **Verified 2026-10-02** — a trusted publisher can only be configured on a package that already
  exists on npm; the first version must be published with a token. Phase 3's manual `0.1.0` and
  AC18 lean on this.
- **Verified 2026-10-02** — `@opentui/core@0.5.14` declares `engines: { bun: ">=1.3.0", node:
  ">=26.4.0" }`, a `web-tree-sitter` peer dependency, and eight per-platform native packages as
  optional dependencies. OpenTUI's deployment docs state that a Bun bundle must "ship the bundle
  and every emitted asset or external dependency", and that Node needs `--experimental-ffi`.
- **Verified 2026-10-02** — the investigator and its dependencies use Bun-only APIs in 25 source
  files outside tests (`Bun.file`, `Bun.write`, `Bun.serve`, `Bun.connect`, `Bun.listen`,
  `Bun.spawn`, `Bun.argv`, `Bun.Glob`, `Bun.sleep`). Grounds the Node non-goal in §3.
- **Verified 2026-10-02** — `apps/mock-sentinel` is imported by none of `apps/investigator`,
  `apps/console` or `packages/sentinel-client`. The mock *connector* (`SentinelApiClient`,
  `packages/sentinel-client/src/client.ts`, 156 lines) is an HTTP client over the Mock Sentinel REST
  contract and is referenced by the factory, so it ships; it carries no fixtures.
- ~~**Unverified** — whether a `bun build --target=bun` bundle of the investigator and console, with
  `node_modules` external, runs OpenTUI's native library and parser worker from a package installed
  into an empty directory. D1 depends on it; Phase 0 probes it; AC1, AC2 and AC11 depend on the
  answer. If the bundle needs assets beside it, `dist/` carries them and `files` lists them.~~ →
  **Verified 2026-10-02 (Phase 0)** — it does, and the bundle needs nothing beside it. Both
  entrypoints bundled with `bun build --target=bun` and the third-party packages external were packed
  into a three-file tarball (`package.json`, `dist/console.js`, `dist/investigate.js`; nothing under
  `fixtures/` or `apps/mock-sentinel/`) and installed with `bun add <tgz>` into an empty directory
  holding only a `.env`. With the lab running, the console rendered the 154-alert mock queue, a run
  started from its compose overlay completed and wrote `.data/runs/01a0fcbe-….json` plus its trace,
  a direct `investigate --alert` completed in 23 s, and `console --attach` rendered against an
  installed `investigate --watch`'s control socket. `lsof` on the console process showed the only
  native file loaded was `node_modules/@opentui/core-darwin-arm64/libopentui.dylib`, resolved
  through the external `@opentui/core`, so `dist/` carries the two bundles and nothing else.
- **Verified 2026-10-02 (Phase 0)** — two things the build recipe in Phase 2 has to do. Bun 1.3.4's
  `--packages external` also externalises the `workspace:*` members (`@soc/*` stayed as bare
  imports), so the externals are listed explicitly (`@earendil-works/*`, `@opentui/*`, `@azure/*`,
  `@t3-oss/*`, `zod`) and the workspace members inline. And `--banner '#!/usr/bin/env bun'` emits
  the shebang on line 3 after Bun's own `// @bun` preamble, which fails with a syntax error, so the
  shebang is prepended after the build.
- **Unverified, non-blocking** — whether an org-level trusted publisher can be configured before the
  first publish. Only changes the order of two clicks in Phase 3; the manual `0.1.0` is planned
  either way.

## 5. Phasing

**Phase 0 — The bundle probe.** Bundle `apps/investigator/src/index.ts` and
`apps/console/src/index.ts` with `bun build --target=bun --packages external` into a scratch
`dist/`, write a minimal `package.json` beside it, `bun pm pack`, install the tarball into an empty
directory, and with the local lab running: open the console, run one mock investigation from it,
and attach the console to an `investigate --watch` loop. Record what OpenTUI needed beside the
bundle, if anything. Also list the tarball's contents and confirm nothing under `fixtures/` or
`apps/mock-sentinel` is in it. Nothing from this phase is committed except a note in §4.4.

*Exit:* the console opens and one mock investigation completes from the installed tarball, and the
§4.4 "Unverified" bundle line is replaced by a verified one naming any assets the bundle must ship.

**Phase 1 — The command surface, from the clone.** `apps/cli/` with the dispatcher, the command
table, `help`, `--help`, `--version`, and `init` (D6) with the `parseInvestigatorEnv` extraction.
`scripts/console-live.ts` becomes `console --live`; `scripts/probe-defender.ts` moves under
`apps/cli/` as `probe`; their tests move with them. `apps/cli/src` joins the ground-truth isolation
`ROOTS`. The root `bun run` scripts re-point at the dispatcher. The loud mock failure (D5) and the
connector comment. `packageVersion` in provenance (D8). `AGENTS.md` §5's `scripts/` line narrows to
what remains.

*Exit:* `bun run check` is green and `bun apps/cli/src/index.ts help` lists every command in the
§4.3 table, each of which runs from the clone exactly as its `bun run` predecessor did.

**Phase 2 — The package.** `bun run build` producing `dist/` from Phase 0's recipe, with a guard
that fails the build if the packed file list contains `fixtures/`, `apps/mock-sentinel` or a
`.env`. Root `package.json` gains `name`, `bin`, `files`, `engines`, the external `dependencies` the
bundle imports, and loses `private`. The AGENTS.md carve-out for the CI-only build. ADR 014 written,
born `Accepted`.

*Exit:* `bun pm pack` then `bun add ./isophase-0.0.0.tgz` in an empty directory followed by
`bunx isophase init --track defender` writes `.env` and `.data/runs`, and `bunx isophase help`
prints the command table — all without the repository on the machine.

**Phase 3 — The release flow.** `.github/workflows/release.yml` (D4). The user tags `v0.1.0`,
publishes it manually with 2FA, and configures the trusted publisher. Then `v0.1.1` is tagged, a
Release is published, and the workflow publishes it.

*Exit:* `bunx @aretea-group/isophase@0.1.1 --version` prints `0.1.1` on a machine that has never
seen the repository, and the npm package page shows provenance for `0.1.1` linking to the release
commit.

**Phase 4 — The README.** The Install section (D7) with the `bunx` line, `init`, and the command
table, placed before "Choose your path". Track A rewritten around `isophase …` commands, Track B
unchanged, the development section stating that `bun run` scripts and the package share one
dispatcher. `docs/roadmap.md` §11 narrowed; the Node and config-file non-goals added to the roadmap;
`docs/README.md` row added.

*Exit:* the first screen of the README shows the package install path before any `git clone`, and
every command the README shows under Track A exists in the §4.3 table.

## 6. Success criteria / Metrics

| Measure | Today (2026-10-02) | Target | Measured by |
|---|---|---|---|
| Commands from zero to a running Track A loop, Bun present | `git clone`, `bun install`, `cp .env.example .env`, edit, `bun run probe:defender`, `bun run investigate --watch`: 6 | 3 (`bunx … init`, edit `.env`, `isophase investigate --watch`) | the README's Install section, walked on a clean machine (AC22) |
| Published versions | 0 | `0.1.0` manual, `0.1.1` by the workflow | the npm package page |
| Long-lived npm credentials in the repository or its secrets | 0 | ~~0~~ one 90-day granular token in `NPM_TOKEN`, rotated (ADR 014 §6, 2026-10-05) | ~~AC17~~ AC29 |
| Run artifacts that name the version that produced them | 0 of all | all new artifacts | AC9 |

## 7. Observability

- The workflow log shows the five gates in order (check, build, tarball guard, version stamp,
  publish) and the provenance URL npm prints.
- The npm package page shows the provenance badge and the source commit for every workflow-published
  version; `0.1.0` is the one version without it, by design.
- `isophase --version` and `packageVersion` in every run artifact under `.data/runs/`.
- `init` prints each file and directory it created and the validation result before the next
  command, so a failed bootstrap shows which step failed.

## 8. Acceptance criteria

- [x] **AC1** — Given the Phase 0 bundle installed from a tarball into an empty directory and the
      local lab running, When `console` is opened, Then it renders and lists the mock queue.
      _(test: e2e, manual, recorded in §4.4)_
- [x] **AC2** — Given the same installation, When one mock investigation is started from the
      console, Then it completes and writes a run artifact under the configured `RUNS_DIR`.
      _(test: e2e, manual, recorded in §4.4)_
- [x] **AC3** — Given the packed tarball, When its file list is read, Then it contains no path under
      `fixtures/`, `apps/mock-sentinel/` or any `.env`, and the build fails if it would.
      _(test: unit — the guard; integration — `bun pm pack --dry-run` against the guard)_
- [x] **AC4** — Given Bun on `PATH`, When `bunx isophase help` runs from an installed tarball, Then it
      prints every command in the §4.3 table and exits 0. _(test: integration)_
- [x] **AC5** — Given the command table, When `help <command>` and `<command> --help` are run for
      each entry, Then both print the same usage text, and an unknown command exits non-zero naming
      `help`. _(test: unit)_
- [x] **AC6** — Given an empty directory, When `isophase init --track defender` runs, Then `.env`
      exists with the `DEFENDER_*` and `SECURITY_SOURCES=defender` lines uncommented and
      `RUNS_DIR`, `INVESTIGATOR_TRACE_DIR` and `WATCH_CONTROL_SOCKET` pointing under `.data/`,
      `.data/runs` and `.data/runs/traces` exist, and the next command printed is `isophase probe`.
      _(test: integration)_
- [x] **AC7** — Given a directory where `.env` already exists, When `init` runs without `--force`,
      Then it refuses, leaves the file byte-identical, and exits non-zero. _(test: unit)_
- [x] **AC8** — Given `init`'s source and the dispatcher's, When scanned, Then neither imports
      `@azure/identity`, calls `fetch`, or references an Entra, ARM or Graph endpoint — `init`
      performs no network call. _(test: unit)_
- [x] **AC9** — Given a completed investigation, When the run artifact is written, Then its
      provenance block carries `packageVersion`, equal to `0.0.0` from the clone and to the tag's
      version from a published package. _(test: unit)_
- [x] **AC10** — Given ADR 008's comparison key, When two runs differ only in `packageVersion`, Then
      their comparison keys are equal. _(test: unit)_
- [x] **AC11** — Given `bun run build`, When it completes, Then `dist/cli.js` exists, imports no
      path under `apps/` or `packages/`, and its externals are exactly the root `dependencies`.
      _(test: integration)_
- [x] **AC12** — Given `SENTINEL_CONNECTOR=mock` and nothing listening on `SENTINEL_BASE_URL`, When
      `investigate` or `console` starts, Then the message names the mock connector, says it needs
      the local lab, and names `isophase init` — and does not mention `bun run dev:mock-sentinel`.
      _(test: unit)_
- [x] **AC13** — Given the root `package.json` after Phase 1, When `bun run investigate`,
      `bun run console`, `bun run console:live defender` and `bun run probe:defender` are invoked,
      Then each reaches the dispatcher and behaves as before. _(test: integration)_
- [x] **AC14** — ~~Given `release.yml`, When read, Then it triggers only on `release: published`,
      declares `id-token: write` and `contents: read` and nothing more, and runs `bun run check`
      before `bun run build`.~~ _(test: unit — a workflow-shape test, like the existing ruleset test)_
      **Superseded 2026-10-05 — §11 A2.** Proven as written on 2026-10-02; replaced by AC29.
- [x] **AC15** — ~~Given a release tag that is not `vX.Y.Z` or `vX.Y.Z-<pre>`, When the version stamp
      step runs, Then the job fails before publishing.~~ _(test: unit — the stamp script)_
      **Superseded 2026-10-05 — §11 A2.** release-please mints every tag; the publish step instead
      refuses a `package.json` version that is not semantic or disagrees with the tag (AC30).
- [x] **AC16** — Given a pre-release tag, When the publish step runs, Then it passes `--tag next`;
      given a release tag, it passes no dist-tag. _(test: unit — the stamp script)_
- [x] **AC17** — ~~Given the repository's secrets and every workflow file, When scanned, Then no
      `NPM_TOKEN` or `NODE_AUTH_TOKEN` is referenced.~~ _(test: unit)_
      **Superseded 2026-10-05 — ADR 014 §6, §11 A2.** Proven as written on 2026-10-02; one token
      now reaches the publish step alone, which AC29 pins.
- [x] **AC18** — Given the `0.1.0` publish, When the trusted publisher is configured, Then the npm
      package settings name `Aretea-Group/isophase` and `release.yml`. _(test: e2e, manual)_
- [x] **AC19** — Given a published `v0.1.1` Release, When the workflow completes, Then
      `@aretea-group/isophase@0.1.1` exists on npm with provenance pointing at the release commit.
      _(test: e2e, manual)_
- [x] **AC20** — Given a machine that has never seen the repository, When
      `bunx @aretea-group/isophase@0.1.1 --version` runs, Then it prints `0.1.1`. _(test: e2e, manual)_
- [x] **AC21** — ~~Given git's `package.json`, When read on `main` after Phase 3, Then its version is
      `0.0.0`.~~ _(test: unit)_ **Superseded 2026-10-05 — §11 A2.** Proven as written on
      2026-10-02; release-please now keeps the real version in git, and a test pins that it matches
      the release-please manifest.
- [x] **AC22** — Given a clean machine with Bun and a Defender credential, When a reader follows the
      README's Install section from the top, Then they reach a running `investigate --watch` in
      three commands without cloning. _(test: e2e, manual walkthrough)_
- [x] **AC23** — Given the README, When read from the top, Then the Install section precedes "Choose
      your path", and every `isophase` command it shows is in the §4.3 table. _(test: unit — a
      README scan, like `scripts/run-artifacts-ignored.test.ts`)_
- [x] **AC24** — Given `AGENTS.md` after Phase 2, When read, Then §2 lists "`init` provisions
      nothing in a tenant" and "the lab is not published", and §5 names `dist/` as CI-only build
      output. _(test: unit — document scan)_
- [x] **AC25** — Given `apps/cli/src`, When the ground-truth isolation suite runs, Then that root is
      in `ROOTS` and the scan over it finds no `fixtures/scenarios/` read or import. _(test: unit)_
- [x] **AC26** — Given no `.env` and no provider key, When `apps/investigator/src/env.ts` is
      imported, Then it still throws at import as before, and `parseInvestigatorEnv` rejects the
      same input with the same error. _(test: unit)_
- [x] **AC27** — Given the `.env` that `init --track defender` wrote, When `investigate --watch`
      starts with valid credentials, Then `assertLiveTenantArtifactDirectories` passes without the
      operator editing any directory variable. _(test: unit — the template against the assertion)_
- [x] **AC28** — Given a packed tarball and a machine state that has only Bun, When a scripted
      new-person flow installs the tarball into an empty directory, runs `init --track defender`,
      `help`, `--version`, and one `investigate --alert` against the lab, Then every step exits 0,
      `.env` and `.data/runs` exist, and the run artifact appears under `.data/runs`. _(test: e2e —
      scripted, against the local lab; added 2026-10-02 by §11 A1)_

- [x] **AC29** — Given `release.yml`, When read, Then it triggers only on pushes to `main`; a
      `release-please` job with `contents: write` and `pull-requests: write` is the only job that
      can write to the repository; `publish` runs only when that job reports `release_created`,
      checks out the tag it names, and runs `bun run check` before `bun run build` before
      `npm publish --access public --provenance`; and the `NPM_TOKEN` secret reaches the publish
      step alone, as `NODE_AUTH_TOKEN`, with no other workflow naming a secret. _(test: unit — the
      workflow-shape test; added 2026-10-05 by §11 A2)_
- [x] **AC30** — Given a `package.json` version that is not `X.Y.Z` or `X.Y.Z-<pre>`, or that
      disagrees with the tag being published, When the publish step reads it, Then the job fails
      before `npm publish`. _(test: unit — the version script; added 2026-10-05 by §11 A2)_

## 9. Open questions

- **Q1** — Who holds the `aretea-group` npm org and performs the manual `0.1.0` publish with 2FA?
  _Partly answered 2026-10-02: the user holds an npm account, not an org. A scope is a username or
  an org name, so `@aretea-group` needs a free org of that name created from that account before
  the manual publish. Who clicks is settled; the org does not exist yet._
  Needed at Phase 3, not for sign-off.
- **Q2** — Does `init` without `--track` ask interactively, or default to `defender` with a printed
  note? Cosmetic; Phase 1 decides and records it in the command table.

## 10. References

- `docs/roadmap.md` §11 — Track A distribution; narrowed by this PRD
- PRD-9 §3 — the npm non-goal this PRD reverses
- PRD-10 — the Track A front door this PRD packages
- ADR 008 — the comparison key D8 protects
- ADR 012 — why no run artifact is ever in the package
- ADR 009 §5, ADR 011 §13 — the `.data/` rule `init`'s template satisfies
- ADR 013 §6 — the write path `PUBLISH_FINDINGS` gates; unchanged here
- `docs/defender-setup.md` — what `init` points the operator at instead of doing it
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers) — OIDC requirements
- [OpenTUI deployment](https://opentui.com/docs/ship/deploy) — bundle and Node constraints

## 11. Amendments

- **A1 — 2026-10-02 — a scripted new-person end-to-end criterion is added.** Asked for in chat
  during Phase 1: "we should add an AC to test the whole thing e2e for a new person, so install
  setup". AC22 already asks for a manual walkthrough of the README from a clean machine; this adds
  AC28, an automated flow against the packed tarball — install, `init`, `help`, `--version`, one
  mock investigation — that Phase 2 can run every time the package shape changes. Nothing is
  struck: it adds a promise and falsifies none.
- **A2 — 2026-10-05 — release-please owns versions and releases; merging its pull request is
  the publish trigger.** Asked for in chat after npm refused the workflow's OIDC identity: "lets do
  Deviate to a granular npm token and also implement release-pls with automatic release". The
  token half is a deviation from D4 and is recorded in ADR 014 §6, not here. The release-please
  half is this amendment: it reverses the §3 non-goal on changelogs and version-bump pull
  requests, strikes D4's trigger and its `0.0.0` clause, supersedes AC14, AC15, AC17 and AC21 (all
  proven as written before the change, boxes kept), and adds AC29 and AC30. The §6 credentials row
  is struck to one rotated token. AC19 and AC20 keep their wording: the first release-please
  publishes is `0.1.1`.
