import { describe, expect, test } from "bun:test";

import { encodeEntities } from "../../src/alerts/entities.ts";
import { projectAlert, type AlertRow } from "../../src/alerts/project.ts";

/**
 * Regression cover for the table -> ARM projection.
 *
 * Every assertion here pins one of the real disagreements between the
 * `SecurityAlert` table and the ARM API (ADR 004). They are pure string and
 * JSON transformations, which is exactly the kind of code that breaks quietly.
 */
const row = (overrides: AlertRow = {}): AlertRow => ({
  SystemAlertId: "abc-123",
  TimeGenerated: "2026-08-18T12:00:00.000Z",
  DisplayName: "Test alert",
  AlertName: "Test alert",
  AlertSeverity: "High",
  Description: "A description",
  Status: "New",
  AlertType: "SOC-RULE-TEST",
  VendorName: "Microsoft",
  ProductName: "Azure Sentinel",
  ProviderName: "ASI Scheduled Alerts",
  Tactics: "",
  Techniques: "",
  SubTechniques: "",
  StartTime: "2026-08-18T11:00:00.000Z",
  EndTime: "2026-08-18T12:00:00.000Z",
  ProcessingEndTime: "2026-08-18T12:00:00.000Z",
  ConfidenceLevel: "Unknown",
  ConfidenceScore: "",
  CompromisedEntity: "host-1",
  RemediationSteps: "[]",
  ExtendedProperties: "{}",
  Entities: "[]",
  ...overrides,
});

describe("projectAlert", () => {
  test("splits the comma-delimited Tactics column into an array", () => {
    const alert = projectAlert(row({ Tactics: "CredentialAccess,Impact" }));

    expect(alert.properties.tactics).toEqual(["CredentialAccess", "Impact"]);
  });

  test("merges Techniques and SubTechniques into one de-duplicated list", () => {
    const alert = projectAlert(row({ Techniques: "T1110", SubTechniques: "T1110.001" }));

    expect(alert.properties.techniques).toEqual(["T1110", "T1110.001"]);
  });

  test("parses the JSON-in-a-string columns into real structures", () => {
    const alert = projectAlert(
      row({
        RemediationSteps: JSON.stringify(["Reset credentials", "Review sessions"]),
        ExtendedProperties: JSON.stringify({ "Failure Count": 11970 }),
      }),
    );

    expect(alert.properties.remediationSteps).toEqual(["Reset credentials", "Review sessions"]);
    expect(alert.properties.additionalData).toEqual({ "Failure Count": 11970 });
  });

  test("decodes PascalCase table entities back to camelCase, preserving $ref", () => {
    const encoded = encodeEntities([
      { $id: "1", type: "host", hostName: "SOC-FW-RDP" },
      { $id: "2", type: "account", name: "ADMINISTRATOR", host: { $ref: "1" } },
    ]);
    // What the table physically stores is PascalCase inside a string.
    expect(encoded).toContain('"HostName"');
    expect(encoded).toContain('"Type":"host"');

    const alert = projectAlert(row({ Entities: encoded }));

    expect(alert.properties.entities).toEqual([
      { $id: "1", type: "host", hostName: "SOC-FW-RDP" },
      { $id: "2", type: "account", name: "ADMINISTRATOR", host: { $ref: "1" } },
    ]);
  });

  test("builds an ARM-shaped resource id and envelope", () => {
    const alert = projectAlert(row());

    expect(alert.kind).toBe("SecurityAlert");
    expect(alert.type).toBe("Microsoft.SecurityInsights/Entities");
    expect(alert.name).toBe("abc-123");
    expect(alert.id).toContain("/providers/Microsoft.SecurityInsights/Entities/abc-123");
  });

  test("drops a malformed entity without losing the alert", () => {
    // One bad entity should cost that entity, not the whole alert — the rest is
    // still usable evidence.
    const alert = projectAlert(
      row({
        Entities: '[{"$id":"1","Type":"host","HostName":"ok"},{"$id":"2","Type":"spaceship"}]',
      }),
    );

    expect(alert.properties.entities).toHaveLength(1);
    expect(alert.properties.entities[0]?.type).toBe("host");
  });

  test("survives entities that are not valid JSON at all", () => {
    expect(projectAlert(row({ Entities: "not json" })).properties.entities).toEqual([]);
  });

  test("falls back safely on unrecognised enum values", () => {
    const alert = projectAlert(row({ AlertSeverity: "Critical", Status: "Escalated" }));

    // Sentinel has no Critical severity and no Escalated status; neither may
    // reach the contract as-is.
    expect(alert.properties.severity).toBe("Informational");
    expect(alert.properties.status).toBe("Unknown");
  });

  test("normalises Kusto's seven-digit fractional seconds to ISO milliseconds", () => {
    const alert = projectAlert(row({ TimeGenerated: "2026-08-18T12:00:00.1234567Z" }));

    expect(alert.properties.timeGenerated).toBe("2026-08-18T12:00:00.123Z");
  });

  test("omits confidenceScore when the provider gave none", () => {
    expect(projectAlert(row()).properties.confidenceScore).toBeUndefined();
    expect(projectAlert(row({ ConfidenceScore: "0.92" })).properties.confidenceScore).toBe(0.92);
  });
});
