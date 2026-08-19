# PRD-4 — Ground-Truth Expansion

**Status:** Complete — §11 records where implementation departed from this draft  
**Depends on:** PRD-2 — Core Investigation Agent  
**Language/runtime:** TypeScript strict mode, Bun  
**Data:** Microsoft Sentinel Training Lab at the pinned revision (ADR 001) — no new telemetry  
**Runtime schemas:** Zod

---

## 1. Purpose

Six scenarios is not enough ground truth to evaluate against, and the six we have are not spread
well.

Three of them — `mirage-account-takeover`, `ransomware-srv-dc01`, `phishing-quarantined` — are the
same incident. Upstream documents the corpus's 2026 telemetry as one ten-stage attack chain, and
those three are stages of it. An agent that works out that mirage's account was stolen gets all
three right together, or misses them together. Half the answer key measures one inference.

Meanwhile the corpus contains a **second, complete attack that has almost no ground truth against
it**. Adele Vance's account is compromised: 53 successful sign-ins from `175.45.176.99`, then
SharePoint permission changes, an anonymous sharing link created on "Contoso Purchasing Data -
Q1.xlsx", and a file deleted. Separately, resources are destroyed across Azure under the same
account name. That entire chain produces exactly one alert today — the disabled-account attempts
against `johns@`, which is the *failed* half of it.

The three tables carrying the rest are queried by no rule and no connector, so nothing raises an
alert on them and no scenario can start there.

One further problem: the existing `disabled-account-signins` scenario states a fact that is wrong.
Its discriminating evidence asserts that `175.45.176.99` "appears nowhere else". It appears 236
times across four tables. That is an incorrect answer sitting in the answer key.

## 2. Product Goal

```text
today       6 scenarios, 4 clusters, 3 of them one incident, 1 with wrong evidence
after       14 scenarios, all 6 clusters, a second attack chain covered, that error corrected
            9 true-positive / 2 false-positive / 3 inconclusive (was 5 / 0 / 1)
```

## 3. What the Corpus Contains

Verified against the live Mock Sentinel instance.

**154 alerts are 101 distinct situations.** `CrowdStrikeAlerts` and `CrowdStrikeDetections` are two
vendor views of the same events — a full outer join on name, host and second returns 53 matched, 0
alert-only, 1 detection-only. 107 alerts describe 54 events.

**Six independent ground-truth clusters exist; four are covered.**

| Cluster | Data | Alerts | Scenarios today |
|---|---|---:|---:|
| 1 · 2026 pkwork attack chain | MailGuard, CrowdStrike, Okta, AWS, GCP, firewall | ~90 | 3 |
| 2 · 2021 Windows | `SecurityEvent`, 23,864 rows / 12 hosts | 3 | 1 |
| 3 · 2021 M365 Adele/John | `disable_accounts_CL` + the three unqueried tables below | 2 | 1 |
| 4 · 2020 SUNBURST | `solarigate_beacon_umbrella_CL`, 1 row | 1 | 1 |
| 5 · buildseccxpninja Azure | `AuditLogsHunting_CL`, `AzureActivity_CL` | 2 | 0 |
| 6 · contoso model evasion | `model_evasion_detection_CL` | 1 | 0 |

**The cluster-3 attack, table by table.** None of these three is referenced anywhere in
`apps/mock-sentinel/src/alerts/`:

| Table | Rows | What it holds |
|---|---:|---|
| `sign_in_adelete_CL` | 56 | adelev, 53 successful sign-ins (`ResultType 0`), all from `175.45.176.99`, 11:01–12:11 on 2021-11-04 |
| `OfficeActivity_CL` | 266 | adelev 143 events (132 from `175.45.176.99`) and johns 77; ends `PermissionLevelAdded` ×3 → `SharingSet` ×3 → `AnonymousLinkCreated` → `FileDeleted` |
| `azureActivity_adele_CL` | 23 | `AdeleV@M365x816222`, all from `37.142.150.162`: Key Vault, resource group, VM, web site, Logic App and connection deletions, plus `SECURITYINSIGHTS/ALERTRULES/WRITE` |

`175.45.176.99` also drives the four failed `johns@` attempts in `disable_accounts_CL` that the
existing scenario is built on.

**Upstream has nothing further.** The pinned revision and current `master` are byte-identical across
all 21 telemetry files, so bumping the pin yields no new data.

## 4. New Analytics Rules

Three rules in `apps/mock-sentinel/src/alerts/rules.ts`, following the shape of the 19 already
there. Each exists so a stage of the cluster-3 attack can start an investigation.

### 4.1 `SOC-RULE-0014-SuspiciousSignInVolume` — `sign_in_adelete_CL`

Fires on an account accumulating successful sign-ins from a single external address.

Triggers on `adelev@m365x816222.onmicrosoft.com` — 53 × `ResultType 0` from `175.45.176.99`.
Threshold: 20 successful sign-ins from one address.

The table carries `CreatedDateTime` (`manifest.ts` declares `dateConvention: "us-long"` with an
enforced window), so the rule can derive a real time window rather than being stamped at ingestion.

### 4.2 `SOC-RULE-0042-AnonymousSharingLinkCreated` — `OfficeActivity_CL`

Fires on `AnonymousLinkCreated`, or on `SharingSet` following `SharingInheritanceBroken` on a
document.

Triggers on adelev for "Contoso Purchasing Data - Q1.xlsx", preceded within seconds by three
`PermissionLevelAdded` and three `SharingSet`, and followed by a `FileDeleted`.

Deliberately event-shaped rather than volume-shaped. A volume rule over this table would fire on
`FileAccessed` and `PageViewed` noise; the sharing operations are the ones that matter.

### 4.3 `SOC-RULE-0026-CloudResourceDestruction` — `azureActivity_adele_CL`

Fires on a caller performing multiple resource deletions in a window. Threshold: 5 successful
deletions. Numbered into the cloud block beside the AWS and GCP rules rather than the `004x`
collaboration block, because that is what it is.

Triggers on `AdeleV@M365x816222.OnMicrosoft.com` — 12 successful deletions across Key Vaults,
resource groups, VMs, web sites, custom APIs, connections and Logic Apps inside about fourteen
minutes, all from `37.142.150.162`.

Rows are `Start` / `Accept` / `Success` triplets for the same operation, so the rule must count
distinct operations rather than rows (see §7).

## 5. New Scenarios

Eight scenario files in `fixtures/scenarios/`, taking the key from 6 to 14. `impact` is a required,
scored field, so every scenario names one.

### 5.1 From the new rules — the cluster-3 attack

| Scenario | Rule | Verdict | Impact |
|---|---|---|---|
| `adele-signin-compromise` | 0014 | true-positive | confirmed-compromise |
| `adele-sharepoint-exfiltration` | 0042 | true-positive | confirmed-compromise |
| `adele-azure-destruction` | 0026 | inconclusive | unknown |

**The three are not the same investigation.** Each starts from different evidence and needs a
different query path: a sign-in volume alert settles on where the address appears elsewhere; a
sharing-link alert settles on what was shared and what happened to it afterwards; a destruction
alert settles on whether the caller normally does this and whether it followed a compromise.

**They must not assume a single actor.** The sign-ins and SharePoint activity come from
`175.45.176.99`; the Azure destruction comes from `37.142.150.162`. Whether that is the same
intruder, the real Adele, or a coincidence is exactly what `adele-azure-destruction`'s
discriminating evidence should ask, not something the fixture asserts.

### 5.2 From alerts that already exist

Alert ids below are stable — an id is `deterministicAlertId(rule.id, canonicalRow(row))`, so adding
the rules in §4 cannot move them.

| Scenario | Alert | Cluster | Verdict | Impact |
|---|---|---:|---|---|
| `app-credential-added` | `8dff45f5-e145-5576-5328-765837705a72` (VadimJ@, 4 credentials via `python/3.8.9 msrest`) | 5 | inconclusive | unknown |
| `model-evasion-attempts` | `6203804c-88ac-f715-e303-a0a837133535` (sarah@contoso.com) | 6 | true-positive | none |
| `aws-backdoor-account` | `b11a4e1c-59b3-75e1-3c95-c068a1548765` (backdoor-svc) | 1 | true-positive | confirmed-compromise |
| `aws-bob-jones-readonly` | `9f7f5623-fb58-6c8c-db3a-094c293e791d` | 1 | false-positive | none |
| `aws-jane-smith-readonly` | `ca236d56-0cb5-d3ed-615c-525e01e2b74b` | 1 | false-positive | none |

`app-credential-added` and `model-evasion-attempts` open clusters 5 and 6, which have no scenarios
today.

`aws-backdoor-account` is the only cluster-1 addition that is a true positive, and it earns its
place on evidence path rather than stage coverage: settling it means noticing the account was
created by mirage 26 minutes earlier and first signs in from mirage's own address
(`198.51.100.42`). No existing scenario tests CloudTrail identity pivoting.

`bob.jones` and `jane.smith` are the answer key's two false positives, and the corpus's only
verified benign identities besides `deploy-svc`. Both sit one host from an attacker address and make
reconnaissance-shaped calls — `DescribeTrails`, `ListUsers`, `GetBucketLogging` — which is exactly
what the fixture was built to make them look like. Four independent signals separate them: every
session is `SessionMfaAuthenticated` where all 30 attacker sessions are not, both sessions predate
the intruder's first event, every API call is `ReadOnly`, and the client is macOS with
`aws-cli/2.15.0` against the attackers' Windows and Linux browsers. The failure they catch is the
agent generalising "this tenant is compromised" onto accounts that did nothing.

## 6. Correcting `disabled-account-signins`

`fixtures/scenarios/disabled-account-signins.json` currently states:

```json
{
  "kql": "union withsource=T disable_accounts_CL, sign_in_adelete_CL, OktaV2_CL | where * has '175.45.176.99' | summarize by T",
  "expected": "Only disable_accounts_CL — the address appears nowhere else"
}
```

The live result is `disable_accounts_CL 4`, `sign_in_adelete_CL 56` — and the address also appears
176 times in `OfficeActivity_CL` and once in `AzureActivity_CL`. The scenario's own query returns
the contradiction.

The `expected` text is corrected, and the impact moves from `none` to `confirmed-compromise`. The
control worked for `johns@` and for no other identity: the same address succeeded 53 times against
`adelev@` and reached an anonymous sharing link on a sensitive document. Closing this alert at
no-impact is the triage failure the scenario now exists to catch, and the old `evaluatorNotes`
recommended exactly that.

Nothing currently checks a scenario's `expected` text against reality, which is how this drifted.

## 7. Constraints

**Kusto Emulator required.** New alerts only exist after a bootstrap. The image is amd64-only; on
Apple Silicon it needs a host providing the Apple Virtualization framework plus Rosetta — QEMU does
not work (ADR 001).

**Rules land before scenarios.** The ids for §5.1's alerts do not exist until §4's rules run, so
scenario authoring is strictly downstream of a bootstrap. The §5.2 ids are already stable and can be
pinned immediately.

**Pins are resolved against the live database** by `apps/mock-sentinel/test/integration/telemetry.test.ts:131`
— not by `test/scenarios.test.ts`, which has no Kusto client. New integration assertions belong in
the former.

**`azureActivity_adele_CL` logs one operation as several rows.** `Start` / `Accept` / `Success`
triplets mean a row count triples a deletion count. §4.3's threshold must count distinct operations.

**The geo labels contradict each other.** `175.45.176.99` is labelled `IL` in `sign_in_adelete_CL`
and `KP` in `disable_accounts_CL`. No scenario's discriminating evidence should rest on the country
field.

**`office_activity_inbox_rule_CL` is a different tenant.** Its rows are
`AdeleV@contoso.OnMicrosoft.com`, not `adelev@m365x816222.onmicrosoft.com`. It is not part of the
cluster-3 chain and no scenario here uses it.

**AGENTS.md §14 has no phase for this work.** The implementation order ends at Phase 7 (PRD-3), and
§14 opens with "Do not skip ahead". PRD-4 reopens Phase 6 evaluation work after Phase 7 shipped, so
it needs a §14 amendment. Per AGENTS.md §15, prefer a small ADR over changing this silently.

**The alert count changes.** "151" and "145" appear in `scripts/evaluate-runs.ts:100`,
`README.md:28`, `docs/roadmap.md`, `docs/prd-3-analyst-console.md` and
`apps/mock-sentinel/src/routes/alerts.ts:39`. All need updating to whatever the bootstrap produces.

**No new telemetry.** Upstream is byte-identical to the pin, so every new alert must derive from the
vendored 21 files unchanged.

## 8. Acceptance Criteria

- [x] **AC1** — Given a bootstrapped database, When alerts are generated, Then each of the three
      rules in §4 emits at least one alert. _(test: integration)_
- [x] **AC2** — Given a bootstrap performed after the new rules land, When scenarios are loaded,
      Then all six pre-existing `startingAlertId` values still resolve to a live alert.
      _(test: integration)_
- [x] **AC3** — Given the expanded scenario set, When it is loaded, Then every `startingAlertId`
      resolves to exactly one live alert. _(test: integration)_
- [x] **AC4** — Given every scenario file, When loaded through `loadScenarios()`, Then all validate
      against the `Scenario` schema, including a `verdict` and an `impact`. _(test: unit)_
- [x] **AC5** — Given `disabled-account-signins.json`, When its second discriminating query is run
      against the database, Then the recorded `expected` text matches the actual result.
      _(test: integration)_
- [x] **AC6** — Given the expanded scenario set, When clusters are counted, Then at least five of
      the six clusters in §3 have a scenario. _(test: manual — reviewed while authoring)_
      **All six are covered:** clusters 5 and 6 had none before and now have one each.
- [x] **AC7** — Given the investigator package, When ground-truth isolation is asserted, Then
      nothing under `apps/investigator/**` can reach `fixtures/scenarios/`.
      _(test: unit, existing)_

## 9. Explicitly Out of Scope

**Any change to how runs are scored.** `scripts/evaluate-runs.ts` keeps its current bands and its
current axes. There is a real one-line bug in them — the true-positive band (≥60) and the
inconclusive band (30–70) overlap, so a constant answer of 65 satisfies both — but fixing it is not
this PRD, and it is noted on the roadmap instead.

**Scoring traces or evidence coverage.** `discriminatingEvidence` stays documentation for whoever
authors and reviews a scenario. Nothing here reads `runs/traces/`.

**New telemetry from outside the Training Lab.** Benign activity is scarce — every rule and
connector filters for adverse conditions, and the tables that looked like baseline turned out to be
the cluster-3 attack. It is not absent, though: `bob.jones`, `jane.smith` and `deploy-svc` are
verified benign, and two of them are now false-positive scenarios. Widening that beyond three
identities needs an external dataset and an amendment to ADR 001. Roadmap, not PRD-4.

**Benign-true-positive verdicts.** `ScenarioVerdict` is
`true-positive | false-positive | inconclusive`, and adding a fourth value is only meaningful
alongside the contract change roadmap §5 owns.

**Mining `SecurityEvent`.** 23,864 rows across 12 hosts producing three alerts. Real value, but
writing detections over 2021 Windows telemetry is a project of its own.

**The full 154-alert sweep.** Roadmap §7.

**Alert grouping.** Roadmap §8.

## 10. Open Questions

1. **Should `deploy-svc` be added as a false-positive scenario?** Still open, and still the only
   benign identity verified in the corpus — six AWS calls and four GCP calls from `10.0.5.100` /
   `deploy-pipeline@pocaas-prod-01`, all `aws-sdk-java/2.20.0` CI/CD work, appearing nowhere in the
   attack path. A rule on destructive compute actions (`TerminateInstances`,
   `compute.instances.stop`) would fire on it and the correct answer would be false-positive. It
   would be the key's only false positive. Outside the scope agreed for this PRD, but cheap.

## 11. What Changed During Implementation

**The two AWS accounts were corrected from inconclusive to false-positive**, after live runs
disagreed with the key and the disagreement turned out to be the key's fault.

The first draft rested those scenarios on the accounts sitting in the same /24 as an attacker. That
adjacency is an artifact: every synthetic address in the 2026 cloud tables comes from the RFC 5737
documentation ranges, so two attackers and two benign users share /24s by construction. A live
`gpt-5.6-terra` run fetched RFC 5737, discounted the adjacency, and answered 2% and 4% — and was
marked wrong by ground truth that was itself wrong.

Re-verified against fields the first pass never opened: `SessionMfaAuthenticated` is true for all 11
sessions belonging to the two accounts and false for all 30 belonging to `mirage`, `backdoor-svc`
and `eve.hacker`; both `SessionCreationDate` values predate the intruder's first event; every API
call is `ReadOnly`; and the clients are macOS with `aws-cli/2.15.0` against Windows and Linux
browsers. Upstream's own `Watchlists/known_bad_ips.csv` names `198.51.100.42`, `203.0.113.77` and
`192.0.2.100` and excludes both of these addresses while including their /24 neighbours — the
look-alike placement is deliberate lab design.

Correcting it moved `gpt-5.6-terra` from 9/14 to **11/14** on direction and `gpt-5.6-luna` from
10/14 to 9/14, which is the right ordering, and it dropped the best constant answer from 14/14 to
12/14 without touching the scorer.

**Two verdicts moved from true-positive to inconclusive**, on evidence gathered while authoring:

- `adele-azure-destruction`. The draft assumed the Azure destruction was the compromise continuing.
  It is not attributable: `37.142.150.162` appears in exactly one table and nowhere else in the
  estate, while the confirmed compromise runs from `175.45.176.99`, and the seven resource groups
  (`BTPOC`, `EY_DEMO`, `GBB01`, `RG77`, `SENTINEL-MAINRG`, `VM-RG01`, `SENTINELYANIVSH`) are named
  like a demo environment. Both readings survive the telemetry, which makes inconclusive the honest
  answer and gives the key a second calibration control alongside `sunburst-domain-inconclusive`.
- `app-credential-added`. `EntApp01`–`EntApp04` and `purview-spn-user099` appear in no other table,
  `InitiatingIpAddress` is empty on every row, and neither `VadimJ@` nor `Victim@` appears in
  `AzureActivity_CL`. The scripted user-agent is suggestive, not decisive.

**The destruction rule was renumbered** `SOC-RULE-0043` → `SOC-RULE-0026`, into the cloud block.

**`disabled-account-signins` gained an impact change**, not just a text fix — see §6.

**A drift guard was added.** `telemetry.test.ts` now checks that a scenario claiming its query
returns nothing actually returns nothing. It is deliberately narrow: "appears only in X" is a claim
about content, not emptiness, and a union summarised by table returns one row when that claim holds.
The broader check — comparing named tables against the result — stays a review responsibility.

**Corpus artifacts are now documented.** `fixtures/scenarios/README.md` records the three
properties that look like evidence and are not — RFC 5737 addressing in the 2026 tables, the `KP`
versus `IL` contradiction on `175.45.176.99`, and the shifting clock — alongside the fields that are
load-bearing, and a note that upstream's watchlists must never be vendored because they name the
answer.

**Wall-clock times are banned from fixture prose.** The loader shifts the corpus onto a
bootstrap-time anchor, so `08:22` became `17:19` on the next bootstrap. Fixtures describe ordering
and elapsed time instead. Three scenarios were rewritten after the verification pass caught this.
