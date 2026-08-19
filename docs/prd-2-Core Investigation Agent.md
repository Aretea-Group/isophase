# PRD-2 — Core Investigation Agent

**Status:** Ready for implementation  
**Depends on:** PRD-1 — Mock Sentinel  
**Primary runtime:** `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`  
**Language/runtime:** TypeScript strict mode, Bun  
**Runtime schemas:** TypeBox

---

## 1. Purpose

PRD-2 implements the first autonomous SOC investigation agent on top of the completed PRD-1 Mock Sentinel environment.

The objective is deliberately narrow:

> Determine whether a capable LLM can autonomously perform useful T1/T2 SOC investigations when given an alert, knowledge of the available security telemetry, and sufficiently general investigation capabilities.

PRD-2 is not a production SOC platform.

It should implement the smallest useful investigation system, observe how it behaves against the existing Training Lab scenarios, and defer additional architecture until concrete shortcomings are demonstrated.

---

## 2. Product Goal

For each alert, the system should autonomously:

```text
receive alert
→ understand the existing evidence
→ decide whether additional investigation is necessary
→ inspect relevant security telemetry
→ perform public internet research when useful
→ consider malicious and benign explanations
→ submit a concise TP/FP assessment
→ human analyst retains final disposition
```

The model owns the investigation strategy.

The system must not encode predefined investigation playbooks such as:

```text
PowerShell alert
→ query process
→ query user
→ query device
→ check IP
→ classify
```

There is no required number or sequence of KQL queries, schema requests, or web searches.

---

## 3. Core Design Principles

### 3.1 Pi owns the autonomous agent loop

`pi-agent-core` is used as the low-level autonomous runtime.

Pi owns:

```text
model interaction
current investigation conversation state
tool execution
tool results
agent loop
turn lifecycle
```

PRD-2 must not implement a second model/tool loop around Pi.

---

### 3.2 The InvestigationHarness owns the SOC run environment

PRD-2 introduces a small application-level:

```text
InvestigationHarness
```

Its responsibility is:

> Prepare, execute, constrain, and complete one autonomous SOC investigation using a Pi Agent.

It owns:

```text
investigation dependencies
initial investigation context
available capabilities
runtime limits
completion semantics
```

It does not decide how an alert should be investigated.

---

### 3.3 One alert = one fresh Pi Agent

Each investigation receives a new Pi Agent instance.

```text
Alert A
→ Pi Agent A
→ complete

Alert B
→ Pi Agent B
→ complete
```

Agent conversation state is never reused across investigations.

Long-term SOC memory is a separate future capability.

---

### 3.4 Keep infrastructure independent of Pi where practical

Infrastructure clients should not depend on Pi types.

For example:

```text
SentinelApiClient
        ↑
query_security_data Pi tool adapter
        ↑
Pi Agent
```

This keeps external-system integration separate from agent-runtime integration.

---

## 4. High-Level Architecture

```text
                    Mock Sentinel
                    GET /alerts
                         │
                         ▼
                    Alert Runner
                         │
                  sequential initially
                         │
                         ▼
                InvestigationHarness
                         │
                one Alert per run
                         │
            ┌────────────┴────────────┐
            │                         │
      initial context            Pi capabilities
            │                         │
      Alert + table names              │
            │                         │
            └────────────┬────────────┘
                         ▼
                      Pi Agent
                         │
       ┌─────────────────┼────────────────────┐
       │                 │                    │
       ▼                 ▼                    ▼
get_security_schema query_security_data   web_search
       │                 │                    │
       └──────────┬──────┘                    │
                  ▼                           ▼
          SentinelApiClient            WebSearchClient
                  │                           │
                  ▼                           ▼
            Mock Sentinel              managed public
              REST API                  web provider
                  │
                  ▼
                Kusto

                      Pi Agent
                         │
                         ▼
                submit_investigation
                         │
                         ▼
                InvestigationSummary
                         │
                         ▼
                  InvestigationHarness
                         │
                         ▼
                     Run file
```

---

## 5. Components

### 5.1 InvestigationHarness

The harness is a concrete reusable class, not a generic agent framework.

Conceptual public interface:

```ts
class InvestigationHarness {
  constructor(options: InvestigationHarnessOptions);

  investigate(alert: Alert): Promise<InvestigationSummary>;
}
```

Long-lived harness dependencies include:

```text
SentinelApiClient
WebSearchClient
model configuration
agent instructions
runtime limits
```

Per-investigation mutable state must remain local to `investigate()`.

The same harness instance must not leak state between investigations.

The implementation should remain compatible with running multiple `investigate()` calls concurrently later, even though PRD-2 processes alerts sequentially.

---

### 5.2 SentinelApiClient

PRD-2 includes a typed client for the existing PRD-1 REST API.

Conceptually:

```ts
class SentinelApiClient {
  listAlerts(): Promise<Alert[]>;
  getAlert(id: string): Promise<Alert>;
  getSchema(): Promise<SecuritySchema>;
  query(kql: string): Promise<QueryResult>;
}
```

This is an API client/SDK, not a generalized connector abstraction.

The future Abstracted Connectors roadmap item remains separate.

---

### 5.3 WebSearchClient

`WebSearchClient` provides constrained access to public internet research through a managed search provider.

Conceptually:

```ts
interface WebSearchClient {
  search(query: string): Promise<WebSearchResult[]>;
}
```

The provider is intentionally not fixed by PRD-2.

Provider-specific configuration must not leak into the agent-facing tool contract.

The model is not given arbitrary HTTP or browser access.

---

### 5.4 Pi Agent

Each `investigate(alert)` call creates a fresh Pi Agent configured with:

```text
injected system instructions
current model
initial investigation context
PRD-2 tools
runtime stopping policy
```

Pi remains the sole owner of autonomous model/tool execution.

---

## 6. Alert Execution

PRD-2 supports two developer execution modes.

### Run every alert

```text
Mock Sentinel GET /alerts
        ↓
Alert A
        ↓
investigate
        ↓
Alert B
        ↓
investigate
        ↓
Alert C
        ↓
investigate
```

Alerts are processed sequentially.

Parallel alert processing is explicitly deferred.

### Run one alert

A developer can specify a single alert ID and investigate only that alert.

Conceptually:

```text
bun run investigate

→ all alerts


bun run investigate --alert <alert-id>

→ one alert
```

Exact CLI parsing is an implementation detail.

---

### Individual failures do not stop the batch

When running all alerts:

```text
Alert A → success
Alert B → failure
Alert C → still investigated
```

A failure in one investigation must not prevent subsequent alerts from running.

No automatic investigation retry is required.

---

## 7. Investigation Startup

At the beginning of one investigation:

```text
Alert
  +
complete Sentinel schema fetched once
        ↓
Harness retains complete schema
        ↓
Agent initially receives:
  - Alert
  - available table names
```

The complete schema is deliberately not placed into model context initially.

Security environments may contain many tables with large numbers of fields. Injecting all schemas would consume context before the agent knows which telemetry is relevant.

The agent can request schemas for whichever tables it decides are useful.

The system instructions themselves are supplied separately.

---

## 8. Agent Instructions

The contents of the SOC system prompt are **not part of PRD-2**.

PRD-2 only requires that instructions are:

```text
injected when the harness is configured
supplied to each fresh Pi Agent
easy to replace
not hard-coded into the harness lifecycle
```

Conceptually:

```ts
new InvestigationHarness({
  instructions,
  ...
});
```

Run-specific alert/security information must remain separate from stable system instructions.

---

## 9. Agent Tools

PRD-2 exposes four tools:

```text
get_security_schema
query_security_data
web_search
submit_investigation
```

No alert-family-specific investigation tools are included.

---

## 10. `get_security_schema`

Purpose:

> Allow the agent to inspect the structure of security tables it considers relevant.

Agent-facing contract:

```ts
get_security_schema({
  tables: string[];
})
```

Requirements:

- `tables` must contain at least one table name.
- Multiple schemas may be requested in one call.
- The agent may request all available tables if it chooses.
- The tool reads from the complete schema already loaded at investigation startup.
- It does not make another schema network request.
- Unknown table names produce a clear tool error.
- The returned table definitions should preserve the PRD-1 schema information without semantic interpretation.

The tool is parallel-capable.

---

## 11. `query_security_data`

Agent-facing contract:

```ts
query_security_data({
  kql: string;
})
```

The agent writes arbitrary read-only KQL.

Execution:

```text
Pi Agent
   ↓
query_security_data
   ↓
SentinelApiClient.query(kql)
   ↓
POST /query
   ↓
Kusto
```

The returned KQL result must be passed back to the model without investigation-specific interpretation, summarization, evidence extraction, or semantic normalization.

The model is responsible for understanding the result.

Invalid KQL or other query failures should be returned as clear tool errors containing enough information for the model to correct the query.

The tool is parallel-capable.

---

## 12. `web_search`

Agent-facing contract:

```ts
web_search({
  query: string;
})
```

The interface must remain deliberately small.

Conceptual result:

```ts
type WebSearchResult = {
  title: string;
  url: string;
  content: string;
};
```

The web provider determines how searching, retrieval, extraction, ranking, redirects, and other provider-specific behavior operate.

Those controls are not exposed to the model.

PRD-2 does not provide:

```text
arbitrary web_fetch
generic HTTP requests
browser access
localhost access
internal-network access
provider-specific search options
```

The tool is parallel-capable.

Internet content remains untrusted evidence.

---

## 13. Parallel Tool Execution

The following tools may execute concurrently when the model produces independent calls in one turn:

```text
get_security_schema
query_security_data
web_search
```

The harness must not impose an artificial sequential investigation workflow.

If one investigation step logically depends on the result of another, the model will naturally need another turn before generating the dependent operation.

`submit_investigation` is treated separately because it represents completion.

---

## 14. `submit_investigation`

A valid call to:

```text
submit_investigation
```

is the Definition of Done for an investigation.

A normal model response is not sufficient.

The result must conform to the `InvestigationSummary` contract.

Conceptually:

```ts
type InvestigationSummary = {
  tpPercent: number;
  tpReason: string;

  fpPercent: number;
  fpReason: string;

  whatHappened: string;

  keyEvidence: string[];

  nextAction: string;
};
```

### Validation

`tpPercent`:

```text
integer
0–100
```

`fpPercent`:

```text
integer
0–100
```

Invariant:

```text
tpPercent + fpPercent = 100
```

Text constraints:

```text
tpReason
1–500 characters

fpReason
1–500 characters

whatHappened
1–1000 characters

keyEvidence
1–6 entries

each keyEvidence entry
1–500 characters

nextAction
1–500 characters
```

Unknown/additional properties should be rejected.

TypeBox is used for runtime contract validation.

The TP + FP invariant may be validated explicitly in tool execution where required.

---

## 15. Analyst-Facing Output

The contract represents this concise human-facing structure:

```text
TP — X%
Reason: ...

FP — Y%
Reason: ...

What happened
...

Key evidence / enrichment
- ...
- ...

Next action
...
```

There is no:

```text
inconclusive classification
separate confidence field
automatic verdict
MITRE mapping requirement
evidence graph
remediation plan
```

Uncertainty is represented directly through TP and FP percentages.

The human analyst retains final disposition.

---

## 16. Completion Behavior

### Successful completion

```text
valid submit_investigation
        ↓
capture InvestigationSummary
        ↓
terminate investigation
        ↓
return summary
```

No additional model turn should begin after successful submission.

---

### Invalid submission

If TypeBox validation or the TP/FP invariant fails:

```text
submit_investigation
        ↓
clear tool validation error
        ↓
agent may correct and resubmit
```

Invalid submission does not complete the investigation.

---

### Agent stops without submission

```text
Pi Agent stops
+
no valid submission
        ↓
investigation failure
```

The harness must not convert the final assistant message into an investigation result.

---

## 17. Runtime Limits

PRD-2 uses a deliberately generous maximum-step ceiling as protection against runaway execution.

The limit is configurable.

A reasonable initial default is:

```text
50 completed agent turns
```

If the limit is reached without a valid submission:

```text
investigation fails
```

No additional recovery workflow or forced final-answer turn is required.

---

### Investigation timeout

The harness should also support a configurable whole-investigation timeout.

Its purpose is different from the step ceiling:

```text
max steps
→ protects against endless reasoning

timeout
→ protects against endless elapsed execution
```

Individual external clients should also apply ordinary request-level timeouts.

No complex timeout/recovery system is required.

---

## 18. Error Handling

### Recoverable tool errors

Examples:

```text
invalid KQL
unknown schema table
web search timeout
web provider error
```

These should produce clear tool errors visible to the model.

The error should contain useful technical information when available.

The harness does not implement investigation-specific correction logic.

The model decides whether to:

```text
retry differently
use another capability
continue without the information
```

---

### Fatal runtime errors

Examples:

```text
fatal model/provider failure
Pi runtime failure
unrecoverable harness failure
```

These fail the current investigation.

No automatic full-investigation retry is required.

When processing all alerts, execution continues with the next alert.

---

## 19. Run Artifact

PRD-2 should persist the important outcome of each development run so that results can later be compared with PRD-1 hidden scenario metadata and ground truth.

This is not a tracing system.

Each invocation that runs one or more alerts should create a run artifact, for example:

```text
runs/<run-id>.json
```

Conceptual structure:

```ts
type InvestigationRun = {
  runId: string;
  startedAt: string;
  completedAt: string;

  results: Array<{
    alertId: string;
    status: "completed" | "failed";

    startedAt: string;
    completedAt: string;
    durationMs: number;

    summary?: InvestigationSummary;

    error?: {
      name: string;
      message: string;
    };
  }>;
};
```

The run artifact should contain only information useful for later analysis.

It does not need to persist:

```text
complete Pi transcript
every token
complete tool trace
raw KQL results
raw web results
```

Those can be added later if evaluation demonstrates a concrete need.

Normal developer logging may still be printed while the agent runs.

The run artifact is the durable output.

---

## 20. Ground-Truth Isolation

PRD-1 scenario metadata remains strictly hidden from the investigation agent.

The agent may access only:

```text
current Alert
available table names
requested table schemas
security data returned through KQL
public web research
```

The run artifact may later be joined with hidden scenario metadata by evaluation tooling outside the investigation agent.

Hidden metadata must never enter:

```text
agent context
tool results
system instructions
tenant context
```

---

## 21. Initial End-to-End Flow

### Run all alerts

```text
start command
     ↓
SentinelApiClient.listAlerts()
     ↓
alerts
     ↓
for each alert sequentially
     │
     ▼
InvestigationHarness.investigate(alert)
     │
     ├── get full schema
     ├── extract table names
     ├── create fresh Pi Agent
     ├── create tools
     ├── inject Alert + table names
     ├── autonomous investigation
     ├── require submit_investigation
     └── return summary / failure
     │
     ▼
append outcome to run result
     ↓
next alert
     ↓
write run artifact
```

### Run one alert

```text
specified alert ID
       ↓
SentinelApiClient.getAlert(id)
       ↓
InvestigationHarness.investigate(alert)
       ↓
write run artifact
```

---

## 22. PRD-2 Acceptance Criteria

PRD-2 is complete when:

- A developer can run all available Mock Sentinel alerts.
- A developer can run one alert by ID.
- Running all alerts processes them sequentially.
- Failure of one alert does not stop subsequent alerts.
- Each alert is investigated by a fresh Pi Agent.
- The same `InvestigationHarness` can be reused across investigations without leaking mutable state.
- The harness receives an already-acquired `Alert`.
- The complete security schema is fetched once at investigation startup.
- Only available table names are placed into initial model context.
- The agent can request schemas for selected tables.
- The agent can request multiple table schemas at once.
- The agent can execute arbitrary read-only KQL.
- Raw KQL results are returned to the agent without investigation-specific interpretation.
- The agent can perform constrained public-web searches.
- The agent cannot perform arbitrary HTTP fetches through PRD-2.
- Independent investigation tools are parallel-capable.
- Tool failures provide useful errors to the agent.
- A valid `submit_investigation` is required for successful completion.
- `tpPercent + fpPercent = 100`.
- All analyst-facing result fields are required and size-constrained.
- Invalid submissions can be corrected by the agent.
- Ending without a valid submission is a failed investigation.
- Max-step exhaustion without a valid submission is a failed investigation.
- Investigation timeout is supported.
- Fatal model/runtime failures fail the current investigation.
- No result is fabricated from an unfinished agent response.
- Each invocation writes a persistent run artifact containing per-alert outcomes.
- Hidden PRD-1 scenario metadata is never exposed to the agent.
- No alert-specific workflow or investigation playbook is encoded in the harness.

---

## 23. Scenario Evaluation

Formal regression infrastructure is not part of PRD-2.

The generated run artifacts should make later comparison against the existing PRD-1 ground truth straightforward.

Initial qualitative review should consider:

```text
Did the agent lean TP/FP in the correct direction?

Did it correctly explain what happened?

Did it discover the important evidence?

Did it materially hallucinate?

Was its enrichment useful?

Was the next action sensible?
```

The exact investigation trajectory must not be graded.

Different valid investigations may use different schemas, KQL, searches, and amounts of evidence.

---

## 24. Explicitly Out of Scope

PRD-2 does not include:

```text
system prompt design/content

case memory
tenant memory
human-feedback learning

generic custom agent framework
generic harness plugins/providers
persistent Pi sessions
context compaction
resume/checkpointing

alert queue
background workers
parallel alert processing
scheduling
polling/webhook ingestion

generalized connector interfaces
additional security-system integrations

alert grouping/correlation

formal evaluation/regression platform
trace database

SOAR/remediation actions
ticketing integration

frontend/UI

planner/executor agents
reviewer agents
multi-agent workflows

alert-specific investigation playbooks
```

---

## 25. Roadmap Notes Created by PRD-2

The following remain candidates for later independent work based on demonstrated need.

### Alert Intake / Scheduling / Queueing

Future responsibility:

```text
detect incoming alerts
queue investigations
control concurrency
apply backpressure
handle worker lifecycle
support retries/DLQ where justified
```

This remains outside the investigation harness.

---

### Security Schema / Context Optimization

PRD-2 deliberately uses the simple strategy:

```text
load schema once
→ expose table names
→ model requests table schemas
```

Potential later improvements include:

```text
schema caching
automatic relevant-schema retrieval
more compact schema representations
context budgeting
schema search
```

These should only be introduced if schema size or discovery becomes an observed problem.

---

### Parallel Alert Processing

PRD-2 processes alerts sequentially for simplicity.

Because each alert creates an isolated Pi Agent and the harness does not share mutable run state, later parallel execution should not require redesigning the investigation agent.

---

### Case Memory + Tenant Context

A future memory capability may add:

```text
small curated tenant context
searchable previous human-confirmed cases
```

This should integrate around the existing harness/Pi boundary without reusing Pi conversation state between investigations.

A simple Hermes-style memory approach is a candidate for experimentation.

---

## 26. Final PRD-2 Boundary

PRD-2 can be summarized as:

```text
existing Mock Sentinel alerts
          ↓
sequential alert runner
          ↓
InvestigationHarness
          ↓
fresh Pi Agent
          │
          ├── selective schema discovery
          ├── raw KQL
          ├── constrained web search
          └── structured submission
          ↓
concise InvestigationSummary
          ↓
persistent run artifact
```

The implementation should remain deliberately small.

The purpose of PRD-2 is not to build the future SOC platform.

It is to create a clean, extensible experiment that answers the central question:

> Can an autonomous LLM investigator, with general access to security telemetry and public research, produce useful T1/T2 SOC assessments without predefined investigation playbooks?