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
 * are returned as the selected source reported them, with no semantic interpretation layered on
 * top.
 */
/** Stable name and schema; selected profile supplies model-visible description. */
export const GET_SECURITY_SCHEMA = {
  name: "get_security_schema",
  label: "Get security schema",
  parameters: Params,
} as const;

function renderTable(table: SchemaTable): string {
  return `${table.name}(${table.columns.map((column) => `${column.name}:${column.type}`).join(",")})`;
}

export function createGetSecuritySchemaTool(
  tables: Map<string, SchemaTable>,
  description: string,
): AgentTool<typeof Params> {
  return {
    ...GET_SECURITY_SCHEMA,
    description,
    execute: async (_toolCallId, params) => {
      const unknown = params.tables.filter((name) => !tables.has(name));
      if (unknown.length > 0) {
        // Naming what is available turns a typo into a one-turn correction.
        throw new Error(
          `Unknown table(s): ${unknown.join(", ")}. Available tables: ${[...tables.keys()].join(", ")}`,
        );
      }

      // Names and types are the whole schema contract. Repeating JSON object keys for every column
      // adds thousands of characters without adding information, so render the same facts in
      // compact table(column:type) form.
      const requested = params.tables.map((name) => {
        const table = tables.get(name);
        // The unknown-name branch above already proved this, but Map.get cannot carry that proof.
        if (table === undefined) throw new Error(`Unknown table: ${name}`);
        return table;
      });
      return {
        content: [
          {
            type: "text",
            text: `Only listed columns exist.\n${requested.map(renderTable).join("\n")}`,
          },
        ],
        details: { tables: params.tables },
      };
    },
  };
}
