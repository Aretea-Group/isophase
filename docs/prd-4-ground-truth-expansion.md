# PRD-4 — Ground-Truth Expansion

**Status:** Complete — no ADR; §11's implementation record is summarised below
**Full text:** `git show 80f9859:"docs/prd-4-ground-truth-expansion.md"` — docs: record PRD-4, the corpus artifacts it surfaced, and alert grouping, 2026-08-19

Six scenarios is not enough ground truth to evaluate against, and the six were not spread well:
`mirage-account-takeover`, `ransomware-srv-dc01` and `phishing-quarantined` are three stages of the
same ten-stage attack chain, so an agent that works out mirage's account was stolen gets all three
right together or misses them together. Half the answer key was measuring one inference. PRD-4
widened it without touching the telemetry — same Training Lab corpus at the pinned revision (ADR
001), more of it turned into scored questions.

`fixtures/scenarios/` now holds fourteen scenarios, each carrying the verdict, the KQL that settles
it, the `discriminatingEvidence` a correct investigation must reach, and the `trap` it was built to
catch. Ground truth still flows one way only, guarded twice — an oxlint `no-restricted-imports` rule
against static imports and `apps/investigator/test/ground-truth-isolation.test.ts` scanning
agent-side source text for the runtime `Bun.file` read no import rule can see. **What changed during
implementation (§11):** the two AWS accounts were corrected from *inconclusive* to *false-positive*
after a live run disagreed with the key and the key turned out to be wrong. The first draft rested
them on /24 adjacency to an attacker, which is an artifact — every synthetic address in the 2026
cloud tables comes from the RFC 5737 documentation ranges, so attackers and benign users share /24s
by construction. Re-verified on `SessionMfaAuthenticated` (true for all 11 sessions of the two
accounts, false for all 30 belonging to `mirage`, `backdoor-svc` and `eve.hacker`), on session
creation dates predating the intruder, on every call being `ReadOnly`, and on upstream's own
`known_bad_ips.csv` excluding both addresses while naming their neighbours. Correcting it moved
`gpt-5.6-terra` from 9/14 to 11/14 and `gpt-5.6-luna` from 10/14 to 9/14 — the right ordering — and
dropped the best constant answer from 14/14 to 12/14 without touching the scorer.

**Superseded non-goals.** §9 records what *this phase* did not do; it does not bind later phases:

- §9 "any change to how runs are scored", and the overlapping-band bug it declined to fix (the
  true-positive band ≥60 and the inconclusive band 30–70 overlap, so a constant 65 satisfies both)
  — fixed in PRD-6 §4.4 / §6.10 and ADR 008 §7.
- §9 "scoring traces or evidence coverage" — still out; `discriminatingEvidence` remains
  documentation for whoever authors and reviews a scenario, and nothing reads `runs/traces/`.
- §9 "new telemetry from outside the Training Lab" — still out; widening past the three verified
  benign identities needs an external dataset and an amendment to ADR 001.
- §9 "benign-true-positive verdicts" — still out; a fourth `ScenarioVerdict` value is only
  meaningful alongside the contract change roadmap §5 owns.
