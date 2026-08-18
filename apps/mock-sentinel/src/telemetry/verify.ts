/* oxlint-disable eslint/no-await-in-loop --
 * Ingestion is deliberately sequential. The Kusto Emulator is a single-node
 * engine running under x86-64 translation on Apple Silicon, where concurrency
 * has already been observed to destabilise it (infra/kusto/README.md documents
 * the .NET/Rosetta crashes and the flags that fix them). Ordering also matters:
 * a table is created before it is filled, and a chunk is only sent once the
 * previous one is durable. Fanning these out with Promise.all would trade a
 * bootstrap that already completes in ~1.6s for a flaky one.
 */
/**
 * Post-ingestion checks.
 *
 * A wrong column type does not make Kusto reject a row — it nulls the value and
 * carries on. Row counts alone therefore prove almost nothing, so the checks
 * here compare what is *in* the engine against what was read from the CSV,
 * column by column, and assert the schema Kusto reports matches the manifest
 * (ADR 001: `GET /schema` must be derived from Kusto, never hand-maintained).
 */

import type { KustoClient } from "../kusto/client.ts";
import type { TelemetryTable } from "./manifest.ts";
import type { NormalizedTable } from "./normalize.ts";

export interface VerificationIssue {
  table: string;
  detail: string;
}

/** Non-empty value count per column, taken from the normalised CSV. */
export function expectedNonEmpty(normalized: NormalizedTable): number[] {
  return normalized.columns.map((_, index) =>
    normalized.rows.reduce((total, row) => total + ((row[index] ?? "") === "" ? 0 : 1), 0),
  );
}

/**
 * Compares per-column populated counts in Kusto against the source CSV.
 *
 * `tostring()` normalises across types so one comparison covers them all: a
 * value that failed to convert is null, and `tostring(null)` is empty.
 */
export async function verifyColumnPopulation(
  client: KustoClient,
  database: string,
  table: TelemetryTable,
  expected: readonly number[],
): Promise<VerificationIssue[]> {
  const projections = table.columns
    .map((c, i) => `c${i}=countif(isnotempty(tostring(${c.name})))`)
    .join(", ");
  const result = await client.query(database, `${table.table} | summarize ${projections}`);

  const row = result.rows[0];
  if (row === undefined) {
    return [{ table: table.table, detail: "population query returned no rows" }];
  }

  const issues: VerificationIssue[] = [];
  for (const [index, column] of table.columns.entries()) {
    const actual = Number(row[index] ?? 0);
    const want = expected[index] ?? 0;
    if (actual !== want) {
      issues.push({
        table: table.table,
        detail:
          `column ${column.name} (${column.type}): ${actual} populated in Kusto, ` +
          `${want} non-empty in the CSV. A ${want - actual} row shortfall means values ` +
          `did not survive conversion — usually an inferred type that is too narrow.`,
      });
    }
  }
  return issues;
}

/** Asserts Kusto's own schema matches the manifest, table by table and column by column. */
export async function verifySchema(
  client: KustoClient,
  database: string,
  tables: readonly TelemetryTable[],
): Promise<VerificationIssue[]> {
  const result = await client.mgmt(`.show database ${database} schema`, database);

  const actual = new Map<string, Map<string, string>>();
  for (const row of result.rows) {
    const [, tableName, columnName, columnType] = row as (string | null)[];
    if (!tableName) continue;
    const columns = actual.get(tableName) ?? new Map<string, string>();
    if (columnName) columns.set(columnName, clrToKusto(String(columnType ?? "")));
    actual.set(tableName, columns);
  }

  const issues: VerificationIssue[] = [];
  for (const table of tables) {
    const columns = actual.get(table.table);
    if (!columns) {
      issues.push({ table: table.table, detail: "table is absent from the Kusto schema" });
      continue;
    }
    for (const column of table.columns) {
      const seen = columns.get(column.name);
      if (seen === undefined) {
        issues.push({ table: table.table, detail: `column ${column.name} is missing in Kusto` });
      } else if (seen !== column.type) {
        issues.push({
          table: table.table,
          detail: `column ${column.name} is ${seen} in Kusto, ${column.type} in the manifest`,
        });
      }
    }
    for (const name of columns.keys()) {
      if (!table.columns.some((c) => c.name === name)) {
        issues.push({
          table: table.table,
          detail: `column ${name} exists in Kusto but not the manifest`,
        });
      }
    }
  }
  return issues;
}

/**
 * `.show ... schema` reports CLR type names; the manifest speaks Kusto's.
 *
 * Two of these are not the obvious guess and were taken from the engine rather
 * than assumed: `bool` comes back as `System.SByte` (not `System.Boolean`), and
 * `dynamic` as `System.Object`.
 */
export function clrToKusto(clrType: string): string {
  const map: Record<string, string> = {
    "System.String": "string",
    "System.Int32": "int",
    "System.Int64": "long",
    "System.Double": "real",
    "System.SByte": "bool",
    "System.DateTime": "datetime",
    "System.Object": "dynamic",
    "System.Data.SqlTypes.SqlDecimal": "decimal",
    "System.TimeSpan": "timespan",
    "System.Guid": "guid",
  };
  return map[clrType] ?? clrType;
}

export interface ScenarioProbe {
  name: string;
  query: string;
  expected: number;
  why: string;
}

/**
 * Representative queries that must hold after a correct load.
 *
 * These pin the `SOC-FW-RDP` brute force recorded in ADR 001 — the first
 * scenario. They are loader assertions only: the alert fixture and the hidden
 * expected verdict belong to PRD-1 §4.2/§5 and are deliberately not here.
 */
export const SCENARIO_PROBES: readonly ScenarioProbe[] = [
  {
    name: "SOC-FW-RDP failed logons",
    query: 'SecurityEvent | where Computer == "SOC-FW-RDP" and EventID == 4625 | count',
    expected: 11_970,
    why: "the brute force itself",
  },
  {
    name: "SOC-FW-RDP successful logons",
    query: 'SecurityEvent | where Computer == "SOC-FW-RDP" and EventID == 4624 | count',
    expected: 10,
    why: "all NT AUTHORITY\\SYSTEM — the attack never succeeded",
  },
  {
    name: "accounts with both a failure and a success",
    query:
      "SecurityEvent | where EventID in (4624, 4625) " +
      "| summarize ids=make_set(EventID) by tolower(Account) " +
      "| where array_length(ids) > 1 | count",
    expected: 0,
    why: "the verdict hinges on this being empty",
  },
  {
    // Asserted as a span, not as absolute instants: the loader shifts the whole
    // dataset forward so relative-time KQL works, so any fixed date would be
    // wrong by construction. The span is exactly what the shift must preserve —
    // it is destroyed by the upstream loader's `TimeGenerated = now()`, which
    // ADR 001 refuses to copy, and this is what proves we did not copy it.
    name: "relative event spacing preserved",
    // Measured by subtraction, not datetime_diff: that function counts
    // second-boundary crossings, so a span of 59m38.048s reports 3578 or 3579
    // depending on the sub-second part of the shift anchor — which changes
    // every run. Subtraction is invariant under a constant offset, which is
    // exactly the property being asserted.
    query:
      "SecurityEvent | summarize spanMs = tolong((max(TimeGenerated) - min(TimeGenerated)) / 1ms)",
    expected: 3_578_048,
    why: "the 59m38.048s SecurityEvent window must survive the time shift intact",
  },
];

export async function runScenarioProbes(
  client: KustoClient,
  database: string,
): Promise<VerificationIssue[]> {
  const issues: VerificationIssue[] = [];
  for (const probe of SCENARIO_PROBES) {
    const result = await client.query(database, probe.query);
    const actual = Number(result.rows[0]?.[0] ?? -1);
    if (actual !== probe.expected) {
      issues.push({
        table: "scenario",
        detail: `${probe.name}: expected ${probe.expected}, got ${actual} (${probe.why})`,
      });
    }
  }
  return issues;
}
