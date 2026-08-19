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
    keyEvidence: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
      minItems: 1,
      maxItems: 6,
      description:
        "The findings the assessment rests on. Cite the source for anything drawn from the public web.",
    }),
    nextAction: Type.String({
      minLength: 1,
      maxLength: 500,
      description: "What the human analyst should do next.",
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
