## Roadmap

### 1. Case Memory + Tenant Context

Introduce durable, tenant-specific context that can improve future investigations without simply reusing previous agent conversations.

Potential capabilities:

* Curated tenant knowledge
* Searchable previous investigations
* Human-confirmed case outcomes
* Simple Hermes-style memory as an initial implementation

### 2. Human Feedback

Capture the human analyst's final decision and corrections after an investigation.

Potential capabilities:

* Analyst TP/FP verdict
* Corrections to the agent's assessment
* Feed confirmed outcomes into case memory
* Feed outcomes into evaluation and regression

### 3. Security Schema & Context Optimization

Improve how the agent discovers and consumes large security-data schemas as environments grow.

Potential capabilities:

* Schema caching
* Schema search
* Automatic relevant-schema selection
* Context budgeting

### 4. Safe Web Search Harness

Strengthen the boundary between the investigation agent and untrusted public internet content.

Potential capabilities:

* Prompt-injection protection
* Explicit treatment of web content as untrusted data
* Sanitization or isolation of retrieved content
* Controlled result size and context usage
* Safe handling of malicious or adversarial web content
* Maintain a constrained search interface without exposing arbitrary network access

