import { describe, expect, test } from "bun:test";

import { parseCsv } from "../../src/telemetry/csv.ts";
import {
  sanitizeColumnName,
  toTableName,
  type TelemetryTable,
} from "../../src/telemetry/manifest.ts";
import {
  normalizeHeader,
  normalizeTable,
  tryParseDateTime,
} from "../../src/telemetry/normalize.ts";

const iso = (value: string, convention: Parameters<typeof tryParseDateTime>[1]): string | null =>
  tryParseDateTime(value, convention)?.toISOString() ?? null;

describe("tryParseDateTime", () => {
  test("reads each convention the Training Lab actually uses", () => {
    expect(iso("4/16/2021, 9:09:00.730 AM", "us-long")).toBe("2021-04-16T09:09:00.730Z");
    expect(iso("10/02/2026 11:00:12", "dmy")).toBe("2026-02-10T11:00:12.000Z");
    expect(iso("02/10/2026 10:23:22", "mdy")).toBe("2026-02-10T10:23:22.000Z");
    expect(iso("2026-02-08 09:12:34Z", "iso")).toBe("2026-02-08T09:12:34.000Z");
    expect(iso("2019-09-12T20:00:00.625Z", "iso")).toBe("2019-09-12T20:00:00.625Z");
  });

  test("maps 12-hour midnight and noon correctly", () => {
    expect(iso("4/16/2021, 12:30:00.000 AM", "us-long")).toBe("2021-04-16T00:30:00.000Z");
    expect(iso("4/16/2021, 12:30:00.000 PM", "us-long")).toBe("2021-04-16T12:30:00.000Z");
  });

  test("the same literal means different days under dmy and mdy", () => {
    // This is the whole reason the convention is declared per file rather than
    // guessed: read the wrong way round, MailGuard365 lands eight months away.
    expect(iso("02/10/2026 10:23:22", "dmy")).toBe("2026-10-02T10:23:22.000Z");
    expect(iso("02/10/2026 10:23:22", "mdy")).toBe("2026-02-10T10:23:22.000Z");
  });

  test("rejects rather than rolls over an impossible component", () => {
    // `24/11/2025` read month-first is month 24. Date.UTC would happily roll
    // that into 2027; returning null is what makes the convention provable.
    expect(iso("24/11/2025 18:43:12", "mdy")).toBeNull();
    expect(iso("24/11/2025 18:43:12", "dmy")).toBe("2025-11-24T18:43:12.000Z");
    expect(iso("2/30/2021, 1:00:00.000 AM", "us-long")).toBeNull();
  });

  test("returns null for empty and malformed values", () => {
    expect(iso("", "dmy")).toBeNull();
    expect(iso("   ", "dmy")).toBeNull();
    expect(iso("not a date", "dmy")).toBeNull();
    expect(iso("2026-02-08 09:12:34Z", "dmy")).toBeNull();
  });
});

describe("header normalisation", () => {
  test("strips the [UTC] portal suffix, applies renames, then sanitises", () => {
    expect(normalizeHeader(["TimeGenerated [UTC]", "UserId_", "Site Url"])).toEqual([
      "TimeGenerated",
      "UserId_",
      "Site_Url",
    ]);
    expect(normalizeHeader(["TimeCollected [UTC]"], { TimeCollected: "TimeGenerated" })).toEqual([
      "TimeGenerated",
    ]);
  });

  test("coerces names Kusto refuses even when bracket-quoted", () => {
    expect(sanitizeColumnName("$table")).toBe("_table");
    expect(sanitizeColumnName("Categories/0")).toBe("Categories_0");
    expect(sanitizeColumnName("Identity Types/0")).toBe("Identity_Types_0");
    expect(sanitizeColumnName("0leading")).toBe("_0leading");
    expect(sanitizeColumnName("_ResourceId")).toBe("_ResourceId");
  });

  test("replaces hyphens in table names", () => {
    expect(toTableName("sign-in_adelete_CL")).toBe("sign_in_adelete_CL");
    expect(toTableName("solarigate-beacon-umbrella_CL")).toBe("solarigate_beacon_umbrella_CL");
  });
});

const table = (overrides: Partial<TelemetryTable> = {}): TelemetryTable => ({
  table: "T",
  file: "t.csv",
  expectedRows: 1,
  dateConvention: "dmy",
  expectedWindow: { from: "2026-02-10T00:00:00Z", to: "2026-02-11T00:00:00Z" },
  columns: [
    { name: "TimeGenerated", type: "datetime" },
    { name: "Account", type: "string" },
  ],
  ...overrides,
});

describe("normalizeTable", () => {
  test("rewrites datetime columns and leaves the rest alone", () => {
    const csv = parseCsv("TimeGenerated,Account\n10/02/2026 11:00:12,admin\n", "t.csv");

    expect(normalizeTable(csv, table()).rows).toEqual([["2026-02-10T11:00:12.000Z", "admin"]]);
  });

  test("preserves empty datetime cells as empty", () => {
    const csv = parseCsv("TimeGenerated,Account\n,admin\n", "t.csv");

    expect(normalizeTable(csv, table()).rows).toEqual([["", "admin"]]);
  });

  test("fails when a value parses outside the declared window", () => {
    // 02/10/2026 read day-first is October, not February.
    const csv = parseCsv("TimeGenerated,Account\n02/10/2026 10:23:22,admin\n", "t.csv");

    expect(() => normalizeTable(csv, table())).toThrow(/outside the expected window/);
  });

  test("names the file, row and column when a timestamp will not parse", () => {
    const csv = parseCsv("TimeGenerated,Account\nnonsense,admin\n", "t.csv");

    expect(() => normalizeTable(csv, table())).toThrow(/row 1, column "TimeGenerated"/);
  });

  test("fails on a header that no longer matches the manifest", () => {
    const csv = parseCsv("TimeGenerated,Renamed\n10/02/2026 11:00:12,admin\n", "t.csv");

    expect(() => normalizeTable(csv, table())).toThrow(/header does not match the manifest/);
  });

  test("fails on an unexpected row count", () => {
    const csv = parseCsv(
      "TimeGenerated,Account\n10/02/2026 11:00:12,a\n10/02/2026 11:00:13,b\n",
      "t.csv",
    );

    expect(() => normalizeTable(csv, table())).toThrow(/expected 1 rows, found 2/);
  });

  test("tolerates a short record only when the manifest pins the count", () => {
    const csv = parseCsv("TimeGenerated,Account\n10/02/2026 11:00:12\n", "t.csv");

    expect(() => normalizeTable(csv, table())).toThrow(/expected 0 truncated record\(s\), found 1/);
    expect(normalizeTable(csv, table({ knownShortRows: 1 })).rows).toEqual([
      ["2026-02-10T11:00:12.000Z", ""],
    ]);
  });
});
