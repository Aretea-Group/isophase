import { describe, expect, test } from "bun:test";

import { canonicalRow, deterministicAlertId, splitTechniques } from "../../src/alerts/generate.ts";

/**
 * Regression cover for alert identity.
 *
 * Both properties below were defects found in development, not hypotheticals:
 * ids built from selected fields collapsed distinct alerts, and ids that
 * included timestamps changed on every bootstrap.
 */
describe("alert identity", () => {
  test("is stable for the same input", () => {
    expect(deterministicAlertId("rule", "a", "b")).toBe(deterministicAlertId("rule", "a", "b"));
  });

  test("is GUID-shaped", () => {
    expect(deterministicAlertId("rule", "a")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("differs when the rule differs", () => {
    expect(deterministicAlertId("rule-a", "x")).not.toBe(deterministicAlertId("rule-b", "x"));
  });

  test("differs when the evidence differs", () => {
    const a = canonicalRow({ Computer: "host-a", Failures: 10 });
    const b = canonicalRow({ Computer: "host-b", Failures: 10 });

    expect(deterministicAlertId("rule", a)).not.toBe(deterministicAlertId("rule", b));
  });

  test("ignores timestamps, so a re-anchored bootstrap keeps the same id", () => {
    // The loader shifts every event onto a bootstrap-time anchor. If instants
    // fed the hash, `/alerts/:id` would change on every run and every pinned
    // reference — scenario metadata included — would rot.
    const run1 = canonicalRow({ Computer: "SOC-FW-RDP", StartTime: "2021-04-16T08:34:04.098Z" });
    const run2 = canonicalRow({ Computer: "SOC-FW-RDP", StartTime: "2026-08-18T09:12:44.512Z" });

    expect(run1).toBe(run2);
    expect(deterministicAlertId("rule", run1)).toBe(deterministicAlertId("rule", run2));
  });

  test("still separates rows that differ in more than time", () => {
    const a = canonicalRow({ Account: "alice", At: "2026-01-01T00:00:00Z" });
    const b = canonicalRow({ Account: "bob", At: "2026-01-01T00:00:00Z" });

    expect(a).not.toBe(b);
  });

  test("treats Date and ISO-string timestamps alike", () => {
    expect(canonicalRow({ t: new Date("2026-01-01T00:00:00Z") })).toBe(
      canonicalRow({ t: "2026-01-01T00:00:00.000Z" }),
    );
  });
});

describe("splitTechniques", () => {
  test("populates both parent and sub-technique, as the table does", () => {
    expect(splitTechniques(["T1110.001"])).toEqual({
      techniques: ["T1110"],
      subTechniques: ["T1110.001"],
    });
  });

  test("keeps a bare technique out of sub-techniques", () => {
    expect(splitTechniques(["T1566"])).toEqual({ techniques: ["T1566"], subTechniques: [] });
  });

  test("de-duplicates a shared parent", () => {
    expect(splitTechniques(["T1110.001", "T1110.003"])).toEqual({
      techniques: ["T1110"],
      subTechniques: ["T1110.001", "T1110.003"],
    });
  });

  test("drops empty ids", () => {
    expect(splitTechniques(["", "T1078"])).toEqual({ techniques: ["T1078"], subTechniques: [] });
  });
});
