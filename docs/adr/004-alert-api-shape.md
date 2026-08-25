# ADR 004 — Alert API Shape and Alert Generation

**Status:** Accepted
**Date:** 2026-08-18
**Amended by:** ADR 010 (the Sentinel alert shape remains the Mock REST contract, not the
investigator contract)

## Context

PRD-1 §4.2 requires alerts over REST. Two facts shaped everything else.

**The Training Lab ships no alerts.** None of the 21 vendored CSVs is a
`SecurityAlert` table. Microsoft distributes raw telemetry; in a real workspace
alerts are *produced*, not ingested as data.

**There are two real "Sentinel alert APIs", and they disagree.** Both are
genuine Microsoft surfaces describing the same alert:

| | ARM REST (`Microsoft.SecurityInsights`, 2025-09-01) | `SecurityAlert` Log Analytics table |
|---|---|---|
| Envelope | `{value:[{id,name,type,kind,properties}]}` | flat rows |
| Casing | camelCase | PascalCase |
| Tactics | `string[]` | comma-delimited `string` |
| Techniques | one list | split across `Techniques` / `SubTechniques` |
| Entities | **absent from the schema** | JSON encoded inside a `string` |
| Remediation | `string[]` | JSON inside a `string` |
| Consumer | REST and SOAR clients | analysts writing KQL |

A mock that picks one and ignores the other is wrong for half its consumers.

## Decision

### Serve ARM, store the table, generate both from one source

`GET /alerts` returns the ARM shape. Phase 4's Sentinel Client is meant to work
against real Azure unchanged (`architecture.md` §2.4), and ARM is what such a
client parses — every field we invented instead would be one it later has to
un-invent.

`SecurityAlert` also exists as a real 35-column Kusto table, because that is
what an analyst — or an agent that has read Sentinel documentation — will query.

Alerts are generated at bootstrap, ingested into the table, and **`/alerts`
projects from the table**. There is no fixture file behind the route. REST and
KQL therefore cannot disagree, which is the same relationship real Sentinel has
between its API and its table.

```text
telemetry in Kusto
      |
      +-- analytics rules (KQL)   --.
      |                              >-- SecurityAlert rows --> ingest --> Kusto
      +-- connector mappers        --'                                       |
                                                                GET /alerts  |
                                                         (project to ARM) <--+
```

### Two documented deviations from Microsoft

1. **URLs are `/alerts`, not the ARM path.** PRD-1 §3 explicitly excludes
   reproducing the subscription/resourceGroup/workspace hierarchy. The `id`
   field still carries an ARM-shaped string so clients that parse it keep
   working.
2. **`properties.entities` exists.** The real ARM alert omits entities entirely
   — they are reachable only through the table or a separate entities call. PRD-1
   §4.2 requires entities on the alert, and they are the most useful thing an
   investigator receives.

### Two alert sources, mirroring Sentinel

**Scheduled analytics rules** run KQL over the telemetry; each result row
becomes one alert with `ProviderName = "ASI Scheduled Alerts"`. **Connector
mappers** translate vendor alert tables (`CrowdStrikeAlerts`,
`CrowdStrikeDetections`, the MailGuard tables) into `SecurityAlert`, preserving
the vendor's own identifiers, severity and MITRE mapping.

Deriving every alert from data means no alert can assert something the telemetry
does not support — the telemetry is what produced it.

Two mapping decisions are lossy and are recorded rather than hidden:

- CrowdStrike's `Critical` folds into `High`; Sentinel has no `Critical`. The
  original is kept in `ExtendedProperties`.
- The mail connectors **exclude `ThreatVerdict == "Clean"`**. Those tables are
  full mail logs — 32 of 46 rows are clean deliveries — and a real mail-security
  connector raises alerts only for adverse verdicts.

### Microsoft's own detection rules were evaluated and rejected

The Training Lab ships 22 authored rules in `Artifacts/DetectionRules/rules.json`,
covering a numbered attack chain. They were vendored, adapted, measured, and then
removed. Recorded here so the evaluation is not repeated from scratch:

| Outcome | Count | Reason |
|---|---:|---|
| Ran only after adaptation | 15 | every rule filters `TimeGenerated > ago(1h)` |
| Needed a rebuilt `Device` column | 6 | rules target the live connector schema; the shipped CSV flattened `Device` into `Device_hostname`, `Device_external_ip`, … |
| Upstream KQL defect | 1 | Stage 3 projects away `Sha256`, then does `extend SHA256 = Sha256` |
| Unusable | 3 | query `PaloAlto_ThreatSummary_KQL_CL` and `DeviceInfo`, absent from the lab telemetry |

The rules also assume the entire lab sits inside one hour, which is only true
because the upstream loader stamps every row with `now()` — the behaviour ADR 001
refuses to copy. Three separate adaptations to run someone else's rules against
data they no longer match was judged worse than owning the rules. **19 local
rules** now cover every source, including the `SecurityEvent` era no upstream
rule touched at all.

### Alert ids are content-addressed and time-independent

`SystemAlertId` is a SHA-256 of the rule identity plus the result row, formatted
as a GUID. Two properties, both learned the hard way:

**Hash the whole row, not selected fields.** Microsoft's Okta rule pairs one
login with each subsequent privilege escalation, emitting rows that share a login
time *and* upstream's `ReportId`. Any hand-picked key collapsed three genuinely
distinct alerts into one.

**Exclude timestamps from the hash.** The loader shifts the dataset onto a
bootstrap-time anchor (ADR 001), so every instant moves between runs. Including
them made every id change on every bootstrap, which broke `/alerts/:id`
stability and any pinned reference. An alert is identified by which rule fired on
what evidence — not by the wall clock. Verified by bootstrapping with anchors
eight months apart and comparing id sets.

Byte-identical rows are collapsed with a log line rather than treated as an
error: identical content is the same detection, not two alerts.

### `POST /query` rejects control commands at the route

Measured against the emulator: `POST /v1/rest/query` **executes control
commands** — `.show databases` returns HTTP 200, and by extension `.drop table
SecurityEvent` would succeed. The route guard is therefore the only boundary, not
defence in depth.

Any query whose first non-comment, non-whitespace character is `.` is refused.
Kusto's query language has no mutating syntax at all; every destructive operation
is a control command and every control command starts with `.`, so this is a
complete boundary rather than a partial one.

It is reported as a normal `query_error`, not a `403`, so a future agent sees an
actionable failure it can correct rather than a special case it must be taught.

## Consequences

### Positive
- A Sentinel Client written against this parses real Azure responses unchanged.
- The same alert is reachable by REST and by KQL, and the two cannot diverge.
- Every alert provably correlates with telemetry.
- `/alerts/:id` is stable across bootstraps, so scenario metadata and tests can
  pin ids — and a changed rule surfaces as a failing test rather than silent drift.
- Destructive KQL cannot reach the engine.

### Negative
- Two representations of one alert, and a projection layer that must stay
  correct; the impedance mismatches are covered by regression tests.
- Rules are ours, so upstream detection improvements do not arrive for free.
- Alert volume tracks the telemetry: 151 alerts today, and a rule change moves
  the ids of the alerts it produces.
- `properties.entities` means a client cannot assume strict ARM equivalence.

## References

- Microsoft Learn — Sentinel security alert schema (`SecurityAlert` table).
- Microsoft Learn — `Microsoft.SecurityInsights` REST API, Incidents - List Alerts.
- Microsoft Learn — Microsoft Sentinel entity types reference.
- [ADR 001](./001-training-lab-kusto.md) — telemetry, timestamps and the time shift.
