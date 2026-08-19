import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { readEvent, readToolResult } from "../src/data/trace-detail.ts";
import { indexTrace } from "../src/data/trace-index.ts";
import { lineText } from "../src/view/format.ts";
import { toTranscript, transcriptLines } from "../src/view/transcript.ts";

const TRACE = join(
  import.meta.dir,
  "fixtures/traces/01a0194a-90fd-7000-b417-5eea46721c99-cc6430ca-0fc5-b704-c048-1d5f3d8a2524.jsonl",
);

describe("toTranscript", () => {
  test("orders the investigation as a readable conversation", async () => {
    const blocks = toTranscript(await indexTrace(TRACE), 70);

    expect(blocks[0]?.kind).toBe("context");
    const kinds = new Set(blocks.map((block) => block.kind));
    expect(kinds.has("reasoning")).toBe(true);
    expect(kinds.has("call")).toBe(true);
    expect(kinds.has("result")).toBe(true);
    // The submission is marked as the verdict rather than as one more tool call.
    expect(kinds.has("verdict")).toBe(true);

    // Every call is immediately followed by its own result.
    const calls = blocks.filter((b) => b.kind === "call" || b.kind === "verdict");
    for (const call of calls) {
      const at = blocks.indexOf(call);
      expect(blocks[at + 1]?.kind).toBe("result");
    }
  });

  test("keeps bodies bounded and records where the rest lives", async () => {
    const blocks = toTranscript(await indexTrace(TRACE), 70);
    for (const block of blocks) {
      for (const line of block.body) expect(line.length).toBeLessThanOrEqual(70);
      // Anything advertised as truncated must say where the full text can be read.
      if (block.truncated) expect(block.source).toBeDefined();
    }
  });

  test("shows the exact KQL on the call block", async () => {
    const blocks = toTranscript(await indexTrace(TRACE), 70);
    const query = blocks.find((b) => b.heading.startsWith("query_security_data"));
    expect(query?.body.join(" ")).toContain("SecurityEvent");
  });
});

describe("expansion", () => {
  test("a truncated result can be read back in full from its byte range", async () => {
    const index = await indexTrace(TRACE);
    const blocks = toTranscript(index, 70);
    const result = blocks.find((b) => b.kind === "result" && b.source !== undefined);
    expect(result?.source).toBeDefined();

    const full = await readToolResult(TRACE, result!.source!);
    expect(full.length).toBeGreaterThan(0);
    // Read on demand rather than held in the index (PRD-3 §10.1).
    expect(full.length).toBeGreaterThanOrEqual(result!.body.join("").length - 8);
  });

  test("reasoning is re-read from the turn entry", async () => {
    const index = await indexTrace(TRACE);
    const turn = index.turns.find((t) => t.thinkingPreview !== undefined);
    expect(turn?.entry).toBeDefined();

    const event = await readEvent(TRACE, turn!.entry!);
    const message = (event as { message?: { content?: { type?: string }[] } }).message;
    expect(message?.content?.some((part) => part.type === "thinking")).toBe(true);
  });
});

describe("transcriptLines", () => {
  test("collapses every block except the selected one", async () => {
    const blocks = toTranscript(await indexTrace(TRACE), 70);
    const lines = transcriptLines(blocks, 0, 70, undefined).map(lineText);

    expect(lines.some((line) => line.startsWith("▶"))).toBe(true);
    expect(lines.filter((line) => line.startsWith("▶"))).toHaveLength(1);
    expect(
      lines.some((line) => line.includes("more line(s)") || line.includes("load the full")),
    ).toBe(true);
  });

  test("renders the loaded text in place of the preview", async () => {
    const blocks = toTranscript(await indexTrace(TRACE), 70);
    const lines = transcriptLines(blocks, 0, 70, "EXPANDED CONTENT HERE").map(lineText);
    expect(lines.join("\n")).toContain("EXPANDED CONTENT HERE");
  });

  test("says so when there is nothing recorded", () => {
    expect(transcriptLines([], 0, 70, undefined).map(lineText).join(" ")).toContain(
      "Nothing recorded",
    );
  });
});
