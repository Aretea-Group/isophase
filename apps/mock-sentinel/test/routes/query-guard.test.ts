import { describe, expect, test } from "bun:test";

import { isControlCommand } from "../../src/routes/query.ts";

/**
 * Regression cover for the read-only boundary.
 *
 * This is the highest-stakes assertion in the suite. The Kusto emulator's query
 * endpoint executes control commands — measured, not assumed — so this guard is
 * the only thing standing between a hallucinating agent and `.drop table
 * SecurityEvent`. A regression here is silent and destructive.
 */
describe("isControlCommand", () => {
  test.each([
    ".drop table SecurityEvent",
    ".show databases",
    ".create table Foo (a:string)",
    ".ingest inline into table Foo <| 1",
    ".clear database cache",
    ".alter table Foo policy retention",
  ])("rejects %s", (query) => {
    expect(isControlCommand(query)).toBe(true);
  });

  test("is not fooled by leading whitespace or blank lines", () => {
    expect(isControlCommand("   .drop table SecurityEvent")).toBe(true);
    expect(isControlCommand("\n\n  \n.drop table SecurityEvent")).toBe(true);
    expect(isControlCommand("\t.drop table SecurityEvent")).toBe(true);
  });

  test("is not fooled by a leading comment", () => {
    expect(isControlCommand("// just looking\n.drop table SecurityEvent")).toBe(true);
    expect(isControlCommand("// one\n// two\n   .drop table SecurityEvent")).toBe(true);
  });

  test("permits ordinary KQL", () => {
    for (const query of [
      "SecurityEvent | count",
      "SecurityAlert | where AlertSeverity == 'High'",
      "let x = 5;\nSecurityEvent | take x",
      "// find the brute force\nSecurityEvent | where EventID == 4625",
      "union SecurityEvent, SecurityAlert | count",
    ]) {
      expect({ query, control: isControlCommand(query) }).toEqual({ query, control: false });
    }
  });

  test("permits a dot that appears later in a legitimate query", () => {
    // Property access and decimals are ordinary KQL and must not be blocked.
    expect(isControlCommand("AWSCloudTrail | where RequestParameters.userName == 'x'")).toBe(false);
    expect(isControlCommand("SecurityAlert | where ConfidenceScore > 0.8")).toBe(false);
  });

  test("treats an empty query as harmless", () => {
    // Rejected earlier by the contract; it must not be mistaken for a command.
    expect(isControlCommand("")).toBe(false);
    expect(isControlCommand("   \n  ")).toBe(false);
  });
});
