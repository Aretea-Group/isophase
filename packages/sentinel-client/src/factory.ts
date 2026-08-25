import { isAbsolute, relative, resolve } from "node:path";

import {
  AzureCliCredential,
  AzurePowerShellCredential,
  ChainedTokenCredential,
  ClientSecretCredential,
  type TokenCredential,
} from "@azure/identity";

import { AzureSentinelClient, azureWorkspaceUrl } from "./azure.ts";
import {
  SentinelApiClient,
  type SecurityDataSource,
  type SentinelApiClientOptions,
} from "./client.ts";
import { DefenderClient, defenderGraphUrl } from "./defender.ts";

export type AzureAuthenticationConfig =
  | {
      kind: "service-principal";
      tenantId: string;
      clientId: string;
      clientSecret: string;
    }
  | { kind: "developer" };

export type SentinelClientConfig =
  | ({ connector: "mock" } & SentinelApiClientOptions)
  | {
      connector: "azure";
      authentication: AzureAuthenticationConfig;
      workspaceId: string;
      timeoutMs?: number;
    };

/**
 * Defender's configuration. No developer fallback, and that is a decision rather than a gap.
 *
 * ADR 009 §3 lets Azure fall back to `AzureCliCredential` then `AzurePowerShellCredential` when the
 * service-principal triple is absent. Defender has no such chain: developer sign-in is not a
 * verified path to `ThreatHunting.Read.All`. PRD-8 §4.1 D2 states this as a deliberate divergence
 * so a later reader does not "fix" it.
 */
export interface DefenderClientConfig {
  connector: "graph";
  tenantId: string;
  clientId: string;
  clientSecret: string;
  workspaceId?: string;
  timeoutMs?: number;
  queryMaxRows?: number;
  alertWindow?: string;
}

/** Every source this build can select, by the id `SECURITY_SOURCES` names. */
export type SecuritySourceConfig =
  | ({ id: "sentinel" } & SentinelClientConfig)
  | ({ id: "defender" } & DefenderClientConfig);

export type SecuritySourceId = SecuritySourceConfig["id"];

export const SECURITY_SOURCE_IDS = ["sentinel", "defender"] as const;

export interface SentinelClientEnvironment {
  SENTINEL_CONNECTOR: "mock" | "azure";
  SENTINEL_BASE_URL: string;
  SENTINEL_TIMEOUT_MS: number;
  AZURE_TENANT_ID?: string;
  AZURE_CLIENT_ID?: string;
  AZURE_CLIENT_SECRET?: string;
  AZURE_LOG_ANALYTICS_WORKSPACE_ID?: string;
}

export interface DefenderClientEnvironment {
  DEFENDER_TENANT_ID?: string;
  DEFENDER_CLIENT_ID?: string;
  DEFENDER_CLIENT_SECRET?: string;
  DEFENDER_WORKSPACE_ID?: string;
  DEFENDER_TIMEOUT_MS?: number;
  DEFENDER_QUERY_MAX_ROWS?: number;
  DEFENDER_ALERT_WINDOW?: string;
}

export interface SecuritySourceEnvironment
  extends SentinelClientEnvironment, DefenderClientEnvironment {
  SECURITY_SOURCES?: string;
  PRIMARY_ALERT_SOURCE?: string;
}

export interface SecuritySourceConfigSet {
  /** Active configurations in `SECURITY_SOURCES` order. */
  readonly sources: readonly SecuritySourceConfig[];
  /** The sole alert producer and default target for source-optional tools. */
  readonly primary: SecuritySourceConfig;
}

export function sentinelClientConfigFromEnv(env: SentinelClientEnvironment): SentinelClientConfig {
  if (env.SENTINEL_CONNECTOR === "mock") {
    return {
      connector: "mock",
      baseUrl: env.SENTINEL_BASE_URL,
      timeoutMs: env.SENTINEL_TIMEOUT_MS,
    };
  }

  const tenantId = env.AZURE_TENANT_ID;
  const clientId = env.AZURE_CLIENT_ID;
  const clientSecret = env.AZURE_CLIENT_SECRET;
  const workspaceId = env.AZURE_LOG_ANALYTICS_WORKSPACE_ID;
  if (workspaceId === undefined) {
    throw new Error("SENTINEL_CONNECTOR=azure requires AZURE_LOG_ANALYTICS_WORKSPACE_ID.");
  }

  const servicePrincipalValues = {
    AZURE_TENANT_ID: tenantId,
    AZURE_CLIENT_ID: clientId,
    AZURE_CLIENT_SECRET: clientSecret,
  };
  const providedServicePrincipalValues = Object.values(servicePrincipalValues).filter(
    (value) => value !== undefined,
  ).length;
  if (providedServicePrincipalValues > 0 && providedServicePrincipalValues < 3) {
    const missing = Object.entries(servicePrincipalValues)
      .filter(([, value]) => value === undefined)
      .map(([name]) => name);
    throw new Error(
      `Azure service-principal values must be set together; missing ${missing.join(", ")}.`,
    );
  }

  return {
    connector: "azure",
    authentication:
      tenantId !== undefined && clientId !== undefined && clientSecret !== undefined
        ? { kind: "service-principal", tenantId, clientId, clientSecret }
        : { kind: "developer" },
    workspaceId,
    timeoutMs: env.SENTINEL_TIMEOUT_MS,
  };
}

/**
 * The Defender credential triple, all or none (PRD-8 §4.1 D2).
 *
 * A partial group names the missing keys and throws. It never falls back to another identity, and
 * it never proceeds with two of three — a half-configured deployment that authenticated as somebody
 * else would be worse than one that refused to start.
 */
export function defenderClientConfigFromEnv(
  env: DefenderClientEnvironment,
): DefenderClientConfig | undefined {
  const values = {
    DEFENDER_TENANT_ID: env.DEFENDER_TENANT_ID,
    DEFENDER_CLIENT_ID: env.DEFENDER_CLIENT_ID,
    DEFENDER_CLIENT_SECRET: env.DEFENDER_CLIENT_SECRET,
  };
  const provided = Object.values(values).filter((value) => value !== undefined).length;
  if (provided === 0) return undefined;
  if (provided < 3) {
    const missing = Object.entries(values)
      .filter(([, value]) => value === undefined)
      .map(([name]) => name);
    throw new Error(
      `Defender credentials must be set together; missing ${missing.join(", ")}. ` +
        "There is no developer fallback for Defender — see docs/defender-setup.md.",
    );
  }

  const { DEFENDER_TENANT_ID: tenantId, DEFENDER_CLIENT_ID: clientId } = values;
  const clientSecret = values.DEFENDER_CLIENT_SECRET;
  if (tenantId === undefined || clientId === undefined || clientSecret === undefined) {
    throw new Error("Defender credentials must be set together.");
  }

  return {
    connector: "graph",
    tenantId,
    clientId,
    clientSecret,
    ...(env.DEFENDER_WORKSPACE_ID === undefined ? {} : { workspaceId: env.DEFENDER_WORKSPACE_ID }),
    ...(env.DEFENDER_TIMEOUT_MS === undefined ? {} : { timeoutMs: env.DEFENDER_TIMEOUT_MS }),
    ...(env.DEFENDER_QUERY_MAX_ROWS === undefined
      ? {}
      : { queryMaxRows: env.DEFENDER_QUERY_MAX_ROWS }),
    ...(env.DEFENDER_ALERT_WINDOW === undefined ? {} : { alertWindow: env.DEFENDER_ALERT_WINDOW }),
  };
}

/**
 * Which sources this run selects, in `SECURITY_SOURCES` order.
 *
 * The default is `sentinel`, which is not in tension with Defender-standalone being first class
 * (D13): the default exists so a zero-credential checkout keeps working against Mock Sentinel, and
 * standalone Defender is an explicit opt-in rather than an accident of configuration.
 */
export function securitySourceConfigsFromEnv(
  env: SecuritySourceEnvironment,
): SecuritySourceConfig[] {
  const requested = (env.SECURITY_SOURCES ?? "sentinel")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");

  if (requested.length === 0) {
    throw new Error(
      `SECURITY_SOURCES must name at least one of: ${SECURITY_SOURCE_IDS.join(", ")}.`,
    );
  }

  const duplicates = requested.filter((id, index) => requested.indexOf(id) !== index);
  if (duplicates.length > 0) {
    throw new Error(`SECURITY_SOURCES lists ${duplicates[0]} more than once.`);
  }

  for (const id of requested) {
    if (!SECURITY_SOURCE_IDS.some((known) => known === id)) {
      throw new Error(
        `SECURITY_SOURCES names unknown source "${id}". Known: ${SECURITY_SOURCE_IDS.join(", ")}.`,
      );
    }
  }

  const configs: SecuritySourceConfig[] = [];
  for (const id of requested) {
    if (id === "defender") {
      const defender = defenderClientConfigFromEnv(env);
      if (defender === undefined) {
        throw new Error(
          "SECURITY_SOURCES=defender requires DEFENDER_TENANT_ID, DEFENDER_CLIENT_ID and DEFENDER_CLIENT_SECRET. " +
            "See docs/defender-setup.md.",
        );
      }
      configs.push({ id: "defender", ...defender });
      continue;
    }
    configs.push({ id: "sentinel", ...sentinelClientConfigFromEnv(env) });
  }
  return configs;
}

/** Resolve the ordered active configurations and their sole alert producer (PRD-8 D5-D7). */
export function securitySourceConfigSetFromEnv(
  env: SecuritySourceEnvironment,
): SecuritySourceConfigSet {
  const sources = securitySourceConfigsFromEnv(env);
  const requestedPrimary = env.PRIMARY_ALERT_SOURCE?.trim();
  if (requestedPrimary === "") {
    throw new Error("PRIMARY_ALERT_SOURCE must name an active source id.");
  }
  if (sources.length > 1 && requestedPrimary === undefined) {
    throw new Error(
      `PRIMARY_ALERT_SOURCE is required when SECURITY_SOURCES contains more than one source. Active: ${sources.map((source) => source.id).join(", ")}.`,
    );
  }

  const primaryId = requestedPrimary ?? sources[0]?.id;
  const primary = sources.find((source) => source.id === primaryId);
  if (primary === undefined) {
    throw new Error(
      `PRIMARY_ALERT_SOURCE names inactive source "${primaryId ?? ""}". Active: ${sources.map((source) => source.id).join(", ")}.`,
    );
  }

  return Object.freeze({ sources: Object.freeze(sources), primary });
}

export function securitySourceTarget(config: SecuritySourceConfig): string {
  if (config.id === "defender") return defenderGraphUrl();
  return sentinelClientTarget(config);
}

export function sentinelClientTarget(config: SentinelClientConfig): string {
  return config.connector === "mock"
    ? config.baseUrl.replace(/\/+$/, "")
    : azureWorkspaceUrl(config.workspaceId);
}

/** Whether this source reads a real tenant rather than a local fixture corpus. */
export function readsLiveTenant(config: SecuritySourceConfig): boolean {
  return config.id === "defender" || config.connector === "azure";
}

/**
 * Real tenant artifacts stay under the repository's ignored `.data/` root.
 *
 * Generalised over the active set (PRD-8 §4.1 D10): if *any* active source reads a real tenant, the
 * run and trace directories must sit inside `.data/`. `SENTINEL_CONNECTOR=mock` alongside an active
 * Defender still writes to `.data/`, never `runs/` — a mixed run is a development convenience and
 * must not enter the committed scored corpus. The rule is about the presence of tenant data
 * anywhere in the run, not about which source produced the alert.
 */
export function assertLiveTenantArtifactDirectories(
  configs: readonly SecuritySourceConfig[],
  directories: readonly string[],
): void {
  const live = configs.filter(readsLiveTenant);
  if (live.length === 0) return;

  const dataRoot = resolve(".data");
  for (const directory of directories) {
    const path = resolve(directory);
    const fromDataRoot = relative(dataRoot, path);
    if (fromDataRoot === "" || (!fromDataRoot.startsWith("..") && !isAbsolute(fromDataRoot))) {
      continue;
    }
    throw new Error(
      `${live.map((config) => config.id).join(", ")} reads a live tenant, so run artifacts may contain tenant data; ` +
        `directory ${directory} must be inside .data/.`,
    );
  }
}

/** Retained for the Sentinel-only call path; `assertLiveTenantArtifactDirectories` generalises it. */
export function assertAzureArtifactDirectories(
  config: SentinelClientConfig,
  directories: readonly string[],
): void {
  assertLiveTenantArtifactDirectories([{ id: "sentinel", ...config }], directories);
}

/**
 * The static map of source id to client (PRD-8 §4.1 D6).
 *
 * ADR 010 §4 rejected a registry with runtime discovery on the premise that there was no third
 * deployable source. That premise has expired, so the rejection is restated on the reason that
 * survives it: `toolDescriptors()` and the prompt-provenance hash must be derivable by reading
 * source, and a discovered source set is not. Adding a fourth integration is one entry here plus a
 * profile.
 */
export function createSecurityClient(config: SecuritySourceConfig): SecurityDataSource {
  if (config.id === "defender") {
    return new DefenderClient({
      credential: new ClientSecretCredential(config.tenantId, config.clientId, config.clientSecret),
      ...(config.workspaceId === undefined ? {} : { workspaceId: config.workspaceId }),
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      ...(config.queryMaxRows === undefined ? {} : { queryMaxRows: config.queryMaxRows }),
      ...(config.alertWindow === undefined ? {} : { alertWindow: config.alertWindow }),
    });
  }
  return createSentinelClient(config);
}

export function createSentinelClient(config: SentinelClientConfig): SecurityDataSource {
  return config.connector === "mock"
    ? new SentinelApiClient(config)
    : new AzureSentinelClient({
        credential: azureCredential(config.authentication, config.timeoutMs),
        workspaceId: config.workspaceId,
        timeoutMs: config.timeoutMs,
      });
}

function azureCredential(config: AzureAuthenticationConfig, timeoutMs = 30_000): TokenCredential {
  if (config.kind === "service-principal") {
    return new ClientSecretCredential(config.tenantId, config.clientId, config.clientSecret);
  }
  const options = { processTimeoutInMs: timeoutMs };
  return new ChainedTokenCredential(
    new AzureCliCredential(options),
    new AzurePowerShellCredential(options),
  );
}
