import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { eventTypeOf, indexTrace, splitTraceName } from "../src/data/trace-index.ts";

const FIXTURE = join(
  import.meta.dir,
  "fixtures/traces/01a0194a-90fd-7000-b417-5eea46721c99-cc6430ca-0fc5-b704-c048-1d5f3d8a2524.jsonl",
);

describe("eventTypeOf", () => {
  test("reads the event's own type, not a nested one", () => {
    // A message_update carries `assistantMessageEvent.type` inside the same 120-byte prefix.
    // Matching that instead would classify the largest lines in a transcript as parseable.
    const line = new TextEncoder().encode(
      '{"at":"2026-08-19T09:11:53.000Z","type":"message_update","assistantMessageEvent":{"type":"thinking_delta"}}',
    );
    expect(eventTypeOf(line)).toBe("message_update");
  });

  test("returns undefined when no type is in the prefix", () => {
    expect(eventTypeOf(new TextEncoder().encode('{"at":"x"}'))).toBeUndefined();
  });
});

describe("splitTraceName", () => {
  test("splits on the UUID boundary, not the first hyphen", () => {
    const parsed = splitTraceName(
      "01a0194a-90fd-7000-b417-5eea46721c99-cc6430ca-0fc5-b704-c048-1d5f3d8a2524.jsonl",
    );
    expect(parsed).toEqual({
      runId: "01a0194a-90fd-7000-b417-5eea46721c99",
      alertId: "cc6430ca-0fc5-b704-c048-1d5f3d8a2524",
    });
  });

  test("rejects a name that is not two UUIDs", () => {
    expect(splitTraceName("nonsense.jsonl")).toBeUndefined();
  });
});

describe("indexTrace", () => {
  test("indexes turns, tool calls and their arguments", async () => {
    const index = await indexTrace(FIXTURE);

    expect(index.complete).toBe(true);
    expect(index.unparsed).toBe(0);
    expect(index.turns).toHaveLength(4);
    expect(index.toolCalls).toHaveLength(11);
    expect(index.runId).toBe("01a0194a-90fd-7000-b417-5eea46721c99");
    expect(index.alertId).toBe("cc6430ca-0fc5-b704-c048-1d5f3d8a2524");

    const names = index.toolCalls.map((call) => call.toolName);
    expect(names[0]).toBe("get_security_schema");
    expect(names.at(-1)).toBe("submit_investigation");
    expect(names.filter((n) => n === "query_security_data")).toHaveLength(9);
  });

  test("counts usage from turn_end only", async () => {
    const index = await indexTrace(FIXTURE);
    // Measured from the source transcript: the assistant's message_end reports the identical
    // usage for the same turn, so counting both would report 49,860 rather than 24,930.
    expect(index.totals.totalTokens).toBe(24_930);
    expect(index.totals.cost).toBeCloseTo(0.0535, 4);
  });

  test("keeps the KQL an analyst needs to read", async () => {
    const index = await indexTrace(FIXTURE);
    const query = index.toolCalls.find((call) => call.toolName === "query_security_data");
    const args = query?.args as { kql?: string } | undefined;
    expect(args?.kql).toContain("SecurityEvent");
  });

  test("records result sizes and bounds the preview", async () => {
    const index = await indexTrace(FIXTURE);
    for (const call of index.toolCalls) {
      expect(call.endedAt).toBeDefined();
      expect(call.resultChars).toBeGreaterThanOrEqual(0);
      expect(call.resultPreview?.length ?? 0).toBeLessThanOrEqual(4_000);
      expect(call.result?.length).toBeGreaterThan(0);
    }
  });

  test("skips the two event types that dominate transcript size", async () => {
    const bytes = await Bun.file(FIXTURE).bytes();
    const lines = new TextDecoder()
      .decode(bytes)
      .split("\n")
      .filter((l) => l !== "");
    const skipped = lines.filter((l) => {
      const type = eventTypeOf(new TextEncoder().encode(l));
      return type === "message_update" || type === "agent_end";
    });
    // The fixture carries both, so this asserts the skip path is actually exercised.
    expect(skipped.length).toBeGreaterThanOrEqual(3);

    const index = await indexTrace(FIXTURE);
    // agent_end is still observed — it is what marks the investigation finished — but never parsed.
    expect(index.complete).toBe(true);
    expect(index.unparsed).toBe(0);
  });

  test("never parses a skipped line, however broken it is", async () => {
    // The decisive proof that message_update and agent_end are skipped rather than parsed: make
    // them syntactically invalid. If either reached JSON.parse, `unparsed` would count it.
    const path = join(
      "/tmp",
      "console-skip-11111111-1111-1111-1111-111111111111-22222222-2222-2222-2222-222222222222.jsonl",
    );
    await Bun.write(
      path,
      [
        JSON.stringify({ at: "2026-08-19T09:00:00.000Z", type: "agent_start" }),
        '{"at":"2026-08-19T09:00:01.000Z","type":"message_update","broken":',
        '{"at":"2026-08-19T09:00:02.000Z","type":"agent_end","messages":[{',
        "",
      ].join("\n"),
    );

    const index = await indexTrace(path);
    expect(index.unparsed).toBe(0);
    expect(index.complete).toBe(true);
    expect(index.startedAt).toBe("2026-08-19T09:00:00.000Z");
  });

  test("indexes a transcript far larger than the index it produces", async () => {
    // 40 MB of the event type that dominates real transcripts. Memory is asserted structurally
    // rather than with a heap probe: `process.memoryUsage()` after a forced GC reports allocator
    // arenas, and measured across 10/40/161 MB inputs it moved 15.0/22.2/4.3 MB — noise, not
    // retention. What is deterministic is that the index stays O(events) while input is O(bytes).
    const noise = JSON.stringify({
      at: "2026-08-19T09:11:53.000Z",
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", partial: { thinking: "z".repeat(20_000) } },
    });
    const path = join(
      "/tmp",
      "console-big-11111111-1111-1111-1111-111111111111-22222222-2222-2222-2222-222222222222.jsonl",
    );
    const writer = Bun.file(path).writer();
    for (let i = 0; i < 2_000; i += 1) writer.write(`${noise}\n`);
    writer.write(
      `${JSON.stringify({ at: "2026-08-19T09:12:00.000Z", type: "turn_end", message: { role: "assistant", usage: { totalTokens: 7, cost: { total: 0.5 } } } })}\n`,
    );
    writer.write(
      `${JSON.stringify({ at: "2026-08-19T09:12:01.000Z", type: "agent_end", messages: [] })}\n`,
    );
    await writer.end();

    const size = Bun.file(path).size;
    expect(size).toBeGreaterThan(40_000_000);

    const index = await indexTrace(path);
    expect(index.complete).toBe(true);
    expect(index.unparsed).toBe(0);
    expect(index.turns).toHaveLength(1);
    expect(index.toolCalls).toHaveLength(0);
    expect(index.totals.totalTokens).toBe(7);
    expect(index.nextOffset).toBe(size);
  });

  test("resumes a growing file and holds back a partial line", async () => {
    const all = await Bun.file(FIXTURE).bytes();
    const path = join(
      "/tmp",
      "console-tail-01a0194a-90fd-7000-b417-5eea46721c99-cc6430ca-0fc5-b704-c048-1d5f3d8a2524.jsonl",
    );

    // Cut mid-line: exactly what a reader sees while the investigator is appending.
    const cut = Math.floor(all.length * 0.45);
    await Bun.write(path, all.slice(0, cut));
    const partial = await indexTrace(path);
    expect(partial.complete).toBe(false);
    expect(partial.nextOffset).toBeLessThan(cut);

    await Bun.write(path, all);
    const resumed = await indexTrace(path, partial);
    const fresh = await indexTrace(path);

    expect(resumed.complete).toBe(true);
    expect(resumed.turns).toHaveLength(fresh.turns.length);
    expect(resumed.toolCalls).toHaveLength(fresh.toolCalls.length);
    expect(resumed.totals.totalTokens).toBe(fresh.totals.totalTokens);
  });
});
