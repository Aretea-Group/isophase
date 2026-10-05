# Technical Artifacts

Architecture baseline, PRDs and decision records for Isophase, the SOC investigation agent.

Where a document disagrees with the code, the **ADRs are the authority** — they record what changed
and why. `architecture.md` predates PRD-2 and is annotated where ADR 005 supersedes it.

## Specifications

| Document | Status |
|---|---|
| [`architecture.md`](./architecture.md) | v0.2 — project-wide implementation architecture |
| [`prd-1-mock-sentinel.md`](./prd-1-mock-sentinel.md) | **Complete** — the mock Sentinel environment |
| [`prd-2-Core Investigation Agent.md`](./prd-2-Core%20Investigation%20Agent.md) | **Complete** — the autonomous investigation agent |
| [`prd-3-analyst-console.md`](./prd-3-analyst-console.md) | **Complete** — the read-only analyst console (TUI) |
| [`prd-4-ground-truth-expansion.md`](./prd-4-ground-truth-expansion.md) | **Complete** — expanding the evaluation answer key |
| [`prd-5-console-operator-surface.md`](./prd-5-console-operator-surface.md) | **Complete** — the alert queue and investigation operator surface |
| [`prd-6-run-comparability.md`](./prd-6-run-comparability.md) | **Complete** — making runs comparable across models, parameters, tools, prompts, steering and memory, and accumulating a durable baseline to compare them on. Partitions the scoring bands and makes the run corpus append-only |
| [`prd-7-real-sentinel-connector.md`](./prd-7-real-sentinel-connector.md) | **Complete** — a read-only Azure Monitor Logs implementation of the Sentinel capability |
| [`prd-8-microsoft-defender-data-source.md`](./prd-8-microsoft-defender-data-source.md) | **Complete** — Microsoft Defender XDR through the Graph security API, so the system runs on Defender alone with no Sentinel at all; and several sources active at once with exactly one holding the primary alert role. AC2 is a recorded deviation: the Sentinel prompt hash moved, splitting the run corpus (ADR 011 §14) |
| [`prd-9-open-source-release-readiness.md`](./prd-9-open-source-release-readiness.md) | **Complete** — the repository is public as `Aretea-Group/isophase`: MIT licence, a protected `main` with a required CI check and no bypass, the `.github/` furniture, and the run corpus untracked so investigation output is never published. The history rewrite was reversed by the user (ADR 012); three clean-machine and fork checks are carried to roadmap §12 |
| [`prd-10-unattended-investigation-and-findings-write-back.md`](./prd-10-unattended-investigation-and-findings-write-back.md) | **Complete** — the agent polls a Defender tenant unattended, investigates each new alert once, and writes its findings back as a comment on the incident, opt-in behind `PUBLISH_FINDINGS`. The console becomes optional: it can drive a loop or attach to one over a control socket, and analyst feedback capture is removed. AC5 is a recorded deviation: `alerts_v2` discards comments, so publication targets the incident (ADR 013 §6) |
| [`prd-11-npm-distribution-and-release-flow.md`](./prd-11-npm-distribution-and-release-flow.md) | **Approved** — Track A as an npm package: `bunx @aretea-group/isophase init`, one `isophase` bin over the existing entrypoints, and a Release-triggered GitHub Actions publish through npm trusted publishing (OIDC). Reverses PRD-9 §3's npm non-goal; narrows roadmap §11. The lab stays clone-only |
| [`research-defender-api.md`](./research-defender-api.md) | **Research** — PRD-8 Phase 0. §1–§8 are the desk half: what Microsoft's documentation settles about the Graph security API and what it contradicts itself on. §9 is the live half, measured against a real tenant, including the two findings that reversed the design. Every claim tagged documented / inferred / contradictory / measured |
| [`defender-setup.md`](./defender-setup.md) | **Setup** — PRD-8 Phase 0. The Entra app registration, the two read-only Graph application permissions and the admin consent `bun run probe:defender` needs. Tenant-free by construction |
| [`research-console-write-path.md`](./research-console-write-path.md) | **Research** — roadmap §6, the console write path. Verdict: buildable in ~1k lines, no new dependency. Not a PRD; nothing in it is built |
| [`research-run-comparability.md`](./research-run-comparability.md) | **Research** — roadmap §9, why runs are not comparable today. The measurements behind PRD-6 |
| [`roadmap.md`](./roadmap.md) | Forward-looking capabilities and follow-up work |
| [`training-lab-data.md`](./training-lab-data.md) | Verified telemetry source reference (ADR 001 spike result) |

## Decisions

| ADR | Status |
|---|---|
| [001 — Training Lab + Kusto](./adr/001-training-lab-kusto.md) | Accepted |
| [002 — Agent runtime (Pi)](./adr/002-agent-runtime.md) | Accepted; partly superseded by 005 |
| [003 — Contract boundaries](./adr/003-contract-boundaries.md) | Accepted; partly superseded by 005 |
| [004 — Alert API shape](./adr/004-alert-api-shape.md) | Accepted |
| [005 — Investigation agent boundary](./adr/005-investigation-agent-boundary.md) | Accepted |
| [006 — Analyst console boundary](./adr/006-analyst-console.md) | Accepted |
| [007 — Console control surface](./adr/007-console-control-surface.md) | Accepted |
| [008 — The comparability record](./adr/008-comparability-record.md) | Accepted; amends 005 §2, `AGENTS.md` §5/§9/§12/§14 and roadmap §7 |
| [009 — Azure Monitor Logs connector](./adr/009-azure-monitor-logs-connector.md) | Accepted |
| [010 — Tabular security data-source boundary](./adr/010-tabular-security-data-source-boundary.md) | Accepted; amends the Sentinel-only investigation boundary |
| [011 — Multi-source security data and the Defender connector](./adr/011-multi-source-security-data.md) | Accepted; reverses 010 §4's single-bundle startup and `AGENTS.md` §2's second-SIEM non-goal |
| [012 — The run corpus leaves version control](./adr/012-run-corpus-leaves-version-control.md) | Accepted; reverses 008 §8's committed corpus and amends `AGENTS.md` §5 — the benchmark inputs ship, our measurements do not |
| [014 — One published package, one command surface](./adr/014-one-published-package.md) | Accepted; amends ADR 007 §2, `AGENTS.md` §2 and §5 and the "no build step" rule — the workspace is an internal detail of a single CI-built bundle, one `isophase` bin fronts every entrypoint, and `init` writes a `.env` and provisions nothing. §6 records the deviation to a granular npm token while npm rejects immutable OIDC subjects, and release-please as the trigger |
| [013 — The findings write path and unattended operation](./adr/013-findings-write-path.md) | Accepted; reverses the write-path half of `AGENTS.md` §2 and amends 009 §1, 010 §1, 011 §1 and PRD-5 §14 — publication is a capability a source declares, the incident is the target, and the loop backs off while the connector never retries |

ADR 006 covers the console: why a TUI rather than a web frontend, why the run artifact gained a
lifecycle, and why the console is not ground-truth-aware.

ADR 008 covers benchmarking: why the run artifact gains counters but never content, why the
comparison key is derived rather than declared, and why a scored report is never written to disk.

ADR 010 covers security sources: why the common boundary stops at alerts and tabular read-only
queries, why source-native alert evidence remains visible, and why query behavior travels with the
selected client as one profile.

ADR 005 is the one to read first if the code surprises you. It records six supersessions —
`submit_investigation` over a BAML finalizer, a run artifact over a trace store, five tools over one,
table names over the full schema, TypeBox at the Pi boundary, and no `agent-runtime` package.

Repository implementation instructions are in the root [`AGENTS.md`](../AGENTS.md).
