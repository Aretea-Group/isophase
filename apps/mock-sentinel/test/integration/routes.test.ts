import { beforeAll, describe, expect, test } from "bun:test";

import {
  AlertListResponse,
  QueryResponse,
  SchemaResponse,
  SecurityAlertResource,
} from "@soc/contracts";

import { createApp } from "../../src/app.ts";
import { ConfigSchema } from "../../src/config.ts";
import { KustoClient } from "../../src/kusto/client.ts";
import { bootstrap } from "../../src/telemetry/bootstrap.ts";
import { TELEMETRY_TABLES } from "../../src/telemetry/tables.ts";

/**
 * Route-level regression cover, against a real Kusto Emulator.
 *
 * Scoped to behaviour that has broken or would be costly if it broke: the
 * read-only boundary actually holding, truncation being reported, Kusto errors
 * arriving intact and legible, and the contracts still validating.
 */
const endpoint = Bun.env["KUSTO_ENDPOINT"] ?? "http://localhost:8080";
const database = "SentinelLabRoutes";
const kusto = new KustoClient({ endpoint, timeoutMs: 60_000 });
const config = ConfigSchema.parse({ KUSTO_DATABASE: database, QUERY_MAX_ROWS: "500" });

const reachable = await kusto.isReachable();
if (!reachable) {
  console.warn(`[integration] skipping routes: no Kusto Emulator at ${endpoint}.`);
}

describe.skipIf(!reachable)("REST surface against a live Kusto Emulator", () => {
  const app = createApp({ config, kusto });

  beforeAll(async () => {
    await bootstrap({ client: kusto, database, reset: true });
  }, 300_000);

  test("GET /alerts returns a contract-valid list", async () => {
    const res = await app.request("/alerts");

    expect(res.status).toBe(200);
    const body = AlertListResponse.parse(await res.json());
    expect(body.value.length).toBeGreaterThan(100);
  });

  test("GET /alerts count matches the SecurityAlert table exactly", async () => {
    // REST projects from the table; if these ever disagree the single-source
    // guarantee in ADR 004 has been broken.
    const res = await app.request("/alerts");
    const body = AlertListResponse.parse(await res.json());
    const counted = await kusto.query(database, "SecurityAlert | count");

    expect(body.value.length).toBe(Number(counted.rows[0]?.[0]));
  });

  test("$top bounds the list", async () => {
    const body = AlertListResponse.parse(await (await app.request("/alerts?$top=5")).json());

    expect(body.value).toHaveLength(5);
  });

  test("GET /alerts/:id round-trips an id from the list", async () => {
    const list = AlertListResponse.parse(await (await app.request("/alerts")).json());
    const id = list.value[0]?.properties.systemAlertId ?? "";

    const res = await app.request(`/alerts/${id}`);

    expect(res.status).toBe(200);
    expect(SecurityAlertResource.parse(await res.json()).properties.systemAlertId).toBe(id);
  });

  test("GET /alerts/:id 404s for an unknown id", async () => {
    const res = await app.request("/alerts/00000000-0000-0000-0000-000000000000");

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  test("at least one alert carries entities", async () => {
    const list = AlertListResponse.parse(await (await app.request("/alerts")).json());

    expect(list.value.some((alert) => alert.properties.entities.length > 0)).toBe(true);
  });

  test("GET /schema reports every table the loader created", async () => {
    const body = SchemaResponse.parse(await (await app.request("/schema")).json());
    const names = new Set(body.tables.map((table) => table.name));

    for (const table of TELEMETRY_TABLES) expect(names.has(table.table)).toBe(true);
    expect(names.has("SecurityAlert")).toBe(true);
  });

  test("POST /query returns rows for valid KQL", async () => {
    const res = await app.request("/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "SecurityEvent | count" }),
    });

    expect(res.status).toBe(200);
    const body = QueryResponse.parse(await res.json());
    expect(Number(body.tables[0]?.rows[0]?.[0])).toBe(23_864);
    expect(body.truncation.truncated).toBe(false);
  });

  test("POST /query marks oversized results as truncated", async () => {
    const res = await app.request("/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "SecurityEvent | project TimeGenerated, Computer" }),
    });

    const body = QueryResponse.parse(await res.json());
    expect(body.tables[0]?.rows).toHaveLength(500);
    expect(body.truncation).toEqual({ truncated: true, returnedRows: 500, maxRows: 500 });
  });

  test("POST /query surfaces a legible Kusto error, not a JSON fragment", async () => {
    // Regression: the message was once the literal "{", because the emulator
    // answers JSON when Accept: application/json is sent and the first line was
    // being taken verbatim. A useless message defeats PRD-1 §4.4.
    const res = await app.request("/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "SecurityEvent | where Compter == 'x' | count" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("query_error");
    expect(body.error.message).toContain("Compter");
    expect(body.error.message.length).toBeGreaterThan(20);
  });

  test("POST /query refuses a control command and the data survives", async () => {
    const res = await app.request("/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: ".drop table SecurityEvent" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "query_error" } });

    // The assertion that actually matters.
    const counted = await kusto.query(database, "SecurityEvent | count");
    expect(Number(counted.rows[0]?.[0])).toBe(23_864);
  });

  test("POST /query rejects a malformed body", async () => {
    const res = await app.request("/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "bad_request" } });
  });
});
