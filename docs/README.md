# Technical Artifacts

Architecture baseline, PRDs and decision records for the SOC Investigation Agent.

Where a document disagrees with the code, the **ADRs are the authority** — they record what changed
and why. `architecture.md` predates PRD-2 and is annotated where ADR 005 supersedes it.

## Specifications

| Document | Status |
|---|---|
| [`architecture.md`](./architecture.md) | v0.2 — project-wide implementation architecture |
| [`prd-1-mock-sentinel.md`](./prd-1-mock-sentinel.md) | **Delivered** — the mock Sentinel environment |
| [`prd-2-Core Investigation Agent.md`](./prd-2-Core%20Investigation%20Agent.md) | **Implemented** — the autonomous investigation agent |
| [`training-lab-data.md`](./training-lab-data.md) | Verified telemetry source reference (ADR 001 spike result) |

## Decisions

| ADR | Status |
|---|---|
| [001 — Training Lab + Kusto](./adr/001-training-lab-kusto.md) | Accepted |
| [002 — Agent runtime (Pi)](./adr/002-agent-runtime.md) | Accepted; partly superseded by 005 |
| [003 — Contract boundaries](./adr/003-contract-boundaries.md) | Accepted; partly superseded by 005 |
| [004 — Alert API shape](./adr/004-alert-api-shape.md) | Accepted |
| [005 — Investigation agent boundary](./adr/005-investigation-agent-boundary.md) | Accepted |

ADR 005 is the one to read first if the code surprises you. It records six supersessions —
`submit_investigation` over a BAML finalizer, a run artifact over a trace store, five tools over one,
table names over the full schema, TypeBox at the Pi boundary, and no `agent-runtime` package — plus
which PRD-2 acceptance criteria are knowingly unmet.

Repository implementation instructions are in the root [`AGENTS.md`](../AGENTS.md).
