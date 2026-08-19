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


### 5. Assessment Contract — What the Console Cannot Show

PRD-3's console pass surfaced four gaps that no amount of rendering can close, because the data is
not in the submission. Each needs a change to `InvestigationSummarySchema`
(`apps/investigator/src/contracts/summary.ts`) and therefore its own PRD.

Potential capabilities:

* **Evidence citations.** `keyEvidence` is `string[]`. An analyst reading "one matching event in
  `solarigate_beacon_umbrella_CL`" cannot get from that claim to the query that produced it — the
  KQL is two levels away in the Activity tab with nothing linking them. Carrying the `toolCallId`
  per evidence item would make the link real. This is the capability competing products lead with.
* **An incident timeline.** Every ground-truth scenario is a sequence — `session.start →
  privilege.grant → api_token.create → mfa.factor.deactivate`, four minutes — and `whatHappened` is
  prose that happens to contain the times. Reconstructing a timeline is a core T2 artefact, and the
  console cannot derive one without interpreting query results, which AGENTS.md §10 forbids.
* **Benign True Positive.** The TP/FP split cannot express "the detection is correct and the
  activity was authorised", which is one of the most common real dispositions. Microsoft Sentinel
  closes incidents on five classifications (`True Positive – suspicious activity`, `Benign Positive
  – suspicious but expected`, two `False Positive` variants, `Undetermined`); nothing in the current
  contract maps onto them, which also blocks any future write-back.
* **Alternative hypotheses, enumerated.** `fpReason` is a strong partial — it is already more than
  the shipping AI-SOC products expose — but the published evaluation checklists ask for hypotheses
  listed individually with the evidence that rejected each.

### 6. Evaluation at Scale

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
