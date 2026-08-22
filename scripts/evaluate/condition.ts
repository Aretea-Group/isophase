import { createHash } from "node:crypto";

import type { InvestigationRun } from "../../apps/investigator/src/contracts/run.ts";

/**
 * The comparison key, derived from what a run recorded (PRD-6 §5.1, §6.1; ADR 008 §3).
 *
 * `evaluate` used to group by `model.id` alone, so two model tables were really nine configurations
 * blended into two rows and the headline moved with whichever model happened to run under whichever
 * harness generation. The key is computed here, from the artifact, and is deliberately **not** a
 * field on any contract:
 *
 * - a declared taxonomy costs a contract edit per axis, and the axes are not known;
 * - a key stored at run time can be computed wrongly and is then wrong forever;
 * - legacy artifacts can never be recomputed into a declared taxonomy, and all 47 on disk resolve
 *   under a derived one.
 *
 * The concrete payoff is already visible: PRD-5's `config.analystContext` became a comparison axis
 * with no code here, because it lives inside `config` and `config` is hashed whole. A future memory
 * field arrives the same way.
 */

/** Every axis a report can render, resolved from one artifact. */
export interface ConditionFields {
  provider: string;
  model: string;
  thinkingLevel: string;
  resultMaxChars: string;
  webSearch: string;
  maxTurns: string;
  timeoutMs: string;
  sentinelBaseUrl: string;
  modelBaseUrl: string;
  modelContextWindow: string;
  modelMaxTokens: string;
  /** `baseline`, or `ctx=<hash6>` of the raw premise. Never the premise text itself. */
  analystContext: string;
  /** `researchDone`, `nextAction` or `?`, inferred from field presence when unrecorded. */
  submission: string;
  promptHash: string;
  submissionHash: string;
  piVersion: string;
  servedModel: string;
  corpus: string;
}

export interface Condition {
  id: string;
  fields: ConditionFields;
}

const UNKNOWN = "?";

/**
 * Recorded on `config`, deliberately **excluded** from the key.
 *
 * The key groups runs that were *set up* the same way. These fields describe what the agent then
 * did, and mixing the two fragments a cell for a reason that is a result rather than a setting:
 * two runs of the same model with the same limits would land in different conditions because the
 * agent happened to search the web in one of them and not the other — which is the very difference
 * the cell exists to average over.
 *
 * They stay on the artifact and stay in the report as columns. What is scored is the outcome
 * against ground truth; effort and cost are diagnostics beside it, never inputs to it.
 */
const OUTCOME_FIELDS = new Set(["webSearchUsed"]);

/** The configured half of `config` — everything the operator chose before the run started. */
function settingsOf(config: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (config === undefined) return null;
  return Object.fromEntries(Object.entries(config).filter(([key]) => !OUTCOME_FIELDS.has(key)));
}

function hash6(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 6);
}

/**
 * Sort object keys recursively so the hash does not depend on serialisation order.
 *
 * Two artifacts written by different code paths can carry the same `config` with the keys in a
 * different order; without this they would be two conditions for no reason a reader could see.
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .toSorted()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/**
 * The submission shape a run was scored against (PRD-6 §6.1, **D17**).
 *
 * The schema is unversioned, so for artifacts written before `provenance` this is inferred from
 * which fields the results actually carry. Marked `inferred` in the legend rather than presented as
 * recorded.
 */
export function submissionShape(run: InvestigationRun): string {
  for (const result of run.results) {
    if (result.summary?.researchDone !== undefined) return "researchDone";
    if (result.summary?.nextAction !== undefined) return "nextAction";
  }
  return UNKNOWN;
}

/**
 * A **named projection** of the provenance block — the one deliberate exception to hashing whole
 * objects (PRD-6 §6.1).
 *
 * `corpus.anchorUtc` and `corpus.offsetMs` are recorded on the artifact and never hashed: they move
 * on every `bun run data:bootstrap`, so hashing them would mint a fresh condition each time and no
 * two runs either side of one would ever share a cell. `alertSetHash` is what catches the change
 * that genuinely breaks the join (ADR 001, ADR 004).
 */
function provenanceKey(run: InvestigationRun): unknown {
  const provenance = run.provenance;
  if (provenance === undefined) return null;
  return {
    promptHash: provenance.promptHash,
    submissionHash: provenance.submissionHash,
    piVersion: provenance.piVersion,
    servedModelId: provenance.servedModelId ?? null,
    telemetryRevision: provenance.corpus?.telemetryRevision ?? null,
    alertSetHash: provenance.corpus?.alertSetHash ?? null,
    queryMaxRows: provenance.corpus?.queryMaxRows ?? null,
  };
}

/**
 * Group runs by everything they recorded.
 *
 * **An absent field is a value, never a wildcard** (PRD-6 §5.2). A run that recorded no thinking
 * level renders `think=?`, and `?` never merges with `medium`. Treating absence as "probably the
 * default" is how the fabricated `medium` of **D12** stayed invisible.
 */
export function conditionOf(run: InvestigationRun): Condition {
  const config = run.config;
  const provenance = run.provenance;

  const fields: ConditionFields = {
    provider: run.model.provider,
    model: run.model.id,
    thinkingLevel: config?.thinkingLevel ?? UNKNOWN,
    resultMaxChars: config === undefined ? UNKNOWN : String(config.resultMaxChars),
    webSearch: config === undefined ? UNKNOWN : config.webSearchConfigured ? "on" : "off",
    maxTurns: String(run.limits.maxTurns),
    timeoutMs: String(run.limits.timeoutMs),
    sentinelBaseUrl: config?.sentinelBaseUrl ?? UNKNOWN,
    modelBaseUrl: config?.modelBaseUrl ?? UNKNOWN,
    modelContextWindow:
      config?.modelContextWindow === undefined ? UNKNOWN : String(config.modelContextWindow),
    modelMaxTokens: config?.modelMaxTokens === undefined ? UNKNOWN : String(config.modelMaxTokens),
    analystContext:
      config?.analystContext === undefined || config.analystContext === ""
        ? "baseline"
        : `ctx=${hash6(config.analystContext)}`,
    submission: submissionShape(run),
    promptHash: provenance?.promptHash ?? UNKNOWN,
    submissionHash: provenance?.submissionHash ?? UNKNOWN,
    piVersion: provenance?.piVersion ?? UNKNOWN,
    servedModel: provenance?.servedModelId ?? UNKNOWN,
    corpus: provenance?.corpus?.alertSetHash ?? UNKNOWN,
  };

  // The whole of `config` and `limits`, not named members — that is the point of a derived key.
  const id = hash6(
    JSON.stringify(
      sortKeys({
        provider: run.model.provider,
        model: run.model.id,
        // Settings only. `webSearchUsed` and anything else describing what happened is excluded,
        // or an outcome would decide which runs are comparable (see OUTCOME_FIELDS).
        config: settingsOf(config as Record<string, unknown> | undefined),
        limits: run.limits,
        submission: fields.submission,
        provenance: provenanceKey(run),
      }),
    ),
  );

  return { id, fields };
}

/** Axes in the order a label renders them. `provider` and the URLs stay out of the short form. */
const LABEL_AXES: { key: keyof ConditionFields; render: (value: string) => string }[] = [
  { key: "model", render: (value) => value },
  { key: "thinkingLevel", render: (value) => `think=${value}` },
  { key: "submission", render: (value) => `sub=${value}` },
  { key: "webSearch", render: (value) => `web=${value}` },
  { key: "resultMaxChars", render: (value) => `rows=${value}` },
  { key: "maxTurns", render: (value) => `turns=${value}` },
  { key: "timeoutMs", render: (value) => `timeout=${value}` },
  { key: "promptHash", render: (value) => `p=${value}` },
  { key: "submissionHash", render: (value) => `s=${value}` },
  { key: "piVersion", render: (value) => `pi=${value}` },
  { key: "servedModel", render: (value) => `served=${value}` },
  { key: "corpus", render: (value) => `corpus=${value}` },
  { key: "analystContext", render: (value) => value },
];

/**
 * Render one label per condition, showing only the axes that differ within this report.
 *
 * **A label must never collapse two distinct ids** (PRD-6 §8.5). Measured before this landed, two
 * conditions rendered identically as `gpt-5.6-luna · think=medium · sub=researchDone` and differed
 * only by `webSearchConfigured` — twelve runs with the web available and one without. `web=off` is
 * exactly the kind of axis a reader would never think to ask about.
 *
 * Showing differing axes is not sufficient on its own, since two conditions can differ only in an
 * axis the short form omits. So the id is appended to any label that would otherwise tie, and the
 * test asserts the property rather than the rendering.
 */
export function labelsFor(conditions: readonly Condition[]): Map<string, string> {
  const unique = new Map(conditions.map((condition) => [condition.id, condition]));
  const all = [...unique.values()];

  const varying = LABEL_AXES.filter(
    (axis) => new Set(all.map((condition) => condition.fields[axis.key])).size > 1,
  );
  // With one condition nothing varies, and a bare id is not a label anyone can read.
  const axes = varying.length === 0 ? LABEL_AXES.slice(0, 3) : varying;

  const labels = new Map<string, string>();
  for (const condition of all) {
    labels.set(
      condition.id,
      axes.map((axis) => axis.render(condition.fields[axis.key])).join(" · "),
    );
  }

  const counts = new Map<string, number>();
  for (const label of labels.values()) counts.set(label, (counts.get(label) ?? 0) + 1);
  for (const [id, label] of labels) {
    if ((counts.get(label) ?? 0) > 1) labels.set(id, `${label} · ${id}`);
  }
  return labels;
}

/** What differs between two conditions, for `--compare` to print instead of two opaque ids. */
export function fieldDiff(a: Condition, b: Condition): { field: string; a: string; b: string }[] {
  const keys = Object.keys(a.fields) as (keyof ConditionFields)[];
  return keys
    .filter((key) => a.fields[key] !== b.fields[key])
    .map((key) => ({ field: key, a: a.fields[key], b: b.fields[key] }));
}
