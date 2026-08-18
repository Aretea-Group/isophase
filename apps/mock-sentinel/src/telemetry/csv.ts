/**
 * RFC 4180 CSV reader/writer.
 *
 * Hand-rolled rather than pulled from npm because the Training Lab data exercises
 * the parts of the format most naive splitters get wrong, and the loader's whole
 * job is to fail loudly rather than silently mangle rows. `SecurityEvents.csv`
 * alone carries 3,228 fields with embedded newlines and 3,656 containing quotes,
 * spread over 76,458 physical lines for 23,864 logical records.
 */

/** Byte-order mark; 8 of the 21 vendored files start with one. */
const BOM = "﻿";

export interface CsvTable {
  header: string[];
  /** Rows are positional and always `header.length` wide. */
  rows: string[][];
  /**
   * 1-based indices of records that were shorter than the header and have been
   * right-padded with empty fields.
   *
   * The pinned Training Lab data contains exactly one such record — the last
   * row of `SecurityEvents.csv`, a hand-appended EventID 1102 entry missing its
   * trailing `RelativeTargetName` field. Padding is reported rather than
   * silently applied so the manifest can pin the count and any *new*
   * malformation still fails the bootstrap.
   */
  paddedRows: number[];
}

/**
 * Parses CSV text into a header plus positional rows.
 *
 * Empty (unquoted) fields become `""`; the loader decides what counts as null,
 * because that distinction is type-dependent and belongs with the schema.
 *
 * Records with *more* fields than the header are always fatal: that is
 * unambiguous corruption. Records with fewer are padded and reported via
 * `paddedRows`, because the pinned upstream data legitimately contains one.
 *
 * @throws if a record has more fields than the header declares.
 */
export function parseCsv(text: string, source: string): CsvTable {
  const input = text.startsWith(BOM) ? text.slice(BOM.length) : text;

  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  let i = 0;

  const endField = (): void => {
    record.push(field);
    field = "";
  };
  const endRecord = (): void => {
    endField();
    // A trailing newline produces one empty field; that is not a record.
    if (record.length > 1 || record[0] !== "") records.push(record);
    record = [];
  };

  while (i < input.length) {
    // charAt over indexing: returns "" past the end rather than undefined.
    const char = input.charAt(i);

    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"' && field === "") {
      quoted = true;
      i += 1;
      continue;
    }
    if (char === ",") {
      endField();
      i += 1;
      continue;
    }
    if (char === "\r") {
      // Bare CR and CRLF both terminate a record.
      endRecord();
      i += input[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (char === "\n") {
      endRecord();
      i += 1;
      continue;
    }

    field += char;
    i += 1;
  }

  if (quoted) {
    throw new Error(`${source}: unterminated quoted field at end of file`);
  }
  if (field !== "" || record.length > 0) endRecord();

  const header = records.shift();
  if (!header) throw new Error(`${source}: file is empty`);

  const paddedRows: number[] = [];
  for (const [index, row] of records.entries()) {
    if (row.length > header.length) {
      throw new Error(
        `${source}: record ${index + 1} has ${row.length} fields, header declares only ${header.length}`,
      );
    }
    if (row.length < header.length) {
      paddedRows.push(index + 1);
      while (row.length < header.length) row.push("");
    }
  }

  return { header, rows: records, paddedRows };
}

/** Quotes a single field only when RFC 4180 requires it. */
export function encodeCsvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Serialises rows back to CSV text. No header — ingestion supplies the schema. */
export function encodeCsvRows(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(encodeCsvField).join(",")).join("\n");
}
