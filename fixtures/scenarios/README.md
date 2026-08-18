# Scenario metadata

Evaluation metadata layered over the shared telemetry (PRD-1 §5). One file per
scenario; no telemetry is duplicated.

**These files are the answer key and must never be served over the REST API.**
An agent that can fetch them does not have to investigate. Nothing under
`apps/mock-sentinel/src/routes/` reads this directory, and
`test/scenarios.test.ts` asserts it stays that way.

Each scenario records a starting alert, the evidence that settles it, and the
verdict a competent analyst should reach. `verdict` and `impact` are separate on
purpose: a detection can be entirely correct about real malicious activity that
nonetheless achieved nothing, and conflating the two is the most common triage
error these scenarios are built to expose.

| Field | Meaning |
|---|---|
| `verdict` | Was the detected activity real and malicious? |
| `impact` | Did it achieve anything? |
| `discriminatingEvidence` | The queries that settle it — an investigation that skips these cannot be right except by luck |
| `trap` | The wrong conclusion this scenario is designed to catch |

`startingAlertId` values are content-addressed hashes of the rule output, so
they are stable across bootstraps but change if a rule changes. The integration
test resolves every one of them against the live database, which is what turns
that from a fragility into drift detection.
