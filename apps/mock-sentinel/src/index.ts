import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { KustoClient } from "./kusto/client.ts";

const config = loadConfig();

// The real dependency probe is constructed here rather than inside createApp so
// that `createApp({ config })` stays hermetic for tests — they inject their own.
const kusto = new KustoClient({
  endpoint: config.KUSTO_ENDPOINT,
  timeoutMs: config.KUSTO_TIMEOUT_MS,
});

const app = createApp({
  config,
  kusto,
  probes: { kusto: async () => ((await kusto.isReachable()) ? "up" : "down") },
});

const server = Bun.serve({
  port: config.PORT,
  hostname: config.HOST,
  fetch: app.fetch,
});

console.info(`[mock-sentinel] listening on http://${server.hostname}:${server.port}`);
