import { describe, expect, test } from "bun:test";

import { HealthResponse } from "@soc/contracts";

import { createApp } from "../src/app.ts";
import { ConfigSchema } from "../src/config.ts";

const config = ConfigSchema.parse({ SERVICE_VERSION: "test" });

describe("GET /health", () => {
  test("returns a contract-valid ok response", async () => {
    const app = createApp({ config });

    const res = await app.request("/health");

    expect(res.status).toBe(200);
    const body = HealthResponse.parse(await res.json());
    expect(body.service).toBe("mock-sentinel");
    expect(body.version).toBe("test");
    expect(body.dependencies["kusto"]).toBe("unknown");
  });

  test("reports degraded with 503 when a dependency probe fails", async () => {
    const app = createApp({
      config,
      probes: { kusto: () => Promise.reject(new Error("connection refused")) },
    });

    const res = await app.request("/health");

    expect(res.status).toBe(503);
    const body = HealthResponse.parse(await res.json());
    expect(body.status).toBe("degraded");
    expect(body.dependencies["kusto"]).toBe("down");
  });
});

describe("unknown routes", () => {
  test("return the shared error envelope", async () => {
    const app = createApp({ config });

    const res = await app.request("/alerts");

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });
});
