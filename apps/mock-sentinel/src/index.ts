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

// Two probes, not one: the engine can be up while the database it is supposed to
// serve does not exist — the state a recreated container is in until
// `bun run data:bootstrap` runs. Reporting that as healthy is what let the
// integration suites run against an empty engine and fail on their assertions
// instead of skipping.
const app = createApp({
  config,
  kusto,
  probes: {
    kusto: async () => ((await kusto.isReachable()) ? "up" : "down"),
    database: async () => ((await kusto.hasDatabase(config.KUSTO_DATABASE)) ? "up" : "down"),
  },
});

const server = Bun.serve({
  port: config.PORT,
  hostname: config.HOST,
  fetch: app.fetch,
});

console.info(`[mock-sentinel] listening on http://${server.hostname}:${server.port}`);
