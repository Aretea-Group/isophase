# PRD-5 — Console as an Operator Surface

**Status:** Complete
**Produces:** ADR 007 — Console control surface
**Reverses:** PRD-3 §4.1 ("the console reads files; it never drives the agent"); ADR 006 §3 (the console may not import the investigator)
**Full text:** `git show d57be75:"docs/prd-5-console-operator-surface.md"` — docs(prd-5): record the overlay rework and three earlier deviations, 2026-08-20

The console could see everything the agent had done and nothing the agent could do next. Starting an
investigation meant leaving the console, typing `bun run investigate --alert <id>` in a second
terminal and switching back to watch a directory poll; choosing *which* alert meant reading a JSON
payload out of `curl`, because the console listed runs and the ~150 alerts with no run against them
were invisible to it. Three consequences were measured rather than assumed: across 37 artifacts,
36 investigated exactly one alert and none investigated more than one; the corpus was barely
explored; and the most common human correction — *this host is a scanner*, *that account belongs to
a contractor who left* — had nowhere to go.

`InvestigationControl` is the seam that fixed it: the console imports the investigator and drives it
in-process, which `docs/research-console-write-path.md` had recommended against (it argued for
spawning the CLI) and §5.1 overrode with its reasons. The queue is a derived view over the alert
surface, never a store — PRD-5 §7's ids-only scenario map marks which alerts have ground truth
without revealing the scenario id, §14 gives the console its single network primitive, and archiving
returns an alert to the queue without deleting a measurement. It records `config.analystContext`,
`derivedFrom` and run-level failures, and interprets none of them (§4.5); PRD-6 is what reads them.
ADR 007 records why importing the investigator was allowed after ADR 006 §3 forbade it.

**Superseded non-goals.** §17 records what *this phase* did not build; it does not bind later
phases:

- §17 "benchmarking, and the ground-truth architecture behind it" — built in PRD-6 (ADR 008), which
  also deletes §4.5's three-line defensive skip and replaces it with the real design.
- §17 "a queue store" — still excluded; the queue stays a derived view (§4.2). Analyst triage state,
  if ever wanted, is an additive side file in the pattern `feedback/` sets.
- §17 "a web UI or an HTTP API" — still excluded; `InvestigationControl` is shaped so one is cheap
  later, and none is built.
- §17 "cross-investigation memory" — still excluded; Flow 4 records and does not consume. Roadmap §1.
- §17 "sweeps from the console" — still excluded; one alert per start.
- §17 "conversation resumption", `steer()` / `followUp()`, Pi's `AgentHarness` — still excluded;
  `AgentHarness` throws `HarnessNotImplemented` for every method at the pinned 0.84.2, which is
  still the pin. Re-check on upgrade.
- §17 "alert grouping / dedupe" — still excluded; `vendorOriginalId` is broken in the vendored CSV.
