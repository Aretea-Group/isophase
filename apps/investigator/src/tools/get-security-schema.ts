import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { SchemaTable } from "@soc/contracts";

const Params = Type.Object(
  {
    tables: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      description: "Table names to describe. Request several at once when that is useful.",
    }),
  },
  { additionalProperties: false },
);

/**
 * Column definitions for tables the agent considers relevant (PRD-2 §10).
 *
 * Reads the schema already loaded at investigation startup — no second network call. Definitions
 * are returned as Mock Sentinel reported them, with no semantic interpretation layered on top.
 */
export function createGetSecuritySchemaTool(
  tables: Map<string, SchemaTable>,
): AgentTool<typeof Params> {
  return {
    name: "get_security_schema",
    label: "Get security schema",
    description:
      "Return the column definitions for one or more security tables. You start an investigation knowing only the table names; use this to see the columns before writing KQL against them.",
    parameters: Params,
    execute: async (_toolCallId, params) => {
      const unknown = params.tables.filter((name) => !tables.has(name));
      if (unknown.length > 0) {
        // Naming what is available turns a typo into a one-turn correction.
        throw new Error(
          `Unknown table(s): ${unknown.join(", ")}. Available tables: ${[...tables.keys()].join(", ")}`,
        );
      }

      const requested = params.tables.map((name) => tables.get(name));
      return {
        content: [{ type: "text", text: JSON.stringify(requested, null, 2) }],
        details: { tables: params.tables },
      };
    },
  };
}
