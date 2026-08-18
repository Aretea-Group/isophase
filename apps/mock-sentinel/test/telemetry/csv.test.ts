import { describe, expect, test } from "bun:test";

import { encodeCsvField, encodeCsvRows, parseCsv } from "../../src/telemetry/csv.ts";

describe("parseCsv", () => {
  test("parses quoted fields containing commas, quotes and newlines", () => {
    const text = ["a,b,c", '1,"x,y","he said ""hi""', 'second line"', ""].join("\n");
    const table = parseCsv(text, "t.csv");

    expect(table.header).toEqual(["a", "b", "c"]);
    expect(table.rows).toEqual([["1", "x,y", 'he said "hi"\nsecond line']]);
  });

  test("strips a UTF-8 BOM", () => {
    expect(parseCsv("﻿Account,Computer\nadmin,pc1\n", "t.csv").header).toEqual([
      "Account",
      "Computer",
    ]);
  });

  test("handles CRLF and a missing trailing newline", () => {
    const table = parseCsv("a,b\r\n1,2\r\n3,4", "t.csv");
    expect(table.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  test("keeps empty trailing fields", () => {
    expect(parseCsv("a,b,c\n1,,\n", "t.csv").rows).toEqual([["1", "", ""]]);
  });

  test("pads a short record and reports it", () => {
    const table = parseCsv("a,b,c\n1,2,3\n4,5\n", "t.csv");

    expect(table.rows).toEqual([
      ["1", "2", "3"],
      ["4", "5", ""],
    ]);
    expect(table.paddedRows).toEqual([2]);
  });

  test("rejects a record with more fields than the header", () => {
    expect(() => parseCsv("a,b\n1,2,3\n", "t.csv")).toThrow(/has 3 fields, header declares only 2/);
  });

  test("rejects an unterminated quoted field", () => {
    expect(() => parseCsv('a,b\n1,"unclosed\n', "t.csv")).toThrow(/unterminated quoted field/);
  });
});

describe("encodeCsv", () => {
  test("quotes only when required", () => {
    expect(encodeCsvField("plain")).toBe("plain");
    expect(encodeCsvField("has,comma")).toBe('"has,comma"');
    expect(encodeCsvField('has"quote')).toBe('"has""quote"');
    expect(encodeCsvField("has\nnewline")).toBe('"has\nnewline"');
  });

  test("round-trips the hazards present in the real telemetry", () => {
    const rows = [["\\ADMINISTRATOR", '<Data Name="x">\n  <v>1</v>\n</Data>', "4625"]];
    const encoded = encodeCsvRows(rows);

    expect(parseCsv(`a,b,c\n${encoded}\n`, "t.csv").rows).toEqual(rows);
  });
});
