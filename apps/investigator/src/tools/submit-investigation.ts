import type { AgentTool } from "@earendil-works/pi-agent-core";

import {
  assertPercentagesSumTo100,
  InvestigationSummarySchema,
  type InvestigationSummary,
} from "../contracts/summary.ts";

/**
 * The Definition of Done for an investigation (PRD-2 §14).
 *
 * A valid call here is the only thing that completes a run — a normal assistant message, however
 * complete it reads, is never converted into a result (PRD-2 §16).
 *
 * Field-level constraints are enforced by Pi against the TypeBox schema before this executes. The
 * one rule the schema cannot express, `tpPercent + fpPercent === 100`, is checked here and thrown,
 * which leaves the loop running so the agent can correct and resubmit.
 *
 * `terminate: true` is a fast path, not the stop: Pi only honours it when every result in the batch
 * sets it, so a submission issued alongside a parallel query would be ignored. The harness's
 * `shouldStopAfterTurn` is the authoritative stop.
 */
/** Name, description and schema — everything the model sees, hashed by `provenance.ts`. */
export const SUBMIT_INVESTIGATION = {
  name: "submit_investigation",
  label: "Submit investigation",
  description:
    "Submit your final assessment and end the investigation. tpPercent and fpPercent must sum to 100 — express uncertainty through the split rather than hedging in prose.",
  parameters: InvestigationSummarySchema,
} as const;

export function createSubmitInvestigationTool(
  onSubmit: (summary: InvestigationSummary) => void,
): AgentTool<typeof InvestigationSummarySchema> {
  return {
    ...SUBMIT_INVESTIGATION,
    execute: async (_toolCallId, params) => {
      assertPercentagesSumTo100(params);
      onSubmit(params);

      return {
        content: [{ type: "text", text: "Investigation submitted." }],
        details: { tpPercent: params.tpPercent, fpPercent: params.fpPercent },
        terminate: true,
      };
    },
  };
}
