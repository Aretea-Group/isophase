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


### 5. Evaluation at Scale

Exercise the investigator beyond the six alerts that have ground truth, and close the verification
gaps PRD-2 left open.

Potential capabilities:

* Run the full 151-alert sweep — aggregate failure rate, cost and step-limit behaviour at scale are
  currently unknown, since every run to date has covered a single alert
* Exercise the investigation timeout, which is implemented and wired but has never fired
* Expand ground-truth coverage beyond six scenarios — with n=6, two impact judgements have already
  been observed flipping in opposite directions between runs differing only in wording that does not
  touch impact, so single-point score movements are variance rather than signal
* Spot-check alerts that have no ground truth, to catch reasoning failures the six scenarios
  structurally cannot see
* Model-tier comparison as a product question: terra-class reasoning cleared the calibration control
  that luna failed, at roughly ten times the token price
