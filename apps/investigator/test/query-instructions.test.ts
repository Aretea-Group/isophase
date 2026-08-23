import { describe, expect, test } from "bun:test";

import { DEFAULT_INSTRUCTIONS } from "../src/instructions.ts";
import { SENTINEL_QUERY_INSTRUCTIONS } from "../src/query-instructions.ts";

describe("Sentinel query instructions", () => {
  test("keep evidence-efficiency and KQL syntax guidance out of generic instructions", () => {
    expect(DEFAULT_INSTRUCTIONS).not.toContain(
      "Before querying, identify the unresolved questions",
    );
    expect(DEFAULT_INSTRUCTIONS).not.toContain("Use valid KQL forms");
    expect(SENTINEL_QUERY_INSTRUCTIONS).toContain(
      "Before querying, identify the unresolved questions",
    );
    expect(SENTINEL_QUERY_INSTRUCTIONS).toContain("Never write '| order by count()'");
    expect(SENTINEL_QUERY_INSTRUCTIONS).toContain(
      "| summarize total=count() by Column | order by total desc",
    );
  });
});
