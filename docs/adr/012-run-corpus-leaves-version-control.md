# ADR 012 — The run corpus leaves version control

**Status:** Accepted
**Date:** 2026-09-22
**Implements:** PRD-9 — Open-source release readiness, §4.1.2, §4.1.4, §4.1.7, §11 A1 (which reversed §4.1.3)
**Reverses:** [ADR 008](./008-comparability-record.md) §8 ("**And the corpus enters version
control.** `/runs/` leaves `.gitignore`; `/runs/traces/` replaces it. The run artifacts and their
archive are committed") — the paragraphs from that sentence to the rejected `fixtures/baseline-runs/`
**Amends:** `AGENTS.md` §5 (`runs/` was listed as a committed repository root, with the rationale that
`evaluate` "must score the same corpus from a fresh clone"); `README.md` §"Run the investigator
directly" ("**Run artifacts are committed.**"); `.gitignore` (the comment block arguing the corpus is
deliberately not ignored); `scripts/evaluate-runs.ts` (no artifacts on disk exits 0, not 1)
**Extends:** ADR 011 §13 (the `.data/` rule for live-tenant artifacts is unchanged and is now the
*only* place run output is meant to live outside an ignored directory — nowhere)

## Context

ADR 008 §8 put the run corpus into version control on 2026-08-20, for a reason that was true when it
was written: a run artifact is a measurement bought with real money against a model that exposes no
seed, so it cannot be re-derived, and a benchmark that cannot be reproduced from a fresh clone is not
a benchmark. Committing the artifacts made the corpus portable and made removing a measurement
visible as a diff.

Two things changed after that decision, and a third was measured against it.

**The repository is being published.** PRD-9 exists to make it public. A run artifact is the
system's *output* — what the agent concluded, about which alert, with which evidence — and since
PRD-7 and PRD-8 the investigator runs against live Microsoft Sentinel and Defender tenants, where
that output carries real alerts and real identities. ADR 011 §13 keeps those runs under ignored
`.data/`, and the discipline held: every one of the 48 committed artifacts was inspected on
2026-09-22 and every one holds Training Lab mock data, none produced by the `azure` or `defender`
connector. But one committed artifact records `https://evo-x2-icarus.tail56d848.ts.net/v1` in
`config.modelBaseUrl` — a private Tailscale host on the maintainer's network. That is the class of
detail a public history must not carry, and it is there because the rule was "commit the
artifacts", not "commit the artifacts after checking them".

**The corpus is not the benchmark it was committed to be.** Measured 2026-09-22: 48 artifacts,
210,746 bytes, spanning 14 scenarios and 10 conditions. `bun run evaluate` reports `n>=3 0/9`,
`0/8`, `0/6`, `0/6`, `0/2`, `0/1`, `0/1` and three conditions with no scoreable draws at all —
**not one `(condition, scenario)` cell reaches the three-draw floor** that ADR 008 §7 and the README
name as the point at which a repeat means anything. Eight of the ten conditions record no
`promptHash`, `submissionHash`, `piVersion` or `corpus` hash, so they cannot be compared to anything
the current harness produces. The portable baseline ADR 008 §8 wanted to protect is 206 KB of
under-powered measurement that nobody can quote.

**What a public reader needs is already committed and is not this.** `fixtures/telemetry/`
(Microsoft's Training Lab telemetry, MIT) and `fixtures/scenarios/` (14 scenarios with their
verdicts, discriminating evidence and traps) are the benchmark *input*: what an agent is tested on.
The artifacts are what *our* agent said. A stranger benchmarking their own agent needs the first and
never the second.

## Decision

1. **The benchmark ships; our measurements do not.** `fixtures/telemetry/` and `fixtures/scenarios/`
   stay committed exactly as they are. `runs/`, `runs/.archive/` and `runs/traces/` leave the
   repository: `.gitignore` gains `/runs/` anchored at the root, replacing `/runs/traces/`. The anchor
   matters — unanchored, `runs` matches any directory of that name at any depth and silently
   excludes the committed test fixtures under `apps/*/test/fixtures/runs/`, which PRD-3 §12 hit
   once. `scripts/run-artifacts-ignored.test.ts` asserts against git itself that the fixtures stay
   tracked and that a freshly written `runs/<run-id>.json` never shows as untracked.

2. **The corpus is untracked at `HEAD`; history is left alone.** PRD-9 §4.1.3 decided the opposite
   — purge `runs/` from history so that neither the artifacts nor the Tailscale host stay readable
   once public — and the user reversed it on 2026-09-22 (PRD-9 §11 A1) after the rewrite had been
   rehearsed and costed. What the rehearsal found, and why it was not worth paying, is under
   *Rejected* below. The consequence accepted instead: the 48 artifacts, all Training Lab mock data,
   and one internal hostname in `config.modelBaseUrl` of a single artifact, remain in the history a
   public reader can see. The hostname is reachable only from inside that tailnet.

3. **The eight PRD full-text pointers are unchanged.** `git show <sha>:"<path>"` lines in the stubs
   keep resolving because no commit id moved. Verified on 2026-09-22 for all eight.

4. **`evaluate` treats an empty `runs/` as nothing to do, not as failure.** A fresh clone has no
   `runs/` at all now. `scripts/evaluate-runs.ts` prints `[evaluate] no run artifacts in …` and
   exits 0 where it exited 1. The PRD-6 D7 gate — runs were read and none joined to a scenario —
   still exits 1, because that one distinguishes a corpus edit that orphaned every run from a typo.

5. **No scores are published.** With the corpus gone, any headline number in the repository is
   unverifiable by a reader. The README describes what the benchmark measures and how to run it,
   and quotes no result (PRD-9 §4.1.7).

6. **Everything ADR 008 §8 decided about the working tree stands.** The corpus is append-only inside
   a checkout; `queue:reset` archives rather than deletes and `--purge` needs `--yes`; `evaluate`
   scores `runs/.archive/` too and fingerprints the set it scored. Only "and it is committed" is
   reversed.

## What is knowingly given up

- **A score we quote is no longer checkable by a third party against the artifacts it was computed
  from.** ADR 008 §8's fingerprint over run ids still prints, but the set it names lives on one
  machine. This is the loss ADR 008 §8 was written to prevent, and it is accepted because the set
  was never large enough to quote from (above) and because the alternative publishes live-tenant
  output by default.
- **Removing a measurement stops being visible as a diff.** Append-only inside the working tree is
  now enforced by `queue:reset`'s behaviour and by nothing else. A measurement set that exists on
  one laptop is one disk failure from being bought twice — which is true, and was true of the
  transcripts already.
- **The history still holds the corpus.** Anyone can read the 48 mock-data artifacts and the one
  internal hostname by checking out an old commit. That is the price of keeping 74 signed commits
  signed, and it was taken knowingly (below).

## Rejected

- **Purging `runs/` from history with `git filter-repo`** — PRD-9 §4.1.3 as written. Rehearsed
  twice on mirror clones on 2026-09-22. Unrestricted, `git fast-export` strips every commit
  signature, so all 141 commits were re-created with new ids and none of the eight PRD full-text
  pointers survived. Range-limited to `eb0d480^..main` and the one feature branch, the 39 older
  commits kept their ids and signatures, but the 74 from `eb0d480` onward were still re-created
  unsigned — a signature covers the tree, and the tree changed — and four pointers had to be
  re-mapped from the commit map. On top of that: every clone would need a hard reset, the open
  pull request on `feat/unattended-investigation` would be rebased, Dependabot's branches would be
  recreated, and the pre-rewrite objects would stay fetchable from GitHub's server-side
  `refs/pull/*` until GitHub Support purged them. All of it to remove one tailnet hostname from
  artifacts that hold mock data. Rejected by the user on that evidence (PRD-9 §11 A1).
- **A curated `fixtures/baseline-runs/`** promoted into by a command, which ADR 008 §8 also
  rejected. Nothing measured since argues for it, and it would reintroduce exactly the class of file
  this decision removes (PRD-9 §3).
- **A `fixtures/demo-runs/` set** so a visitor could open a finished investigation with no credential.
  Considered in PRD-9 §4.1.13 and dropped for the same reason.

## Testing

- `scripts/run-artifacts-ignored.test.ts` — AC7 (unit): the rule is anchored and both fixture
  directories stay tracked, asserted through `git ls-files` and `git check-ignore`; AC4
  (integration): an artifact written to `runs/<run-id>.json` is ignored and absent from
  `git status`.
- `scripts/evaluate-runs.test.ts` — AC6 (integration): an empty runs directory reports no artifacts
  and exits 0.
- AC9 is repository state, checked once: each of the eight `git show` pointers resolves to the
  document it names. AC5 and AC8, the post-rewrite checks, were dropped with the rewrite (PRD-9
  §11 A1).

## References

- PRD-9 §1, §4.1.2–§4.1.4, §4.1.7, §4.3, §4.4 — the measurements this decision rests on
- [ADR 008](./008-comparability-record.md) §8 — the decision reversed, kept in place with its text
- [ADR 011](./011-multi-source-security-data.md) §13 — the `.data/` rule for live-tenant artifacts
- `AGENTS.md` §5 — the repository shape after this decision
