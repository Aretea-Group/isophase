import { describe, expect, test } from "bun:test";

import type { QueryResponse } from "@soc/contracts";
import type { SecurityDataSource } from "@soc/sentinel-client";

import {
  createQuerySecurityDataTool,
  fitResultToBudget,
} from "../src/tools/query-security-data.ts";
import {
  createFixtureSourceBundle,
  FIXTURE_QUERY_ERROR,
  TEST_SOURCE_PROFILE,
} from "./fixtures/source.ts";

const RESULT: QueryResponse = {
  tables: [
    {
      name: "NativeResult",
      columns: [{ name: "opaque", type: "native-type" }],
      rows: [["evidence"]],
    },
  ],
  truncation: { truncated: false, returnedRows: 1, maxRows: 500 },
};

describe("query_security_data selected profile", () => {
  test("exposes stable { query } input and passes raw text and results through", async () => {
    const received: string[] = [];
    const source = {
      query: (query: string) => {
        received.push(query);
        return Promise.resolve(RESULT);
      },
    } as unknown as SecurityDataSource;
    const tool = createQuerySecurityDataTool(
      {
        primaryId: "fixture",
        sources: new Map([
          ["fixture", { client: source, profile: TEST_SOURCE_PROFILE, tables: new Map() }],
        ]),
      },
      TEST_SOURCE_PROFILE.queryToolDescription,
      TEST_SOURCE_PROFILE.queryParameterDescription,
    );

    expect(tool.description).toBe(TEST_SOURCE_PROFILE.queryToolDescription);
    expect(tool.parameters).toMatchObject({
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { description: TEST_SOURCE_PROFILE.queryParameterDescription },
      },
    });

    const result = await tool.execute("call-1", { query: "MATCH NativeEvents RETURN opaque" });
    expect(received).toEqual(["MATCH NativeEvents RETURN opaque"]);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(RESULT) }]);
    expect(result.details).toMatchObject({
      query: "MATCH NativeEvents RETURN opaque",
      source: "fixture",
      keptRows: 1,
      totalRows: 1,
    });
  });

  test("keeps explicit first-row truncation without source-specific query syntax", () => {
    const large: QueryResponse = {
      ...RESULT,
      tables: [{ ...RESULT.tables[0]!, rows: Array.from({ length: 20 }, () => ["evidence"]) }],
      truncation: { truncated: false, returnedRows: 20, maxRows: 500 },
    };

    const fitted = fitResultToBudget(large, 250);
    expect(fitted.keptRows).toBeLessThan(20);
    expect(fitted.totalRows).toBe(20);
    expect(fitted.text).toContain("rows are not a sample");
    expect(fitted.text).toContain("narrower or aggregated query");
    expect(fitted.text).not.toContain("summarize");
  });

  test("propagates an actionable FixtureQL diagnostic without interpreting the query", async () => {
    const fixture = createFixtureSourceBundle({ queryError: FIXTURE_QUERY_ERROR });
    const tool = createQuerySecurityDataTool(
      {
        primaryId: "fixture",
        sources: new Map([
          ["fixture", { client: fixture.source, profile: TEST_SOURCE_PROFILE, tables: new Map() }],
        ]),
      },
      TEST_SOURCE_PROFILE.queryToolDescription,
      TEST_SOURCE_PROFILE.queryParameterDescription,
    );
    const query = "MATCH IdentitySessions RETURN device_trsut";

    await expect(tool.execute("call-error", { query })).rejects.toThrow(FIXTURE_QUERY_ERROR);
    expect(fixture.source.queries).toEqual([query]);
  });
});
