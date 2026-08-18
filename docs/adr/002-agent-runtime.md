# ADR 002 — Use Pi Agent Core as the Initial Investigation Runtime

**Status:** Accepted  
**Date:** 2026-08-18

## Context

The investigation product requires an autonomous multi-step LLM agent that can:
- receive an alert and startup context;
- decide whether tool use is required;
- invoke investigation tools repeatedly;
- incorporate results;
- stop and return an assessment;
- support multiple LLM providers;
- expose execution events for tracing.

The application should not build a custom agent loop unless an actual runtime limitation appears.

## Decision

Use:
- `@earendil-works/pi-agent-core` for the agent runtime;
- `@earendil-works/pi-ai` for model/provider abstraction.

The older `@mariozechner/pi-agent-core` namespace is deprecated and must not be introduced into the project.

## Why Pi

Pi Agent Core currently provides:
- stateful agent execution;
- tool execution;
- event streaming;
- an explicit `Agent` abstraction;
- lower-level loop APIs if required later.

Pi AI provides a unified multi-provider model layer.

This matches the project requirement without forcing the application to own the generic LLM/tool loop.

## Boundary

```text
Application
+-- builds investigation context
+-- defines instructions
+-- defines tools
+-- enforces limits
+-- persists trace
+-- owns Sentinel client
+-- owns BAML assessment
        |
        v
Pi Agent Core
+-- model turn
+-- tool call
+-- tool result integration
+-- repeat/complete
        |
        v
Pi AI
        |
        v
Configured LLM provider
```

Pi is replaceable behind the internal `agent-runtime` package.

No Sentinel-specific logic belongs in Pi wrappers.

## Initial Tool Set

Start with one domain tool:

```text
query_security_data(kql)
```

The tool implementation uses the application Sentinel Client.

Do not encode alert-type playbooks in tool registration.

## Agent Startup Context

```text
system instructions
+ current alert
+ current queryable schema
+ available tools
```

The agent starts with a clean session for each investigation in this implementation slice.

Cross-investigation memory is a later PRD.

## Execution Limits

The wrapper must support configurable limits such as:
- total investigation timeout;
- tool-call count;
- result-size limits;
- model/token budget where available;
- cancellation.

These are runtime guardrails, not investigation logic.

## Observability

Subscribe to Pi runtime events and persist enough information to inspect:
- model activity needed for debugging;
- tool requests;
- tool results;
- runtime errors;
- completion.

Do not depend on private/hidden model chain-of-thought. Persist explicit messages, tool events, and evidence-facing outputs.

## Structured Final Output

Pi owns the autonomous investigation.

BAML owns the final contractual assessment. Initial implementation uses a final assessment step after the Pi investigation rather than tightly coupling BAML into every Pi turn.

This can be revisited if a cleaner direct structured-output integration proves reliable.

## Consequences

### Positive
- no custom generic tool loop;
- provider flexibility;
- tool/event primitives already exist;
- small agent runtime relative to full coding-agent frameworks;
- replaceable application boundary.

### Negative
- external runtime dependency;
- Pi API evolution must be pinned and upgraded deliberately;
- provider behavior is not perfectly uniform;
- we still own domain tracing and persistence.

## Package Version Policy

Pin compatible Pi package versions at the workspace level.

Do not automatically follow latest releases in CI. Upgrade Pi deliberately with:
- changelog review;
- typecheck;
- unit/integration tests;
- at least one replayed autonomous investigation.

## Alternatives

### Custom TypeScript loop
Rejected initially. Revisit only if Pi blocks a concrete product requirement.

### Full Pi coding agent
Rejected. The product needs the underlying agent runtime, not a filesystem coding agent.

### Workflow/state-machine-first architecture
Rejected for investigation strategy. The agent owns the investigative path; deterministic orchestration remains around the agent only where needed.

## References

- `earendil-works/pi` repository.
- `@earendil-works/pi-agent-core` package documentation.
- `@earendil-works/pi-ai` package documentation.
