import type { RunArtifact, RunResult } from "../../data/runs.ts";
import type { Aggregate, RunTotals } from "../../data/stats.ts";
import type { TraceIndex } from "../../data/trace-index.ts";
import type { ConsoleEnv } from "../../env.ts";
import { summariseArgs, toActivityView, type ActivityRow } from "../../view/activity.ts";
import { entityPairs, remediationLines, type AlertFacts } from "../../view/alert.ts";
import { DATA_SOURCES, toConfigRows } from "../../view/config.ts";
import {
  alignDecimal,
  bandLabel,
  bandTone,
  columns,
  severityTone,
  chars,
  clockTime,
  cost,
  duration,
  inlineBold,
  pad,
  prose,
  plural,
  tokens,
  tpBar,
  truncate,
  wrap,
  type Line,
  type Tone,
} from "../../view/format.ts";
import { COLUMN_GUTTER, balancedCuts, columnCount } from "../../view/layout.ts";
import { toVerdictView, type VerdictView } from "../../view/verdict.ts";

/** The bar never shrinks past being readable, nor grows past being scannable. */
const MIN_BAR_WIDTH = 12;
const MAX_BAR_WIDTH = 40;

/**
 * One cell of the configuration table, with a column of its own kept clear.
 *
 * `pad` fills to exactly its width, so a value the length of its column touched the next one:
 * `total spend, all ru…$0.053` read as a single token rather than as a label and a figure.
 */
function cell(text: string, width: number): string {
  return pad(truncate(text, width - 1), width);
}

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
 * The divider that closes the header block.
 *
 * Drawn once, hanging off the bottom of the band and entities rather than sitting above the first
 * heading: attached to the heading it read as decoration on that one section, and a rule above
 * every section turned the verdict into a column of boxes that read louder than the headings it
 * was there to separate. Sized to the prose right edge rather than the pane's, which the scrollbar
 * takes a column of.
 */
function sectionRule(width: number): Line {
  return [{ text: `  ${"\u2500".repeat(Math.max(0, width - 4))}`, tone: "rule" }];
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

/**
 * Severity, when it happened and what it hit, repeated from pane [1] — which is hidden below 100
 * columns, where the main pane is all there is (PRD-3 §9.6).
 */
function factsHead(facts: AlertFacts | undefined, width: number): Line[] {
  if (facts === undefined) return [];
  const asset = facts.compromisedEntity ?? "—";
  // The same em dash every other absent field uses. `severityTag` is blank-padded when nothing was
  // recorded, so trimming it opened this line with a gap and no explanation for it.
  const tag = facts.severityTag.trim();
  const severity: Line[number] = {
    text: `  ${tag === "" ? "—" : tag}`,
    tone: severityTone(facts.severity),
    bold: true,
  };

  // One line if it fits, stacked if it does not. It was a single unbreakable row, so on a narrow
  // main pane the asset wrapped to column 0 and sat under the border — the exact failure `wrap`
  // exists to prevent, in the three facts an analyst reads first.
  const inline = `  ${tag === "" ? "—" : tag}   incident ${facts.window}   asset ${asset}`;
  if (inline.length <= width) {
    return [
      "",
      [
        severity,
        { text: "   incident ", tone: "label" },
        { text: facts.window },
        { text: "   asset ", tone: "label" },
        { text: asset },
      ],
      "",
    ];
  }
  return [
    "",
    [severity],
    [{ text: "  incident  ", tone: "label" }, { text: facts.window }],
    [{ text: "  asset     ", tone: "label" }, { text: truncate(asset, Math.max(8, width - 12)) }],
    "",
  ];
}

/**
 * An investigation that is still running (PRD-3 §11, §13).
 *
 * There is no verdict to show and there will not be one until the end — the agent submits its
 * assessment in a single `submit_investigation` call — so this pane says what the agent is doing
 * instead of rendering an empty verdict with "—" where the numbers go. What it can say depends on
 * whether the run was traced, which is the same fork the transcript tabs make.
 */
export function progressBody(
  facts: AlertFacts | undefined,
  index: TraceIndex | undefined,
  traced: boolean,
  width: number,
): Line[] {
  const lines: Line[] = [...factsHead(facts, width)];

  lines.push([
    { text: "  ● INVESTIGATING", tone: "running", bold: true },
    ...(index?.startedAt === undefined
      ? []
      : [{ text: "   started ", tone: "label" as const }, { text: clockTime(index.startedAt) }]),
  ]);
  lines.push("");

  if (index !== undefined) {
    // Read off the index rather than through `toActivityView`: this pane redraws on every append
    // to a live transcript, and the counts are all it needs.
    const last = index.toolCalls.at(-1);
    lines.push([
      { text: "  " },
      { text: `${index.turns.length} turns · ${index.toolCalls.length} calls · ` },
      { text: tokens(index.totals.totalTokens), tone: "label" },
      { text: `  ${cost(index.totals.cost)}`, tone: "dim" },
    ]);
    if (last !== undefined) {
      lines.push([
        { text: "  latest  ", tone: "label" },
        { text: last.toolName, tone: "accent" },
        { text: `  ${truncate(summariseArgs(last, width - 30), Math.max(12, width - 26))}` },
        { text: last.endedAt === undefined ? "  ·  running" : "", tone: "running" },
      ]);
    }
    lines.push(
      "",
      ...wrap("Activity and Stream follow this live as the transcript grows.", width - 4).map(
        (l) => `  ${l}`,
      ),
    );
    return lines;
  }

  lines.push(
    ...wrap(
      traced
        ? "The transcript has not appeared yet. This pane picks it up within a second of the agent writing its first event."
        : "Tracing is off for this run (INVESTIGATOR_TRACE=false), so its progress cannot be followed. The verdict appears here when the investigation finishes.",
      width - 4,
    ).map((l) => `  ${l}`),
  );
  return lines;
}

/**
 * The verdict body, as the ordered sections it is made of.
 *
 * Sections rather than one list of lines, because the column layout needs to know where it may cut
 * without splitting a heading off its paragraph or a numbered list in half.
 */
function verdictSections(
  view: VerdictView,
  facts: AlertFacts | undefined,
  width: number,
): Line[][] {
  const sections: Line[][] = [];

  if (facts?.description !== undefined && facts.description.trim() !== "") {
    sections.push([
      [{ text: "  WHY THE ALERT FIRED", tone: "heading", bold: true }],
      ...wrap(facts.description, width - 4).map((line) => `  ${line}`),
      "",
    ]);
  }

  const narrative = view.blocks.find((block) => block.key === "what");
  if (narrative !== undefined) {
    sections.push([
      [{ text: "  WHAT HAPPENED", tone: "heading", bold: true }],
      ...(facts === undefined
        ? []
        : labelledBlock(
            "MITRE ATT&CK",
            [...facts.tactics, ...facts.techniques].join(" · "),
            width,
            "accent",
          )),
      ...narrative.lines.flatMap((paragraph) =>
        wrap(paragraph, width - 4).map((line) => `  ${line}`),
      ),
      "",
    ]);
  }

  for (const block of view.blocks) {
    if (block.key === "what") continue;
    const lines: Line[] = [
      [{ text: `  ${block.heading.toUpperCase()}`, tone: "heading", bold: true }],
    ];

    if (block.list) {
      for (const [at, item] of block.lines.entries()) {
        const wrapped = wrap(item, width - 7);
        lines.push(`  ${String(at + 1).padStart(2)}  ${wrapped[0] ?? ""}`);
        lines.push(...wrapped.slice(1).map((line) => `      ${line}`));
      }
    } else {
      for (const paragraph of block.lines) {
        lines.push(...wrap(paragraph, width - 4).map((line) => `  ${line}`));
      }
    }
    lines.push("");
    sections.push(lines);
  }

  if (facts !== undefined) {
    const remediation = remediationLines(facts, width);
    if (remediation.length > 0) sections.push([...remediation, ""]);
  }
  return sections;
}

export function verdictBody(
  result: RunResult,
  facts: AlertFacts | undefined,
  width: number,
): Line[] {
  const view = toVerdictView(result);

  if (view.failed && view.error !== undefined) {
    return [
      "",
      [{ text: `  FAILED — ${view.error.name}`, tone: "failed", bold: true }],
      "",
      ...wrap(view.error.message, width - 4).map((l) => `  ${l}`),
    ];
  }

  const head: Line[] = [...factsHead(facts, width)];

  // The verdict leads, then what it is a verdict about, then the case for and against it.
  //
  // The headline is the thing an analyst is looking for when they open a case. What it must not do
  // is stand alone above the evidence — leading with a confidence score and nothing else is the
  // shape practitioner critiques of AI triage blame for analysts ratifying a number rather than
  // weighing it. So the narrative sits between the score and the argument that produced it.
  head.push(...verdictHead(view, width));

  // Entities directly under the classification: they are what the verdict is *about*, and the
  // pair reads as one header block. Below 100 columns panes [1] and [3] are hidden and this is
  // the only place the pivot identifiers appear at all (PRD-3 §9.6).
  if (facts !== undefined) {
    const entities = labelledBlock("ENTITIES", entityPairs(facts).join(" · "), width);
    if (entities.length > 0) head.push(...entities);
  }

  /**
   * One column, or several.
   *
   * The header stays full width whichever it is — the band, the bar and the entities are about the
   * case as a whole, and splitting them would suggest a division that is not there. Only the body
   * is columned, and where it is cut is decided by how tall the sections are rather than by what
   * they mean: cutting by meaning put a short narrative beside a tall stack of evidence, which
   * reads as a rendering fault rather than as a column.
   */
  const count = columnCount(width);
  const columnWidth =
    count === 1 ? width : Math.floor((width - COLUMN_GUTTER * (count - 1)) / count);
  const sections = verdictSections(view, facts, columnWidth);

  // …and the rule under the header. Suppressed when nothing follows, so it never trails the pane.
  if (sections.length > 0) head.push(sectionRule(width), "");

  let body: Line[];
  if (count <= 1 || sections.length <= 1) {
    body = sections.flat();
  } else {
    const cuts = balancedCuts(
      sections.map((section) => section.length),
      count,
    );
    let from = 0;
    const laid: Line[][] = [];
    for (const cut of cuts) {
      laid.push(sections.slice(from, cut).flat());
      from = cut;
    }
    body = columns(laid, columnWidth, COLUMN_GUTTER);
  }

  const lines = [...head, ...body];
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
      { text: isSelected ? "▶ " : "  ", tone: "accent" },
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
      : {
          text: `${plural(view.searches.length, "search", "searches")}, ${plural(view.fetches.length, "fetch", "fetches")}`,
        },
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
      ...prose(
        `! ${plural(index.unparsed, "line")} of this transcript were not understood — it may ` +
          "predate the current trace format, so what is above may be incomplete",
        width,
        "inconclusive",
      ),
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
 * One line per turn and one per tool call, which is the shape `trace.ts` narrates to stdout, so the
 * console and the terminal log agree rather than competing (PRD-3 §8.4).
 *
 * One deliberate divergence: `trace.ts:108` prints `← <tool> <n> chars`, and this prints `← <n> ch`
 * without the name. stdout scrolls and has no right edge to run out of; this pane is fixed-width,
 * and the name is already on the `→` line directly above, so repeating it spent the widest column
 * on the row to say nothing new. If §8.4 is meant to be literal parity rather than the same shape,
 * this is the line to change back.
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
          text: `  ${row.pending === true ? "in progress…" : alignDecimal(row.cost)}`,
          tone: row.pending === true ? "running" : "dim",
        },
      ]);
      const turn = index.turns.find((t) => t.index === row.index);
      if (turn?.thinkingPreview !== undefined && turn.thinkingPreview.trim() !== "") {
        lines.push([
          { text: "  │  · ", tone: "dim" },
          ...inlineBold(truncate(turn.thinkingPreview, width - 8), "dim"),
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
        : // The name is on the → line directly above, so repeating it here spent the widest
          // column on the row to say nothing new. What is new is how much came back.
          [
            { text: "  │  ← ", tone: "dim" },
            { text: row.size, tone: "dim" },
          ],
    );
  }

  lines.push(
    index.complete
      ? [{ text: `  └─ finished after ${plural(index.turns.length, "turn")}`, tone: "ok" }]
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
  /**
   * Three columns that share the pane, rather than two fixed ones and whatever is left.
   *
   * The label was pinned at 26 and THIS RUN at 30, so CURRENT ENV got `width - 58` — twelve
   * characters at a 120-column terminal. `openai / gpt-5.6-terra` arrived as `openai / gp…` and
   * the sentinel URL as `http://loca…`, while the label column carried slack and the pane had
   * empty space to the right of both. The two value columns hold the same kind of thing and are
   * read against each other, so they get the same width.
   */
  const labelWidth = Math.min(26, Math.max(22, Math.round(width * 0.24)));
  const valueWidth = Math.max(10, Math.floor((width - labelWidth - 2) / 2));

  const lines: Line[] = [
    "",
    [
      { text: `  ${pad("", labelWidth)}` },
      {
        text: cell(`THIS RUN  ${run?.runId.slice(0, 8) ?? "—"}`, valueWidth),
        tone: "heading",
        bold: true,
      },
      { text: "CURRENT ENV", tone: "heading", bold: true },
    ],
  ];
  for (const row of toConfigRows(run, env)) {
    // Values are truncated rather than left to soft-wrap: an over-long one wrapped to column 0 and
    // read as a broken row rather than as a long one.
    lines.push([
      { text: `  ${cell(row.label, labelWidth)}`, tone: "label" },
      { text: cell(row.thisRun, valueWidth) },
      { text: truncate(row.currentEnv, valueWidth), tone: "dim" },
    ]);
  }

  lines.push("", [{ text: "  DATA SOURCES", tone: "heading", bold: true }]);
  for (const source of DATA_SOURCES) {
    lines.push([
      { text: `  ${cell(source.label, labelWidth)}`, tone: "label" },
      { text: truncate(source.detail, Math.max(8, width - labelWidth - 4)) },
    ]);
  }

  if (totals !== undefined) {
    lines.push("", [{ text: "  THIS RUN", tone: "heading", bold: true }]);
    lines.push(
      `  ${cell("tokens", labelWidth)}${tokens(totals.tokens)}${totals.partial ? `  partial — ${totals.tracedAlerts} of ${totals.totalAlerts} alerts traced` : ""}`,
    );
    lines.push(`  ${cell("cost", labelWidth)}${cost(totals.cost)}`);
  }

  lines.push("", [
    { text: "  TOKENS & COST", tone: "heading", bold: true },
    {
      text:
        aggregate === undefined
          ? ""
          : `   over ${plural(aggregate.traced, "traced investigation")} of ${aggregate.total}`,
      tone: "label",
    },
  ]);
  if (aggregate?.tokens !== undefined) {
    lines.push(
      `  ${cell("billed tokens / inv", labelWidth)}avg ${pad(tokens(Math.round(aggregate.tokens.avg)), 10)}min ${pad(tokens(aggregate.tokens.min), 10)}max ${tokens(aggregate.tokens.max)}`,
    );
  }
  if (aggregate?.cost !== undefined) {
    lines.push(
      `  ${cell("cost / inv", labelWidth)}avg ${pad(cost(aggregate.cost.avg), 10)}min ${pad(cost(aggregate.cost.min), 10)}max ${cost(aggregate.cost.max)}`,
    );
  }
  if (aggregate?.turns !== undefined) {
    lines.push(
      `  ${cell("turns / inv", labelWidth)}avg ${pad(aggregate.turns.avg.toFixed(1), 10)}min ${pad(String(aggregate.turns.min), 10)}max ${aggregate.turns.max}`,
    );
  }
  if (aggregate?.calls !== undefined) {
    lines.push(
      `  ${cell("tool calls / inv", labelWidth)}avg ${pad(aggregate.calls.avg.toFixed(1), 10)}min ${pad(String(aggregate.calls.min), 10)}max ${aggregate.calls.max}`,
    );
  }
  if (aggregate !== undefined) {
    lines.push(`  ${cell("total spend, all runs", labelWidth)}${cost(aggregate.totalSpend)}`);
    const untraced = aggregate.total - aggregate.traced;
    if (untraced > 0) {
      lines.push(
        ...prose(
          `! ${plural(untraced, "investigation")} have no transcript, so their tokens are not ` +
            "counted here. INVESTIGATOR_TRACE was off when they ran.",
          width,
          "inconclusive",
        ),
      );
    }
    if (!aggregate.complete) lines.push("  … still indexing transcripts; figures are partial");
  }
  lines.push(
    "",
    `  ${duration(env.INVESTIGATOR_TIMEOUT_MS)} per-alert ceiling · ${env.INVESTIGATOR_MAX_TURNS} turn ceiling`,
  );
  return lines;
}
