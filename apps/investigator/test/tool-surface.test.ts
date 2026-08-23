import { describe, expect, test } from "bun:test";

import type { SecurityDataSource } from "@soc/sentinel-client";

import type { WebSearchClient } from "../src/clients/brave.ts";
import type { WebFetchClient } from "../src/clients/fetch.ts";
import { createInvestigationTools, INVESTIGATION_TOOL_NAMES } from "../src/tools/index.ts";
import { testSourceBundle } from "./fixtures/source.ts";

/**
 * `INVESTIGATION_TOOL_NAMES` is what the console renders before spending money. It was a hand-
 * written copy, because the factory closes over per-investigation state a name-only caller cannot
 * supply; PRD-6 §6.6 hoisted each tool's metadata into a `const` beside its implementation, so the
 * names are now derived from the same list the factory spreads.
 *
 * The guard still earns its place. Derivation makes the *names* honest; this asserts the factory
 * still builds those tools, in that order. A sixth tool wired into the factory but left out of
 * `TOOLS` fails here rather than quietly leaving the overlay describing an agent that no longer
 * exists — and, because `toolDescriptors()` reads the same list, leaving the prompt hash unmoved by
 * a change to what the agent can do.
 */
describe("the advertised tool surface matches the built one (PRD-5 §8)", () => {
  test("names and order are identical to what the factory returns", () => {
    const tools = createInvestigationTools({
      tables: new Map(),
      source: testSourceBundle({} as SecurityDataSource),
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
