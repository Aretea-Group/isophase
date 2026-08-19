import type { RunArtifact, RunResult } from "../../data/runs.ts";
import type { Aggregate, RunTotals } from "../../data/stats.ts";
import type { TraceIndex } from "../../data/trace-index.ts";
import type { ConsoleEnv } from "../../env.ts";
import { toActivityView, type ActivityRow } from "../../view/activity.ts";
import { entityPairs, remediationLines, type AlertFacts } from "../../view/alert.ts";
import { DATA_SOURCES, toConfigRows } from "../../view/config.ts";
import {
  bandLabel,
  bandTone,
  severityTone,
  chars,
  clockTime,
  cost,
  duration,
  pad,
  tokens,
  tpBar,
  truncate,
  wrap,
  type Line,
  type Tone,
} from "../../view/format.ts";
import { toVerdictView, type VerdictView } from "../../view/verdict.ts";

/** The bar never shrinks past being readable, nor grows past being scannable. */
const MIN_BAR_WIDTH = 12;
const MAX_BAR_WIDTH = 40;

/** A labelled, wrapped row — the shape `ENTITIES` and `MITRE ATT&CK` share. */
function labelledBlock(label: string, value: string, width: number, tone?: Tone): Line[] {
  if (value === "") return [];
  const gutter = `  ${label.padEnd(14)}`;
  const wrapped = wrap(value, Math.max(12, width - gutter.length - 2));
  return wrapped.map((line, at): Line => [
    { text: at === 0 ? gutter : " ".repeat(gutter.length), tone: "label" },
    { text: line, tone },
  ]);
}

/**
 * The verdict line.
 *
 * Band word, split, and impact together, because they answer one question between them: is this
 * real, how sure are we, and did it achieve anything. The bar takes whatever width is left; when
 * there is not enough for a legible one, impact moves to its own line rather than being dropped.
 */
function verdictHead(view: VerdictView, width: number): Line[] {
  const band = bandLabel(view.band);
  const tp = `   TP ${String(view.tpPercent ?? "—").padStart(3)}%  `;
  const fp = `  FP ${view.fpPercent ?? "—"}%`;
  const fixed = 2 + band.length + tp.length + fp.length;
  const barWidth = Math.max(MIN_BAR_WIDTH, Math.min(MAX_BAR_WIDTH, Math.max(0, width - fixed) - 2));

  return [
    [
      { text: `  ${band}`, tone: bandTone(view.band), bold: true },
      { text: tp },
      { text: tpBar(view.tpPercent, barWidth) },
      { text: fp },
    ],
    "",
  ];
}

export function verdictBody(
  result: RunResult,
  facts: AlertFacts | undefined,
  width: number,
): Line[] {
  const view = toVerdictView(result);
  const lines: Line[] = [];

  if (view.failed && view.error !== undefined) {
    lines.push("", [{ text: `  FAILED — ${view.error.name}`, tone: "failed", bold: true }], "");
    lines.push(...wrap(view.error.message, width - 4).map((l) => `  ${l}`));
    return lines;
  }

  // Severity, when it happened and what it hit, repeated from pane [1] — which is hidden below
  // 100 columns, where this pane is all there is (PRD-3 §9.6).
  if (facts !== undefined) {
    lines.push("", [
      { text: `  ${facts.severityTag.trim()}`, tone: severityTone(facts.severity), bold: true },
      { text: "   incident ", tone: "label" },
      { text: facts.window },
      { text: "   asset ", tone: "label" },
      { text: facts.compromisedEntity ?? "—" },
    ]);
    lines.push("");
  }

  // The verdict leads, then what it is a verdict about, then the case for and against it.
  //
  // The headline is the thing an analyst is looking for when they open a case. What it must not do
  // is stand alone above the evidence — leading with a confidence score and nothing else is the
  // shape practitioner critiques of AI triage blame for analysts ratifying a number rather than
  // weighing it. So the narrative sits between the score and the argument that produced it.
  lines.push(...verdictHead(view, width));

  // Entities directly under the classification: they are what the verdict is *about*, and the
  // pair reads as one header block. Below 100 columns panes [1] and [3] are hidden and this is
  // the only place the pivot identifiers appear at all (PRD-3 §9.6).
  if (facts !== undefined) {
    const entities = labelledBlock("ENTITIES", entityPairs(facts).join(" · "), width);
    if (entities.length > 0) lines.push(...entities, "");
  }

  if (facts?.description !== undefined && facts.description.trim() !== "") {
    lines.push([{ text: "  WHY THE ALERT FIRED", tone: "heading", bold: true }]);
    lines.push(...wrap(facts.description, width - 4).map((l) => `  ${l}`));
    lines.push("");
  }

  const narrative = view.blocks.find((block) => block.key === "what");
  if (narrative !== undefined) {
    lines.push([{ text: "  WHAT HAPPENED", tone: "heading", bold: true }]);
    if (facts !== undefined) {
      lines.push(
        ...labelledBlock(
          "MITRE ATT&CK",
          [...facts.tactics, ...facts.techniques].join(" · "),
          width,
          "accent",
        ),
      );
    }
    for (const paragraph of narrative.lines) {
      lines.push(...wrap(paragraph, width - 4).map((l) => `  ${l}`));
    }
    lines.push("");
  }

  for (const block of view.blocks) {
    if (block.key === "what") continue;
    lines.push([{ text: `  ${block.heading.toUpperCase()}`, tone: "heading", bold: true }]);

    if (block.list) {
      for (const [i, item] of block.lines.entries()) {
        const wrapped = wrap(item, width - 7);
        lines.push(`  ${String(i + 1).padStart(2)}  ${wrapped[0] ?? ""}`);
        lines.push(...wrapped.slice(1).map((l) => `      ${l}`));
      }
    } else {
      for (const paragraph of block.lines) {
        lines.push(...wrap(paragraph, width - 4).map((l) => `  ${l}`));
      }
    }
    lines.push("");
  }

  if (facts !== undefined) lines.push(...remediationLines(facts, width), "");

  if (view.absent.length > 0) {
    lines.push([{ text: `  not recorded by this run: ${view.absent.join(", ")}`, tone: "label" }]);
  }
  return lines;
}

export interface ActivityRender {
  lines: Line[];
  /** Row index -> the underlying activity row, so a selection can be resolved back. */
  selectable: ActivityRow[];
}

/** Query calls are the investigation; the rest is scaffolding around them. */
function toolTone(toolName: string): Tone {
  if (toolName === "query_security_data") return "accent";
  if (toolName === "submit_investigation") return "ok";
  return "label";
}

export function activityBody(index: TraceIndex, width: number, selected: number): ActivityRender {
  const view = toActivityView(index);
  const lines: Line[] = [];
  const selectable: ActivityRow[] = [];

  for (const row of view.rows) {
    if (row.kind === "turn") {
      lines.push([
        { text: ` turn ${String(row.index).padEnd(2)} `, tone: "heading", bold: true },
        { text: `${row.at}  `, tone: "dim" },
        { text: row.tokens.padStart(8), tone: "label" },
        { text: `  ${row.cost}`, tone: "dim" },
      ]);
      continue;
    }
    const isSelected = selectable.length === selected;
    lines.push([
      { text: isSelected ? "▶" : " ", tone: "accent" },
      { text: `${String(row.seq).padStart(2)} `, tone: "dim" },
      { text: `${row.at} `, tone: "dim" },
      { text: row.isError ? "✗" : " ", tone: "failed" },
      { text: pad(row.toolName, 20), tone: toolTone(row.toolName), bold: isSelected },
      { text: ` ${pad(row.summary, Math.max(8, width - 46))} ` },
      { text: row.size, tone: "dim" },
    ]);
    selectable.push(row);
  }

  lines.push("", [
    { text: ` ${view.turnCount} turns · ${view.callCount} calls · ` },
    { text: `${view.errors} errored`, tone: view.errors > 0 ? "failed" : "dim" },
  ]);
  lines.push([
    { text: " tables  ", tone: "label" },
    view.tables.length === 0
      ? { text: "none queried", tone: "dim" }
      : {
          text: view.tables.map((t) => `${t.name}${t.count > 0 ? ` ×${t.count}` : ""}`).join("  "),
          tone: "accent",
        },
  ]);
  lines.push([
    { text: " web     ", tone: "label" },
    view.searches.length === 0 && view.fetches.length === 0
      ? { text: "no web_search / web_fetch calls in this investigation", tone: "dim" }
      : { text: `${view.searches.length} search(es), ${view.fetches.length} fetch(es)` },
  ]);
  for (const query of view.searches) {
    lines.push([{ text: "         search: ", tone: "dim" }, { text: truncate(query, width - 18) }]);
  }
  for (const url of view.fetches) {
    lines.push([{ text: "         fetch:  ", tone: "dim" }, { text: truncate(url, width - 18) }]);
  }

  // Counted since PRD-3 and reported nowhere, which meant a transcript whose format had moved on
  // rendered as a thinner investigation rather than as one the console could not fully read.
  if (index.unparsed > 0) {
    lines.push(
      [
        {
          text: ` ! ${index.unparsed} line(s) of this transcript were not understood — it may predate the`,
          tone: "inconclusive",
        },
      ],
      [
        {
          text: "   current trace format, so what is above may be incomplete",
          tone: "inconclusive",
        },
      ],
    );
  }

  return { lines, selectable };
}

/**
 * One call's arguments as written — the exact KQL, unwrapped from its JSON envelope.
 *
 * Shared by the detail pane and `y`, so what gets copied is character-for-character what is on
 * screen rather than a second rendering of it.
 */
export function callArgsText(row: ActivityRow): string {
  if (row.kind !== "call") return "";
  const args = row.call.args;
  return typeof args === "object" && args !== null && "kql" in args && typeof args.kql === "string"
    ? args.kql
    : JSON.stringify(args, undefined, 2);
}

/** The full arguments of one call — the exact KQL as the agent wrote it (PRD-3 §8.3). */
export function callDetail(row: ActivityRow, width: number): Line[] {
  if (row.kind !== "call") return [];
  const lines: Line[] = [
    [{ text: ` ${row.toolName}`, tone: "heading", bold: true }],
    [{ text: ` ${row.call.toolCallId.slice(0, 24)}…  ${clockTime(row.call.at)}`, tone: "dim" }],
    [
      { text: ` ${row.isError ? "ERROR" : "ok"}`, tone: row.isError ? "failed" : "ok" },
      { text: ` · ${chars(row.call.resultChars)}`, tone: "dim" },
    ],
    "",
    [{ text: " ARGUMENTS", tone: "heading", bold: true }],
  ];
  const text = callArgsText(row);
  for (const line of String(text).split("\n")) {
    lines.push(...wrap(line, width - 2).map((l): Line => [{ text: ` ${l}`, tone: "accent" }]));
  }
  lines.push("", [
    {
      text: ` RESULT — first ${chars(row.call.resultPreview?.length)} of ${chars(row.call.resultChars)}`,
      tone: "heading",
      bold: true,
    },
  ]);
  for (const line of (row.call.resultPreview ?? "").split("\n").slice(0, 40)) {
    lines.push(` ${truncate(line, width - 2)}`);
  }
  return lines;
}

/**
 * The live feed.
 *
 * One line per turn and one per tool call, which is the same shape `trace.ts` narrates to stdout,
 * so the console and the terminal log agree rather than competing (PRD-3 §8.4).
 */
export function streamBody(index: TraceIndex, width: number): Line[] {
  const lines: Line[] = [
    [
      { text: `  ${clockTime(index.startedAt)}  `, tone: "dim" },
      { text: "agent start", tone: "heading", bold: true },
    ],
  ];
  const view = toActivityView(index);

  for (const row of view.rows) {
    if (row.kind === "turn") {
      lines.push([
        { text: "  ├─ ", tone: "dim" },
        { text: `turn ${String(row.index).padEnd(3)} `, tone: "heading", bold: true },
        { text: row.tokens.padStart(9), tone: "label" },
        {
          text: `  ${row.pending === true ? "in progress…" : row.cost}`,
          tone: row.pending === true ? "running" : "dim",
        },
      ]);
      const turn = index.turns.find((t) => t.index === row.index);
      if (turn?.thinkingPreview !== undefined && turn.thinkingPreview.trim() !== "") {
        lines.push([
          { text: "  │  · ", tone: "dim" },
          { text: truncate(turn.thinkingPreview, width - 8), tone: "dim" },
        ]);
      }
      continue;
    }
    lines.push([
      { text: "  │  → ", tone: "dim" },
      { text: pad(row.toolName, 22), tone: toolTone(row.toolName) },
      { text: ` ${truncate(row.summary, width - 32)}` },
    ]);
    lines.push(
      row.isError
        ? [
            { text: "  │  ✗ ", tone: "failed" },
            { text: pad(row.toolName, 22), tone: "failed" },
            { text: " ERROR", tone: "failed" },
          ]
        : [
            { text: "  │  ← ", tone: "dim" },
            { text: pad(row.toolName, 22), tone: "label" },
            { text: ` ${row.size}`, tone: "dim" },
          ],
    );
  }

  lines.push(
    index.complete
      ? [{ text: `  └─ finished after ${index.turns.length} turn(s)`, tone: "ok" }]
      : [{ text: "  ├─ …", tone: "running" }],
  );
  return lines;
}

export function configBody(
  run: RunArtifact | undefined,
  env: ConsoleEnv,
  aggregate: Aggregate | undefined,
  totals: RunTotals | undefined,
  width: number,
): Line[] {
  const lines: Line[] = [
    "",
    [
      { text: `  ${pad("", 26)}` },
      { text: pad(`THIS RUN  ${run?.runId.slice(0, 8) ?? "—"}`, 30), tone: "heading", bold: true },
      { text: "CURRENT ENV", tone: "heading", bold: true },
    ],
  ];
  for (const row of toConfigRows(run, env)) {
    // The last column is truncated rather than left to soft-wrap: an over-long value wrapped to
    // column 0 and read as a broken row rather than as a long one.
    lines.push([
      { text: `  ${pad(row.label, 26)}`, tone: "label" },
      { text: pad(row.thisRun, 30) },
      { text: truncate(row.currentEnv, Math.max(8, width - 58)), tone: "dim" },
    ]);
  }

  lines.push("", [{ text: "  DATA SOURCES", tone: "heading", bold: true }]);
  for (const source of DATA_SOURCES) {
    lines.push([
      { text: `  ${pad(source.label, 26)}`, tone: "label" },
      { text: truncate(source.detail, width - 30) },
    ]);
  }

  if (totals !== undefined) {
    lines.push("", [{ text: "  THIS RUN", tone: "heading", bold: true }]);
    lines.push(
      `  ${pad("tokens", 26)}${tokens(totals.tokens)}${totals.partial ? `  partial — ${totals.tracedAlerts} of ${totals.totalAlerts} alerts traced` : ""}`,
    );
    lines.push(`  ${pad("cost", 26)}${cost(totals.cost)}`);
  }

  lines.push("", [
    { text: "  TOKENS & COST", tone: "heading", bold: true },
    {
      text:
        aggregate === undefined
          ? ""
          : `   over ${aggregate.traced} traced investigation(s) of ${aggregate.total}`,
      tone: "label",
    },
  ]);
  if (aggregate?.tokens !== undefined) {
    lines.push(
      `  ${pad("billed tokens / inv", 26)}avg ${pad(tokens(Math.round(aggregate.tokens.avg)), 10)}min ${pad(tokens(aggregate.tokens.min), 10)}max ${tokens(aggregate.tokens.max)}`,
    );
  }
  if (aggregate?.cost !== undefined) {
    lines.push(
      `  ${pad("cost / inv", 26)}avg ${pad(cost(aggregate.cost.avg), 10)}min ${pad(cost(aggregate.cost.min), 10)}max ${cost(aggregate.cost.max)}`,
    );
  }
  if (aggregate?.turns !== undefined) {
    lines.push(
      `  ${pad("turns / inv", 26)}avg ${pad(aggregate.turns.avg.toFixed(1), 10)}min ${pad(String(aggregate.turns.min), 10)}max ${aggregate.turns.max}`,
    );
  }
  if (aggregate?.calls !== undefined) {
    lines.push(
      `  ${pad("tool calls / inv", 26)}avg ${pad(aggregate.calls.avg.toFixed(1), 10)}min ${pad(String(aggregate.calls.min), 10)}max ${aggregate.calls.max}`,
    );
  }
  if (aggregate !== undefined) {
    lines.push(`  ${pad("total spend, all runs", 26)}${cost(aggregate.totalSpend)}`);
    const untraced = aggregate.total - aggregate.traced;
    if (untraced > 0) {
      lines.push([
        {
          text: `  ! ${untraced} investigation(s) have no transcript — their tokens are not counted (INVESTIGATOR_TRACE was off)`,
          tone: "inconclusive",
        },
      ]);
    }
    if (!aggregate.complete) lines.push("  … still indexing transcripts; figures are partial");
  }
  lines.push(
    "",
    `  ${duration(env.INVESTIGATOR_TIMEOUT_MS)} per-alert ceiling · ${env.INVESTIGATOR_MAX_TURNS} turn ceiling`,
  );
  return lines;
}
