import type { SecurityDataSource } from "@soc/sentinel-client";

import type {
  SecuritySourceBundle,
  SecuritySourceProfile,
} from "../../src/source-profile.ts";

export const TEST_QUERY_GUIDANCE = "Use valid TestQL forms and only listed columns.";

export const TEST_SOURCE_PROFILE: SecuritySourceProfile = Object.freeze({
  kind: "test-source",
  connector: "in-memory",
  target: "test-fixture",
  queryLanguage: "testql",
  schemaToolDescription: "Describe TestQL tables and their native column types.",
  queryToolDescription: "Run a read-only TestQL query and return the raw tabular result.",
  queryParameterDescription: "Read-only TestQL query text.",
  initialContext: Object.freeze({
    alertIntroduction: "Investigate the following test-source alert.",
    tablesIntroduction: "These are the TestQL tables available for this investigation.",
  }),
  queryGuidance: TEST_QUERY_GUIDANCE,
  guidanceActivationTools: Object.freeze(["get_security_schema", "query_security_data"] as const),
});

export function testSourceBundle(client: SecurityDataSource): SecuritySourceBundle {
  return Object.freeze({ client, profile: TEST_SOURCE_PROFILE });
}
