import { describe, expect, test } from "bun:test";

import { parseCsv } from "../../src/telemetry/csv.ts";
import { normalizeTable } from "../../src/telemetry/normalize.ts";
import { readTelemetryFile } from "../../src/telemetry/source.ts";
import { TELEMETRY_TABLES } from "../../src/telemetry/tables.ts";

/**
 * Runs the manifest against the vendored CSVs without touching Kusto.
 *
 * This is the drift detector ADR 001 asks for: if the pinned upstream revision
 * moves, or the manifest is edited without regenerating, it fails here rather
 * than halfway through a bootstrap.
 */
describe("telemetry manifest", () => {
  test("covers 21 tables", () => {
    expect(TELEMETRY_TABLES).toHaveLength(21);
  });

  test("table names are plain Kusto identifiers", () => {
    for (const table of TELEMETRY_TABLES) {
      expect(table.table).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
  });

  test("every column name is a plain Kusto identifier and unique per table", () => {
    for (const table of TELEMETRY_TABLES) {
      const names = table.columns.map((c) => c.name);
      for (const name of names) expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  test("a table with datetime columns declares a convention and a window", () => {
    for (const table of TELEMETRY_TABLES) {
      if (table.columns.some((c) => c.type === "datetime")) {
        expect(table.dateConvention).toBeDefined();
        expect(table.expectedWindow).toBeDefined();
      }
    }
  });

  test.each(TELEMETRY_TABLES.map((t) => [t.table, t] as const))(
    "%s matches its vendored CSV",
    async (_name, table) => {
      const csv = parseCsv(await readTelemetryFile(table.file), table.file);
      const normalized = normalizeTable(csv, table);

      expect(normalized.rows).toHaveLength(table.expectedRows);
      expect(normalized.columns).toHaveLength(csv.header.length);
    },
  );

  test("SecurityEvent exposes TimeGenerated rather than the CSV's TimeCollected", () => {
    const securityEvent = TELEMETRY_TABLES.find((t) => t.table === "SecurityEvent");

    expect(
      securityEvent?.columns.some((c) => c.name === "TimeGenerated" && c.type === "datetime"),
    ).toBe(true);
    expect(securityEvent?.columns.some((c) => c.name === "TimeCollected")).toBe(false);
    // EventID must be numeric or `where EventID == 4625` silently matches nothing.
    expect(securityEvent?.columns.find((c) => c.name === "EventID")?.type).toBe("int");
  });
});
