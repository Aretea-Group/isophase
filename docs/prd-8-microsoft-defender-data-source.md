# PRD-8 — Microsoft Defender Data Source

**Status:** Complete — see `docs/adr/011-multi-source-security-data.md` §14 and §16 for accepted deviations
**Produces:** ADR 011 — Multi-source security data and the Microsoft Defender connector
**Depends on:** PRD-7 — Real Microsoft Sentinel Connector
**Full text:** `git show 3e7048e:"docs/prd-8-microsoft-defender-data-source.md"` — docs: give PRD-8 D11 an ADR home and say where §7's answers went, 2026-08-27

The system only spoke Sentinel. Every path from configuration to alert to query assumed a Log
Analytics workspace: `SENTINEL_CONNECTOR` chose between two transports and both read `SecurityAlert`
with KQL against the Logs endpoint, so Mock and Azure were two transports of one product and the
boundary ADR 010 drew to make sources substitutable had never had a second product to substitute. A
tenant whose detections live in Microsoft Defender XDR therefore could not use the system at all —
not "could not use it well": its alerts are not rows in a workspace and its telemetry is not
addressable through the Logs query endpoint, so every hop was inapplicable rather than merely
unconfigured. A second and smaller cost applied to a tenant running both products, where an
investigation confined to one stops at the product boundary rather than at the answer.

`packages/sentinel-client/src/defender.ts` reaches Defender through the Microsoft Graph security API
— alerts from `alerts_v2` bounded by an explicit `DEFENDER_ALERT_WINDOW`, telemetry from
`runHuntingQuery`, one `ClientSecretCredential` and no new dependency. `SECURITY_SOURCES` selects an
ordered set of sources through the static map in `src/factory.ts` and `PRIMARY_ALERT_SOURCE` names
the only one that produces alerts; every active source stays queryable through the `source`
parameter both security tools gained, and `apps/investigator/src/context.ts` emits one labelled
table block per source. Provenance hashes every active profile, and the artifact records
`config.source` for the primary beside `config.sources` for the set, so runs over different source
sets are different conditions. Defender standalone is first-class: `SECURITY_SOURCES=defender` needs
no Sentinel credential, workspace or Mock Sentinel process. Phase 0 left
`scripts/probe-defender.ts`, `docs/research-defender-api.md` and `docs/defender-setup.md`. Two
things were not built as written, both recorded in ADR 011: AC2's unchanged-prompt-hash half (§14),
and D11's `DEFENDER_QUERY_INSTRUCTIONS` constant, which shipped as
`defenderQueryInstructions(maxRows)` because the row cap is configurable (§16). Live validation on
2026-08-27 also retired §6's claim that cross-source querying was proven as routing only, and
re-measured §7 Q2 against a real workspace — both annotated in the full text above.

**Superseded non-goals.** §3 records what *this phase* did not build; it does not bind later phases.
Nothing in it has been picked up since — PRD-8 is the newest PRD:

- §3 "merging or deduplicating alerts across sources" — still excluded, and ADR 011 §4 is where the
  rule now lives rather than here.
- §3 "the Defender incidents API, and incident-level grouping" — still out, and still wanted: ADR
  011 §1 records that incident membership is reachable from neither the alerts API nor advanced
  hunting, which is what makes it worth its own PRD.
- §3 "any write path", "the legacy Microsoft Defender for Endpoint APIs", "a Defender equivalent of
  Mock Sentinel", "Defender ground truth, scenarios or evaluation", "a connector registry or plugin
  discovery", "delegated or developer credentials for Defender", "sovereign and national clouds" and
  "a third integration" — all still out of scope.
- §3 "fixing the startup-context size" — still deferred to `roadmap.md` §3, which now carries the
  live-workspace measurement rather than the Mock Sentinel one it was written against.
