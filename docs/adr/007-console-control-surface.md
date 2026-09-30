# ADR 007 — Console Control Surface

**Status:** Accepted
**Date:** 2026-08-20
**Amends:** ADR 006 §1 and §3; `AGENTS.md` §2, §12 and §14
**Extends:** ADR 006 §4 (observable run lifecycle)
**Extended by:** ADR 008 §2 (the investigator remains the sole writer of run artifacts);
[ADR 013](./013-findings-write-path.md) (`InvestigationControl` gains its second consumer, the
unattended loop, over a unix domain socket)

## Context

ADR 006 made the analyst console a local, read-only view over run artifacts and transcripts. PRD-5
adds the operator loop that the read-only boundary cannot provide: select an outstanding alert,
start or extend an investigation, cancel live work, and record an analyst classification.

Spawning the investigator CLI would preserve process isolation, but it would also require a second
protocol for model discovery and live events. In-process execution makes those capabilities
available through the same typed boundary and keeps the terminal responsive while work proceeds.

## Decisions

### 1. The console drives a control surface, not the harness

`InvestigationControl` is the console's only execution boundary. It lists alerts and available
models, starts and cancels runs, exposes live state, and publishes serializable domain events. Pi's
event types do not cross this boundary, and the console does not construct the harness or agent
tools.

The initial implementation is `InProcessControl`. A spawned process or remote worker may replace it
without changing the TUI if process isolation becomes more valuable than direct live events.

### 2. The investigator remains the sole writer of run artifacts

The console may initiate work, but it never writes under `runs/`. `executeRun` owns artifact
creation and lifecycle updates for both CLI- and console-started investigations. The queue is a
derived fold of Sentinel alerts, persisted artifacts, and live control state; it is never a store.

Analyst classifications are written under `feedback/` through the console's narrow feedback writer.
They freeze the assessment the analyst reviewed, never modify a run artifact, never enter agent
context, and are not consumed by evaluation.

### 3. In-process faults are contained on a best-effort basis

Every started run has an abort controller and a caught settlement promise. Ordinary model, tool,
schema, and network failures therefore settle the run rather than escaping to the renderer.

The host also offers an unhandled rejection to the control. When exactly one run is active, the
control can attribute the fault, abort that run, persist it as failed with the original error, and
emit `run_failed` without exiting the console. With zero or several active runs attribution is not
safe, so the existing fatal path restores the terminal and exits. Out-of-memory and native crashes
remain process-fatal.

### 4. Cancellation is cooperative

Cancellation aborts the active Pi investigation and checks the signal again between alerts. A
cancelled run is persisted as `interrupted`; its active alert records
`InvestigationAbortedError`. The console does not kill a process or rewrite an artifact.

## Consequences

- The local console holds the same provider credentials as the investigator it hosts.
- Console-started runs force tracing so their stream remains durable after the session.
- Quitting the console cancels its in-process runs; they cannot survive the host process.
- The interface can move behind an API or worker later without changing queue or pane logic.
- Feedback is durable human input, but cross-investigation memory and feedback retrieval remain out
  of scope.
