import { afterEach, describe, expect, test } from "bun:test";

import { QueryResponse, SecurityAlert, SecuritySchema } from "@soc/contracts";

import {
  alertWindowMs,
  applyRowCap,
  assertLiveTenantArtifactDirectories,
  DefenderClient,
  defenderClientConfigFromEnv,
  securitySourceConfigSetFromEnv,
  securitySourceConfigsFromEnv,
  SentinelApiError,
  withRowCap,
  type SecuritySourceEnvironment,
} from "../src/index.ts";

/**
 * Deterministic Defender behaviour over mocked transport (PRD-8 §5 Phase 1).
 *
 * A local `Bun.serve` rather than a stubbed `fetch`: the connector's job is to speak HTTP to Graph,
 * and a test that replaces `fetch` proves the code around the request rather than the request. This
 * still mocks the *service*, which AGENTS.md §7 permits — what it forbids is faking a query engine
 * with query-string conditionals, and nothing here inspects KQL to decide what to return.
 */

const TOKEN = { token: "test-token", expiresOnTimestamp: Date.now() + 3_600_000 };
const credential = { getToken: async () => TOKEN };

interface Handled {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

interface Recorded {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body: unknown;
}

const servers: { stop: () => void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

function serve(handler: (request: Recorded) => Handled): { url: string; seen: Recorded[] } {
  const seen: Recorded[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const text = await request.text();
      const recorded: Recorded = {
        method: request.method,
        path: url.pathname,
        search: url.search,
        headers: Object.fromEntries(request.headers.entries()),
        body: text === "" ? undefined : JSON.parse(text),
      };
      seen.push(recorded);
      const handled = handler(recorded);
      return new Response(JSON.stringify(handled.body), {
        status: handled.status ?? 200,
        headers: { "content-type": "application/json", ...handled.headers },
      });
    },
  });
  servers.push(server);
  return { url: server.url.origin, seen };
}

/**
 * The connector points at Graph by a module constant, so the tests reach it by rewriting the host
 * on the way out. Keeping the constant unexported is deliberate — a connector whose endpoint is a
 * constructor option is one misconfiguration away from talking to somewhere else.
 */
function clientAgainst(origin: string, options: Record<string, unknown> = {}): DefenderClient {
  const original = globalThis.fetch;
  const patched = (input: string | Request | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return original(url.replace("https://graph.microsoft.com/v1.0", origin), init);
  };
  // `preconnect` carried through rather than dropped: `typeof fetch` includes it, and a partial
  // replacement would be a difference between the test's transport and the real one.
  globalThis.fetch = Object.assign(patched, { preconnect: original.preconnect.bind(original) });
  servers.push({ stop: () => (globalThis.fetch = original) });
  return new DefenderClient({ credential, ...options });
}

const GRAPH_ALERT = {
  id: "da1_1",
  providerAlertId: "1_1",
  incidentId: "42",
  incidentWebUrl: "https://security.microsoft.com/incident2/42/overview",
  title: "'EICAR_Test_File' malware was prevented",
  description: "A malware file was detected and prevented.",
  severity: "informational",
  status: "new",
  detectorId: "d60f5b90-ecd8-4d77-8186-a801597ec762",
  serviceSource: "microsoftDefenderForEndpoint",
  detectionSource: "antivirus",
  firstActivityDateTime: "2026-07-06T20:54:11.3343296Z",
  lastActivityDateTime: "2026-07-07T07:43:00.5333333Z",
  createdDateTime: "2026-07-07T07:44:00Z",
  categories: ["Malware"],
  mitreTechniques: ["T1204.002"],
  evidence: [{ "@odata.type": "#microsoft.graph.security.deviceEvidence", hostName: "mdeai-0" }],
};

describe("DefenderClient alert mapping", () => {
  /** AC5 */
  test("maps into the common envelope, leaves absent fields absent, and keeps native whole", async () => {
    const { url } = serve(() => ({ body: { value: [GRAPH_ALERT] } }));
    const [alert] = await clientAgainst(url).listAlerts();
    const parsed = SecurityAlert.parse(alert);

    expect(parsed.id).toBe("da1_1");
    expect(parsed.severity).toBe("informational");
    expect(parsed.tactics).toEqual(["Malware"]);
    expect(parsed.techniques).toEqual(["T1204.002"]);
    // Sub-second precision beyond three digits is normalised rather than rejected.
    expect(parsed.startTimeUtc).toBe("2026-07-06T20:54:11.334Z");

    // Absent by decision, not by oversight: Graph has no `compromisedEntity`, and `alertType` is
    // unmapped because the probe could not confirm `detectorId` is per-detection-logic.
    expect(parsed.compromisedEntity).toBeUndefined();
    expect(parsed.alertType).toBeUndefined();

    // `native` keeps incident membership — the agent cannot enumerate an incident's other alerts,
    // but seeing that the alert belongs to one costs nothing.
    expect(parsed.native).toMatchObject({ incidentId: "42", detectorId: GRAPH_ALERT.detectorId });
  });

  /** AC5 — `categories` absent gives an empty `tactics`, never a value borrowed from elsewhere. */
  test("an alert without categories maps to empty tactics", async () => {
    const { categories: _categories, mitreTechniques: _techniques, ...bare } = GRAPH_ALERT;
    const { url } = serve(() => ({ body: { value: [bare] } }));
    const [alert] = await clientAgainst(url).listAlerts();

    expect(alert?.tactics).toEqual([]);
    expect(alert?.techniques).toEqual([]);
    expect(alert?.native).not.toHaveProperty("categories");
  });

  /** AC15 — the request carries the window, and the header the enums need. */
  test("filters on createdDateTime over the configured window and sends the Prefer header", async () => {
    const { url, seen } = serve(() => ({ body: { value: [] } }));
    await clientAgainst(url, { alertWindow: "P3D" }).listAlerts();

    const request = seen[0];
    expect(request?.path).toBe("/security/alerts_v2");
    expect(decodeURIComponent(request?.search ?? "")).toContain("$filter=createdDateTime ge ");
    expect(request?.headers["prefer"]).toBe("include-unknown-enum-members");
    // 501 asked for against a cap of 500: exceeding the cap has to be detectable.
    expect(request?.search).toContain("$top=501");
  });

  /** AC15 — above the cap it refuses, naming the window and the count. */
  test("more than 500 alerts in the window is refused rather than truncated", async () => {
    const many = Array.from({ length: 501 }, (_value, index) => ({
      ...GRAPH_ALERT,
      id: `alert-${index}`,
    }));
    const { url } = serve(() => ({ body: { value: many, "@odata.count": 640 } }));

    const error = await clientAgainst(url, { alertWindow: "P7D" })
      .listAlerts()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SentinelApiError);
    expect(String(error)).toContain("P7D");
    expect(String(error)).toContain("640");
  });

  test("an oversized count is refused even when Graph returns a short page", async () => {
    const { url } = serve(() => ({ body: { value: [GRAPH_ALERT], "@odata.count": 640 } }));

    const error = await clientAgainst(url, { alertWindow: "P7D" })
      .listAlerts()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SentinelApiError);
    expect(String(error)).toContain("640");
  });

  test("an explicit limit is honoured and skips the cap refusal", async () => {
    const { url, seen } = serve(() => ({ body: { value: [GRAPH_ALERT] } }));
    const alerts = await clientAgainst(url).listAlerts(1);

    expect(alerts).toHaveLength(1);
    expect(seen[0]?.search).toContain("$top=1");
  });

  test("getAlert round-trips one alert by id", async () => {
    const { url, seen } = serve(() => ({ body: GRAPH_ALERT }));
    const alert = await clientAgainst(url).getAlert("da1_1");

    expect(seen[0]?.path).toBe("/security/alerts_v2/da1_1");
    expect(alert.id).toBe("da1_1");
  });
});

describe("DefenderClient hunting results", () => {
  /** AC3 — the projection D4 legislates. */
  test("object-keyed results project positionally in schema order, absent keys becoming null", async () => {
    const { url } = serve(() => ({
      body: {
        schema: [
          { name: "Timestamp", type: "DateTime" },
          { name: "DeviceName", type: "String" },
          { name: "ReportId", type: "Int64" },
        ],
        results: [
          // `ReportId` absent, and an OData annotation key `schema` never names. A projection
          // built from `Object.keys()` would drop a column and invent one.
          {
            Timestamp: "2026-07-07T07:43:00Z",
            DeviceName: "mdeai-0",
            "DeviceName@odata.type": "x",
          },
          { DeviceName: "mdeai-1", ReportId: 7, Timestamp: "2026-07-07T07:44:00Z" },
        ],
      },
    }));

    const result = QueryResponse.parse(await clientAgainst(url).query("DeviceInfo | take 2"));
    const table = result.tables[0];

    expect(table?.columns.map((column) => column.name)).toEqual([
      "Timestamp",
      "DeviceName",
      "ReportId",
    ]);
    expect(table?.rows[0]).toEqual(["2026-07-07T07:43:00Z", "mdeai-0", null]);
    // Row two arrived with its keys in a different order; position still comes from `schema`.
    expect(table?.rows[1]).toEqual(["2026-07-07T07:44:00Z", "mdeai-1", 7]);
  });

  /** AC16 — `take` and `truncation.maxRows` derive from one value. */
  test("the row cap it sends and the truncation it reports come from the same number", async () => {
    const rows = Array.from({ length: 4 }, (_value, index) => ({ N: index }));
    const { url, seen } = serve(() => ({
      body: { schema: [{ name: "N", type: "Int32" }], results: rows },
    }));

    const result = await clientAgainst(url, { queryMaxRows: 3 }).query("AlertInfo");

    expect(seen[0]?.body).toMatchObject({ Query: "AlertInfo\n| take 4" });
    expect(result.truncation).toEqual({ truncated: true, returnedRows: 3, maxRows: 3 });
    expect(result.tables[0]?.rows).toHaveLength(3);
  });

  /** AC4 — the service's message reaches the caller unrewritten. */
  test("a rejected query throws query_error carrying the engine diagnostic verbatim", async () => {
    const message =
      "'project' operator: Failed to resolve scalar expression named 'Nope'. Fix semantic errors in your query.";
    const { url } = serve(() => ({
      status: 400,
      body: { error: { code: "BadRequest", message, innerError: { code: "BadRequest" } } },
    }));

    const error = await clientAgainst(url)
      .query("AlertInfo | project Nope")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SentinelApiError);
    expect(error).toMatchObject({ code: "query_error", status: 400 });
    expect((error as SentinelApiError).message).toBe(message);
  });

  /**
   * The regression this file was written in time to catch.
   *
   * Every `400` the Phase 0 probe collected carried `innerError: { date, request-id,
   * client-request-id }` — no `code`, no `message`. An error schema requiring either would fail to
   * parse every real rejection, and the connector would hand the model "POST … returned 400 Bad
   * Request" while the engine's own diagnostic sat unread in the body.
   */
  test("a real Graph inner error, which carries no code and no message, still parses", async () => {
    const message =
      "'take' operator: Failed to resolve table or column expression named 'DeviceInfo'. Fix semantic errors in your query.";
    const { url } = serve(() => ({
      status: 400,
      body: {
        error: {
          code: "BadRequest",
          message,
          innerError: {
            date: "2026-08-25T14:50:38",
            "request-id": "3e2a0b5e-e8f2-4728-8dee-49da72a2a436",
            "client-request-id": "3e2a0b5e-e8f2-4728-8dee-49da72a2a436",
          },
        },
      },
    }));

    const error = await clientAgainst(url)
      .query("DeviceInfo | take 1")
      .catch((caught: unknown) => caught);

    expect((error as SentinelApiError).message).toBe(message);
    // The correlation ids do not dilute the diagnostic the model reads.
    expect((error as SentinelApiError).message).not.toContain("request-id");
  });

  test("both spellings of the nested error member are read", async () => {
    const { url } = serve(() => ({
      status: 400,
      body: {
        error: {
          code: "BadRequest",
          message: "outer",
          innererror: { code: "x", message: "inner" },
        },
      },
    }));

    const error = await clientAgainst(url)
      .query("AlertInfo")
      .catch((caught: unknown) => caught);

    expect(String(error)).toContain("inner");
  });

  test.each([
    [401, "authentication_error"],
    [403, "authorization_error"],
    [429, "rate_limited"],
    [503, "upstream_unavailable"],
  ])("HTTP %i becomes %s", async (status, code) => {
    const { url } = serve(() => ({
      status,
      body: { error: { code: "Whatever", message: "no" } },
    }));

    const error = await clientAgainst(url)
      .query("AlertInfo")
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code });
  });

  test("control commands are refused locally, without a round trip", async () => {
    const { url, seen } = serve(() => ({ body: {} }));
    const error = await clientAgainst(url)
      .query("// comment\n.show tables")
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "query_error" });
    expect(seen).toHaveLength(0);
  });
});

describe("DefenderClient schema discovery", () => {
  test("one batched union returns every table, ordered by ColumnOrdinal", async () => {
    const { url, seen } = serve(() => ({
      body: {
        schema: [
          { name: "SourceTable", type: "String" },
          { name: "ColumnName", type: "String" },
          { name: "ColumnType", type: "String" },
          { name: "ColumnOrdinal", type: "Int32" },
        ],
        results: [
          // Deliberately out of order, and interleaved across tables: `union` gives no ordering
          // guarantee across its legs, so the connector must not depend on arrival order.
          {
            SourceTable: "AlertInfo",
            ColumnName: "AlertId",
            ColumnType: "string",
            ColumnOrdinal: 1,
          },
          {
            SourceTable: "DeviceInfo",
            ColumnName: "DeviceId",
            ColumnType: "string",
            ColumnOrdinal: 1,
          },
          {
            SourceTable: "AlertInfo",
            ColumnName: "Timestamp",
            ColumnType: "datetime",
            ColumnOrdinal: 0,
          },
          {
            SourceTable: "DeviceInfo",
            ColumnName: "Timestamp",
            ColumnType: "datetime",
            ColumnOrdinal: 0,
          },
        ],
      },
    }));

    const schema = SecuritySchema.parse(await clientAgainst(url).getSchema());

    expect(seen[0]?.path).toBe("/security/runHuntingQuery");
    const query = String((seen[0]?.body as { Query?: unknown } | undefined)?.Query);
    expect(query).toStartWith("union isfuzzy=true ");
    expect(query).toContain('(AlertInfo | getschema | extend SourceTable = "AlertInfo")');

    expect(schema.tables.map((table) => table.name)).toEqual(["AlertInfo", "DeviceInfo"]);
    expect(schema.tables[0]?.columns.map((column) => column.name)).toEqual([
      "Timestamp",
      "AlertId",
    ]);
  });

  test("tables the tenant does not hold are simply absent, not an error", async () => {
    const { url } = serve(() => ({
      body: {
        schema: [{ name: "SourceTable", type: "String" }],
        results: [{ SourceTable: "AlertInfo", ColumnName: "AlertId", ColumnOrdinal: 0 }],
      },
    }));

    const schema = await clientAgainst(url).getSchema();
    expect(schema.tables).toHaveLength(1);
  });
});

describe("Defender configuration", () => {
  /** AC1 — the all-or-none credential group. */
  test("a partial credential group throws naming the missing key", () => {
    expect(() =>
      defenderClientConfigFromEnv({
        DEFENDER_TENANT_ID: "t",
        DEFENDER_CLIENT_ID: "c",
      }),
    ).toThrow(/DEFENDER_CLIENT_SECRET/);
  });

  test("a partial group never falls back to another identity", () => {
    expect(() =>
      defenderClientConfigFromEnv({ DEFENDER_TENANT_ID: "t", DEFENDER_CLIENT_ID: "c" }),
    ).toThrow(/no developer fallback/);
  });

  test("no Defender variables at all means the source is simply not configured", () => {
    expect(defenderClientConfigFromEnv({})).toBeUndefined();
  });

  const base: SecuritySourceEnvironment = {
    SENTINEL_CONNECTOR: "mock",
    SENTINEL_BASE_URL: "http://localhost:8787",
    SENTINEL_TIMEOUT_MS: 30_000,
  };

  /** AC2 — the zero-credential default is unchanged. */
  test("SECURITY_SOURCES unset selects mock Sentinel with no credential", () => {
    const configs = securitySourceConfigsFromEnv(base);
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ id: "sentinel", connector: "mock" });
  });

  test("SECURITY_SOURCES=defender needs no Sentinel configuration at all", () => {
    const configs = securitySourceConfigsFromEnv({
      ...base,
      SECURITY_SOURCES: "defender",
      DEFENDER_TENANT_ID: "t",
      DEFENDER_CLIENT_ID: "c",
      DEFENDER_CLIENT_SECRET: "s",
    });
    expect(configs[0]).toMatchObject({ id: "defender", connector: "graph" });
  });

  test("SECURITY_SOURCES=defender without credentials says which ones", () => {
    expect(() => securitySourceConfigsFromEnv({ ...base, SECURITY_SOURCES: "defender" })).toThrow(
      /DEFENDER_TENANT_ID/,
    );
  });

  test("an unknown source id lists the known ones", () => {
    expect(() => securitySourceConfigsFromEnv({ ...base, SECURITY_SOURCES: "splunk" })).toThrow(
      /sentinel, defender/,
    );
  });

  test("several sources preserve their configured order", () => {
    const configs = securitySourceConfigsFromEnv({
      ...base,
      SECURITY_SOURCES: "sentinel,defender",
      DEFENDER_TENANT_ID: "t",
      DEFENDER_CLIENT_ID: "c",
      DEFENDER_CLIENT_SECRET: "s",
    });
    expect(configs.map((config) => config.id)).toEqual(["sentinel", "defender"]);
  });

  test("several sources require one active primary", () => {
    const multi = {
      ...base,
      SECURITY_SOURCES: "sentinel,defender",
      DEFENDER_TENANT_ID: "t",
      DEFENDER_CLIENT_ID: "c",
      DEFENDER_CLIENT_SECRET: "s",
    };
    expect(() => securitySourceConfigSetFromEnv(multi)).toThrow(/PRIMARY_ALERT_SOURCE is required/);
    expect(() =>
      securitySourceConfigSetFromEnv({ ...multi, PRIMARY_ALERT_SOURCE: "splunk" }),
    ).toThrow(/inactive source/);

    const selected = securitySourceConfigSetFromEnv({
      ...multi,
      PRIMARY_ALERT_SOURCE: "defender",
    });
    expect(selected.sources.map((source) => source.id)).toEqual(["sentinel", "defender"]);
    expect(selected.primary.id).toBe("defender");
  });

  test.each([
    ["P7D", 7 * 24 * 60 * 60_000],
    ["PT12H", 12 * 60 * 60_000],
    ["PT30M", 30 * 60_000],
  ])("%s parses to %i ms", (duration, expected) => {
    expect(alertWindowMs(duration)).toBe(expected);
  });

  test.each([["P1M"], ["7d"], ["P0D"], [""]])("%p is refused as a window", (duration) => {
    expect(() => alertWindowMs(duration)).toThrow();
  });

  test("a malformed window stops the client at construction, not at first use", () => {
    expect(() => new DefenderClient({ credential, alertWindow: "P1M" })).toThrow(
      /DEFENDER_ALERT_WINDOW/,
    );
  });
});

/** AC6 — any active live-tenant source forces the whole run under `.data/`. */
describe("live-tenant artifact directories", () => {
  const defender = {
    id: "defender",
    connector: "graph",
    tenantId: "t",
    clientId: "c",
    clientSecret: "s",
  } as const;
  const mock = {
    id: "sentinel",
    connector: "mock",
    baseUrl: "http://localhost:8787",
  } as const;

  test("mock Sentinel alone may write to the default runs directory", () => {
    expect(() => assertLiveTenantArtifactDirectories([mock], ["runs"])).not.toThrow();
  });

  test("an active Defender forces .data/ even when Sentinel is mock", () => {
    expect(() => assertLiveTenantArtifactDirectories([mock, defender], ["runs"])).toThrow(
      /must be inside \.data/,
    );
  });

  test("a Defender run under .data/ is accepted", () => {
    expect(() =>
      assertLiveTenantArtifactDirectories([defender], [".data/runs", ".data/runs/traces"]),
    ).not.toThrow();
  });

  test("the error names the source that made the run live", () => {
    expect(() => assertLiveTenantArtifactDirectories([defender], ["runs"])).toThrow(/defender/);
  });
});

/** AC16, for the shared helper both connectors now build their query text with. */
describe("the row cap is one value", () => {
  test("withRowCap asks for one row beyond the cap so truncation is detectable", () => {
    expect(withRowCap("AlertInfo", 500)).toBe("AlertInfo\n| take 501");
  });

  test("applyRowCap trims to the cap and reports it", () => {
    const table = {
      name: "PrimaryResult",
      columns: [{ name: "N", type: "int" }],
      rows: [[1], [2], [3]],
    };
    expect(applyRowCap([table], 2)).toMatchObject({
      truncation: { truncated: true, returnedRows: 2, maxRows: 2 },
    });
    expect(applyRowCap([table], 5)).toMatchObject({
      truncation: { truncated: false, returnedRows: 3, maxRows: 5 },
    });
  });
});

/**
 * AC7 — a multi-source set must not be guessed into existence.
 *
 * With more than one active source the alert producer is a choice with consequences: it decides
 * which product's detections start an investigation, and ADR 008 §3 folds it into the condition key.
 * Defaulting it would make that choice silently, and a later reader could not tell whether the
 * operator meant it.
 */
describe("AC7 — PRIMARY_ALERT_SOURCE", () => {
  const base: SecuritySourceEnvironment = {
    SENTINEL_CONNECTOR: "mock",
    SENTINEL_BASE_URL: "http://localhost:8787",
    SENTINEL_TIMEOUT_MS: 30_000,
    DEFENDER_TENANT_ID: "t",
    DEFENDER_CLIENT_ID: "c",
    DEFENDER_CLIENT_SECRET: "s",
  };

  test("two active sources and no primary throws rather than guessing", () => {
    expect(() =>
      securitySourceConfigSetFromEnv({ ...base, SECURITY_SOURCES: "sentinel,defender" }),
    ).toThrow(/PRIMARY_ALERT_SOURCE is required/);
  });

  test("a primary naming an inactive source throws, listing the active ids", () => {
    expect(() =>
      securitySourceConfigSetFromEnv({
        ...base,
        SECURITY_SOURCES: "sentinel,defender",
        PRIMARY_ALERT_SOURCE: "splunk",
      }),
    ).toThrow(/splunk/);
  });

  test("one active source defaults the primary to itself", () => {
    const set = securitySourceConfigSetFromEnv({ ...base, SECURITY_SOURCES: "defender" });
    expect(set.primary.id).toBe("defender");
    expect(set.sources).toHaveLength(1);
  });

  test("the active set keeps SECURITY_SOURCES order, whichever one is primary", () => {
    const set = securitySourceConfigSetFromEnv({
      ...base,
      SECURITY_SOURCES: "defender,sentinel",
      PRIMARY_ALERT_SOURCE: "sentinel",
    });

    // Order is the operator's, not the primary's — turn-0 emits blocks in this order.
    expect(set.sources.map((source) => source.id)).toEqual(["defender", "sentinel"]);
    expect(set.primary.id).toBe("sentinel");
  });
});
