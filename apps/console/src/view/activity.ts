import type { ToolCall, TraceIndex } from "../data/trace-index.ts";
import { chars, clockTime, cost, tokens, truncate } from "./format.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The table a KQL query opens with.
 *
 * Every query in the corpus starts with its source table, which is simply how KQL reads. This is a
 * display convenience for the "which tables did it look at" summary, so an unrecognised query is
 * left out rather than guessed at.
 */
export function leadingTable(kql: string): string | undefined {
  for (const raw of kql.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("//") || line.startsWith("|")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
    return match?.[1];
  }
  return undefined;
}

/** A one-line description of what a call asked for. */
export function summariseArgs(call: ToolCall, width = 40, queryLanguage?: string): string {
  const args = asRecord(call.args);
  if (args === undefined) return "";

  switch (call.toolName) {
    case "get_security_schema": {
      const tables = args["tables"];
      return Array.isArray(tables) ? `${tables.length} tables` : "";
    }
    case "query_security_data": {
      const query = args["query"];
      if (typeof query !== "string") return "";
      return queryLanguage === "kql"
        ? (leadingTable(query) ?? truncate(query, width))
        : truncate(query, width);
    }
    case "web_search":
      return typeof args["query"] === "string" ? truncate(args["query"], width) : "";
    case "web_fetch":
      return typeof args["url"] === "string" ? truncate(args["url"], width) : "";
    case "submit_investigation": {
      const tp = args["tpPercent"];
      const fp = args["fpPercent"];
      return typeof tp === "number" && typeof fp === "number" ? `TP ${tp} / FP ${fp}` : "verdict";
    }
    default:
      return truncate(JSON.stringify(args), width);
  }
}

export type ActivityRow =
  | {
      kind: "turn";
      index: number;
      at: string;
      tokens: string;
      cost: string;
      /** The turn has started but not ended — its usage is not known yet. */
      pending?: boolean;
    }
  | {
      kind: "call";
      seq: number;
      at: string;
      toolName: string;
      summary: string;
      size: string;
      isError: boolean;
      call: ToolCall;
    };

export interface ActivityView {
  rows: ActivityRow[];
  /** Which tables were queried, and how often — the answer without opening a call (PRD-3 §8.3). */
  tables: { name: string; count: number }[];
  searches: string[];
  fetches: string[];
  errors: number;
  turnCount: number;
  callCount: number;
}

export function toActivityView(index: TraceIndex, queryLanguage?: string): ActivityView {
  const rows: ActivityRow[] = [];
  const tableCounts = new Map<string, number>();
  const searches: string[] = [];
  const fetches: string[] = [];
  let errors = 0;

  const callsByTurn = new Map<number, ToolCall[]>();
  for (const call of index.toolCalls) {
    const list = callsByTurn.get(call.turn) ?? [];
    list.push(call);
    callsByTurn.set(call.turn, list);
  }

  const callRow = (call: ToolCall): ActivityRow => ({
    kind: "call",
    seq: call.seq,
    at: clockTime(call.at),
    toolName: call.toolName,
    summary: summariseArgs(call, 40, queryLanguage),
    size: chars(call.resultChars),
    isError: call.isError === true,
    call,
  });

  for (const turn of index.turns) {
    rows.push({
      kind: "turn",
      index: turn.index,
      at: clockTime(turn.at),
      tokens: tokens(turn.usage?.totalTokens),
      cost: cost(turn.usage?.cost),
    });
    for (const call of callsByTurn.get(turn.index) ?? []) rows.push(callRow(call));
  }

  // Calls made during a turn that has not ended yet.
  //
  // Usage arrives with `turn_end`, so a turn in flight has no row of its own. Hanging its calls
  // off the last completed turn would be wrong, and dropping them would make the live view blank
  // for exactly as long as the agent is working — which is when someone is watching it.
  const ended = new Set(index.turns.map((turn) => turn.index));
  const inFlight = index.toolCalls.filter((call) => !ended.has(call.turn));
  if (inFlight.length > 0 || (!index.complete && index.turns.length === 0)) {
    rows.push({
      kind: "turn",
      index: (index.turns.at(-1)?.index ?? 0) + 1,
      at: clockTime(inFlight[0]?.at ?? index.startedAt),
      tokens: "…",
      cost: "",
      pending: true,
    });
    for (const call of inFlight) rows.push(callRow(call));
  }

  for (const call of index.toolCalls) {
    if (call.isError === true) errors += 1;
    const args = asRecord(call.args);
    if (args === undefined) continue;

    if (call.toolName === "get_security_schema" && Array.isArray(args["tables"])) {
      for (const table of args["tables"]) {
        if (typeof table === "string") tableCounts.set(table, tableCounts.get(table) ?? 0);
      }
    }
    if (
      queryLanguage === "kql" &&
      call.toolName === "query_security_data" &&
      typeof args["query"] === "string"
    ) {
      const table = leadingTable(args["query"]);
      if (table !== undefined) tableCounts.set(table, (tableCounts.get(table) ?? 0) + 1);
    }
    if (call.toolName === "web_search" && typeof args["query"] === "string") {
      searches.push(args["query"]);
    }
    if (call.toolName === "web_fetch" && typeof args["url"] === "string") {
      fetches.push(args["url"]);
    }
  }

  const tables = [...tableCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .toSorted((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    rows,
    tables,
    searches,
    fetches,
    errors,
    turnCount: index.turns.length,
    callCount: index.toolCalls.length,
  };
}
