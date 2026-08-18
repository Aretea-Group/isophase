# Telemetry Source

Vendored, unmodified, from the Microsoft Sentinel Training Lab.

| | |
|---|---|
| Repository | [`Azure/Azure-Sentinel`](https://github.com/Azure/Azure-Sentinel) |
| Revision | `da6d06ffc59dd3eb1e7a2d58c401c2af2da79eeb` |
| Upstream path | `Tools/Microsoft-Sentinel-Training-Lab/Artifacts/Telemetry` |
| License | MIT — see [`LICENSE`](./LICENSE) |

These files are committed rather than downloaded at bootstrap, per
`docs/training-lab-data.md` §7: it pins the content byte-exactly, keeps bootstrap
offline and free of GitHub rate limits, and avoids the `master`-tracking drift baked
into the upstream ARM templates. Treat a revision change as a dependency upgrade
(ADR 001, "Determinism").

MIT permits redistribution with attribution. It does **not** grant rights to the
Microsoft / CrowdStrike / Okta / Cisco trademarks appearing in the sample data. The
content is synthetic (`contoso`-style identities), though it has not been exhaustively
audited for stray real identifiers.

## Re-fetching

```bash
SHA=da6d06ffc59dd3eb1e7a2d58c401c2af2da79eeb
BASE="https://raw.githubusercontent.com/Azure/Azure-Sentinel/$SHA/Tools/Microsoft-Sentinel-Training-Lab/Artifacts/Telemetry"
curl -sL "$BASE/BuildIn/SecurityEvents.csv" -o fixtures/telemetry/BuildIn/SecurityEvents.csv
# … one per file below
```

Integrity is verifiable two ways. `Git blob SHA-1` is what the GitHub contents API
reports for the file upstream, so `git hash-object` proves provenance directly:

```bash
git hash-object fixtures/telemetry/BuildIn/SecurityEvents.csv   # must equal the table below
```

## Inventory

All 21 files verified byte-identical to the pinned revision. `Rows` excludes the header
and accounts for quoted fields containing embedded newlines — `SecurityEvents.csv` is
23,864 rows across 76,458 physical lines.

| File | Rows | Cols | BOM | Bytes | Git blob SHA-1 | SHA-256 |
|---|---:|---:|:---:|---:|---|---|
| `BuildIn/AWSCloudTrail.csv` | 47 | 33 |  | 25,399 | `f4c13e522954f94d9863c1e425fb25f9d2afcc35` | `132f3a73ef1fe4b313cc1b9727c7defba9ce1b624b3012b1df77f6952dd64646` |
| `BuildIn/CommonSecurityLog.csv` | 149 | 64 |  | 94,688 | `1da73ec9a6d33035d19837247a9231a67459d72b` | `2cc9eacd8ad53e1786c22ae80a5d747d990142c039576109a44f1ff4a760a729` |
| `BuildIn/CrowdStrikeAlerts.csv` | 53 | 40 |  | 34,200 | `f0415188bdbe20d8272a4d61db1360feb326b6fd` | `99f57f3492f76cba5ac7ca5db50ed2b138ab8cdfe3584d0b4b1d5aa494a50a47` |
| `BuildIn/CrowdStrikeCases.csv` | 1 | 30 |  | 1,357 | `9c935311038a3c4c8258955fd001aa7d75f43776` | `09a61c31ce1fafe9bf73f05f945c466ba41f6736835d47a57a9f20af5cb7bc49` |
| `BuildIn/CrowdStrikeDetections.csv` | 54 | 123 |  | 158,981 | `fdf02e86084a49c136252c96abc04d0bd5e3f2ae` | `24c133cd0a03753c544e95c05ab99cddd54467a96b55d06240458a74be66724b` |
| `BuildIn/CrowdStrikeHosts.csv` | 8 | 93 |  | 9,848 | `56f7b1f181e56cb4d2de432717b413ac2713a50e` | `7fc6228c1251ed322d3849a46a3a97b4c2c7e8fb99dfa8758cfaec81f7cc5fa2` |
| `BuildIn/CrowdStrikeVulnerabilities.csv` | 10 | 29 |  | 5,770 | `29228adc476e15bc4ba00860142093a343332334` | `9605473d03451ad0de8c84d42e34309660fe1e183b2ed8442d6e1c9124b23c08` |
| `BuildIn/GCPAuditLogs.csv` | 25 | 26 |  | 21,794 | `7994419b0735d3775c20b63cf26f70637159561e` | `2e50968367359970590ddb911d6a1febc55daa0e8bc75bc9e6b8eecf009737c0` |
| `BuildIn/SecurityEvents.csv` | 23,864 | 20 | yes | 8,887,578 | `f11b042ca2b12c06a16855ef8a43f8c3b916c2f4` | `94739d0cbce163c47e8a8786f0d32f45a5b6109c9ee3c53f37389fa9e1355c71` |
| `Custom/AuditLogsHunting_CL.csv` | 5 | 39 | yes | 11,934 | `8c1ee41ecdc5a6a66241d938c7e27a3d2b83c4ee` | `dbf40ae64c8cb37c20bb40447f66ea39966f3ff7220992eeb885f342a11c3b6f` |
| `Custom/AzureActivity_CL.csv` | 325 | 20 | yes | 480,587 | `4e71a931b20da4b60ab61eab082cae9161f84d95` | `77d7458ef907d0cf751c46ef1c1b3c6db061c9a35cb7d0dfa9cb4e1268997ebe` |
| `Custom/MailGuard365_Threats_CL.csv` | 41 | 33 |  | 24,474 | `a307416159d4726eec29781cc1f7c7ca7c723093` | `fbe6f595f022f6f5dc664e0b3694973ee3f476e75c0a2e6a8738040b6d20001e` |
| `Custom/OfficeActivity_CL.csv` | 266 | 131 | yes | 275,155 | `b03a8f376099cf0f34c28b8158170b3563fbd286` | `b37072497c6f90f664887145adeb6dead46b3a146a81633cf9ce86c064547f0a` |
| `Custom/OktaV2_CL.csv` | 36 | 58 |  | 33,315 | `0605028ec264d1bbc517cfc7df87210bf1eeeb7d` | `6403384be6e3da92fb0c45e75fb68283862ccc8bed2f9bcbe35bcd1f8660122e` |
| `Custom/SEG_MailGuard_CL.csv` | 5 | 36 |  | 3,548 | `35ac4a531805e12588899699488e7266ce4677af` | `c213a4529d0c4d902d9c682bc72f5fc5549e7c0e9bb377af342a97162f099125` |
| `Custom/azureActivity_adele_CL.csv` | 23 | 47 | yes | 159,808 | `a7023de02e0a119ed207254e1b2095988ce76a74` | `ed4c908e55c7c33d2b56393f49534d3aadb39dcb5d447c98210d3ef3184d3a43` |
| `Custom/disable_accounts_CL.csv` | 4 | 61 | yes | 8,321 | `eade3bae5a8172c1a4d0674274819e913f3e3c8e` | `24778de2bcd94b514069b4f79ef0c271715a78167f2a10743b4b15a85fb0d03f` |
| `Custom/model_evasion_detection_CL.csv` | 4 | 34 | yes | 2,862 | `b8356cbfa3c536a04cf165d5354ee36d9a8ab59f` | `267e8464c4f7b10cfeb48bd2a041587b415e188cc47c228899b2895d61b5780b` |
| `Custom/office_activity_inbox_rule_CL.csv` | 2 | 129 | yes | 4,333 | `8eb01f202673a9b8621699570b0a44aa1f3ceb49` | `08cd75937eeb524a30f4ee0a2cf659bb585b6e2cd7a832d0beee87c12ad9e540` |
| `Custom/sign-in_adelete_CL.csv` | 56 | 71 | yes | 112,761 | `09b8fbe2eab4471f0aef8516b7cd34797f0dd297` | `5c5cc469719d9731ae27d62a616d90cb625def25f60067bbf08df923393a7aa4` |
| `Custom/solarigate-beacon-umbrella_CL.csv` | 1 | 16 |  | 400 | `af1bda393f48b261838f9b91c75513588e4e62c7` | `09f168ac262020e8c511e40c934e297ba241e57b903740284ba30436a84d9185` |
