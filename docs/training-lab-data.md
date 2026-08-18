# Training Lab Telemetry — Source Reference

Supporting reference for [ADR 001](./adr/001-training-lab-kusto.md), which defers the
built-in/custom table mapping to "an implementation spike". This document is the
result of that spike. It is input to PRD-1 Phase 2 (the bootstrap loader).

Verified against `Azure/Azure-Sentinel` on 2026-08-18.

## 1. There are two Training Labs — use the new one

| Path | Use |
|---|---|
| `Tools/Microsoft-Sentinel-Training-Lab/` | **Yes.** Added 2026-03-17, actively maintained, ingests into real built-in table names |
| `Solutions/Training/Azure-Sentinel-Training-Lab/` | No. Legacy, frozen since 2024-01-11, lands everything in `_CL` tables via the old Data Collector API |

There is no standalone `Azure/Azure-Sentinel-Training-Lab` repository; that name only
resolves to third-party forks.

## 2. Pinned revision

```text
da6d06ffc59dd3eb1e7a2d58c401c2af2da79eeb   (2026-04-20)
```

This is the most recent commit touching `Artifacts/Telemetry`. Pin to it rather than
`master`, which churns daily from unrelated connector PRs.

```text
https://raw.githubusercontent.com/Azure/Azure-Sentinel/<sha>/<path>
```

Note that the upstream ARM templates hardcode `master` in `_artifactsLocation` and
`primaryScriptUri`. Anything that reuses them verbatim is unpinned by construction.

## 3. Telemetry inventory

All plain CSV with a header row. No archives, no embedded JSON. ~10.4 MB total.

`Artifacts/Telemetry/BuildIn/` → built-in table names (~9.24 MB):

| File | Rows | Cols | Table |
|---|---|---|---|
| `SecurityEvents.csv` | 23,864 | 20 | `SecurityEvent` |
| `CrowdStrikeDetections.csv` | 54 | 123 | `CrowdStrikeDetections` |
| `CommonSecurityLog.csv` | 149 | 64 | `CommonSecurityLog` |
| `CrowdStrikeAlerts.csv` | 53 | 40 | `CrowdStrikeAlerts` |
| `AWSCloudTrail.csv` | 47 | 33 | `AWSCloudTrail` |
| `GCPAuditLogs.csv` | 25 | 26 | `GCPAuditLogs` |
| `CrowdStrikeHosts.csv` | 8 | 93 | `CrowdStrikeHosts` |
| `CrowdStrikeVulnerabilities.csv` | 10 | 29 | `CrowdStrikeVulnerabilities` |
| `CrowdStrikeCases.csv` | 1 | 30 | `CrowdStrikeCases` |

`Artifacts/Telemetry/Custom/` → `_CL` tables (~1.12 MB): `AzureActivity_CL` (325 rows),
`OfficeActivity_CL` (266), `azureActivity_adele_CL` (23), `sign-in_adelete_CL` (56),
`OktaV2_CL` (36), `MailGuard365_Threats_CL` (41), `AuditLogsHunting_CL` (5),
`disable_accounts_CL` (4), `SEG_MailGuard_CL` (5), `office_activity_inbox_rule_CL` (2),
`model_evasion_detection_CL` (4), `solarigate-beacon-umbrella_CL` (1).

Note the hyphens in `sign-in_adelete_CL.csv` and `solarigate-beacon-umbrella_CL.csv`:
Kusto rejects `-` in identifiers, so the loader maps them to `_` for the table name.

`SecurityEvents.csv` EventID distribution — useful for scenario selection:
`4625`×18,163 · `8002`×1,547 · `4688`×1,489 · `4662`×760 · `5379`×545 · `5058`×425 ·
`5061`×425 · `4624`×93 · `4672`×85 · `4798`×82 · `4663`×62 · `4627`×51 · `4799`×48 ·
`4634`×27 · `4702`×19.

**No `SecurityAlert` sample data exists anywhere in either lab.** Mock alert fixtures
(PRD-1 §4.2) must be authored by us and correlated to this telemetry by hand.

## 4. Column schemas

- **Connector-defined tables**: typed schemas exist in-repo at
  `.script/tests/KqlvalidationsTests/CustomTables/*.json`
  (`{"Name": ..., "Properties": [{"name":..., "type":...}]}`), but coverage is thin.
  Rechecked at the pinned revision on 2026-08-18: of the 21 lab files only
  **`GCPAuditLogs.json`, `OktaV2_CL.json` and `MailGuard365_Threats_CL.json`** are
  present. There is **no `CrowdStrikeAlerts.json`** — the nearest names are
  `CrowdstrikeReplicator.json` and `CrowdStrikeFalconEndpointProtection_KqlValidation.json`,
  which describe different tables. Types are therefore inferred from the data by
  `scripts/generate-telemetry-manifest.ts` and committed for review.
- **Microsoft built-in tables** (`SecurityEvent`, `CommonSecurityLog`, `SigninLogs`,
  `OfficeActivity`, `AuditLogs`, `AzureActivity`, `AWSCloudTrail`): **not in the repo**.
  Use the Microsoft Learn `azure-monitor/reference/tables/<name>` pages.
- The CSVs are column *subsets*. `SecurityEvents.csv` carries 20 of `SecurityEvent`'s
  ~230 columns. Decide deliberately whether Kusto tables mirror the full Sentinel
  schema (heavy null-padding) or only the columns present.

## 5. Timestamps — the important one

The upstream loader (`Artifacts/Scripts/IngestCSV.ps1`) emits
`source | extend TimeGenerated = now()` and projects away the CSV's own time column.
**Every row is re-stamped to ingestion time; the lab's apparent recency is manufactured
at load.**

The original event time is still in the data: `SecurityEvents.csv` carries
`TimeCollected [UTC]` spanning **2021-04-16 08:34:04 → 09:33:42 UTC** (~60 minutes).

ADR 001 says not to rewrite timestamps by default and to first check whether scenarios
work with explicit time windows from the alert fixture. That guidance holds, and this
is where it gets decided. Since we control both the loader and the alert fixtures, the
cleanest option is to preserve original timestamps and have fixtures carry matching
absolute windows — leaving `ago()`/`now()`-style agent queries to be handled only if
they prove necessary.

## 6. Normalization the loader must handle

- Portal-export suffixes in headers: `TimeGenerated [UTC]`, `TimeCollected [UTC]`,
  `EventSubmissionTimestamp [UTC]`.
- UTF-8 BOM on the legacy CSVs — read as `utf-8-sig`.
- Trailing-underscore disambiguation: `UserId` + `UserId_`, `ClientIP` + `ClientIP_`.
- Type-split columns in sign-in data: `DeviceDetail_dynamic` / `DeviceDetail_string`,
  and the same for `ConditionalAccessPolicies`, `Status`, `MfaDetail`.
- **Inconsistent datetime formats across files**: `10/02/2026 11:00:12`,
  `02/10/2026 10:23:22`, `2026-02-08 09:12:34Z`, and legacy US
  `4/16/2021, 9:09:00.730 AM`. DD/MM vs MM/DD for the `10/02/2026` files is
  **unconfirmed** — resolve empirically before ingesting, and fail loudly on ambiguity.
  *Resolved 2026-08-18*: see the per-file table in ADR 001. `CrowdStrikeHosts.FirstSeen`
  (`24/11/2025`) and `CrowdStrikeVulnerabilities.CreatedTimestamp` (`25/01/2026`) are
  impossible month-first, proving DD/MM for the CrowdStrike files; `MailGuard365_Threats_CL`
  has no such anchor and is declared MM/DD, guarded by an expected-window assertion.
- Files with no timestamp column at all: `AuditLogsHunting_CL.csv`,
  `disable_accounts_CL.csv`, `model_evasion_detection_CL.csv`.
  (`office_activity_inbox_rule_CL.csv` was previously listed here in error — it has
  no `TimeGenerated`, but does carry `ElevationTime [UTC]` and `Start_Time [UTC]`.)
- Nine `Custom/` files are byte-identical to their legacy counterparts (same blob SHAs).

## 7. Licensing

`Azure/Azure-Sentinel` is **MIT** (single repo-root `LICENSE`; no separate or more
restrictive license under either lab tree).

MIT permits redistribution with attribution, so **vendor the CSVs rather than
downloading at bootstrap**. *Done 2026-08-18*: all 21 files live under
`fixtures/telemetry/`, verified byte-identical to the pinned revision via
`git hash-object`, with the upstream `LICENSE` and a per-file `SOURCE.md` manifest. Vendoring pins content exactly, avoids GitHub API rate
limits, and avoids the `master`-tracking drift baked into the upstream templates.
Retain the MIT text and a `SOURCE` note recording repository and SHA.

MIT does not grant rights to the Microsoft/CrowdStrike/Okta/Cisco trademarks appearing
in the sample data. Content is synthetic (`contoso`-style identities), though the CSVs
have not been exhaustively audited for stray real identifiers.
