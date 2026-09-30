# PRD-9 — Open-source release readiness

**Status:** Complete — see `docs/adr/012-run-corpus-leaves-version-control.md` for the reversed decision (§4.1.3, amendment A1)
**Produces:** ADR 012 — The run corpus leaves version control
**Reverses:** ADR 008 §8 ("the corpus enters version control")
**Full text:** `git show 6a49177:"docs/prd-9-open-source-release-readiness.md"` — chore: rename the project to Isophase (PRD-9 Phase 5), and carry the three unproven criteria to the roadmap (A2), 2026-09-30

The repository was private, unlicensed and unprotectable on its plan, with no `.github/` directory,
48 run artifacts committed under a rationale the corpus could not support — not one
`(condition, scenario)` cell reached the three-draw floor — and a name ending in `-poc`. The
benchmark a stranger needs, the Training Lab telemetry and 14 known-answer scenarios, was already
committed; the README did not say so, and told an operator with a real tenant to install Docker first.

Five phases, 2026-09-22 to 2026-09-30. `LICENSE` (MIT, "Aretea Group and contributors") and the
README's licence section. `/runs/` ignored at the root and the corpus untracked, guarded by
`scripts/run-artifacts-ignored.test.ts`; `scripts/evaluate-runs.ts` exits 0 with nothing to score;
README, `AGENTS.md`, `.gitignore`, `.env.example`, ADR 008 §8 and `docs/roadmap.md` corrected to say
so. `.github/` — `workflows/check.yml` running `bun run check` credential-free, `dependabot.yml`,
`CODEOWNERS`, issue and pull request templates, `rulesets/main.json` — with `SECURITY.md` and
`CONTRIBUTING.md` at the root. The repository public as `Aretea-Group/isophase`, the ruleset applied
(required check, zero approvals, no bypass), secret scanning with push protection, Dependabot alerts
and private vulnerability reporting on. Not built as written: the history rewrite of §4.1.3, reversed
by the user (A1) after a rehearsal showed it would strip signatures from 74 commits — ADR 012.

**Corrected during build.** §4.2 "the committed artifacts contain private alert information" — false;
all 48 hold Training Lab mock data. §4.4 "`evaluate` exits 0 on an empty `runs/`" — it exited 1; AC6
changed it.

**Amendments.** A1 (2026-09-22) dropped the history rewrite — AC5 and AC8 dropped, Goal 1 narrowed.
A2 (2026-09-30) carried AC13, AC28 (clean-machine walkthroughs) and AC19 (fork pull request) to
`docs/roadmap.md` §12. Final tally: 24 ticked, 2 dropped, 3 carried, 0 open.

**Platform facts worth keeping** (§4.4, verified 2026-09-30): rulesets and push protection are free
on a public repository in this organisation and unavailable while private; `git fast-export` strips
commit signatures, so any history rewrite re-creates every rewritten commit unsigned; GitHub's
`refs/pull/*` keep force-pushed-away objects fetchable until Support purges them.

**Superseded non-goals.** §3 records what *this phase* did not do; it does not bind later phases.
Nothing in it has been picked up since:

- §3 "a container image or a release binary" — deferred to `docs/roadmap.md` §11, with the
  `bun build --compile` question that gates it.
- §3 "a CLA or a formal governance model" — parked in `docs/roadmap.md` §12 until a second outside
  contributor appears.
- §3 "publishing to npm", "a hosted demo or a web UI", "reference scores or a leaderboard",
  "re-opening `fixtures/baseline-runs/`", "redacting the Training Lab identities" — all still out.
- §3 "any change to the agent, its connectors, its tools or the scoring logic" — held, bar the one
  exit code above. PRD-10 changed the agent under its own authority, not this one's.
