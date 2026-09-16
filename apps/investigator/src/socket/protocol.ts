import { z } from "zod";

/**
 * The wire contract for the control socket (PRD-9 §4.1 D4).
 *
 * Newline-delimited JSON validated by Zod on both ends, which is already this repository's contract
 * tool for REST, configuration and run artifacts. The protocol surface is exactly
 * `InvestigationControl` — seven request/response methods and one event stream — because the whole
 * point of ADR 007's interface was that a second implementation could sit behind it without the
 * caller changing. Inventing a wider wire vocabulary would undo that.
 *
 * Deliberately unauthenticated and unix-domain only (PRD-9 §3): local machine, single user, file
 * permissions as the access control. A TCP listener here would be a service, which `AGENTS.md` §2
 * has no room for.
 */

/** Bumped when a change would make an older client misread a newer server. */
export const PROTOCOL_VERSION = 1;

export const Hello = z.object({
  type: z.literal("hello"),
  protocolVersion: z.number().int().positive(),
});

export const ControlRequest = z.discriminatedUnion("method", [
  z.object({ id: z.string().min(1), method: z.literal("listAlerts") }),
  z.object({ id: z.string().min(1), method: z.literal("listModels") }),
  z.object({ id: z.string().min(1), method: z.literal("listTools") }),
  z.object({ id: z.string().min(1), method: z.literal("live") }),
  z.object({ id: z.string().min(1), method: z.literal("shutdown") }),
  z.object({
    id: z.string().min(1),
    method: z.literal("cancel"),
    runId: z.string().min(1),
  }),
  z.object({
    id: z.string().min(1),
    method: z.literal("start"),
    request: z.object({
      runId: z.string().min(1),
      alertId: z.string().min(1),
      alertTitle: z.string().optional(),
      model: z.object({ provider: z.string(), id: z.string() }).optional(),
      analystContext: z.string().optional(),
      derivedFrom: z.object({ runId: z.string(), alertId: z.string() }).optional(),
    }),
  }),
]);

export const ControlResponse = z.union([
  /**
   * `result` is unvalidated on purpose, for the same reason `ControlEventFrame` is loose.
   *
   * What the wire schema guards is the *frame* — an id, an outcome, an error shape — so a garbled
   * line can never be mistaken for an answer. The payloads are `SecurityAlert[]`, `ModelChoice[]`
   * and `LiveRun[]`, all of which already have one definition on the TypeScript side; re-deriving
   * them as Zod schemas here would create a second that can drift from the first, which is exactly
   * what `AGENTS.md` §3 forbids for schema-generated types.
   */
  z.object({ id: z.string().min(1), ok: z.literal(true), result: z.unknown().optional() }),
  z.object({
    id: z.string().min(1),
    ok: z.literal(false),
    error: z.object({ name: z.string(), message: z.string() }),
  }),
]);

/**
 * An event, pushed to every connected client.
 *
 * `ControlEvent` is validated loosely on purpose: it is a closed union in TypeScript and re-deriving
 * it as a Zod schema would create a second definition that can drift from the first. What matters
 * on the wire is that the frame *is* an event and carries a `type` — the client narrows from there
 * against the same TypeScript union the server emits.
 */
export const ControlEventFrame = z.object({
  type: z.literal("event"),
  event: z.looseObject({ type: z.string().min(1) }),
});

export const ServerFrame = z.union([Hello, ControlResponse, ControlEventFrame]);

export type ControlRequest = z.infer<typeof ControlRequest>;
export type ControlResponse = z.infer<typeof ControlResponse>;
export type ServerFrame = z.infer<typeof ServerFrame>;

/** One JSON value per line. A frame that does not parse is dropped, never partially applied. */
export function encodeFrame(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * Split a byte stream into complete lines, carrying the remainder.
 *
 * A socket read boundary has nothing to do with a message boundary — a long `run_completed` frame
 * carrying a whole artifact arrives in several chunks, and two short frames arrive in one. Both
 * failure modes are silent corruption if the reader assumes otherwise.
 */
const EMPTY = new Uint8Array(0);
const encoder = new TextEncoder();

export class QueuedWriter {
  #pending: Uint8Array = EMPTY;
  readonly #socket: { write(data: Uint8Array): number };

  /**
   * Write everything, eventually — the counterpart to `LineBuffer` on the sending side.
   *
   * `socket.write` returns how many **bytes** it accepted and may accept fewer than it was given;
   * the rest belongs on the next `drain`. Ignoring the return value truncates precisely the frames
   * that matter — a `run_completed` carries a whole run artifact, far past any socket buffer — and
   * the receiver then drops a half-line as unparseable.
   *
   * The buffer is bytes rather than a string because that return value is a byte count, and an
   * earlier cut carried it as `string.slice(written)`. A JavaScript string is indexed in UTF-16
   * code units, so every non-ASCII character in the written prefix made the slice skip *past* what
   * had actually gone out, deleting characters from the middle of the frame. Pure-ASCII payloads
   * small enough to be accepted in one call never exercise the slice at all, which is why this
   * survived the socket tests and only appeared against a live tenant: a 205 KB `listAlerts` reply
   * went out over 27 partial writes and arrived as unparseable JSON.
   */
  constructor(socket: { write(data: Uint8Array): number }) {
    this.#socket = socket;
  }

  write(data: string): void {
    const bytes = encoder.encode(data);
    if (this.#pending.length === 0) {
      this.#pending = bytes;
    } else {
      const merged = new Uint8Array(this.#pending.length + bytes.length);
      merged.set(this.#pending);
      merged.set(bytes, this.#pending.length);
      this.#pending = merged;
    }
    this.flush();
  }

  flush(): void {
    if (this.#pending.length === 0) return;
    const written = this.#socket.write(this.#pending);
    // Zero or negative means nothing moved; keep the whole buffer for the next drain.
    if (written > 0) this.#pending = this.#pending.subarray(written);
  }
}

export class LineBuffer {
  #buffer = "";
  /**
   * Stateful across chunks for the same reason the writer counts bytes: a 205 KB frame arrives in
   * dozens of chunks, and a chunk boundary falling inside a multi-byte character makes a one-shot
   * decode emit U+FFFD and corrupt the frame. `{ stream: true }` holds the trailing partial
   * sequence until its continuation bytes arrive.
   */
  readonly #decoder = new TextDecoder();

  push(chunk: Uint8Array | string): string[] {
    this.#buffer +=
      typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";
    return lines.filter((line) => line.trim() !== "");
  }
}
