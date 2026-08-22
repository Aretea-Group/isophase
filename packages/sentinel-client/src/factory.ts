import { AzureSentinelClient, type AzureSentinelClientOptions } from "./azure.ts";
import { SentinelApiClient, type SentinelApiClientOptions, type SentinelClient } from "./client.ts";

export type SentinelClientConfig =
  | ({ connector: "mock" } & SentinelApiClientOptions)
  | ({ connector: "azure" } & AzureSentinelClientOptions);

export function createSentinelClient(config: SentinelClientConfig): SentinelClient {
  return config.connector === "mock"
    ? new SentinelApiClient(config)
    : new AzureSentinelClient(config);
}
