/**
 * Joins the curated manifest (`manifest.ts`) to the generated column lists
 * (`manifest.generated.ts`) into the table definitions the loader works from.
 */

import { GENERATED_COLUMNS } from "./manifest.generated.ts";
import { CURATION, type TelemetryTable } from "./manifest.ts";

function build(): TelemetryTable[] {
  return Object.entries(CURATION).map(([table, curation]) => {
    const columns = GENERATED_COLUMNS[table];
    if (columns === undefined || columns.length === 0) {
      throw new Error(
        `Table ${table} is curated but has no generated columns. ` +
          `Run \`bun run data:manifest\` to regenerate manifest.generated.ts.`,
      );
    }
    return Object.assign({ table, columns }, curation);
  });
}

/** Every table the bootstrap creates, in a stable order. */
export const TELEMETRY_TABLES: readonly TelemetryTable[] = build().toSorted((a, b) =>
  a.table.localeCompare(b.table),
);

export function findTable(name: string): TelemetryTable | undefined {
  return TELEMETRY_TABLES.find((t) => t.table === name);
}
