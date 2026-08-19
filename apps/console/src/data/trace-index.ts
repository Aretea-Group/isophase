/**
 * Streaming index over one investigation transcript.
 *
 * Transcripts are large enough that reading them naively is a defect rather than a slow path
 * (PRD-3 §10). With `INVESTIGATOR_TRACE_STREAM` on they reach 23 MB, of which 96.4% is
 * `message_update` lines that each carry the whole partial message; `agent_end` then replays the
 * entire transcript once more on a single line.
 *
 * So this never materialises the file as a string and never parses either of those two event
 * types. It scans bytes, takes each line's type from a short prefix, and keeps a compact index —
 * offsets, not payloads — so the detail view can read one event back on demand.
 */

const CHUNK_BYTES = 1 << 20;
const NEWLINE = 0x0a;
/** `{"at":"<iso>","type":"<name>"` fits comfortably; measured against every line of a 1,752-line file. */
const TYPE_PREFIX_BYTES = 120;
const RESULT_PREVIEW_CHARS = 4_000;
const REASONING_PREVIEW_CHARS = 600;

/**
 * Event types whose payload is never worth the parse (PRD-3 §10).
 *
 * `message_end` joins the two obvious ones. Nothing reads it — usage comes from `turn_end`, and
 * counting it there as well would double every figure — yet across the transcripts on disk it is
 * 494 lines parsed and discarded on every pass, the largest of them 45,687 bytes.
 */
const NEVER_PARSE = new Set(["message_update", "message_end", "agent_end"]);

export interface TraceUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: number;
}

/** Where an event sits in the file, so it can be re-read without keeping it in memory. */
export interface ByteRange {
  offset: number;
  length: number;
}

export interface ToolCall {
  seq: number;
  turn: number;
  at: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  endedAt?: string;
  isError?: boolean;
  /** Measured from the result text — the transcript carries no size field of its own. */
  resultChars?: number;
  resultPreview?: string;
  result?: ByteRange;
}

export interface Turn {
  index: number;
  at: string;
  usage?: TraceUsage;
  stopReason?: string;
  provider?: string;
  model?: string;
  /** Bounded previews. The full assistant message is re-read from `entry` on demand. */
  thinkingPreview?: string;
  textPreview?: string;
  /** The `turn_end` line, so the transcript view can recover the whole message (PRD-3 §10.1). */
  entry?: ByteRange;
}

export interface TraceIndex {
  path: string;
  runId: string;
  alertId: string;
  startedAt?: string;
  endedAt?: string;
  /** An `agent_end` line exists, so the investigation finished rather than being cut off. */
  complete: boolean;
  turns: Turn[];
  toolCalls: ToolCall[];
  totals: { totalTokens: number; cost: number };
  /** The first user message, which embeds the alert JSON (PRD-3 §6.2). Read on demand. */
  alertMessage?: ByteRange;
  /** Byte offset after the last complete line, so a growing file can be resumed. */
  nextOffset: number;
  /** Lines whose type prefix could not be read. Non-zero means the format moved. */
  unparsed: number;
}

const decoder = new TextDecoder();

/**
 * The event's own type, read from the first bytes of the line.
 *
 * It must be the *first* `"type":"` in the prefix: a `message_update` line carries a nested
 * `assistantMessageEvent.type` well inside the first 120 bytes, and matching that instead would
 * classify the largest lines in the file as something worth parsing.
 */
export function eventTypeOf(line: Uint8Array): string | undefined {
  const prefix = decoder.decode(line.subarray(0, Math.min(line.length, TYPE_PREFIX_BYTES)));
  const at = prefix.indexOf('"type":"');
  if (at === -1) return undefined;
  const from = at + '"type":"'.length;
  const to = prefix.indexOf('"', from);
  return to === -1 ? undefined : prefix.slice(from, to);
}

/** Split a run's transcript filename into its two hyphenated UUIDs (PRD-3 §6.2). */
export function splitTraceName(fileName: string): { runId: string; alertId: string } | undefined {
  const stem = fileName.endsWith(".jsonl") ? fileName.slice(0, -".jsonl".length) : fileName;
  // Both halves are UUIDs, so the boundary is positional. Splitting on "-" would find the first
  // of nine hyphens.
  if (stem.length !== 36 + 1 + 36 || stem[36] !== "-") return undefined;
  return { runId: stem.slice(0, 36), alertId: stem.slice(37) };
}

interface Line {
  bytes: Uint8Array;
  offset: number;
}

/**
 * Yield whole lines only, holding a trailing partial line back.
 *
 * The investigator appends to this file with `appendFileSync` while the console reads it, so a
 * final incomplete line is normal rather than corruption. It is left for the next pass, and
 * `nextOffset` stops at its start.
 */
async function* readLines(path: string, from: number): AsyncGenerator<Line, number> {
  const file = Bun.file(path);
  const size = file.size;
  let readAt = from;
  let buffer = new Uint8Array(0);
  let bufferAt = from;

  while (readAt < size) {
    const to = Math.min(readAt + CHUNK_BYTES, size);
    // Streaming by design: the whole point is to hold one chunk rather than the file (PRD-3 §10).
    // eslint-disable-next-line no-await-in-loop
    const chunk = new Uint8Array(await file.slice(readAt, to).arrayBuffer());
    readAt = to;

    const merged = new Uint8Array(buffer.length + chunk.length);
    merged.set(buffer);
    merged.set(chunk, buffer.length);
    buffer = merged;

    let start = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      if (buffer[i] !== NEWLINE) continue;
      yield { bytes: buffer.subarray(start, i), offset: bufferAt + start };
      start = i + 1;
    }
    if (start > 0) {
      buffer = buffer.slice(start);
      bufferAt += start;
    }
  }

  return bufferAt;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const record = asRecord(part);
      if (record === undefined) return "";
      if (record["type"] === "text" && typeof record["text"] === "string") return record["text"];
      return "";
    })
    .join("");
}

function partOf(content: unknown, type: "thinking" | "text"): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const key = type === "thinking" ? "thinking" : "text";
  const found: string[] = [];
  for (const part of content) {
    const record = asRecord(part);
    if (record?.["type"] === type && typeof record[key] === "string") found.push(record[key]);
  }
  if (found.length === 0) return undefined;
  const joined = found.join(" ").replace(/\s+/g, " ").trim();
  return joined === "" ? undefined : joined.slice(0, REASONING_PREVIEW_CHARS);
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function usageOf(message: Record<string, unknown>): TraceUsage | undefined {
  const usage = asRecord(message["usage"]);
  if (usage === undefined) return undefined;
  const cost = asRecord(usage["cost"]);
  return {
    input: num(usage["input"]),
    output: num(usage["output"]),
    cacheRead: num(usage["cacheRead"]),
    cacheWrite: num(usage["cacheWrite"]),
    reasoning: num(usage["reasoning"]),
    totalTokens: num(usage["totalTokens"]),
    cost: cost === undefined ? undefined : num(cost["total"]),
  };
}

function emptyIndex(path: string, runId: string, alertId: string): TraceIndex {
  return {
    path,
    runId,
    alertId,
    complete: false,
    turns: [],
    toolCalls: [],
    totals: { totalTokens: 0, cost: 0 },
    nextOffset: 0,
    unparsed: 0,
  };
}

/**
 * Build, or extend, the index for one transcript.
 *
 * Pass the previous index to resume from where it stopped; only the bytes appended since are read,
 * which is what makes following a live run cheap (PRD-3 §10.2).
 */
export async function indexTrace(path: string, previous?: TraceIndex): Promise<TraceIndex> {
  const name = path.split("/").pop() ?? path;
  const parts = splitTraceName(name);
  const index: TraceIndex = previous ?? emptyIndex(path, parts?.runId ?? "", parts?.alertId ?? "");

  const pending = new Map<string, ToolCall>();
  for (const call of index.toolCalls) {
    if (call.endedAt === undefined) pending.set(call.toolCallId, call);
  }
  let turn = index.turns.length;

  const lines = readLines(path, index.nextOffset);
  let next = await lines.next();
  while (next.done !== true) {
    const { bytes, offset } = next.value;
    // A sequential scan over an ordered event log; nothing here is parallelisable.
    // eslint-disable-next-line no-await-in-loop
    next = await lines.next();
    if (bytes.length === 0) continue;

    const type = eventTypeOf(bytes);
    if (type === undefined) {
      index.unparsed += 1;
      continue;
    }

    // The two that make transcripts large. `agent_end` still tells us the run finished; its
    // payload is the transcript over again and is never worth the parse.
    if (NEVER_PARSE.has(type)) {
      if (type === "agent_end") index.complete = true;
      continue;
    }
    // The only message_start that matters is the first user one; the rest are the same payloads
    // the assistant and tool events already carry.
    if (type === "message_start" && index.alertMessage !== undefined) continue;

    let event: Record<string, unknown> | undefined;
    try {
      event = asRecord(JSON.parse(decoder.decode(bytes)));
    } catch {
      index.unparsed += 1;
      continue;
    }
    if (event === undefined) {
      index.unparsed += 1;
      continue;
    }

    const at = typeof event["at"] === "string" ? event["at"] : "";

    switch (type) {
      case "agent_start": {
        index.startedAt ??= at;
        break;
      }
      case "turn_start": {
        turn += 1;
        break;
      }
      case "turn_end": {
        const message = asRecord(event["message"]);
        if (message === undefined) break;
        // Usage hangs off `message`, and only `turn_end` is counted. The assistant's `message_end`
        // reports the identical usage for the same turn, so counting both doubles every figure;
        // `message_start` carries a zeroed placeholder (PRD-3 §10).
        const usage = usageOf(message);
        index.turns.push({
          index: turn === 0 ? index.turns.length + 1 : turn,
          at,
          ...(usage === undefined ? {} : { usage }),
          ...(typeof message["stopReason"] === "string"
            ? { stopReason: message["stopReason"] }
            : {}),
          ...(typeof message["provider"] === "string" ? { provider: message["provider"] } : {}),
          ...(typeof message["model"] === "string" ? { model: message["model"] } : {}),
          ...(() => {
            const thinking = partOf(message["content"], "thinking");
            return thinking === undefined ? {} : { thinkingPreview: thinking };
          })(),
          ...(() => {
            const text = partOf(message["content"], "text");
            return text === undefined ? {} : { textPreview: text };
          })(),
          entry: { offset, length: bytes.length },
        });
        index.totals.totalTokens += usage?.totalTokens ?? 0;
        index.totals.cost += usage?.cost ?? 0;
        index.endedAt = at;
        break;
      }
      case "message_start": {
        // Only the first one matters: it is the initial user turn, which embeds the alert JSON.
        const message = asRecord(event["message"]);
        if (message?.["role"] === "user") {
          index.alertMessage ??= { offset, length: bytes.length };
        }
        break;
      }
      case "tool_execution_start": {
        const call: ToolCall = {
          seq: index.toolCalls.length + 1,
          turn,
          at,
          toolCallId: typeof event["toolCallId"] === "string" ? event["toolCallId"] : "",
          toolName: typeof event["toolName"] === "string" ? event["toolName"] : "(unknown)",
          args: event["args"],
        };
        index.toolCalls.push(call);
        if (call.toolCallId !== "") pending.set(call.toolCallId, call);
        break;
      }
      case "tool_execution_end": {
        const id = typeof event["toolCallId"] === "string" ? event["toolCallId"] : "";
        const call =
          pending.get(id) ??
          index.toolCalls.findLast(
            (c) => c.toolName === event["toolName"] && c.endedAt === undefined,
          );
        if (call === undefined) break;
        pending.delete(id);
        const result = asRecord(event["result"]);
        const text = result === undefined ? "" : textOf(result["content"]);
        call.endedAt = at;
        call.isError = event["isError"] === true;
        call.resultChars = text.length;
        call.resultPreview = text.slice(0, RESULT_PREVIEW_CHARS);
        call.result = { offset, length: bytes.length };
        break;
      }
      default:
        break;
    }
  }

  index.nextOffset = next.value;
  return index;
}
