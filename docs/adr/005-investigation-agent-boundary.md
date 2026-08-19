# ADR 005 — PRD-2 Investigation Agent Boundary

**Status:** Accepted
**Date:** 2026-08-19
**Supersedes in part:** ADR 002 (Structured Final Output), ADR 003 (Initial Integration, Zod responsibilities)

## Context

PRD-2 specifies the first autonomous investigation agent. Implementing it as written contradicts
several decisions taken earlier in `AGENTS.md`, `docs/architecture.md` and ADR 003 — all of which
predate any working investigation.

`AGENTS.md` §15 asks for an ADR rather than a silent change of course. This is that ADR. It records
what changed, and why the earlier decision no longer holds.

## Decisions

### 1. `submit_investigation` replaces the BAML finalizer

**Was:** ADR 003 and `AGENTS.md` §13 gave BAML the final assessment contract, reached by a separate
finalizer call after the Pi investigation.

**Now:** the agent submits its own assessment through a tool, and a valid call is the Definition of
Done. No BAML, no second LLM call.

The finalizer existed to guarantee a validated structured output. A tool call already provides that:
Pi validates arguments against the tool's schema before execution, and a validation failure returns
to the model as a correctable error. The extra call would have re-derived an assessment from a
summary of the investigation rather than the investigation itself, which is a worse input.

**Consequence.** ADR 003's assessment semantics listed `inconclusive` as a verdict. PRD-2 §15 has no
such class — uncertainty is the TP/FP split, and a 50/50 answer is the honest representation of it.
This is a real change to the product contract, not just plumbing: the `sunburst-domain-inconclusive`
scenario is now judged by whether the split lands near even, not by a label.

BAML is deferred, not rejected. Nothing here prevents adding it later if free-form submissions prove
unreliable in practice.

**Amended 2026-08-19, after the first evaluation run.** The submission contract now carries an
`impact` field (`none | contained | confirmed-compromise | unknown`) and a `researchDone` list, and
has dropped `nextAction`. This amends PRD-2 §14's field set and §15's "no separate confidence field"
position.

`impact` exists because a single TP/FP axis cannot express *the detection is real, its significance
is unknowable*. That is precisely what the `sunburst-domain-inconclusive` scenario tests, and both
models tested answered it with a confident TP (95% and 80%) while their prose said the opposite —
`gpt-5.6-terra` wrote "Do not claim compromise from this lookup alone" and then submitted 80/20. The
scenario fixtures have always carried `verdict` and `impact` separately; collapsing them into one
number discarded a distinction the agent was already making unprompted.

`researchDone` replaces `nextAction` because it records the negative space. "Checked X, found
nothing" is a materially different claim from never having checked X, and both observed failures
turn on that distinction — one on absent corroboration, the other on a line of enquiry never opened.
Coverage is visible in a trace, but traces are optional and off by default, and the artifact is what
evaluation reads. `nextAction` was scored by nothing, sits adjacent to the remediation plan PRD-2
§15 already excludes, and was the field that overran its length limit in a live run and cost a turn
to correct.

### 2. A run artifact replaces the PostgreSQL trace store

**Was:** `AGENTS.md` §12 and Milestone 6 called for PostgreSQL/Drizzle persistence of alerts, schema
snapshots, agent events, tool calls, KQL, results and assessments.

**Now:** one `runs/<run-id>.json` per invocation, holding per-alert outcomes and nothing else.

PRD-2 §19 is explicit that this is not a tracing system. The question PRD-2 answers is whether the
agent produces useful assessments; that needs the assessments and a key to join them to ground
truth, which is what the artifact holds. A trace database would be infrastructure built ahead of a
demonstrated need, which `AGENTS.md` §1 forbids.

The artifact carries the model identity and runtime limits beyond PRD-2's shape, because two runs
are not comparable without knowing which model produced them.

### 3. Five tools, not one — and one more than PRD-2 specifies

**Was:** `AGENTS.md` §10 and ADR 002 started with `query_security_data` alone. `AGENTS.md` §2 and
`architecture.md` §14 listed web research as a non-goal.

**Now:** `get_security_schema`, `query_security_data`, `web_search`, `web_fetch`,
`submit_investigation`. The web research non-goal is lifted.

PRD-2 §12 specifies a single `web_search` returning page content, and explicitly does not provide
`web_fetch`. We took the other trade, because the chosen provider (Brave) returns snippets rather
than page text: a fetch has to happen somewhere, and letting the model choose what to open costs
fewer tokens than blind top-N fetching and matches how an analyst researches an indicator.

**Consequence — prompt injection.** Fetched pages are untrusted content that the model reads. The
exposure is not network reach, so address filtering is not the mitigation; it is contained by
framing instead:

- content is returned inside a `<web_content url=… retrieved=…>` provenance envelope;
- the system prompt standing-orders web content as data, never instructions, and flags
  instruction-shaped content as itself suspicious;
- a character cap stops one page dominating the context window.

Two existing properties bound the blast radius: `POST /query` refuses control commands, so injected
KQL cannot mutate the workspace, and `submit_investigation` is the only tool with any effect, so the
worst outcome is a skewed assessment on one alert that a human analyst still adjudicates.

The residual is real and accepted: a determined injection can move a single verdict. Runs are
reviewed against ground truth, so this is observable rather than silent.

### 4. Table names at startup, schemas on demand

**Was:** `architecture.md` §7.1 and `AGENTS.md` §11 injected the current queryable schema into
startup context.

**Now:** the agent receives table names and pulls schemas it decides are relevant.

`AGENTS.md` §15 lists "the full schema is too large for useful startup context" as an explicit
stop-and-decide trigger. Measured: 22 tables, 1,168 columns, ~60 KB of JSON. That is spent before
the agent knows which telemetry matters. The complete schema is still fetched once per investigation
and held by the harness; only its placement in context changed.

### 5. TypeBox at the Pi boundary, Zod everywhere else

**Was:** ADR 003 assigned Zod to KQL tool inputs and tool-result envelopes.

**Now:** tool parameter schemas and the `InvestigationSummary` contract are TypeBox; everything else
— REST responses, the run artifact, configuration — stays Zod.

This is forced, not preferred: `pi-agent-core` types `AgentTool.parameters` as a TypeBox `TSchema`
and offers no Zod path. `Type`, `Static` and `TSchema` are re-exported by `pi-ai`, so this adds no
dependency and stays version-aligned with the validator Pi actually runs. ADR 003's principle is
unchanged — schemas live at boundaries and types are inferred, never hand-duplicated.

### 6. `@t3-oss/env-core` for investigator configuration

`apps/mock-sentinel` uses a hand-rolled `loadConfig()`. The investigator uses `@t3-oss/env-core`,
which validates at module import so a missing key stops the process before the first alert is
fetched rather than partway through a 151-alert sweep. Provider credentials are deliberately *not*
declared there — `pi-ai` reads them from the ambient environment, so they are checked during model
resolution via `Models.getAuth()`, which asks the library what it would actually look for.

### 7. No `packages/agent-runtime`

**Was:** ADR 002 said "Pi is replaceable behind the internal `agent-runtime` package", and
`AGENTS.md` §5 lists it in the expected shape.

**Now:** `apps/investigator/src/harness.ts` is that boundary. It is the only file in the repository
that imports Pi.

ADR 002's requirement is one replaceable seam, and the harness is one. PRD-2 §24 explicitly excludes
a "generic custom agent framework" and "generic harness plugins/providers", which is what a wrapper
package around a single class would become. `AGENTS.md` §5 also forbids creating packages ahead of
need.

## Testing

`AGENTS.md` §7 prioritises the investigation runner and tool boundaries. PRD-2's slice ships with
integration cover for the Sentinel Client only; harness and tool unit tests were scoped out
deliberately.

The cost is worth stating: the PRD-2 §16 completion rules — step-limit exhaustion, timeout, provider
failure, invalid submission — are exercised by live runs rather than by tests, so a regression in
outcome classification will surface as a confusing failed investigation rather than a red test.

`streamFn` is a constructor option on the harness specifically so this stays cheap to reverse:
`pi-ai` ships a `faux` provider that scripts assistant turns and tool calls with no network and no
API cost, which is how every completion path was verified during implementation.

## Consequences

**Positive:** no second LLM call on the critical path; no infrastructure ahead of need; the agent
owns its investigative path end to end; one file to replace if Pi is swapped.

**Negative:** two contract libraries rather than one; BAML and PostgreSQL are deferred work that
`AGENTS.md` still anticipates elsewhere; the web tools accept a real prompt-injection exposure; and
completion semantics are untested until a live run.

## References

- `docs/prd-2-Core Investigation Agent.md`
- ADR 002 (agent runtime), ADR 003 (contract boundaries), ADR 004 (alert API shape)
- `@earendil-works/pi-agent-core` 0.84.2 — note `AgentHarness` is unimplemented in this release and
  every method throws `HarnessNotImplemented`; there is also no built-in turn limit, so the max-step
  ceiling is application-owned via `shouldStopAfterTurn`.
