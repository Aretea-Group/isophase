import { describe, expect, test } from "bun:test";

import type { SchemaTable } from "@soc/contracts";

import { createGetSecuritySchemaTool } from "../src/tools/get-security-schema.ts";

describe("get_security_schema", () => {
  test("returns every requested column and type without repeated JSON structure", async () => {
    const table: SchemaTable = {
      name: "Example_CL",
      columns: [
        { name: "CreatedAt", type: "datetime" },
        { name: "Properties", type: "dynamic" },
      ],
    };
    const tool = createGetSecuritySchemaTool(
      {
        primaryId: "fixture",
        sources: new Map([
          [
            "fixture",
            {
              client: {} as never,
              profile: {} as never,
              tables: new Map([[table.name, table]]),
            },
          ],
        ]),
      },
      "Describe test tables.",
    );

    const result = await tool.execute("call-1", { tables: [table.name] });

    expect(result.content).toEqual([
      {
        type: "text",
        text: "Only listed columns exist.\nExample_CL(CreatedAt:datetime,Properties:dynamic)",
      },
    ]);
    expect(result.details).toEqual({ source: "fixture", tables: [table.name] });
  });
});
