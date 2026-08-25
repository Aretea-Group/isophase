# PRD-3 — Analyst Console

**Status:** Complete — see `docs/adr/006-analyst-console.md` for accepted deviations
**Produces:** ADR 006 — Analyst console boundary
**Deviation:** `frontend` was an AGENTS.md §2 non-goal — scoped, not deleted, by ADR 006 §1
**Full text:** `git show fe28b0c:"docs/prd-3-analyst-console.md"` — feat(console): ship PRD-5 operator surface, 2026-08-20

PRD-2 produced good investigations that nobody could read. The agent's work was observable in four
places and none of them answered an analyst's questions: stdout scrolled away, `runs/<runId>.json`
held the verdict and deliberately nothing else, `runs/traces/*.jsonl` held everything at 217 KB to
23 MB per run, and `evaluate` printed scores. *What is it doing right now, which tables did it look
at, what did it search for, what did this cost* were answerable only by grepping multi-megabyte
JSONL by hand.

`apps/console` is the answer, and its shape is the argument: `src/view/` holds pure view models with
no renderer import, `src/ui/` is the only code that knows OpenTUI exists, and the console was
read-only by construction — it read `runs/` and wrote nothing. ADR 006 records why a TUI rather than
the web frontend AGENTS.md §2 excluded, why the run artifact gained a lifecycle (`status`,
`traceDir`, `config`, flushed per alert so an in-flight sweep is readable), and why ground-truth
scoring stays in `scripts/` (§5) — the console must be able to open a two-week-old run with no
provider key for a model it will never call. PRD-5 later reversed the read-only half; everything
about the view/render split survived it.

**Superseded non-goals.** §14 records what *this phase* did not build; it does not bind later
phases:

- §14 "starting, stopping, aborting or re-running investigations" — built in PRD-5 (ADR 007), which
  reverses PRD-3 §4.1 and ADR 006 §3 by name.
- §14 "alert browsing independent of a run", "live Mock Sentinel queries" — built in PRD-5 §14; the
  console now has exactly one network primitive, `apps/console/src/data/alerts.ts`.
- §14 "ground-truth scoring or expected-vs-actual comparison", "cross-run diffing", "regression
  dashboards" — built in PRD-6 (ADR 008), and deliberately in `scripts/`, not in the console. What
  the console gained is PRD-5 §7's ids-only scenario map: a ◆ marks an alert with ground truth
  behind it and the scenario id is never shown.
- §14 "ad-hoc KQL execution" — still excluded, and `data/alerts.ts` cites §14 as the reason.
- §14 "trace database" — never built; ADR 005 §2 stands.
- §14 "web frontend", "network service", "authentication/RBAC", "multi-user or remote access",
  "export or reporting", "persistent console state", "cross-investigation memory" — still out of
  scope. "analyst TP/FP feedback capture" is roadmap §2; PRD-5's `config.analystContext` records
  steering, which is not a verdict correction.
