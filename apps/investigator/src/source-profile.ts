import {
  createSecurityClient,
  DEFAULT_DEFENDER_QUERY_MAX_ROWS,
  securitySourceTarget,
  type SecurityDataSource,
  type SecuritySourceConfig,
  type SecuritySourceConfigSet,
  type SecuritySourceId,
  type SentinelClientConfig,
} from "@soc/sentinel-client";

import { defenderQueryInstructions, SENTINEL_QUERY_INSTRUCTIONS } from "./query-instructions.ts";

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

export interface SecuritySourceSet {
  /** Active bundles by source id, in `SECURITY_SOURCES` order. */
  readonly sources: ReadonlyMap<string, SecuritySourceBundle>;
  /** The sole alert producer and default target for source-optional tools. */
  readonly primary: SecuritySourceBundle;
}

const GUIDANCE_ACTIVATION_TOOLS = Object.freeze([
  "get_security_schema",
  "query_security_data",
] as const);

export function createSentinelSourceBundle(config: SentinelClientConfig): SecuritySourceBundle {
  const profile: SecuritySourceProfile = Object.freeze({
    kind: "microsoft-sentinel",
    connector: config.connector === "mock" ? "mock-sentinel-rest" : "azure-monitor-logs",
    target: securitySourceTarget({ id: "sentinel", ...config }),
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
    guidanceActivationTools: GUIDANCE_ACTIVATION_TOOLS,
  });

  return Object.freeze({ client: createSecurityClient({ id: "sentinel", ...config }), profile });
}

/**
 * Microsoft Defender XDR through the Graph security API (PRD-8 Phase 1, ADR 011).
 *
 * The profile carries what the agent is told; the connector carries how the data is fetched. Both
 * say "advanced hunting" rather than "Sentinel" because the vocabulary genuinely differs — the time
 * column is `Timestamp` and not `TimeGenerated`, alerts live in `AlertInfo`/`AlertEvidence` rather
 * than `SecurityAlert`, and an agent arriving with Sentinel's vocabulary discovers this by failed
 * query. `queryLanguage` stays `"kql"`: it is the same language, and the console's leading-table
 * summary is correct for both.
 */
export function createDefenderSourceBundle(config: SecuritySourceConfig): SecuritySourceBundle {
  if (config.id !== "defender") {
    throw new Error(`Source id ${config.id} routed to the defender factory.`);
  }
  const queryMaxRows = config.queryMaxRows ?? DEFAULT_DEFENDER_QUERY_MAX_ROWS;
  const profile: SecuritySourceProfile = Object.freeze({
    kind: "microsoft-defender-xdr",
    connector: "microsoft-graph-security",
    target: securitySourceTarget(config),
    queryLanguage: "kql",
    schemaToolDescription:
      "Return compact table(column:type) definitions for one or more Microsoft Defender advanced hunting tables.",
    queryToolDescription:
      "Run a read-only KQL query against Microsoft Defender advanced hunting and return the raw result.",
    queryParameterDescription:
      "Read-only advanced hunting KQL. Control commands (anything starting with '.') are rejected.",
    initialContext: Object.freeze({
      alertIntroduction: "Investigate the following Microsoft Defender XDR alert.",
      tablesIntroduction:
        "These are the Microsoft Defender advanced hunting tables you can query. Request schemas for whichever look relevant.",
    }),
    queryGuidance: defenderQueryInstructions(queryMaxRows),
    guidanceActivationTools: GUIDANCE_ACTIVATION_TOOLS,
  });

  return Object.freeze({ client: createSecurityClient(config), profile });
}

/**
 * The static map of source id to bundle factory (PRD-8 §4.1 D6).
 *
 * ADR 010 §4 rejected a registry with runtime discovery because there was no third deployable
 * source. That premise expired with Defender, so the rejection is restated on the reason that
 * survives it: `toolDescriptors()` and the prompt-provenance hash must be derivable by *reading
 * source*, and a discovered source set is not. Adding a fourth integration is one entry here plus a
 * profile.
 *
 * D7 narrows ADR 010 §4's "no source-id branch" to what was actually load-bearing: no branch on
 * source *kind*, connector or query language. `SOURCE_BUNDLES[id]` is routing; `if (kind ===
 * "defender")` inside investigation control flow stays forbidden.
 */
const SOURCE_BUNDLES: Record<
  SecuritySourceId,
  (config: SecuritySourceConfig) => SecuritySourceBundle
> = {
  sentinel: (config) =>
    config.id === "sentinel"
      ? createSentinelSourceBundle(config)
      : // Unreachable: the key and the config's own id come from the same value at the call site.
        // Throwing rather than casting keeps that provable instead of asserted.
        (() => {
          throw new Error(`Source id ${config.id} routed to the sentinel factory.`);
        })(),
  defender: (config) => createDefenderSourceBundle(config),
};

export function createSecuritySourceBundle(config: SecuritySourceConfig): SecuritySourceBundle {
  return SOURCE_BUNDLES[config.id](config);
}

export function createSecuritySources(config: SecuritySourceConfigSet): SecuritySourceSet {
  const sources = new Map(
    config.sources.map((source) => [source.id, createSecuritySourceBundle(source)] as const),
  );
  const primary = sources.get(config.primary.id);
  if (primary === undefined) {
    throw new Error(`Primary source ${config.primary.id} is not active.`);
  }
  return Object.freeze({ sources, primary });
}

/** The connector's own default, repeated so the artifact records what actually applied. */
const DEFENDER_DEFAULT_ALERT_WINDOW = "P7D";

/**
 * The alert-queue window of whichever selected source bounds its queue by one (PRD-8 §4.1 D14).
 *
 * `undefined` when no selected source has one — Mock and Azure Sentinel both list alerts without a
 * window — so the artifact records no window rather than a borrowed default. Absent means absent:
 * a Sentinel run and a Defender run agreeing on a field only one of them measured would be worse
 * than the field being missing.
 *
 * Lives here rather than in the CLI because it is a fact about the selected source, and the console
 * needs the same answer without becoming a second place that decides it.
 */
export function alertWindowOf(
  value: SecuritySourceConfig | readonly SecuritySourceConfig[],
): string | undefined {
  const config = Array.isArray(value) ? value[0] : value;
  if (config === undefined) return undefined;
  return config.id === "defender"
    ? (config.alertWindow ?? DEFENDER_DEFAULT_ALERT_WINDOW)
    : undefined;
}

/** The configured query row cap when the selected source has one. */
export function queryMaxRowsOf(configs: readonly SecuritySourceConfig[]): number | undefined {
  for (const config of configs) {
    if (config.id === "defender") {
      return config.queryMaxRows ?? DEFAULT_DEFENDER_QUERY_MAX_ROWS;
    }
  }
  return undefined;
}
