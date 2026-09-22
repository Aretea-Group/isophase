# ADR 012 — The run corpus leaves version control

**Status:** Accepted
**Date:** 2026-09-22
**Implements:** PRD-9 — Open-source release readiness, §4.1.2, §4.1.3, §4.1.4, §4.1.7
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

2. **The corpus is purged from history, not merely untracked.** Untracking at `HEAD` leaves every
   artifact — and the Tailscale host — readable in a public history, which would make the stated
   reason for removing them false. The rewrite is `git filter-repo --path runs/ --invert-paths`
   over a fresh mirror clone, **range-limited** to the commits from the first one that touched
   `runs/`:

   ```bash
   git clone --mirror <origin> soc-mirror && cd soc-mirror
   git filter-repo --path runs/ --invert-paths --force \
     --refs eb0d480^..main eb0d480^..feat/unattended-investigation refs/tags/prd-8-full-text
   ```

   The range limit is not in PRD-9 §4.3 and is load-bearing. `git fast-export`, which
   `filter-repo` drives, strips commit signatures — 105 of the 113 commits on `main` are
   SSH-signed — so an unrestricted run re-creates *every* commit with a new id, including the 39
   older than the rewrite point, and none of the PRD full-text pointers would survive. Rehearsed
   2026-09-22 on a mirror clone: unrestricted, all 141 commits changed id; range-limited, the 39
   commits before `eb0d480` are untouched and keep their ids and signatures, and the 74 from
   `eb0d480` onward are rewritten. Exactly two commits ever touched `runs/`: `eb0d480` ("chore(runs):
   commit the run corpus and stop ignoring it"), which keeps its `.gitignore` change, and `8247a2c`
   ("Record llama-server compatibility evaluation"), which touched nothing else and is pruned as
   empty.

3. **The four full-text pointers after the rewrite point are re-pointed from the commit map.** PRD
   stubs carry `git show <sha>:"<path>"` lines so that `PRD-N §M` citations resolve through git. Of
   the eight, `211735a`, `80f9859` and `fe28b0c` precede the rewrite point and survive untouched;
   `d57be75` → `01fc71e` (PRD-5), `c43f898` → `cca0770` (PRD-6), `8ad3c2a` → `ae85a84` (PRD-7) and
   `a92e13f` → `3e7048e` (PRD-8) are substituted from `filter-repo/commit-map`. The `prd-8-full-text`
   tag is rewritten in place. The ids are deterministic for the same history and the same command,
   and are confirmed against the real rewrite's map at the Phase 2 exit; a mismatch is a mechanical
   re-substitution, not a decision.

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
- **74 commits lose their signatures.** Every commit from `eb0d480` onward is re-created by the
  rewrite without its `gpgsig` header, because a signature covers the tree and the tree changed.
  They cannot be re-signed by their original authors after the fact. The 39 older commits keep
  theirs. Existing clones must be re-cloned or hard-reset onto the rewritten `main`.
- **GitHub keeps the old objects reachable for a while.** A mirror clone of `origin` carries
  `refs/pull/*/head` for every pull request ever opened, and those refs are server-side: a force
  push rewrites branches and tags, not them. Until GitHub garbage-collects, or is asked to, the
  pre-rewrite commits — and the artifacts in them — remain fetchable by id from
  `github.com/Aretea-Group/soc-agent-poc` even though no branch or tag reaches them. PRD-9 AC5 and
  AC8 are measured on a clone, which does not fetch those refs, so they pass on a clone and are
  incomplete on the server. Closing that gap is a request to GitHub Support to purge cached views
  and unreachable objects, made after the force push and before the visibility flip in Phase 4.

## Rejected

- **Untrack at `HEAD` and leave history alone.** Cheapest, and it would have kept every signature.
  Rejected because it leaves the Tailscale host and 48 artifacts readable in a public history — the
  reason for removing them would be false the moment the repository went public.
- **A curated `fixtures/baseline-runs/`** promoted into by a command, which ADR 008 §8 also
  rejected. Nothing measured since argues for it, and it would reintroduce exactly the class of file
  this decision removes (PRD-9 §3).
- **A `fixtures/demo-runs/` set** so a visitor could open a finished investigation with no credential.
  Considered in PRD-9 §4.1.13 and dropped for the same reason.
- **Rewriting the whole history to keep the recipe simple.** Rejected once the rehearsal showed it
  re-ids all 141 commits and breaks the three full-text pointers that the range limit preserves.

## Testing

- `scripts/run-artifacts-ignored.test.ts` — AC7 (unit): the rule is anchored and both fixture
  directories stay tracked, asserted through `git ls-files` and `git check-ignore`; AC4
  (integration): an artifact written to `runs/<run-id>.json` is ignored and absent from
  `git status`.
- `scripts/evaluate-runs.test.ts` — AC6 (integration): an empty runs directory reports no artifacts
  and exits 0.
- AC5, AC8 and AC9 are repository state after the rewrite, checked once at the Phase 2 exit:
  `git log --all -- runs/` empty, no blob reachable from any ref containing `tail56d848`, and each of
  the eight `git show` pointers resolving to the document it names.

## References

- PRD-9 §1, §4.1.2–§4.1.4, §4.1.7, §4.3, §4.4 — the measurements this decision rests on
- [ADR 008](./008-comparability-record.md) §8 — the decision reversed, kept in place with its text
- [ADR 011](./011-multi-source-security-data.md) §13 — the `.data/` rule for live-tenant artifacts
- `AGENTS.md` §5 — the repository shape after this decision
