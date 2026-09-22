# PRD-9 — Open-source release readiness

**Status:** Approved — 2026-09-22
**Produces:** ADR 012 — The run corpus leaves version control
**Reverses:** ADR 008 §8 ("**And the corpus enters version control.** `/runs/` leaves `.gitignore`;
`/runs/traces/` replaces it. The run artifacts and their archive are committed")
**Amends:** `AGENTS.md` §5 (`runs/` listed as a committed repository root, with the rationale that
`evaluate` "must score the same corpus from a fresh clone"); `README.md` §"Run the investigator
directly" ("**Run artifacts are committed.**")

## 1. Purpose

The repository is private, holds 113 commits, and is intended to be published. Nothing about the
software blocks that — `bun run check` is green at 552 passing tests — but the repository around it
is not publishable, in six specific ways.

**There is no licence on `main`.** GitHub reports `licenseInfo: null`. Without one the default is
all rights reserved: a reader may look, and may do nothing else. Every other item here is cosmetic
next to this one.

**`main` is unprotected and cannot currently be protected.** The branch-protection API answers
`403 "Upgrade to GitHub Pro or make this repository public to enable this feature"`, and the
organisation is on no paid plan. There is presently nothing between a keystroke and the default
branch — no required review, no required status check, no force-push guard.

**There is no `.github/` directory at all.** No CI, so no pull request is checked by anything but
the author; no `SECURITY.md`, so a tool that authenticates against a customer's security tenant
offers no private route to report a vulnerability in it; no contributing guide, issue or pull
request templates, `CODEOWNERS`, or Dependabot. The README meanwhile tells the reader that tests
calling a paid model "are not part of default CI", describing infrastructure that does not exist.

**48 run artifacts are committed.** A run artifact is the system's *output* — what the agent
concluded, about which alert, with which evidence. Since PRD-7 and PRD-8 the investigator runs
against live Microsoft Sentinel and Defender tenants, where that output carries real alerts and real
identities. One artifact already on `main` records a private Tailscale host address as its model
endpoint. This is the wrong class of file to publish, and publishing it is not required by anything.

**The corpus is described as a benchmark it cannot support.** `README.md` argues the artifacts are
committed so the benchmark travels with a fresh clone. Measured against what is actually on disk:
ten conditions, and **not one of them has a single `(condition, scenario)` cell reaching three
draws** — the floor at which a repeat means anything, which `README.md` states and `evaluate`
reports as the `n>=3` column. Eight of the ten record no `promptHash`, `submissionHash`,
`piVersion` or `corpus` hash, so they cannot be compared to anything the current harness produces.
The corpus is 206 KB of under-powered measurement, not a baseline.

**The name ends in `-poc`**, which is the first thing a visitor reads and the URL forever.

The benchmark a public reader actually needs is already in the repository and is unaffected by all
of this: `fixtures/telemetry/` (Microsoft's Training Lab telemetry, MIT) and `fixtures/scenarios/`
(14 scenarios with their verdicts, discriminating evidence and traps) are the benchmark *input*, and
they are what lets a stranger score their own agent. The README does not currently say so.

## 2. Goals

1. The repository can be made public without publishing any investigation output of ours, ~~or any
   private infrastructure detail~~. → narrowed 2026-09-22, §11 A1: output written from now on is
   never published; the 48 mock-data artifacts and one internal hostname already in history stay
   there.
2. A stranger can clone it and benchmark **their own** agent against the Training Lab telemetry and
   the 14 scenarios, needing no credential of ours and no corpus of ours — and the README tells them
   that is what the repository is for.
3. `main` is protected: no direct pushes, no force-pushes, and a green CI run required before any
   pull request can merge — the maintainer included.
4. The project is legally usable — MIT on `main`, third-party content attributed, contributors
   named.
5. The standard furniture a public repository is judged on exists: security policy, contributing
   guide, CI on every pull request, issue and pull request templates, `CODEOWNERS`, Dependabot.
6. Every document that describes the run corpus says what is true once this PRD lands.
7. `docs/roadmap.md` is true. A visitor reads it to decide whether the project is alive and where it
   is going, and it currently presents delivered work as future work and describes code that no
   longer exists.
8. An operator who wants to point the agent at their own Defender or Sentinel tenant can do so
   without installing Docker, and learns that from the top of the README rather than from its
   twelfth section.

## 3. Non-Goals

- **Publishing to npm.** The workspace stays `private: true`; the `@soc/*` scope is not owned and is
  not being claimed.
- **A hosted demo or a web UI.** Roadmap §6 already holds the console write path; neither is release
  work.
- **Building a container image or a release binary.** Not rejected — deferred. §4.1.12 records why
  and puts both on the roadmap; what this PRD ships is clone-and-run.
- **Any change to the agent, its connectors, its five tools, or the scoring logic.** This PRD moves
  files, documents and repository settings. If a code change is needed beyond the guard in AC7 and
  the CI workflow, that is a signal the scope was drawn wrong.
- **Publishing reference scores or a leaderboard.** Decision §4.1.7; revisit only when a condition
  reaches the three-draw floor across the scenario set.
- **Re-opening `fixtures/baseline-runs/`.** ADR 008 §8 considered and rejected a curated committed
  baseline; nothing measured since argues for reversing that, and it would reintroduce exactly the
  class of file this PRD removes.
- **A CLA or a formal governance model.** Premature for a project with one maintainer and one named
  contributor; it goes to the roadmap until a second outside contributor appears.
- **Re-planning the roadmap.** Goal 7 is a truth pass, not a product exercise: sections that shipped
  are marked shipped, claims about code that no longer exists are corrected or struck, and nothing
  is reordered, reprioritised or dropped on the grounds that it no longer looks interesting.
  Deciding what gets built after PRD-9 is a `prd-discuss` conversation, not release hygiene.
  **One addition is in scope, on the user's instruction of 2026-09-22**: a roadmap item for
  container and binary distribution of Track A (§4.1.12). It is recorded there rather than built
  here, which is the point of the fence — the roadmap gains a candidate, not a commitment.
- **Redacting the Training Lab identities.** `adelev@m365x816222.onmicrosoft.com` and its siblings
  are Microsoft's own published sample identities, shipped under the MIT licence in
  `fixtures/telemetry/LICENSE`. They stay.
- **Renaming the repository before the licence and protection land.** Ordering, not refusal: the
  rename is Phase 5 and is the only stretch item here.

## 4. Design

### 4.1 Decisions (locked)

1. **MIT, with the copyright line reading "Aretea Group and contributors".** The licence text on the
   unmerged `chore/oss-license-and-untrack-runs` branch is correct and is reused; only the holder
   line changes, so that the named contributor in §4.1.6 is covered by the grant rather than sitting
   outside it.

2. **The benchmark ships; our measurements do not.** `fixtures/telemetry/` and
   `fixtures/scenarios/` stay committed exactly as they are. `runs/` and `runs/.archive/` leave the
   repository. The distinction is input versus output: the fixtures are what an agent is *tested
   on*, the artifacts are what *our* agent said. Third-party benchmarking needs the first and never
   the second, so removing the second costs a public reader nothing.

3. ~~**`runs/` is purged from git history, not merely untracked.** Untracking at `HEAD` leaves every
   artifact readable in a public history, which would make the stated reason for removing them
   false. The rewrite is narrow and its cost is measured: two of 113 commits ever touched `runs/`
   (§4.4), and of the eight `git show <sha>:"<path>"` full-text pointers in the PRD stubs, four
   predate the rewrite point and survive untouched while four must be re-pointed from the
   `git-filter-repo` commit map. The `prd-8-full-text` tag is rewritten in place and keeps resolving.~~
   → reversed by the user 2026-09-22, §11 A1: `runs/` is untracked at `HEAD` and history is left
   alone. ADR 012 records the rehearsal that informed it.

4. **Reversing ADR 008 §8 produces ADR 012.** A locked decision is not reversed in a `.gitignore`
   comment. ADR 012 records what changed, the measurement that justifies it, and what is knowingly
   given up — that a score we quote is no longer checkable by a third party against the artifacts it
   was computed from, and that removing a measurement stops being visible as a diff.

5. **`main` is protected immediately after the repository goes public, with the ruleset written in
   advance.** Protection is unavailable while the repository is private on this plan (§4.4), so the
   order is forced: land everything, prepare the ruleset JSON, flip visibility, apply it. The window
   between flip and ruleset is the risk being managed, and preparing the JSON beforehand is what
   makes it seconds rather than a session.

6. **Contributors are named in the repository.** Jan-Henrik Damaschke authored 34 commits and is a
   contributor rather than a vendored import; an `ACKNOWLEDGEMENTS` section in the README names him
   alongside Microsoft's Training Lab telemetry. Confirmed with the user 2026-09-22: no licensing
   conflict.

7. **No scores are published.** Removing the corpus means any headline number would be unverifiable
   by a reader. The README describes what the benchmark measures and how to run it, and quotes no
   result.

8. **Live-tenant artifact paths stay enforced in code.** `assertLiveTenantArtifactDirectories` and
   ADR 011 §13's `.data/` rule are the mechanism that kept live tenant data out of the repository
   through PRD-7 and PRD-8 (§4.4), and this PRD documents that guarantee in the README rather than
   relying on it silently.

9. **A green CI run is a required status check; required approvals are zero while there is one
   maintainer.** Every change reaches `main` through a pull request whose checks passed — that is
   the enforceable half, and it binds the maintainer exactly as it binds a stranger. The review half
   is deliberately not enforced by a counter, because GitHub does not let an author approve their
   own pull request (§4.4): a required-approvals count of one against a single maintainer does not
   buy careful review, it means nothing merges without a bypass, and a bypass exercised daily
   protects nothing. Outside contributions are already gated by write access — a stranger opens from
   a fork and cannot merge their own work whatever the count says. The count rises to one the moment
   a second maintainer exists.

10. **The project is renamed to Isophase, and the clearance is already on record (§4.4).** A
    lighthouse whose light and dark periods are exactly equal, identifiable by its rhythm alone.
    The rename remains Phase 5 and remains droppable; what is locked is the candidate, so no further
    name search is in scope.

11. **The README offers two tracks from the top, and neither is a subset of the other.** **Track A —
    point it at your tenant:** Bun, a model key, and a Defender or Log Analytics credential.
    No Docker, no Kusto, no bootstrap, no fixtures. **Track B — the full local lab:** everything
    above plus the emulator, the Training Lab telemetry and the 14 scenarios, which is what
    customising the agent and scoring it against ground truth requires. Both already work (§4.4);
    what is wrong is the presentation. Docker is currently an unconditional prerequisite in the
    Quick start, and the tenant path is 200 lines below it under a heading named "Other workflows",
    so the operator who wants Track A reads Track B's requirements first and concludes the emulator
    is mandatory. Prerequisites are stated per track, and neither track is described in terms of the
    other.

12. **Track A is distributed as clone-and-run; a container image and a compiled binary go to the
    roadmap, not into this PRD.** `git clone`, `bun install`, four `.env` lines is what ships,
    because it works today and adds no build, publish or signing pipeline to a release that has
    enough moving parts already. The two alternatives are real and were not dismissed on merit:
    against Track A a prebuilt binary is the *best* of the three — no Docker, no Bun, no clone — and
    an image is viable now that the console's clipboard is known to travel as OSC 52 rather than a
    host binary (§4.4), so a containerised TUI keeps copy working. Both are recorded in
    `docs/roadmap.md` with the one open technical question: whether `bun build --compile` handles
    OpenTUI's native dependencies, which nobody has checked. An earlier note in this PRD dismissed
    both outright; that judgement was made against Track B's emulator problem, where packaging
    genuinely cannot help, and does not carry over to Track A.

13. **No demo artifacts are committed.** Considered and dropped: a `fixtures/demo-runs/` set would
    have let a visitor open a finished investigation with no credential at all, but it re-opens
    §4.1.2 for an audience this project does not need to serve. The two tracks above are the
    supported ways in.

14. **The roadmap is corrected in place, and delivered sections compress rather than disappear.** A
    section the project shipped becomes a short delivered note naming the PRD that closed it, kept
    rather than deleted, because a roadmap that silently drops its completed items reads as a
    project that never finishes anything. A claim about code that no longer exists is struck with
    the date and what replaced it, in the same style §4.2 uses here — the roadmap is the one
    document in `docs/` that a stranger reads *first*, and the only one with no ADR above it to
    correct the record.

### 4.2 Assumptions (load-bearing)

- **Aretea Group holds copyright in all non-vendored code**, with Jan-Henrik Damaschke as a named
  contributor whose involvement raises no licensing conflict. Confirmed with the user 2026-09-22.
- ~~The committed run artifacts contain private alert information.~~ **Corrected 2026-09-22.** All
  48 were inspected: every one holds Training Lab mock data, and none was produced by the `azure` or
  `defender` connector. Decision §4.1.2 and §4.1.3 are unchanged, because they rest on two other
  facts rather than on this one — artifacts written after PRD-7/PRD-8 *do* carry live tenant alerts
  and identities, and one committed artifact carries a private Tailscale host address.
- **A history rewrite is acceptable.** The repository is private, has one active developer, no
  public forks and one remote branch besides `main`. If a fork or a second clone appears before
  Phase 2, the rewrite has to be coordinated rather than simply performed.
- **Publishing the answer key is acceptable.** `fixtures/scenarios/` holds the verdicts in plain
  text; public means readable by anyone and eventually present in model training data, which erodes
  the benchmark's value over time. **Confirmed with the user 2026-09-22** as the accepted price of
  an open benchmark: a benchmark a stranger cannot read is not one they can use.
- **No licence obligation attaches to the Kusto Emulator image beyond running it.** The image is
  pinned by digest in `infra/docker-compose.yml` and never redistributed, only pulled by the user.

### 4.3 Design details

**The corpus split.** `.gitignore` gains `/runs/` anchored at the root, replacing `/runs/traces/`.
The anchor matters: unanchored, `runs` matches any directory of that name at any depth and would
silently exclude the committed test fixtures under `apps/*/test/fixtures/runs/`, which are inputs to
the console and investigator test suites and must stay tracked. That trap has been hit once before
(PRD-3 §12), so AC7 adds the test that catches it next time.

~~**What the history rewrite touches.** `git-filter-repo --path runs/ --invert-paths` over a fresh
mirror clone. Rewrite point is `eb0d480` at depth 40; commits at depth 1–39 keep their SHAs. The
emitted `.git/filter-repo/commit-map` is the source for re-pointing the four stale PRD full-text
lines — PRD-5, PRD-6, PRD-7 and PRD-8 — which is a mechanical substitution, not a judgement call.
The single remote branch `feat/unattended-investigation` is rewritten with everything else or
deleted first.~~ → dropped 2026-09-22, §11 A1. The pointers keep their original commits.

**The ruleset.** A repository ruleset on `main` rather than classic branch protection: require a
pull request, **require the CI status check to pass**, block force-pushes and deletions, and no
bypass actors. Required approvals are zero per §4.1.9, so the gate that actually holds is the status
check — a pull request with a red `check` run cannot be merged by anyone, the maintainer included,
and there is no standing bypass to make that gate optional. Written as JSON in `.github/` so it is
reviewable, version-controlled, and appliable in one `gh api` call at the moment of the visibility
flip.

**CI.** One workflow on `pull_request` and on `push` to `main`, running `bun run check` — the same
four-stage gate the repository already defines (`fmt:check`, `lint`, `typecheck`, `test`). Nothing
requiring Docker, Kusto, a tenant or a paid model runs in CI; those suites already skip themselves
explicitly when their dependency is absent, which is what makes a credential-free CI honest rather
than hollow. This workflow is the required status check named in the ruleset.

**Where the documents change** is enumerated in §7.

### 4.4 Platform facts

- **Verified 2026-09-20** — `GET /repos/Aretea-Group/soc-agent-poc/branches/main/protection` returns
  `403 "Upgrade to GitHub Pro or make this repository public to enable this feature."`, and
  `GET /orgs/Aretea-Group` reports `plan: null`. Branch protection is unavailable while the
  repository is private on the current plan. This forces the Phase 4 ordering and AC17.
- **Verified 2026-09-20** — `.env` has never been tracked on any ref, including the three local
  `refs/t3/checkpoints/*`. A scan of every blob reachable from every ref for key-shaped strings
  (`sk-`, `ghp_`, `github_pat_`, `AKIA`, `xox[baprs]-`, JWTs, `AccountKey=`) returns only
  `AKIAIOSFODNN7EXAMPLE` and two siblings — AWS's published documentation placeholders, inside the
  Training Lab fixtures. The history carries no real credential.
- **Verified 2026-09-20** — no committed run artifact was ever produced by the `azure` or `defender`
  connector; the `.data/` discipline held through PRD-7 and PRD-8. Supports §4.1.8 and corrects the
  struck assumption in §4.2.
- **Verified 2026-09-20** — one committed artifact (condition `d9bc93`) records
  `https://evo-x2-icarus.tail56d848.ts.net/v1` in `config.modelBaseUrl`: a private Tailscale host.
  It also appears in commit `8247a2c`. Grounds for AC8.
- **Verified 2026-09-20** — the commit log carries three author identities. Two are GitHub `noreply`
  addresses; the third is Jan-Henrik Damaschke with 34 commits across two addresses. Grounds for
  §4.1.6.
- **Verified 2026-09-22** — the committed corpus is 48 artifacts, 210,746 bytes, spanning 14
  scenarios and 10 conditions. `bun run evaluate` reports `n>=3 0/9`, `0/8`, `0/6`, `0/6`, `0/2`,
  `0/1`, `0/1` and three conditions with no scoreable draws at all: **zero cells reach the
  three-draw floor**. Eight of ten conditions show `p=? · s=? · pi=? · corpus=?`. Grounds for §1,
  §4.1.2 and §4.1.7.
- **Verified 2026-09-22** — exactly 2 of 113 commits on `main` touch `runs/`: `eb0d480`
  ("chore(runs): commit the run corpus and stop ignoring it") at depth 40, and `8247a2c` at depth
  41+. Grounds for the cost claim in §4.1.3.
- **Verified 2026-09-22** — of the eight PRD full-text pointers, `211735a` (depth 21), `80f9859`
  (32) and `fe28b0c` (36) precede the rewrite point and survive; `d57be75` (41), `c43f898` (48),
  `8ad3c2a` (76) and `a92e13f` (118) follow it and must be re-pointed. `prd-8-full-text` tags
  `a92e13f` and is rewritten in place by `git-filter-repo`. Grounds for AC9.
- ~~**Verified 2026-09-22** — a fresh clone with no `runs/` directory runs `bun run evaluate`
  successfully: it prints `[evaluate] no run artifacts in runs or runs/.archive` and exits 0.~~
  **Corrected 2026-09-22 (Phase 2).** Re-measured on `main` at `9b8e29f`: it prints that line and
  exits **1** — the no-artifacts check in `scripts/evaluate-runs.ts` sits ahead of the PRD-6 D7
  gate and shared its exit code. AC6 requires 0, so Phase 2 changes that one exit code; the D7 gate
  itself — runs read but none joined to a scenario — still exits 1. The rest of the line holds: the
  investigator's `run-artifact.ts` creates the directory with `mkdir(…, { recursive: true })` on
  first write, and removing the corpus breaks no other code path. Grounds for AC6.
- **Verified 2026-09-22** — `bun run check` on the licence branch: 552 pass, 65 skip, 0 fail across
  51 files. The skips are the Kusto, Mock Sentinel, Azure and Defender suites declining themselves
  in the absence of their dependency, which is the behaviour CI relies on in §4.3.
- **Verified 2026-09-22** — Track A needs no Docker and no emulator, and already works.
  `apps/investigator/src/env.ts` defaults `SENTINEL_BASE_URL` and `SENTINEL_CONNECTOR`, and
  `SECURITY_SOURCES=defender` selects a source that contacts no Sentinel of any kind; PR #56's
  `bun run console:live defender` sets the three variables that must move together and forces the
  artifact directories under `.data/`. Nothing in this PRD builds Track A — §4.1.11 documents it.
- **Verified 2026-09-22** — the README presents Track B as the only way in. Its Quick start lists
  "Docker CLI with Compose v2" as an unconditional prerequisite, and the tenant paths appear ~200
  lines later under a heading named "Other workflows". Grounds for §4.1.11 and AC27.
- **Verified 2026-09-22** — `docs/roadmap.md` §9 "Benchmarking Surface" rests on two claims about
  current code, and neither holds. `latestPerScenario` does not exist anywhere in the tree, and
  `config.analystContext` is not skipped but hashed into the condition key
  (`scripts/evaluate/condition.ts:180`) — which is the "steered beside baseline" comparison axis §9
  proposes building. PRD-6 delivered it. Grounds for Goal 7 and AC25.
- **Verified 2026-09-22** — `docs/roadmap.md` §6 "Console as an Operator Surface" is written
  throughout as unbuilt work, with four open design questions, and then closes by recording that
  PRD-5 implemented it and answered all four. §10 is a section whose entire content is delivered
  work. A reader meets the forward-looking text first and the correction last. Grounds for §4.1.14.
- **Documented, not measured, 2026-09-22** — GitHub does not permit the author of a pull request to
  approve it. A required-approvals count of one therefore blocks a solo maintainer entirely rather
  than producing review. Grounds for §4.1.9; confirmed in practice at the Phase 3 exit, when the
  first pull request runs through the prepared ruleset.
- **Verified 2026-09-22 (name clearance, §4.1.10)** — `isophase` and the `@isophase` scope are both
  unregistered on npm (404), and `Aretea-Group/isophase` is free (404). The GitHub *user* handle
  `isophase` is taken — registered 2020-01-25, one public repository, no bio — so a dedicated
  `github.com/isophase` organisation is unavailable while the repository name under the existing
  organisation is not. Two same-name entities exist: `IsoPhase-security/IsoPhase`, a dormant CVE
  research project (1 star, last push 2022-10-18) sharing both the name and the security domain;
  and Isophase Computing Ltd., an active Canadian FPGA consultancy holding `isophase.com`.
  `isophase.io`, `.dev` and `.sh` return no A record, which suggests but does not prove they are
  unregistered.
- **Unverified** — whether GitHub repository *rulesets* (as opposed to classic branch protection)
  are available to this organisation once the repository is public. `GET /rulesets` currently
  answers `404`. AC17 depends on the answer; if rulesets are unavailable, classic branch protection
  covers the same four requirements and AC17 is satisfied by it instead.
- **Unverified** — whether GitHub secret scanning and push protection are enabled for free on public
  repositories in this organisation. AC18 depends on the answer and is checked at the moment of the
  flip, not before.

## 5. Phasing

**Phase 1 — The licence.** MIT `LICENSE` at the root with the holder line from §4.1.1,
`"license": "MIT"` in the root `package.json`, and a README section naming the Training Lab
telemetry's separate Microsoft copyright and its in-tree `fixtures/telemetry/LICENSE`, plus the
contributor from §4.1.6. Reuses the two commits already sitting unmerged on
`chore/oss-license-and-untrack-runs`, minus its `.gitignore` change, which belongs to Phase 2.

*Exit:* `LICENSE` is on `main` and `gh repo view --json licenseInfo` reports MIT.

**Phase 2 — The corpus leaves, and the documents stop claiming otherwise.** ADR 012 written first,
because it is what authorises the rest. Then `/runs/` into `.gitignore`, the 48 artifacts untracked,
~~the history rewritten per §4.3, the four stale full-text pointers re-pointed from the commit map,~~
(dropped 2026-09-22, §11 A1) and every document in §7 corrected — `docs/roadmap.md` included, per §4.1.14. The README gains the
section Goal 2 asks for: what the benchmark is, what it measures, and how to run your own agent
against it.

*Exit:* ~~`git log --all -- runs/` returns nothing~~ `git ls-files runs/` returns nothing (§11 A1),
`bun run check` is green, no file in the repository states that run artifacts are committed, and no
roadmap section presents delivered work as future work.

**Phase 3 — The furniture.** `.github/` with the CI workflow from §4.3, `SECURITY.md` naming a
private disclosure route and a response expectation, `CONTRIBUTING.md` covering the `bun run check`
gate and the ADR-before-architecture-change rule from `AGENTS.md` §15, issue and pull request
templates, `CODEOWNERS`, `dependabot.yml`, and the prepared ruleset JSON.

*Exit:* a pull request against `main` runs CI to green with no credential configured in the
repository.

**Phase 4 — Protect, then publish.** Apply the prepared ruleset, flip the repository to public,
enable secret scanning with push protection and Dependabot alerts, and set the repository
description and topics.

*Exit:* the repository is public, a direct push to `main` is rejected, and push protection is
active.

**Phase 5 — The name (stretch).** Rename to **Isophase** (§4.1.10). The GitHub repository, the root
`package.json` `name`, the README title and the `docs/README.md` subtitle; GitHub's redirect covers
existing clones, and the workspace scopes `@soc/*` are out of scope because nothing is published.
Clearance is already recorded in §4.4, so the only outstanding check is a registrar lookup if a
domain is wanted — which the rename does not depend on.

*Exit:* the repository name no longer contains `poc`, or the phase is explicitly dropped.

## 6. Success criteria / Metrics

| | Today | Target | Measured by |
|---|---|---|---|
| Run artifacts ~~reachable from any public ref~~ tracked at `HEAD` (§11 A1) | 48 | 0 | ~~`git log --all -- runs/`~~ `git ls-files runs/` |
| Documents claiming the corpus is committed | 4 (`README.md`, `AGENTS.md` ×2, ADR 008 §8) | 0 | §7 checklist |
| Pull requests gated by an automated check | 0 | all | ruleset required-check setting |
| Private disclosure route for a vulnerability | none | `SECURITY.md` | file exists and names a route |
| Roadmap sections presenting delivered work as future work | 3 (§6, §9, §10) | 0 | §7 checklist |
| Time for a stranger to a first scored run | unmeasured | ≤ 30 min on a clean machine, model key aside | walkthrough on a fresh clone, Phase 2 exit |

The last row is the one that decides whether Goal 2 was actually met, and it is measured by walking
the README on a machine that has never seen the repository — not by reading it.

## 7. Legacy removal checklist

Every place that currently asserts the corpus is committed, or otherwise describes the pre-PRD-9
repository:

- [x] `README.md` §"Run the investigator directly" — "**Run artifacts are committed.** … Expect
      `git status` to show new artifacts after an investigation."
- [x] `README.md` §"Evaluate runs" — "Every run ever recorded is scored" and the fresh-clone
      reproducibility argument.
- [x] `README.md` §Development — "not part of default CI", which describes CI that does not exist.
- [x] `README.md` §Quick start — "Docker CLI with Compose v2" as an unconditional prerequisite, and
      the Track A paths buried under a heading named "Other workflows" (§4.1.11).
- [x] `AGENTS.md` §5 — `runs/` listed as a committed repository root in the tree diagram.
- [x] `AGENTS.md` §5 — "`scripts/evaluate-runs.ts` must score the same corpus from a fresh clone".
- [x] `AGENTS.md` §14 — "the committed corpus" as the comparison baseline.
- [x] `docs/adr/008-comparability-record.md` §8 — superseded by ADR 012, marked in place rather than
      rewritten.
- [x] `.gitignore` — the comment block arguing the corpus is deliberately not ignored.
- [x] `.env.example` — `RUNS_DIR=runs` and its comment, checked for consistency with the new rule.
- [x] ~~`docs/prd-5`, `prd-6`, `prd-7`, `prd-8` — full-text pointers re-pointed from the commit map.~~
      Not needed, §11 A1: the original commits stay, and all eight pointers were verified to resolve.
- [x] `docs/README.md` — the specification table gains PRD-9 and the decision table gains ADR 012.

**Landed early, 2026-09-22, at the user's request** — the two-track restructure (§4.1.11) and the
plain-language benchmark section (AC12) were written before sign-off rather than in Phase 2. They
close the Quick start and benchmark-naming items above; the corpus-dependent README items are
untouched and still belong to Phase 2, because the claim that run artifacts are committed is still
true until the corpus actually moves. `docs/roadmap.md` §11 was added in the same pass.

And in `docs/roadmap.md`, per §4.1.14 — corrected, not re-planned:

- [x] §6 "Console as an Operator Surface" — delivered by PRD-5; the section still reads as unbuilt
      work with four open questions and records its own delivery only in a closing paragraph.
- [x] §9 "Benchmarking Surface" — the `latestPerScenario` last-wins key and the steered-run skip
      guard it proposes deleting were both deleted by PRD-6; two of its six capabilities shipped.
- [x] §10 "Completed PRD-5 Follow-Ups" — entirely delivered, and already declared complete by §6.
- [x] §7 "Evaluation at Scale" — carries one struck item moved to PRD-6, items marked "owned by
      PRD-4", and a model-tier claim marked **Unverified**; each needs its current state.
- [x] §8 "Alert Grouping" — its evidence is "the twenty traces in `runs/traces/`", which no reader
      will ever have. State the measurement without pointing at an unreachable artifact.
- [x] §6 and §9 — counts quoted from a working tree ("the 148 alerts with no run against them")
      that a fresh clone does not reproduce.

## 8. Acceptance criteria

- [x] **AC1** — Given a clone of `main`, When a reader looks for licence terms, Then `LICENSE`
      exists at the root, names MIT, and the copyright line reads "Aretea Group and contributors".
      _(test: manual)_
- [x] **AC2** — Given the repository on GitHub, When `gh repo view --json licenseInfo` is called,
      Then it reports MIT rather than `null`. _(test: manual)_
- [x] **AC3** — Given the README, When a reader looks for third-party content, Then it names the
      Microsoft Training Lab telemetry, points at `fixtures/telemetry/LICENSE`, and names
      Jan-Henrik Damaschke as a contributor. _(test: manual)_
- [x] **AC4** — Given `.gitignore`, When `git status` is run after an investigation writes
      `runs/<run-id>.json`, Then the artifact is ignored and does not appear as untracked.
      _(test: integration)_
- [ ] **AC5** — ~~Given the rewritten history, When `git log --all -- runs/` is run, Then it returns
      no commits.~~ **Dropped 2026-09-22 — §11 A1.** _(test: manual)_
- [x] **AC6** — Given a fresh clone with no `runs/` directory, When `bun run evaluate` is run, Then
      it reports that no artifacts were found and exits 0 rather than failing. _(test: integration)_
- [x] **AC7** — Given the `/runs/` ignore rule, When the test suite runs, Then a test asserts that
      `apps/console/test/fixtures/runs/` and `apps/investigator/test/fixtures/runs/` are still
      tracked, so an unanchored pattern cannot silently drop the fixtures. _(test: unit)_
- [ ] **AC8** — ~~Given the rewritten history, When every blob reachable from every ref is searched
      for `tail56d848`, Then there are no matches.~~ **Dropped 2026-09-22 — §11 A1.** _(test: manual)_
- [x] **AC9** — Given the ~~rewritten~~ history (§11 A1), When each of the eight PRD full-text pointers is run as
      written, Then each `git show <sha>:"<path>"` resolves to the document it names.
      _(test: manual)_
- [x] **AC10** — Given ADR 012, When a reader follows ADR 008 §8, Then §8 is marked superseded by
      012 with its original text intact, and 012 states the measurement and the accepted loss.
      _(test: manual)_
- [x] **AC11** — Given the repository after Phase 2, When every file is searched for the claim that
      run artifacts are committed, Then §7's checklist is fully ticked and no match remains.
      _(test: manual)_
- [x] **AC12** — Given the README, When a reader who has never seen the repository looks for how to
      benchmark their own agent, Then the section describes the benchmark in their terms —
      Microsoft's Sentinel Training Lab telemetry, and 14 scenarios whose correct answers are known
      — states what a scenario records and how scoring works, and gives the command that scores a
      run. Directory paths appear as supporting detail, never as the explanation.
      _(test: manual)_
- [ ] **AC13** — Given a clean machine with Bun, Docker and a model key, When a reader follows the
      README's Track B from the top, Then they reach a scored run against the scenario corpus in 30
      minutes or less. _(test: e2e)_
- [x] **AC14** — Given a pull request against `main`, When CI runs, Then `bun run check` executes
      all four stages and passes with no credential configured in the repository. _(test: ci)_
- [x] **AC15** — Given `SECURITY.md`, When a reader finds a vulnerability, Then the file names a
      private reporting route and a response expectation, and does not direct them to a public
      issue. _(test: manual)_
- [x] **AC16** — Given `CONTRIBUTING.md`, When a first-time contributor reads it, Then it states the
      `bun run check` gate and the `AGENTS.md` §15 rule that an architecture change needs an ADR
      before code. _(test: manual)_
- [ ] **AC17** — Given the repository after the visibility flip, When a direct push to `main` is
      attempted, Then it is rejected and the change must arrive as a pull request.
      _(test: manual)_
- [ ] **AC18** — Given a pull request whose CI run is red, When merge is attempted by the
      maintainer, Then GitHub blocks it, and no standing bypass actor exists that would let it
      through. _(test: manual)_
- [ ] **AC19** — Given a pull request opened from a fork by someone with no write access, When CI
      runs, Then the check reports on the pull request and the contributor cannot merge it
      themselves. _(test: manual)_
- [ ] **AC20** — Given the public repository, When a commit containing a recognised credential
      pattern is pushed, Then push protection blocks it. _(test: manual)_
- [ ] **AC21** — Given the public repository, When a visitor loads the repository page, Then a
      description and topics are set. _(test: manual)_
- [x] **AC22** — Given `.github/dependabot.yml`, When a dependency in `package.json` has a newer
      version, Then Dependabot opens a pull request against `main`. _(test: manual)_
- [x] **AC23** — Given the investigator configured with a live source, When artifact directories
      outside `.data/` are configured, Then it refuses to start, and the README documents that
      refusal as a stated guarantee. _(test: integration)_
- [x] **AC24** — Given the published repository, When a reader looks for a headline score, Then none
      is quoted anywhere, and the benchmark section explains what the scenarios measure instead.
      _(test: manual)_
- [x] **AC25** — Given `docs/roadmap.md` after Phase 2, When a reader looks for work the project has
      already delivered, Then every such section names the PRD that closed it in its opening rather
      than its closing lines, and no section describes code that is absent from the tree.
      _(test: manual)_
- [x] **AC26** — Given `docs/roadmap.md` after Phase 2, When its sections are compared against the
      version before Phase 2, Then none has been added, removed, reordered or reprioritised, and
      every change is a correction of fact — the §3 fence holds. _(test: manual)_
- [x] **AC27** — Given the README, When an operator who wants to use their own tenant reads it from
      the top, Then Track A and Track B are named before either is described, Docker appears only in
      Track B's prerequisites, and no tenant path sits under a heading that calls it an "other"
      workflow. _(test: manual)_
- [ ] **AC28** — Given a clean machine with Bun, a model key and a consented Defender app
      registration, When a reader follows Track A only, Then they reach a completed investigation
      against their tenant without installing Docker, starting the emulator, or running
      `data:bootstrap`. _(test: e2e)_
- [x] **AC29** — Given the README after Phase 2, When its length is measured, Then it is no longer
      than it was before this PRD (543 lines), every section added is paid for by one removed, and
      no passage duplicates `.env.example`, `docs/defender-setup.md` or `docs/README.md` rather than
      linking to it. _(test: manual)_

`manual` marks the release gates that are repository state rather than program behaviour — a
licence file, a GitHub setting, a rewritten history. They are checked once, at the phase exit that
owns them, and most reduce to a single command named in the criterion.

## 9. Open questions

- ~~**The answer key is public once the repository is.** `fixtures/scenarios/` holds the verdicts,
  the discriminating evidence and the traps in plain text. Publishing it is what makes the benchmark
  usable by a stranger, and is also what erodes it.~~ **Resolved 2026-09-22** — accepted by the
  user; a benchmark a stranger cannot read is not one they can use. Recorded in §4.2. The
  alternative, a held-back private scenario set scored on request, is a different project and is not
  proposed here.
- ~~**Whether the `-poc` rename happens at all**, and to what.~~ **Resolved 2026-09-22** — the name
  is **Isophase** (§4.1.10), cleared on npm, GitHub and domains in §4.4. Phase 5 remains droppable
  on timing, but the candidate is no longer open.
- ~~**Whether a second maintainer is named in `CODEOWNERS`.**~~ **Resolved 2026-09-22** — required
  approvals are zero while there is one maintainer (§4.1.9), so the question does not arise until a
  second one exists. The gate that holds is the required CI check, which binds the maintainer too.
- ~~**How a non-developer gets from the repository page to a working investigation.**~~ **Resolved
  2026-09-22** — two tracks, §4.1.11, neither a subset of the other. Track A already works and needs
  no Docker (§4.4); Track B is the existing lab. The packagings considered and dropped: a container
  image does not help, because the emulator is already a container and the barrier is the host VM
  configuration beneath it; a compiled binary removes only `curl -fsSL bun.sh/install`, the cheapest
  step there is; and demo artifacts are dropped by §4.1.12. A `bun run setup` preflight for Track B
  remains available but is no longer load-bearing, because the reader who does not want Docker is
  now told, at the top, that they do not need it.

  Note for whoever writes Track A: the slow step is not this software. It is the Entra app
  registration and the admin consent in `docs/defender-setup.md`, which is a tenant-administrator
  task with its own latency. AC28 states no time bound for that reason.
- ~~**Whether the three local `refs/t3/checkpoints/*` refs are pruned before the flip.**~~
  **Resolved 2026-09-22** — out of scope. They are coding-agent snapshots local to one working copy,
  and an ordinary `git push` does not carry them.

Every question this PRD opened is now closed.

## 10. References

- [ADR 008 — The comparability record](./adr/008-comparability-record.md) §8 (the decision this PRD
  reverses, the append-only rule, and the rejected `fixtures/baseline-runs/`)
- [ADR 011 — Multi-source security data](./adr/011-multi-source-security-data.md) §13 ("Any active
  live-tenant source forces the whole run under `.data/`"), §11 (standalone Defender is unscored by
  construction)
- [`AGENTS.md`](../AGENTS.md) §5 (repository shape), §15 (when to stop and ask)
- [`fixtures/scenarios/README.md`](../fixtures/scenarios/README.md) — the scenario reference a
  public benchmark section points at
- [`fixtures/telemetry/SOURCE.md`](../fixtures/telemetry/SOURCE.md) and
  [`LICENSE`](../fixtures/telemetry/LICENSE) — the vendored telemetry's provenance and terms

## 11. Amendments

- **A1 — 2026-09-22 — the history rewrite is dropped; `runs/` is untracked at `HEAD` only.** Asked
  for in chat, after the rewrite had been rehearsed on a mirror clone and its cost reported: "yeah
  fuck that, we wont do a complete rewrite". The rehearsal showed that removing files from a commit
  invalidates its signature, so every one of the 74 commits from the first corpus commit onward
  would be re-created unsigned, every clone would need resetting, an open pull request would be
  rebased, and the pre-rewrite objects would stay fetchable from GitHub's pull-request refs until
  Support purged them — all to remove one internal hostname, since the 48 artifacts hold Training
  Lab mock data (§4.2). Falsifies §4.1.3, the §4.3 rewrite paragraph, Phase 2's rewrite clause and
  its exit line, the §6 first row, the §7 pointer item, AC5 and AC8 — all struck in place. AC9 is
  kept and reworded, since the original pointers resolve unchanged. Goal 1 is narrowed. ADR 012
  records the decision and the rehearsal evidence.
