/**
 * Turns a vendored Training Lab CSV into something Kusto can ingest, and refuses
 * to do so quietly when the data does not look like what the manifest declares.
 *
 * Pure functions over already-read text: no filesystem, no network, no Kusto.
 */

import type { CsvTable } from "./csv.ts";
import {
  sanitizeColumnName,
  UTC_HEADER_SUFFIX,
  type DateConvention,
  type TelemetryColumn,
  type TelemetryTable,
} from "./manifest.ts";

/** `4/16/2021, 9:09:00.730 AM` */
const US_LONG =
  /^(\d{1,2})\/(\d{1,2})\/(\d{4}),\s+(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?\s*(AM|PM)$/i;
/** `10/02/2026 11:00:12` — component order depends on the convention. */
const SLASHED = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T]+(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?$/;
/** `2026-02-08 09:12:34Z`, `2019-09-12T20:00:00.625Z` */
const ISO = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?Z?$/;

/** Milliseconds, from a fractional-seconds capture of arbitrary precision. */
function fractionToMillis(fraction: string | undefined): number {
  if (fraction === undefined) return 0;
  return Math.floor(Number(`0.${fraction}`) * 1000);
}

/**
 * Builds a UTC timestamp, rejecting components that would silently roll over.
 * `2025-13-01` must fail rather than become `2026-01-01`, because month 13 is
 * exactly what a day-first date looks like when read month-first.
 */
function utc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  ms: number,
): Date | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
  const roundTripped =
    date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
  return roundTripped ? date : null;
}

/**
 * Parses one timestamp under a declared convention.
 *
 * @returns the instant, or `null` if the value does not match — which the caller
 *   treats as a hard error rather than a skip, since a column is either a
 *   datetime column or it is not.
 */
export function tryParseDateTime(value: string, convention: DateConvention): Date | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;

  if (convention === "us-long") {
    const m = US_LONG.exec(trimmed);
    if (!m) return null;
    const [, month = "", day = "", year = "", hh = "", mm = "", ss = "", frac, meridiem = ""] = m;
    const hour12 = Number(hh);
    if (hour12 < 1 || hour12 > 12) return null;
    const pm = meridiem.toUpperCase() === "PM";
    const hour = pm ? (hour12 === 12 ? 12 : hour12 + 12) : hour12 === 12 ? 0 : hour12;
    return utc(
      Number(year),
      Number(month),
      Number(day),
      hour,
      Number(mm),
      Number(ss),
      fractionToMillis(frac),
    );
  }

  if (convention === "iso") {
    const m = ISO.exec(trimmed);
    if (!m) return null;
    const [, year = "", month = "", day = "", hh = "", mm = "", ss = "", frac] = m;
    return utc(
      Number(year),
      Number(month),
      Number(day),
      Number(hh),
      Number(mm),
      Number(ss),
      fractionToMillis(frac),
    );
  }

  const m = SLASHED.exec(trimmed);
  if (!m) return null;
  const [, first = "", second = "", year = "", hh = "", mm = "", ss = "", frac] = m;
  const day = Number(convention === "dmy" ? first : second);
  const month = Number(convention === "dmy" ? second : first);
  return utc(Number(year), month, day, Number(hh), Number(mm), Number(ss), fractionToMillis(frac));
}

/** Kusto-ingestible ISO 8601, always UTC, milliseconds retained. */
export function toKustoDateTime(date: Date): string {
  return date.toISOString();
}

/**
 * Strips the ` [UTC]` portal-export suffix, applies table-specific renames, then
 * coerces the result to a plain Kusto identifier. The suffix carries no
 * information — the values are already UTC.
 */
export function normalizeHeader(
  header: readonly string[],
  rename: Record<string, string> = {},
): string[] {
  return header.map((raw) => {
    const stripped = raw.endsWith(UTC_HEADER_SUFFIX)
      ? raw.slice(0, -UTC_HEADER_SUFFIX.length)
      : raw;
    return sanitizeColumnName(rename[stripped] ?? stripped);
  });
}

export interface NormalizedTable {
  columns: readonly TelemetryColumn[];
  /** Positional rows aligned to `columns`, datetimes rewritten to ISO 8601. */
  rows: string[][];
  /** Indices of the datetime columns, so a later shift need not re-detect them. */
  dateColumnIndices: number[];
  /** Newest instant in this table, or `undefined` when it has no datetimes. */
  latestTimestamp: Date | undefined;
}

/**
 * Validates a parsed CSV against its manifest entry and rewrites its datetime
 * columns to ISO 8601.
 *
 * Every failure names the file, the column and the offending value: the drift
 * this guards against is invisible at runtime otherwise — no error, no crash,
 * records placed months from where an investigation will look for them.
 */
export function normalizeTable(csv: CsvTable, table: TelemetryTable): NormalizedTable {
  const header = normalizeHeader(csv.header, table.rename);
  const declared = table.columns.map((c) => c.name);

  if (header.length !== declared.length || header.some((name, i) => name !== declared[i])) {
    throw new Error(
      `${table.file}: header does not match the manifest for table ${table.table}.\n` +
        `  file:     ${header.join(", ")}\n` +
        `  manifest: ${declared.join(", ")}\n` +
        `Regenerate with \`bun run data:manifest\` if the upstream revision changed.`,
    );
  }
  const knownShortRows = table.knownShortRows ?? 0;
  if (csv.paddedRows.length !== knownShortRows) {
    throw new Error(
      `${table.file}: expected ${knownShortRows} truncated record(s), found ` +
        `${csv.paddedRows.length} at record(s) ${csv.paddedRows.join(", ") || "-"}. ` +
        `Short records are padded only where the manifest pins the count, so this ` +
        `is either new upstream damage or a stale manifest.`,
    );
  }
  if (csv.rows.length !== table.expectedRows) {
    throw new Error(
      `${table.file}: expected ${table.expectedRows} rows, found ${csv.rows.length}. ` +
        `Row counts are pinned to the upstream revision; treat a change as a dependency upgrade.`,
    );
  }

  const window = table.expectedWindow;
  const from = window ? Date.parse(window.from) : 0;
  const to = window ? Date.parse(window.to) : 0;

  const dateColumns = table.columns.flatMap((column, index) =>
    column.type === "datetime" ? [{ index, name: column.name }] : [],
  );
  const convention = table.dateConvention;
  if (dateColumns.length > 0 && convention === undefined) {
    throw new Error(`${table.file}: has datetime columns but no dateConvention declared`);
  }

  const rows = csv.rows.map((row) => [...row]);
  let latestTimestamp: Date | undefined;
  for (const { index, name } of dateColumns) {
    if (convention === undefined) break;
    for (const [rowIndex, row] of rows.entries()) {
      const raw = row[index] ?? "";
      if (raw.trim() === "") {
        row[index] = "";
        continue;
      }

      const parsed = tryParseDateTime(raw, convention);
      if (parsed === null) {
        throw new Error(
          `${table.file}: row ${rowIndex + 1}, column "${name}": ${JSON.stringify(raw)} ` +
            `is not a valid ${convention} timestamp.`,
        );
      }
      if (window && (parsed.getTime() < from || parsed.getTime() >= to)) {
        throw new Error(
          `${table.file}: row ${rowIndex + 1}, column "${name}": ${JSON.stringify(raw)} ` +
            `parses as ${parsed.toISOString()}, outside the expected window ` +
            `${window.from} .. ${window.to}. This is what an incorrect date convention ` +
            `looks like — see ADR 001, "Date formats are inconsistent per file".`,
        );
      }
      row[index] = toKustoDateTime(parsed);
      if (latestTimestamp === undefined || parsed > latestTimestamp) latestTimestamp = parsed;
    }
  }

  return {
    columns: table.columns,
    rows,
    dateColumnIndices: dateColumns.map((column) => column.index),
    latestTimestamp,
  };
}

/**
 * Moves every timestamp in a normalised table by a fixed offset.
 *
 * Applied **after** `normalizeTable` has validated the original values against
 * the manifest's expected window, so the drift checks still judge the source
 * data as shipped. Shifting is a presentation concern; validation is a fidelity
 * concern, and conflating them would let a shift hide real upstream drift.
 *
 * The offset is the same for every table, so all intervals — within a table,
 * between tables, and between eras — survive untouched.
 */
export function applyTimeShift(normalized: NormalizedTable, offsetMs: number): NormalizedTable {
  if (offsetMs === 0 || normalized.dateColumnIndices.length === 0) return normalized;

  const rows = normalized.rows.map((row) => {
    const shifted = [...row];
    for (const index of normalized.dateColumnIndices) {
      const value = shifted[index] ?? "";
      if (value === "") continue;
      shifted[index] = new Date(Date.parse(value) + offsetMs).toISOString();
    }
    return shifted;
  });

  return {
    ...normalized,
    rows,
    latestTimestamp:
      normalized.latestTimestamp === undefined
        ? undefined
        : new Date(normalized.latestTimestamp.getTime() + offsetMs),
  };
}
