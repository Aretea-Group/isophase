import { z } from "zod";

import { QueryResponse, SecurityAlert, SecuritySchema } from "@soc/contracts";
import type { SecurityDataSource } from "@soc/sentinel-client";

import type {
  SecuritySourceBundle,
  SecuritySourceProfile,
} from "../../src/source-profile.ts";

export const TEST_QUERY_GUIDANCE =
  "FixtureQL uses MATCH <table> WHERE <column> = <literal> RETURN <columns>. " +
  "Use only listed tables and columns; pipes and Kusto operators are invalid.";

export const TEST_SOURCE_PROFILE: SecuritySourceProfile = Object.freeze({
  kind: "fixture-siem",
  connector: "in-memory",
  target: "fixture-corpus",
  queryLanguage: "fixtureql",
  schemaToolDescription: "Describe FixtureQL tables and their native column types.",
  queryToolDescription: "Run a read-only FixtureQL query and return the raw tabular result.",
  queryParameterDescription: "Read-only FixtureQL query text. Use MATCH ... RETURN syntax.",
  initialContext: Object.freeze({
    alertIntroduction: "Investigate the following Fixture SIEM alert.",
    tablesIntroduction: "These are the FixtureQL tables available for this investigation.",
  }),
  queryGuidance: TEST_QUERY_GUIDANCE,
  guidanceActivationTools: Object.freeze(["get_security_schema", "query_security_data"] as const),
});

export function testSourceBundle(client: SecurityDataSource): SecuritySourceBundle {
  return Object.freeze({ client, profile: TEST_SOURCE_PROFILE });
}

/** Source-native shape: deliberately unrelated to Microsoft Sentinel's resource envelope. */
export const FixtureNativeAlert = z.object({
  signalKey: z.string().min(1),
  ruleName: z.string().min(1),
  narrative: z.string(),
  risk: z.string().min(1),
  lifecycle: z.string().min(1),
  detector: z.string().min(1),
  detectedAt: z.iso.datetime(),
  subject: z.object({ kind: z.string().min(1), value: z.string().min(1) }),
  facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
export type FixtureNativeAlert = z.infer<typeof FixtureNativeAlert>;

export const FIXTURE_NATIVE_ALERT: FixtureNativeAlert = FixtureNativeAlert.parse({
  signalKey: "fixture-alert-1",
  ruleName: "Privileged identity used from an unmanaged console",
  narrative: "A privileged account opened a console session from an unmanaged device.",
  risk: "urgent",
  lifecycle: "open",
  detector: "fixture.identity.console",
  detectedAt: "2026-08-23T12:00:00.000Z",
  subject: { kind: "identity", value: "casey.admin" },
  facts: { managedDevice: false, sessionCount: 3, region: "eu-central" },
});

export function normaliseFixtureAlert(native: FixtureNativeAlert) {
  return SecurityAlert.parse({
    id: native.signalKey,
    title: native.ruleName,
    description: native.narrative,
    severity: native.risk,
    status: native.lifecycle,
    alertType: native.detector,
    timeGenerated: native.detectedAt,
    tactics: [],
    techniques: [],
    compromisedEntity: native.subject.value,
    entities: [native.subject],
    native,
  });
}

const FIXTURE_SCHEMA = SecuritySchema.parse({
  tables: [
    {
      name: "IdentitySessions",
      columns: [
        { name: "observed_at", type: "instant" },
        { name: "principal", type: "text" },
        { name: "device_trust", type: "boolean" },
        { name: "action", type: "text" },
      ],
    },
  ],
});

const FIXTURE_RESULT = QueryResponse.parse({
  tables: [
    {
      name: "matches",
      columns: [
        { name: "observed_at", type: "instant" },
        { name: "principal", type: "text" },
        { name: "device_trust", type: "boolean" },
        { name: "action", type: "text" },
      ],
      rows: [["2026-08-23T11:58:00.000Z", "casey.admin", false, "console_login"]],
    },
  ],
  truncation: { truncated: false, returnedRows: 1, maxRows: 50 },
});

export class FixtureSecuritySource implements SecurityDataSource {
  readonly nativeAlert = FIXTURE_NATIVE_ALERT;
  readonly alert = normaliseFixtureAlert(this.nativeAlert);
  readonly queries: string[] = [];

  async listAlerts(limit?: number) {
    return limit === 0 ? [] : [this.alert];
  }

  async getAlert(id: string) {
    if (id !== this.alert.id) throw new Error(`Unknown fixture alert: ${id}`);
    return this.alert;
  }

  async getSchema() {
    return FIXTURE_SCHEMA;
  }

  async query(query: string) {
    this.queries.push(query);
    return FIXTURE_RESULT;
  }

  async getCorpus() {
    return undefined;
  }
}

export function createFixtureSourceBundle(): {
  source: FixtureSecuritySource;
  bundle: SecuritySourceBundle;
} {
  const source = new FixtureSecuritySource();
  return { source, bundle: testSourceBundle(source) };
}
