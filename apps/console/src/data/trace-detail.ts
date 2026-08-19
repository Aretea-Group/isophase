import type { ByteRange } from "./trace-index.ts";

/**
 * Read one event back out of a transcript.
 *
 * The index keeps offsets rather than payloads (PRD-3 §10.1), so opening a tool call reads exactly
 * the bytes of that one line. This is what keeps the console's footprint bounded while still
 * letting an analyst see a 24,000-character query result in full.
 */
export async function readEvent(path: string, range: ByteRange): Promise<unknown> {
  const bytes = await Bun.file(path)
    .slice(range.offset, range.offset + range.length)
    .arrayBuffer();
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function joinText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const record = asRecord(part);
      return record?.["type"] === "text" && typeof record["text"] === "string"
        ? record["text"]
        : "";
    })
    .join("");
}

/** The full text of a tool result, for the detail pane. */
export async function readToolResult(path: string, range: ByteRange): Promise<string> {
  const event = asRecord(await readEvent(path, range));
  const result = asRecord(event?.["result"]);
  return result === undefined ? "" : joinText(result["content"]);
}

/**
 * The alert as the agent saw it.
 *
 * `context.ts` wraps the alert JSON in an `<alert>` block inside the first user message, so the
 * console recovers severity, tactics and entities from the transcript rather than calling Mock
 * Sentinel for display data (PRD-3 §6.2).
 */
export async function readAlert(path: string, range: ByteRange): Promise<unknown> {
  const event = asRecord(await readEvent(path, range));
  const message = asRecord(event?.["message"]);
  const text = message === undefined ? "" : joinText(message["content"]);
  const open = text.indexOf("<alert>");
  const close = text.indexOf("</alert>");
  if (open === -1 || close === -1 || close < open) return undefined;
  try {
    return JSON.parse(text.slice(open + "<alert>".length, close));
  } catch {
    return undefined;
  }
}
