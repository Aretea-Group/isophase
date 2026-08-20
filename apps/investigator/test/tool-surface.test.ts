import { describe, expect, test } from "bun:test";

import type { SentinelApiClient } from "@soc/sentinel-client";

import type { WebSearchClient } from "../src/clients/brave.ts";
import type { WebFetchClient } from "../src/clients/fetch.ts";
import { createInvestigationTools, INVESTIGATION_TOOL_NAMES } from "../src/tools/index.ts";

/**
 * `INVESTIGATION_TOOL_NAMES` is what the console renders before spending money, and it is a hand-
 * written copy of a list that lives in `createInvestigationTools`. Deriving it there is not
 * possible — the factory closes over per-investigation state a name-only caller cannot supply — so
 * this is the guard that keeps the copy honest.
 *
 * A sixth tool added without touching the constant fails here rather than quietly leaving the
 * overlay describing an agent that no longer exists.
 */
describe("the advertised tool surface matches the built one (PRD-5 §8)", () => {
  test("names and order are identical to what the factory returns", () => {
    const tools = createInvestigationTools({
      tables: new Map(),
      sentinel: {} as SentinelApiClient,
      webSearch: {} as WebSearchClient,
      webFetch: {} as WebFetchClient,
      onSubmit: () => undefined,
    });

    expect(tools.map((tool) => tool.name)).toEqual([...INVESTIGATION_TOOL_NAMES]);
  });

  test("submit_investigation is present, because a run with no way to conclude is not a run", () => {
    expect(INVESTIGATION_TOOL_NAMES).toContain("submit_investigation");
  });
});
