import { afterEach, describe, expect, test } from "bun:test";

import { AzureSentinelClient, SentinelApiError, createSentinelClient } from "../src/index.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

function captureFetch(
  handler: (request: CapturedRequest, index: number) => Response | Promise<Response>,
): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = { url: String(input), init };
      requests.push(request);
      return handler(request, requests.length - 1);
    },
    { preconnect: originalFetch.preconnect },
  );
  return requests;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

const options = {
  tenantId: "tenant-id",
  clientId: "client-id",
  clientSecret: "secret&value",
  workspaceId: "workspace-id",
};

const workspace = {
  id: options.workspaceId,
  name: "sentinel-prod",
  resourceId:
    "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.OperationalInsights/workspaces/sentinel-prod",
};

const metadata = {
  tables: [
    {
      name: "SecurityAlert",
      columns: [
        { name: "TimeGenerated", type: "datetime" },
        { name: "SystemAlertId", type: "string" },
      ],
    },
  ],
  workspaces: [workspace],
};

function token(value = "access-token", expiresIn = 3600): Response {
  return json({ token_type: "Bearer", expires_in: expiresIn, access_token: value });
}

function queryResult(rows: unknown[][], columns = [{ name: "value", type: "long" }]): Response {
  return json({ tables: [{ name: "PrimaryResult", columns, rows }] });
}

describe("AzureSentinelClient authentication and metadata", () => {
  test("uses client credentials, shares token and metadata requests, and caches both", async () => {
    const requests = captureFetch((request) => {
      if (request.url.includes("/oauth2/v2.0/token")) return token();
      expect(request.init?.headers).toMatchObject({ authorization: "Bearer access-token" });
      return json(metadata);
    });
    const client = new AzureSentinelClient(options);

    const [first, second] = await Promise.all([client.getSchema(), client.getSchema()]);
    expect(first).toEqual(second);
    expect(first).toEqual({
      database: "sentinel-prod",
      tables: metadata.tables,
    });
    expect(await client.getCorpus()).toBeUndefined();
    expect(requests).toHaveLength(2);

    const tokenRequest = requests[0];
    expect(tokenRequest?.url).toBe("https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token");
    const form = new URLSearchParams(String(tokenRequest?.init?.body));
    expect(form.get("client_id")).toBe(options.clientId);
    expect(form.get("client_secret")).toBe(options.clientSecret);
    expect(form.get("scope")).toBe("https://api.loganalytics.io/.default");
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(requests[1]?.url).toBe(
      "https://api.loganalytics.azure.com/v1/workspaces/workspace-id/metadata",
    );
  });

  test("refreshes a token that is inside the expiry safety window", async () => {
    let tokenNumber = 0;
    const requests = captureFetch((request) => {
      if (request.url.includes("/oauth2/v2.0/token")) {
        tokenNumber += 1;
        return token(`token-${tokenNumber}`, 1);
      }
      return queryResult([[1]]);
    });
    const client = new AzureSentinelClient(options);

    await client.query("SecurityAlert | count");
    await client.query("SecurityAlert | count");

    expect(requests.filter((request) => request.url.includes("/token"))).toHaveLength(2);
  });

  test("never includes the client secret or bearer token in errors", async () => {
    captureFetch(() =>
      json(
        {
          error: "invalid_client",
          error_description: `credential ${options.clientSecret} was rejected`,
        },
        401,
      ),
    );
    const client = new AzureSentinelClient(options);

    const authError = await client.getSchema().catch((error: unknown) => error);
    expect(authError).toBeInstanceOf(SentinelApiError);
    expect(String(authError)).not.toContain(options.clientSecret);

    captureFetch((request) => {
      if (request.url.includes("/token")) return token("private-token");
      return json(
        { error: { code: "BadArgumentError", message: "private-token is invalid" } },
        400,
      );
    });
    const queryError = await new AzureSentinelClient(options)
      .query("missing | count")
      .catch((error: unknown) => error);
    expect(String(queryError)).not.toContain("private-token");
  });
});

describe("AzureSentinelClient query boundary", () => {
  test("sends timespan and bearer auth, then reports the 501st row as truncation", async () => {
    const requests = captureFetch((request) => {
      if (request.url.includes("/token")) return token();
      return queryResult(Array.from({ length: 501 }, (_, index) => [index]));
    });
    const client = new AzureSentinelClient(options);

    const result = await client.query("SecurityAlert | project value", "PT12H");

    expect(result.tables[0]?.rows).toHaveLength(500);
    expect(result.truncation).toEqual({ truncated: true, returnedRows: 500, maxRows: 500 });
    const request = requests[1];
    expect(request?.url).toEndWith("/v1/workspaces/workspace-id/query");
    expect(request?.init?.headers).toMatchObject({ authorization: "Bearer access-token" });
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      query: "SecurityAlert | project value\n| take 501",
      timespan: "PT12H",
    });
  });

  test("rejects control commands before authentication", async () => {
    const requests = captureFetch(() => {
      throw new Error("fetch must not run");
    });
    const error = await new AzureSentinelClient(options)
      .query(" // comment\n.drop table SecurityAlert")
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "query_error", status: 400 });
    expect(requests).toHaveLength(0);
  });

  test("rejects a 200 PartialError with its diagnostic", async () => {
    captureFetch((request) => {
      if (request.url.includes("/token")) return token();
      return json({
        tables: [{ name: "PrimaryResult", columns: [], rows: [] }],
        error: {
          code: "PartialError",
          message: "Query result is partial",
          details: [{ code: "LimitsExceeded", message: "response exceeded a service limit" }],
        },
      });
    });

    const error = await new AzureSentinelClient(options)
      .query("SecurityAlert")
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "query_error", status: 200 });
    expect(String(error)).toContain("response exceeded a service limit");
  });

  test.each([
    [401, "authentication_error"],
    [403, "authorization_error"],
    [429, "rate_limited"],
    [503, "upstream_unavailable"],
  ] as const)("maps HTTP %i to %s", async (status, code) => {
    captureFetch((request) => {
      if (request.url.includes("/token")) return token();
      return json({ error: { code: "RequestFailed", message: "upstream diagnostic" } }, status);
    });

    const error = await new AzureSentinelClient(options)
      .query("SecurityAlert | count")
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code, status });
    expect(String(error)).toContain("upstream diagnostic");
  });
});

const alertColumns = [
  "SystemAlertId",
  "TimeGenerated",
  "DisplayName",
  "AlertName",
  "AlertSeverity",
  "Description",
  "Status",
  "AlertType",
  "VendorOriginalId",
  "VendorName",
  "ProductName",
  "ProductComponentName",
  "ProviderName",
  "Tactics",
  "Techniques",
  "SubTechniques",
  "StartTime",
  "EndTime",
  "ProcessingEndTime",
  "ConfidenceLevel",
  "ConfidenceScore",
  "CompromisedEntity",
  "RemediationSteps",
  "AlertLink",
  "ExtendedProperties",
  "Entities",
].map((name) => ({ name, type: "string" }));

function alertRow(systemAlertId: string): unknown[] {
  const values: Record<string, unknown> = {
    SystemAlertId: systemAlertId,
    TimeGenerated: "2026-08-22T10:00:00.0000000Z",
    DisplayName: "Suspicious sign-in",
    AlertSeverity: "High",
    Description: "Observed unusual authentication",
    Status: "New",
    AlertType: "rule-id",
    VendorOriginalId: "vendor-id",
    VendorName: "Microsoft",
    ProductName: "Microsoft Sentinel",
    ProviderName: "Scheduled Alerts",
    Tactics: "InitialAccess, CredentialAccess",
    Techniques: "T1078",
    SubTechniques: "T1078.004",
    StartTime: "2026-08-22T09:55:00Z",
    EndTime: "2026-08-22T10:00:00Z",
    ProcessingEndTime: "2026-08-22T10:01:00Z",
    ConfidenceLevel: "High",
    ConfidenceScore: 0.9,
    CompromisedEntity: "alice",
    RemediationSteps: '["Reset password"]',
    AlertLink: "https://portal.azure.com/#alert",
    ExtendedProperties: '{"source":"test"}',
    Entities: '[{"$id":"1","Type":"account","Name":"alice","NTDomain":"CONTOSO"}]',
  };
  return alertColumns.map((column) => values[column.name] ?? null);
}

describe("AzureSentinelClient alerts", () => {
  test("escapes an alert id and projects a real SecurityAlert row", async () => {
    const requestedId = 'alert"with\\slashes';
    const requests = captureFetch((request) => {
      if (request.url.includes("/token")) return token();
      if (request.url.endsWith("/metadata")) return json(metadata);
      return queryResult([alertRow(requestedId)], alertColumns);
    });
    const client = new AzureSentinelClient(options);

    const alert = await client.getAlert(requestedId);

    expect(alert.id).toBe(
      `${workspace.resourceId}/providers/Microsoft.SecurityInsights/Entities/${requestedId}`,
    );
    expect(alert.properties).toMatchObject({
      systemAlertId: requestedId,
      alertDisplayName: "Suspicious sign-in",
      severity: "High",
      tactics: ["InitialAccess", "CredentialAccess"],
      techniques: ["T1078", "T1078.004"],
      remediationSteps: ["Reset password"],
      additionalData: { source: "test" },
      entities: [{ $id: "1", type: "account", name: "alice", ntDomain: "CONTOSO" }],
    });
    const queryBody = JSON.parse(String(requests[1]?.init?.body)) as { query: string };
    expect(queryBody.query).toContain('where SystemAlertId == "alert\\"with\\\\slashes"');
  });

  test("returns not_found when a targeted alert query has no row", async () => {
    captureFetch((request) =>
      request.url.includes("/token") ? token() : queryResult([], alertColumns),
    );
    const error = await new AzureSentinelClient(options)
      .getAlert("missing")
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "not_found", status: 404 });
  });

  test("fails visibly when the unbounded alert list exceeds 500", async () => {
    const requests = captureFetch((request) =>
      request.url.includes("/token")
        ? token()
        : queryResult(
            Array.from({ length: 501 }, () => alertRow("alert")),
            alertColumns,
          ),
    );
    const error = await new AzureSentinelClient(options)
      .listAlerts()
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "bad_request", status: 400 });
    expect(requests.some((request) => request.url.endsWith("/metadata"))).toBeFalse();
  });

  test("rejects a top above the first-slice limit before fetch", async () => {
    const requests = captureFetch(() => {
      throw new Error("fetch must not run");
    });
    const error = await new AzureSentinelClient(options)
      .listAlerts(501)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "bad_request", status: 400 });
    expect(requests).toHaveLength(0);
  });
});

test("factory selects Mock and Azure implementations", () => {
  expect(createSentinelClient({ connector: "mock", baseUrl: "http://localhost:8787" })).not.toBe(
    undefined,
  );
  expect(createSentinelClient({ connector: "azure", ...options })).toBeInstanceOf(
    AzureSentinelClient,
  );
});
