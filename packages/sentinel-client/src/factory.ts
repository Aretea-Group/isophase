import { isAbsolute, relative, resolve } from "node:path";

import { AzureSentinelClient, type AzureSentinelClientOptions } from "./azure.ts";
import { SentinelApiClient, type SentinelApiClientOptions, type SentinelClient } from "./client.ts";

export type SentinelClientConfig =
  | ({ connector: "mock" } & SentinelApiClientOptions)
  | ({ connector: "azure" } & AzureSentinelClientOptions);

export interface SentinelClientEnvironment {
  SENTINEL_CONNECTOR: "mock" | "azure";
  SENTINEL_BASE_URL: string;
  SENTINEL_TIMEOUT_MS: number;
  AZURE_TENANT_ID?: string;
  AZURE_CLIENT_ID?: string;
  AZURE_CLIENT_SECRET?: string;
  AZURE_LOG_ANALYTICS_WORKSPACE_ID?: string;
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
  if (
    tenantId === undefined ||
    clientId === undefined ||
    clientSecret === undefined ||
    workspaceId === undefined
  ) {
    const missing = Object.entries({
      AZURE_TENANT_ID: tenantId,
      AZURE_CLIENT_ID: clientId,
      AZURE_CLIENT_SECRET: clientSecret,
      AZURE_LOG_ANALYTICS_WORKSPACE_ID: workspaceId,
    })
      .filter(([, value]) => value === undefined)
      .map(([name]) => name);
    throw new Error(`SENTINEL_CONNECTOR=azure requires ${missing.join(", ")}.`);
  }

  return {
    connector: "azure",
    tenantId,
    clientId,
    clientSecret,
    workspaceId,
    timeoutMs: env.SENTINEL_TIMEOUT_MS,
  };
}

export function sentinelClientTarget(config: SentinelClientConfig): string {
  return config.connector === "mock"
    ? config.baseUrl.replace(/\/+$/, "")
    : `https://api.loganalytics.azure.com/v1/workspaces/${encodeURIComponent(config.workspaceId)}`;
}

/** Real tenant artifacts stay under the repository's ignored `.data/` root. */
export function assertAzureArtifactDirectories(
  config: SentinelClientConfig,
  directories: readonly string[],
): void {
  if (config.connector !== "azure") return;

  const dataRoot = resolve(".data");
  for (const directory of directories) {
    const path = resolve(directory);
    const fromDataRoot = relative(dataRoot, path);
    if (fromDataRoot === "" || (!fromDataRoot.startsWith("..") && !isAbsolute(fromDataRoot))) {
      continue;
    }
    throw new Error(
      `Azure Sentinel artifacts may contain tenant data; directory ${directory} must be inside .data/.`,
    );
  }
}

export function createSentinelClient(config: SentinelClientConfig): SentinelClient {
  return config.connector === "mock"
    ? new SentinelApiClient(config)
    : new AzureSentinelClient(config);
}
