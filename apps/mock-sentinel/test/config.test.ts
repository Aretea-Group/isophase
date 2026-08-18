import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  test("applies defaults for an empty environment", () => {
    const config = loadConfig({});

    expect(config.PORT).toBe(8787);
    expect(config.KUSTO_DATABASE).toBe("SentinelLab");
    expect(config.QUERY_MAX_ROWS).toBe(500);
  });

  test("coerces numeric environment strings", () => {
    expect(loadConfig({ PORT: "9000" }).PORT).toBe(9000);
  });

  test("fails fast and names the offending key", () => {
    expect(() => loadConfig({ KUSTO_ENDPOINT: "not-a-url" })).toThrow(/KUSTO_ENDPOINT/);
  });
});
