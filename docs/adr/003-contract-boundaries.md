# ADR 003 — Separate Runtime Contracts (Zod) from LLM Contracts (BAML)

**Status:** Accepted; partly superseded by ADR 005 — tool schemas are TypeBox because Pi offers no
Zod path (§5), and the BAML finalizer became a `submit_investigation` tool (§1). The Zod-at-runtime-
boundaries principle is unchanged  
**Date:** 2026-08-18

## Context

The project needs strong contracts at two fundamentally different boundaries:

1. software/network boundaries containing untrusted JSON;
2. LLM interactions where prompts and structured model outputs must remain provider-portable.

Using one system for both concerns would either weaken runtime validation or over-couple normal application code to LLM-specific tooling.

## Decision

Use:

```text
Zod 4
  -> application and runtime boundaries

BAML
  -> LLM functions and structured LLM outputs
```

## Zod Responsibilities

Use Zod for:
- environment/config validation;
- Mock Sentinel REST requests;
- Mock Sentinel REST responses;
- alert fixture validation;
- Sentinel Client responses;
- KQL tool inputs;
- KQL tool-result envelopes;
- persisted external JSON where validation is necessary.

Types should generally be inferred from the schema rather than duplicated manually.

## BAML Responsibilities

Use BAML for:
- final investigation assessment;
- LLM prompt templates associated with contractual outputs;
- provider-independent typed structured outputs.

Initial assessment semantics should cover:
- likely true positive;
- likely false positive;
- inconclusive;
- confidence/uncertainty;
- summary;
- supporting evidence;
- benign/contradicting evidence;
- justification;
- unresolved questions;
- recommended analyst actions.

The exact BAML class names/field wording are implementation details, but the semantic contract is part of the product.

## Initial Integration

```text
Pi investigation
      |
      v
explicit investigation output + evidence/tool trace
      |
      v
BAML finalizer
      |
      v
validated InvestigationAssessment
```

The BAML call should receive enough explicit evidence to avoid inventing facts outside the investigation.

## Rule Against Duplication

Do not maintain parallel hand-written TypeScript interfaces for Zod schemas.

Do not mirror every BAML contract in Zod unless a concrete non-LLM boundary requires it.

When crossing from BAML output into persistence, use the generated BAML TypeScript type. Add Zod only if the value subsequently crosses an untrusted serialization/network boundary where runtime revalidation is necessary.

## Provider Independence

BAML and Pi both support multi-provider operation, but provider independence does not mean forcing all models to a lowest-common-denominator behavior.

Application code should choose provider/model through configuration.

The BAML contract remains stable across providers.

## Consequences

### Positive
- clear responsibility split;
- strong validation at HTTP/tool boundaries;
- strong structured-output support for LLMs;
- less duplicated schema code;
- easier provider changes.

### Negative
- two contract technologies in the repo;
- developers must understand which one applies;
- adapter code is needed at some application boundaries.

## Alternatives Rejected

### Zod for all LLM output contracts
Possible, but rejected as the primary design because BAML is already a project constraint and provides a dedicated structured-output/prompt layer.

### BAML for REST/runtime validation
Rejected because normal HTTP/config validation should not depend on an LLM DSL/toolchain.

### Hand-written TypeScript interfaces
Rejected at runtime boundaries because they do not validate external data.

## References

- Zod 4 documentation.
- Boundary BAML TypeScript and structured-output documentation.
