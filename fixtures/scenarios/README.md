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

## Artifacts that look like evidence

Three properties of this corpus are products of how it was generated, not
signals. A scenario whose discriminating evidence rests on any of them is
grading the fixture generator rather than the investigation.

**Addresses in the 2026 cloud data are RFC 5737 documentation ranges.** All four
actor addresses in `AWSCloudTrail` and `OktaV2_CL` come from `198.51.100.0/24`
and `203.0.113.0/24`, plus `192.0.2.100` in `CommonSecurityLog` — the ranges
reserved for documentation. Two attackers and two benign users therefore share
/24s by construction, and proximity carries no information. The 2021 tables are
different: they use real allocations throughout, and `175.45.176.99` genuinely
sits in a DPRK block.

**Geolocation fields disagree with each other.** `175.45.176.99` is labelled `KP`
in `disable_accounts_CL` and `IL` in `sign_in_adelete_CL`. Either the country or
the address is wrong; nothing in the corpus says which.

**Wall-clock times move between bootstraps.** The loader shifts the whole dataset
onto a bootstrap-time anchor so relative-time KQL works (ADR 001), preserving
relative spacing but not absolute instants. Describe ordering and elapsed time —
"between StopLogging and DeleteTrail", "inside ninety seconds" — never `08:22`.

Fields that *are* load-bearing, and are checked by the integration tests:
`SessionMfaAuthenticated`, `SessionCreationDate`, `ReadOnly` and `UserAgent` in
CloudTrail; `ResultType` in the sign-in tables; `ActivityStatusValue` in Azure
Activity, where one operation is logged as Start, Accept and Success rows.

## Upstream material deliberately not vendored

The Training Lab ships `Watchlists/known_bad_ips.csv`, which names the 2026
attacker infrastructure outright, and `vip_users.csv`, which labels `mirage` as
the victim. Both are useful for *authoring* a scenario and neither may be loaded
into the database: an agent that can read them does not have to investigate,
which is the same rule that governs this directory.
