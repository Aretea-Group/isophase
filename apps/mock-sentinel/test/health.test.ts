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
    expect(body.dependencies["database"]).toBe("unknown");
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

  test("is degraded when the engine is up but its database is missing", async () => {
    // The regression this endpoint exists to catch. `.show version` is
    // cluster-scoped, so a recreated container that has never been bootstrapped
    // answers it happily; reporting that as healthy let the sentinel-client and
    // console suites run against an empty engine and fail on their assertions
    // rather than skip. Health has to speak for the database too.
    const app = createApp({
      config,
      probes: {
        kusto: () => Promise.resolve("up"),
        database: () => Promise.resolve("down"),
      },
    });

    const res = await app.request("/health");

    expect(res.status).toBe(503);
    const body = HealthResponse.parse(await res.json());
    expect(body.status).toBe("degraded");
    expect(body.dependencies["kusto"]).toBe("up");
    expect(body.dependencies["database"]).toBe("down");
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
