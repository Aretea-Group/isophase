import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentEvent } from "@earendil-works/pi-agent-core";

export interface TracerOptions {
  runId: string;
  alertId: string;
  /** Directory for JSONL transcripts. */
  dir: string;
  /** Also narrate to stdout. */
  console: boolean;
  /**
   * Persist `message_update` streaming deltas.
   *
   * Off by default, and the difference is not marginal: measured on a real run these were 1,636 of
   * the 1,752 events and **96.4% of a 16.5 MB file**, because each delta carries the whole partial
   * message — quadratic in message length. Dropping them takes a trace to ~0.6 MB and loses
   * nothing, since `message_end` already holds the completed message. Only turn this on to debug
   * streaming itself.
   */
  streamDeltas?: boolean;
  log?: (message: string) => void;
}

export interface Tracer {
  onEvent: (event: AgentEvent) => void;
  path: string;
}

const MAX_ECHO = 600;

function clip(text: string, limit = MAX_ECHO): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}… (+${flat.length - limit} chars)`;
}

function textOf(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" && part !== null && (part as { type?: string }).type === "text",
    )
    .map((part) => part.text)
    .join("");
}

/**
 * Full transcript capture for one investigation.
 *
 * PRD-2 §19 leaves the Pi transcript out of the run artifact and says it can be added "if
 * evaluation demonstrates a concrete need". The need showed up on the first live run: two
 * investigations died on provider token limits and there was no record of which queries had filled
 * the context, so the cause had to be reconstructed by re-measuring queries by hand.
 *
 * This stays off by default and out of the run artifact. The artifact remains the durable,
 * comparable output; a trace is a debugging aid for a single run, written beside it.
 */
export function createTracer(options: TracerOptions): Tracer {
  const { runId, alertId, dir } = options;
  const log = options.log ?? ((message: string) => console.info(message));

  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${runId}-${alertId}.jsonl`);

  let turn = 0;

  const write = (record: Record<string, unknown>) => {
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
  };

  const streamDeltas = options.streamDeltas ?? false;

  const onEvent = (event: AgentEvent): void => {
    // Everything except the streaming deltas is kept uncut — that is the point of having it.
    if (streamDeltas || event.type !== "message_update") {
      write(event as unknown as Record<string, unknown>);
    }
    if (!options.console) return;

    switch (event.type) {
      case "turn_start": {
        turn += 1;
        log(`  ├─ turn ${turn}`);
        break;
      }
      case "message_end": {
        if ((event.message as { role?: string }).role !== "assistant") break;
        const text = textOf(event.message);
        if (text.trim() !== "") log(`  │  💭 ${clip(text)}`);
        break;
      }
      case "tool_execution_start": {
        const args = JSON.stringify(event.args ?? {});
        log(`  │  → ${event.toolName} ${clip(args, 400)}`);
        break;
      }
      case "tool_execution_end": {
        if (event.isError) {
          const text = textOf(event.result);
          log(`  │  ✗ ${event.toolName} ERROR ${clip(text, 400)}`);
          break;
        }
        const text = textOf(event.result);
        log(`  │  ← ${event.toolName} ${text.length} chars`);
        break;
      }
      case "agent_end": {
        log(`  └─ agent finished after ${turn} turn(s)`);
        break;
      }
      default:
        break;
    }
  };

  return { onEvent, path };
}
