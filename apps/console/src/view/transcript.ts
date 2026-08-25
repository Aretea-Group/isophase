import type { ByteRange, ToolCall, TraceIndex } from "../data/trace-index.ts";
import { summariseArgs, type QueryLanguageResolver } from "./activity.ts";
import {
  chars,
  clockTime,
  cost,
  inlineBold,
  plural,
  tokens,
  truncate,
  wrap,
  type Line,
  type Tone,
} from "./format.ts";

/**
 * The investigation as a readable conversation.
 *
 * The Activity view answers "what did it do"; this answers "why did it do that". It is the same
 * transcript, ordered and labelled: the context the agent was given, what it reasoned, what it said,
 * what it asked for and what came back.
 *
 * Bodies are previews. Anything longer is read back from `source` when the analyst expands it, so
 * the view stays inside the rule that the index holds offsets rather than payloads (PRD-3 §10).
 */
export type BlockKind = "context" | "reasoning" | "assistant" | "call" | "result" | "verdict";

export interface TranscriptBlock {
  id: string;
  kind: BlockKind;
  turn: number;
  at: string;
  heading: string;
  body: string[];
  /** More exists than the body shows; `source` says where to read it. */
  truncated: boolean;
  source?: ByteRange;
}

const GLYPH: Record<BlockKind, string> = {
  context: "▸",
  reasoning: "·",
  assistant: "▪",
  call: "→",
  result: "←",
  verdict: "✓",
};

export function blockGlyph(kind: BlockKind): string {
  return GLYPH[kind];
}

function callBody(call: ToolCall, width: number): string[] {
  const args = call.args;
  if (
    typeof args === "object" &&
    args !== null &&
    "query" in args &&
    typeof args.query === "string"
  ) {
    return args.query.split("\n").flatMap((line) => wrap(line, width));
  }
  return wrap(JSON.stringify(args ?? {}), width);
}

export function toTranscript(
  index: TraceIndex,
  width: number,
  queryLanguage?: QueryLanguageResolver,
): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  const body = Math.max(20, width - 6);

  if (index.alertMessage !== undefined) {
    blocks.push({
      id: "context",
      kind: "context",
      turn: 0,
      at: clockTime(index.startedAt),
      heading: "Context given to the agent — the alert and the table list",
      body: wrap("The alert as the agent received it, plus the tables it was told about.", body),
      truncated: true,
      source: index.alertMessage,
    });
  }

  const callsByTurn = new Map<number, ToolCall[]>();
  for (const call of index.toolCalls) {
    const list = callsByTurn.get(call.turn) ?? [];
    list.push(call);
    callsByTurn.set(call.turn, list);
  }

  const ended = new Set(index.turns.map((turn) => turn.index));
  const emitCalls = (turnIndex: number): void => {
    for (const call of callsByTurn.get(turnIndex) ?? []) {
      const isVerdict = call.toolName === "submit_investigation";
      blocks.push({
        id: `call:${call.seq}`,
        kind: isVerdict ? "verdict" : "call",
        turn: call.turn,
        at: clockTime(call.at),
        heading: `${call.toolName}  ${summariseArgs(call, 60, queryLanguage)}`,
        body: callBody(call, body),
        truncated: false,
      });
      if (call.endedAt === undefined) continue;
      blocks.push({
        id: `result:${call.seq}`,
        kind: "result",
        turn: call.turn,
        at: clockTime(call.endedAt),
        heading: `${call.isError === true ? "ERROR" : "result"}  ${chars(call.resultChars)}`,
        body: wrap(truncate(call.resultPreview ?? "", 600), body),
        truncated: (call.resultChars ?? 0) > (call.resultPreview?.length ?? 0),
        ...(call.result === undefined ? {} : { source: call.result }),
      });
    }
  };

  for (const turn of index.turns) {
    if (turn.thinkingPreview !== undefined) {
      blocks.push({
        id: `reasoning:${turn.index}`,
        kind: "reasoning",
        turn: turn.index,
        at: clockTime(turn.at),
        heading: `turn ${turn.index} — reasoning   ${tokens(turn.usage?.totalTokens)}  ${cost(turn.usage?.cost)}`,
        body: wrap(turn.thinkingPreview, body),
        truncated: true,
        ...(turn.entry === undefined ? {} : { source: turn.entry }),
      });
    }
    if (turn.textPreview !== undefined) {
      blocks.push({
        id: `assistant:${turn.index}`,
        kind: "assistant",
        turn: turn.index,
        at: clockTime(turn.at),
        heading: `turn ${turn.index} — said`,
        body: wrap(turn.textPreview, body),
        truncated: true,
        ...(turn.entry === undefined ? {} : { source: turn.entry }),
      });
    }
    emitCalls(turn.index);
  }

  for (const turnIndex of [...callsByTurn.keys()].toSorted((a, b) => a - b)) {
    if (!ended.has(turnIndex)) emitCalls(turnIndex);
  }

  return blocks;
}

/** Render the ordered blocks, expanding one of them. */
/** What each kind of block is, as a tone. The glyph still carries it without colour (§9.8). */
function blockTone(kind: TranscriptBlock["kind"]): Tone {
  switch (kind) {
    case "context":
      return "label";
    case "reasoning":
      return "dim";
    case "call":
      return "accent";
    case "result":
      return "label";
    case "verdict":
      return "ok";
    default:
      return "heading";
  }
}

export function transcriptLines(
  blocks: TranscriptBlock[],
  selected: number,
  width: number,
  expandedText: string | undefined,
): Line[] {
  const lines: Line[] = [];

  for (const [position, block] of blocks.entries()) {
    const isOpen = position === selected;
    lines.push([
      // A space between the two. The selection marker and the context glyph are both small right
      // triangles, and set flush they read as one smeared character rather than as "this row is
      // selected, and it is a context block".
      { text: isOpen ? "▶ " : "  ", tone: "accent" },
      { text: `${blockGlyph(block.kind)} `, tone: blockTone(block.kind) },
      { text: `${block.at}  `, tone: "dim" },
      {
        text: truncate(block.heading, width - 14),
        tone: isOpen ? "heading" : blockTone(block.kind),
        bold: isOpen,
      },
    ]);

    const body =
      isOpen && expandedText !== undefined
        ? expandedText.split("\n").flatMap((line) => wrap(line, width - 6))
        : block.body;
    const shown = isOpen ? body : body.slice(0, 2);

    // Reasoning is written by the model, and models write markdown; the emphasis it puts on its
    // own headings was reaching the analyst as literal asterisks.
    for (const line of shown) lines.push([{ text: "    " }, ...inlineBold(line)]);
    if (!isOpen && body.length > 2) {
      lines.push([{ text: `    … ${plural(body.length - 2, "more line")}`, tone: "dim" }]);
    }
    if (isOpen && block.truncated && expandedText === undefined) {
      lines.push([{ text: "    ⏎ to load the full text", tone: "accent" }]);
    }
    lines.push("");
  }

  return lines.length === 0 ? ["", "  Nothing recorded in this transcript yet."] : lines;
}
