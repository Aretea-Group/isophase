# ADR 001 — Use Microsoft Sentinel Training Lab Telemetry with Kusto Emulator

**Status:** Accepted  
**Date:** 2026-08-18  
**Amended:** 2026-08-18 — table schema fidelity, timestamp/date-format findings, and
the initial scenario constraint, after measuring the telemetry at the pinned revision.
Supporting detail: [`../training-lab-data.md`](../training-lab-data.md).  
**Amended:** 2026-08-18 — ingestion mechanism, column-name normalization, and four
factual corrections, after implementing the loader (PRD-1 §4.1).

## Context

The SOC investigation agent needs a realistic but deterministic security-data environment before the agent itself is implemented.

The environment must support:
- realistic security telemetry;
- KQL;
- multiple investigation paths;
- local/CI execution;
- reproducible tests;
- no mandatory Azure tenant.

A custom fake KQL interpreter would create a test environment biased toward queries anticipated by the implementation team.

## Verification

Microsoft’s Sentinel Training Lab is built around prerecorded telemetry that is deployed into a Sentinel workspace for hands-on investigation exercises.

The current Training Lab repository exposes representative telemetry and exercises covering tables such as `CommonSecurityLog`, `AWSCloudTrail`, `CrowdStrikeDetections`, `CrowdStrikeAlerts`, `OktaV2_CL`, and `SecurityEvent`.

Microsoft’s Kusto Emulator:
- is distributed as a Linux Docker container;
- exposes the Kusto query engine over HTTP;
- is intended for local development and automated testing;
- can ingest local files with ingestion commands such as `.ingest into table`;
- does not require Azure provisioning.

Therefore the lab telemetry can be used as source data for the local emulator, provided we create the required tables/schemas and execute ingestion commands.

“Directly load” does **not** mean zero transformation or zero bootstrap logic. Kusto does not automatically infer and materialize a Sentinel workspace from the repository tree.

## Decision

Use:

```text
Pinned Microsoft Azure-Sentinel repository revision
                    |
                    v
Sentinel Training Lab telemetry
                    |
                    v
TypeScript bootstrap loader
                    |
                    v
Microsoft Kusto Emulator
```

Do not:
- deploy Azure merely to obtain the Training Lab data;
- build a custom KQL parser;
- query a moving `master` branch during normal development/CI.

## Bootstrap Responsibilities

The loader must:

1. obtain telemetry from a pinned upstream revision;
2. create the local Kusto database;
3. create required table schemas;
4. ingest the CSV files;
5. verify representative tables/rows;
6. fail loudly on schema or ingestion drift.

The exact built-in/custom table mapping is an implementation spike.

## Table Schema Fidelity

**Decided 2026-08-18.**

The Training Lab CSVs are column *subsets* of the real Log Analytics tables:

| Table | Columns in CSV | Columns in real schema |
|---|---|---|
| `SecurityEvent` | 20 | ~230 |
| `CrowdStrikeAlerts` | 40 | 163 |

**Create only the columns present in the source data.** Do not null-pad tables out to
the full Sentinel schema.

Rationale: `GET /schema` feeds the agent's startup context, and `architecture.md` §7.1
warns that an oversized or noisy schema is a problem to be measured and avoided. A
table of ~210 permanently-null columns is precisely that noise, and invites the agent
to query fields that can never hold anything.

The accepted cost is that an agent may write a real Sentinel column name that does not
exist here and receive a Kusto error. That is acceptable, and partly desirable: PRD-1
§4.4 requires real query errors to reach the agent so it can correct itself.

Two obligations follow:

1. Derive the schema response from Kusto itself (`.show database <db> schema`) rather
   than from a hand-maintained list, so it cannot drift from what is queryable.
2. Map `TimeCollected [UTC]` → `TimeGenerated` for `SecurityEvent` during load. The CSV
   has no `TimeGenerated` column, and essentially every realistic KQL query filters on
   it.

Revisit only if measurement shows agents failing primarily because of absent columns
rather than absent data.

## Determinism

The pinned Microsoft commit/ref is part of the test fixture version.

An upstream update is an explicit dependency upgrade:
1. change the pin;
2. rerun bootstrap;
3. review schema/data changes;
4. rerun integration tests;
5. update fixture alerts if needed.

## Timestamp Handling

**Amended 2026-08-18** after measuring the telemetry at the pinned revision. The
original guidance stands; the findings below make it concrete.

Do not rewrite timestamps by default.

Preserve the original event times and give each alert fixture an **absolute** time
window matching its data. This keeps relative event ordering, which is what an
investigation actually reasons about.

If natural agent behavior turns out to depend heavily on `ago()` / `now()`, add a
deterministic timestamp-shift phase to the loader that preserves relative spacing,
applied per era. This remains an optimization, not an initial requirement — let the
need be observed before building it.

Note that the upstream loader does the opposite: `IngestCSV.ps1` emits
`source | extend TimeGenerated = now()` and projects away the CSV's own time column.
The lab's apparent recency is manufactured at load, and relative timing is destroyed.
We deliberately do not copy that behaviour.

### The telemetry spans two eras

Measured from the CSVs at the pinned revision:

| Table | Real time range |
|---|---|
| `SecurityEvent` | 2021-04-16 08:34:04 → 09:33:42 UTC (~60 min) |
| `OfficeActivity_CL` | 2021-04-28 14:28 → 15:13 |
| `CrowdStrikeAlerts` | 2026-02-06 14:46 → 18:42 |
| `SEG_MailGuard_CL` | 2026-02-08 |
| `CommonSecurityLog` | 2026-02-10 10:39 → 11:18 |
| `AWSCloudTrail` | 2026-02-10 11:00 → 11:37 |
| `OktaV2_CL` | 2026-02-10 10:23 → 11:21 |

| `solarigate-beacon-umbrella_CL` | 2019-09-12 20:00:00 (single row) |

The 2021 files are the legacy-lab lineage; the 2026 files are the new connector tables.
`solarigate-beacon-umbrella_CL` is a third era of one row, five years before the rest —
it correlates with nothing and is loaded only for completeness.

**Consequence:** with original timestamps preserved, no investigation can correlate
`SecurityEvent` against `CommonSecurityLog` / `OktaV2_CL` / `AWSCloudTrail` — they are
roughly five years apart. A scenario must live entirely within one era. Windows-log
scenarios sit in 2021-04-16; cross-source scenarios sit in 2026-02-06 → 02-10.

### Date formats are inconsistent per file

The CSVs do not share one date convention. Resolved using `SEG_MailGuard_CL.csv`,
which carries unambiguous ISO `2026-02-08` as an anchor:

| File | Literal | Convention | Resolves to |
|---|---|---|---|
| `CommonSecurityLog`, `AWSCloudTrail`, `OktaV2_CL` | `10/02/2026` | DD/MM | 10 Feb 2026 |
| `CrowdStrikeAlerts` | `06/02/2026` | DD/MM | 6 Feb 2026 |
| `MailGuard365_Threats_CL` | `02/10/2026` | **MM/DD** | 10 Feb 2026 |
| `SecurityEvents`, `OfficeActivity_CL` | `4/16/2021, 8:34:04.098 AM` | US M/D/YYYY | 16 Apr 2021 |

Applying either convention globally scatters the files across eight months. Applied
per file, everything clusters into 6–10 February 2026, which is clearly the intended
scenario window.

**The loader must therefore parse dates per file and assert that parsed values land in
the expected window.** A global assumption fails silently: no error, no crash, records
placed months away, and an investigation that finds nothing. This is exactly the class
of drift this ADR requires the bootstrap to fail loudly on.

## Initial Scenario Constraint

**Recorded 2026-08-18.** Scenario selection belongs to PRD-1, but two properties of the
telemetry constrain it architecturally and are recorded here.

**No `SecurityAlert` data exists** anywhere in either Training Lab. Alert fixtures must
be authored by us and correlated to the telemetry by hand. This is why PRD-1 lists
alert fixtures as our own artifact rather than upstream content.

**A scenario cannot span the two eras** described under Timestamp Handling.

The first scenario is the `SOC-FW-RDP` brute force, verified from the data:

| Property | Value |
|---|---|
| Host | `SOC-FW-RDP` — 12,661 events |
| Failed logons (4625) | 11,970 |
| Window | 2021-04-16 08:34:04 → 09:33:42 UTC |
| Distinct accounts targeted on the host | 257 |
| Distinct accounts targeted dataset-wide | 470 (`\ADMINISTRATOR` 10,255, `\admin` 1,989, `\administrator` 1,864, …) |
| Successful logons (4624) on host | 10 — all `NT AUTHORITY\SYSTEM` |
| Accounts with both a failure and a success, dataset-wide | **0** |

The attack failed completely. This makes it a genuine triage problem rather than a
foregone conclusion: the alert looks severe, the correct verdict is reachable only by
querying, and it requires at least two distinct queries — characterise the failures,
then test whether any targeted account ever succeeded.

The alert fixture must not state the outcome. It reports failed logon attempts and
nothing about success; the expected verdict lives in hidden scenario metadata
(PRD-1 §5). An agent that concludes "12,000 failures means compromise" must be able to
get it wrong.

## Ingestion Mechanism

**Decided 2026-08-18**, after measuring both candidates against the emulator.

Use `.ingest inline`, one command per table (chunked only if a table ever exceeds
~4 MB of encoded CSV).

The alternative was mounting a host directory into the container and using
`.ingest into table T (@"/staging/T.csv")`, which Microsoft documents as supported
("Data can be ingested from local files, external tables, or external data").
Inline won on measurement and on coupling:

| | Result |
|---|---|
| `SecurityEvent`, 23,864 rows / 4.1 MB, single inline command | HTTP 200 in **~0.22 s** |
| Full bootstrap, 21 tables / 24,979 rows / 1,133 columns | **~1.7 s** |
| Quoted fields with embedded newlines (3,228 in `SecurityEvents.csv`) | round-trip **exactly** |
| Doubled quotes, commas inside quoted fields | round-trip **exactly** |

The decisive point is not speed but that inline needs no bind mount. The emulator
stays a black box reachable only over HTTP, the loader behaves identically wherever
it runs, and there is no host-path or filesystem-sharing failure mode to debug.

Ingestion is deliberately sequential. The emulator is single-node and, on Apple
Silicon, runs under x86-64 translation where concurrency has already been observed
to destabilise it; ordering also matters, since a table must exist before it is
filled. At 1.7 s there is nothing to gain from fanning out.

## Column Name Normalization

**Decided 2026-08-18.**

Every column name is coerced to `[A-Za-z_][A-Za-z0-9_]*`.

Kusto's naming rules are narrower than bracket-quoting suggests. Measured against
the emulator: `['Blocked Categories']` and `['Policy Identity']` are accepted, but
`['$table']`, `['Categories/0']` and `['Identity Types/0']` are rejected outright
with "does not comply with naming rules". Nine headers in
`solarigate-beacon-umbrella_CL.csv` fall in the rejected set.

Normalizing all names rather than quoting the survivors keeps one rule instead of
two, and means no generated KQL — and no agent-written KQL — ever needs bracket
quoting to read this data. The generator fails if two source columns ever collapse
onto the same name; none do today.

## Known Upstream Data Defect

The final record of `SecurityEvents.csv` carries 19 of the header's 20 fields,
omitting `RelativeTargetName`. It is a hand-appended row: EventID 1102 ("the audit
log was cleared") on a `pkwork` hostname where the rest of the file is
contoso-style, with the placeholder `EventOriginId` `a1b2c3d4-e5f6-7890-abcd-ef1234567890`.
Confirmed present upstream and reproduced with an independent CSV parser.

The loader right-pads short records but only where the manifest pins the expected
count (`knownShortRows`), so this one is tolerated while any *new* truncation still
fails the bootstrap. Records with **more** fields than the header remain fatal.

## Verification Strategy

Row counts alone prove very little: a column typed too narrowly does not make Kusto
reject the row, it nulls the value and carries on. The bootstrap therefore checks,
in order:

1. per-table row count against the manifest;
2. **per-column populated count** — non-empty values in the CSV versus
   `countif(isnotempty(tostring(col)))` in Kusto, which is what actually catches a
   bad inferred type;
3. the schema Kusto reports (`.show database <db> schema`) against the manifest,
   column by column and type by type;
4. representative scenario queries (the `SOC-FW-RDP` counts above).

All findings are collected and reported together rather than failing on the first,
so one run shows the whole picture.

Note for the future `/schema` route: `.show ... schema` reports CLR type names, and
two are not the obvious guess — `bool` comes back as `System.SByte`, `dynamic` as
`System.Object`.

## Consequences

### Positive
- real KQL engine semantics;
- realistic lab data;
- deterministic local development;
- no Azure cost/dependency;
- future agents can issue unanticipated queries;
- useful query-error behavior.

### Negative
- bootstrap logic is more involved than fixture-only mocks;
- Kusto Emulator is not a complete Sentinel/Log Analytics service;
- table schema mapping may require explicit work;
- emulator has no production-grade authentication/security;
- the emulator image is **amd64-only**, so Apple Silicon development depends on Apple
  Virtualization + Rosetta and requires `DOTNET_EnableWriteXorExecute=0` to remain
  stable. Verified working; measured detail in `infra/kusto/README.md`. Podman is not a
  viable host — it falls back to QEMU, under which the emulator never starts serving;
- the CSVs use inconsistent per-file date formats and span two eras five years apart,
  so the loader carries real normalization responsibility (see Timestamp Handling).

## Alternatives Rejected

### Canned query responses
Rejected because agent autonomy would be constrained to anticipated queries.

### Custom subset KQL interpreter
Rejected because it adds significant complexity while still differing from real Kusto semantics.

### Deploy Training Lab in Azure for every development environment
Rejected because it adds external dependency, credentials, latency, cost, and non-determinism.

### Export from Azure once and maintain our own data set
Not needed as the first approach because Microsoft already provides the Training Lab source telemetry. May be reconsidered only if a specific required table cannot be recreated correctly from the published assets.

## References

- Microsoft Learn — Azure Data Explorer Kusto Emulator overview.
- Microsoft Learn — Install the Azure Data Explorer Kusto Emulator.
- Microsoft Azure-Sentinel repository — Microsoft Sentinel Training Lab.
