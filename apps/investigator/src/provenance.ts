import { createHash } from "node:crypto";

import packageJson from "../package.json" with { type: "json" };
import { buildInitialContext } from "./context.ts";
import { InvestigationSummarySchema } from "./contracts/summary.ts";
import {
  DEFAULT_INSTRUCTIONS,
  SUBMISSION_DEADLINE_REMINDER,
  SUBMISSION_FOLLOW_UP,
} from "./instructions.ts";
import type { SecuritySourceProfile } from "./source-profile.ts";
import { toolDescriptors } from "./tools/index.ts";

/**
 * What produced this run (PRD-6 §6.6, ADR 008 §1).
 *
 * Derived from source, never from configuration, which is why this is not a fourth file reading the
 * environment beside `mock-sentinel/src/config.ts`, `investigator/src/env.ts` and
 * `console/src/env.ts` (ADR 005 §6).
 *
 * The problem it solves is that the prompt axis was not merely unrecorded, it was **unrecordable**.
 * `DEFAULT_INSTRUCTIONS` reaches the harness by module import and `RunConfig` has no `instructions`
 * field, so two artifacts could agree on every recorded field and still have been produced by
 * different software. Steering and case memory are both prompt changes, so this blocks all three of
 * the axes evaluation exists to compare.
 */

/** Legibility only — the hash is the truth. Two runs sharing this with different hashes is a defect. */
export const INSTRUCTIONS_LABEL = "soc-triage-v11-source-profile";

function hash12(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/**
 * A stable serialisation of a TypeBox schema.
 *
 * Keys sorted recursively: TypeBox builds its objects in declaration order, so a harmless
 * reordering of a schema's properties would otherwise mint a new condition and read as a prompt
 * change that never happened.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .toSorted()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/**
 * Everything the model is told, hashed together.
 *
 * **Not an instructions-only hash.** A tool description is an instruction in every sense that
 * matters — it is in the model's context and it changes behaviour — so an instructions-only hash
 * would call two materially different agents the same agent. The five tools contribute their name,
 * description and serialised parameters in name order.
 *
 * `buildInitialContext` contributes its *template* with the alert and the table list elided: those
 * vary per investigation and per bootstrap, and hashing them would mint a fresh condition for every
 * alert. What is captured is the framing around them, which is the part that is a prompt decision.
 */
export function computePromptHash(profile: SecuritySourceProfile): string {
  const tools = toolDescriptors(profile).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: canonical(tool.parameters),
  }));

  const contextTemplate = buildInitialContext(
    profile,
    {
      id: "",
      title: "",
      description: "",
      tactics: [],
      techniques: [],
      entities: [],
      native: null,
    },
    [],
    undefined,
  );

  return hash12(
    JSON.stringify({
      instructions: DEFAULT_INSTRUCTIONS,
      queryGuidance: {
        triggerTools: profile.guidanceActivationTools,
        instructions: profile.queryGuidance,
      },
      submissionDeadlineReminder: SUBMISSION_DEADLINE_REMINDER,
      submissionFollowUp: SUBMISSION_FOLLOW_UP,
      tools,
      contextTemplate,
    }),
  );
}

/**
 * The submission schema, hashed **separately** from the prompt.
 *
 * That is what actually split this corpus — `summary.nextAction` became `summary.researchDone` and
 * eight artifacts predate the change — and a reader needs to see which of the two moved rather than
 * one combined number that says only "something did" (**D17**).
 */
export function computeSubmissionHash(): string {
  return hash12(JSON.stringify(canonical(InvestigationSummarySchema)));
}

/**
 * The pinned Pi versions, read from the declared dependency rather than from `node_modules`.
 *
 * A runtime resolve would trip `ground-truth-isolation.test.ts`'s caller-supplied-path scan, and
 * this is a static JSON import instead. The accepted gap: a `bun update` inside the range moves the
 * real version without moving this string. pi-ai owns both the dollar figures and the meaning of
 * `thinkingLevel`, so when it moves, everything downstream of it moves too.
 */
export function computePiVersion(): string {
  const dependencies = packageJson.dependencies as Record<string, string>;
  const core = dependencies["@earendil-works/pi-agent-core"] ?? "?";
  const ai = dependencies["@earendil-works/pi-ai"] ?? "?";
  return `core@${core}+ai@${ai}`;
}

export function provenanceForProfile(profile: SecuritySourceProfile) {
  return {
    promptHash: computePromptHash(profile),
    submissionHash: computeSubmissionHash(),
    piVersion: computePiVersion(),
    instructionsLabel: INSTRUCTIONS_LABEL,
  } as const;
}
