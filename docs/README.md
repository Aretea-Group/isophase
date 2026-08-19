# Technical Artifacts

This directory contains the current architecture baseline for the SOC Investigation Agent.

- `architecture.md` — project-wide implementation architecture.
- `prd-1-mock-sentinel.md` — first implementation PRD: the Mock Sentinel environment.
- `prd-2-Core Investigation Agent.md` — second implementation PRD: the autonomous investigation agent.
- `training-lab-data.md` — verified Training Lab telemetry source reference (ADR 001 spike result).
- `adr/001-training-lab-kusto.md` — decision to use Microsoft Training Lab telemetry with Kusto Emulator.
- `adr/002-agent-runtime.md` — Pi Agent Core / Pi AI runtime decision.
- `adr/003-contract-boundaries.md` — Zod vs BAML responsibility split.
- `adr/004-alert-api-shape.md` — alert API shape, alert generation, and the read-only query boundary.
- `adr/005-investigation-agent-boundary.md` — what PRD-2 supersedes: submit_investigation over BAML, run artifact over trace store, five tools, schema on demand.

Repository implementation instructions are in the root `AGENTS.md`.
