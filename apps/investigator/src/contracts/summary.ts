import { Type, type Static } from "@earendil-works/pi-ai";

/**
 * The analyst-facing investigation result (PRD-2 §14).
 *
 * TypeBox rather than Zod because this doubles as the `submit_investigation` tool's parameter
 * schema, and pi-agent-core types `AgentTool.parameters` as a TypeBox `TSchema` with no Zod path.
 * Pi validates arguments against it before the tool executes, so every bound below is enforced for
 * free and a violation reaches the model as a correctable tool error (ADR 005).
 *
 * `additionalProperties: false` matters: PRD-2 §14 requires unknown properties to be rejected.
 *
 * Two amendments to PRD-2 §14/§15, recorded in ADR 005 §1:
 *
 * `impact` was added because a single TP/FP axis cannot express "the detection is real but its
 * significance is unknowable" — which is exactly what the calibration scenario tests, and what an
 * investigation got wrong by answering TP 95%. The scenario fixtures have always carried `verdict`
 * and `impact` as separate fields; collapsing them into one number lost information the agent was
 * already reasoning about in prose.
 *
 * `nextAction` was replaced by `researchDone`. Nothing scored the recommended action, PRD-2 §15
 * already excludes a remediation plan from scope, and it was the field that overran its length
 * limit in a live run and cost a turn to correct. `researchDone` earns its place differently: it
 * records the negative space. "Checked X, found nothing" is a materially different claim from never
 * having checked X, and both observed failures turn on that distinction — one hinged on absent
 * corroboration, the other on a line of enquiry never opened. Coverage is visible in the trace, but
 * traces are optional and the artifact is what evaluation reads.
 */
export const InvestigationSummarySchema = Type.Object(
  {
    tpPercent: Type.Integer({
      minimum: 0,
      maximum: 100,
      description: "Likelihood this alert is a true positive. Must sum to 100 with fpPercent.",
    }),
    tpReason: Type.String({
      minLength: 1,
      maxLength: 500,
      description: "Why the evidence supports a true positive.",
    }),
    fpPercent: Type.Integer({
      minimum: 0,
      maximum: 100,
      description: "Likelihood this alert is a false positive. Must sum to 100 with tpPercent.",
    }),
    fpReason: Type.String({
      minLength: 1,
      maxLength: 500,
      description: "Why the evidence supports a false positive.",
    }),
    whatHappened: Type.String({
      minLength: 1,
      maxLength: 1000,
      description:
        "What actually happened, for an analyst who has not seen the alert. Name the accounts, hosts, addresses and times that matter.",
    }),
    impact: Type.Union(
      [
        Type.Literal("none"),
        Type.Literal("contained"),
        Type.Literal("confirmed-compromise"),
        Type.Literal("unknown"),
      ],
      {
        description:
          "What the activity actually achieved, independent of whether it was malicious. 'none' = attempted and failed; 'contained' = succeeded but was stopped or reverted; 'confirmed-compromise' = achieved something that matters; 'unknown' = the available telemetry cannot say.",
      },
    ),
    keyEvidence: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
      minItems: 1,
      maxItems: 6,
      description:
        "The findings the assessment rests on. Cite the source for anything drawn from the public web.",
    }),
    researchDone: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), {
      minItems: 1,
      maxItems: 8,
      description:
        "What you actually checked, including lines of enquiry that came back empty. An analyst needs to know where you looked and found nothing, not only what you found.",
    }),
  },
  { additionalProperties: false },
);

export type InvestigationSummary = Static<typeof InvestigationSummarySchema>;

/**
 * The one rule TypeBox cannot express (PRD-2 §14).
 *
 * Checked in tool execution and thrown, so an invalid submission does not complete the
 * investigation and the agent can correct and resubmit (PRD-2 §16).
 */
export function assertPercentagesSumTo100(summary: InvestigationSummary): void {
  const total = summary.tpPercent + summary.fpPercent;
  if (total !== 100) {
    throw new Error(
      `tpPercent + fpPercent must equal 100, got ${summary.tpPercent} + ${summary.fpPercent} = ${total}. Resubmit with percentages that sum to 100.`,
    );
  }
}
