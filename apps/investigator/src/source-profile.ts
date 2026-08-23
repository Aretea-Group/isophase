import {
  createSentinelClient,
  sentinelClientTarget,
  type SecurityDataSource,
  type SentinelClientConfig,
} from "@soc/sentinel-client";

import { SENTINEL_QUERY_INSTRUCTIONS } from "./query-instructions.ts";

export interface SecuritySourceProfile {
  readonly kind: string;
  readonly connector: string;
  readonly target: string;
  readonly queryLanguage: string;
  readonly schemaToolDescription: string;
  readonly queryToolDescription: string;
  readonly queryParameterDescription: string;
  readonly initialContext: Readonly<{
    alertIntroduction: string;
    tablesIntroduction: string;
  }>;
  readonly queryGuidance: string;
  readonly guidanceActivationTools: readonly string[];
}

export interface SecuritySourceBundle {
  readonly client: SecurityDataSource;
  readonly profile: SecuritySourceProfile;
}

export function createSentinelSourceBundle(config: SentinelClientConfig): SecuritySourceBundle {
  const profile: SecuritySourceProfile = Object.freeze({
    kind: "microsoft-sentinel",
    connector: config.connector === "mock" ? "mock-sentinel-rest" : "azure-monitor-logs",
    target: sentinelClientTarget(config),
    queryLanguage: "kql",
    schemaToolDescription:
      "Return compact table(column:type) definitions for one or more Microsoft Sentinel telemetry tables.",
    queryToolDescription:
      "Run a read-only KQL query against Microsoft Sentinel telemetry and return the raw result.",
    queryParameterDescription:
      "Read-only KQL. Control commands (anything starting with '.') are rejected.",
    initialContext: Object.freeze({
      alertIntroduction: "Investigate the following Microsoft Sentinel alert.",
      tablesIntroduction:
        "These are the Microsoft Sentinel tables you can query. Request schemas for whichever look relevant.",
    }),
    queryGuidance: SENTINEL_QUERY_INSTRUCTIONS,
    guidanceActivationTools: Object.freeze(["get_security_schema", "query_security_data"] as const),
  });

  return Object.freeze({ client: createSentinelClient(config), profile });
}
