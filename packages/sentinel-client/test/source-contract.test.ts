import { afterEach, describe, expect, test } from "bun:test";

import type { TokenCredential } from "@azure/identity";
import { SecurityAlertResource, type QueryResponse } from "@soc/contracts";

import {
  AzureSentinelClient,
  SentinelApiClient,
  SentinelApiError,
  type SecurityDataSource,
} from "../src/index.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const nativeMockAlert = SecurityAlertResource.parse({
  id: "/subscriptions/mock/providers/Microsoft.SecurityInsights/Entities/alert-1",
  name: "alert-1",
  type: "Microsoft.SecurityInsights/Entities",
  kind: "SecurityAlert",
  properties: {
    systemAlertId: "alert-1",
    alertDisplayName: "Suspicious authentication",
    description: "Authentication from an unusual network",
    severity: "High",
    status: "New",
    alertType: "AUTH-1",
    vendorName: "Microsoft",
    productName: "Microsoft Sentinel",
    providerName: "Scheduled Alerts",
    tactics: ["InitialAccess"],
    techniques: ["T1078"],
    startTimeUtc: "2026-08-23T10:00:00.000Z",
    endTimeUtc: "2026-08-23T10:01:00.000Z",
    timeGenerated: "2026-08-23T10:02:00.000Z",
    processingEndTime: "2026-08-23T10:03:00.000Z",
    compromisedEntity: "alice@example.test",
    entities: [{ $id: "1", type: "account", name: "alice@example.test" }],
  },
});

const schemaTables = [
  {
    name: "AuthEvents",
    columns: [{ name: "identity", type: "native-scalar<identity>" }],
  },
];

const queryResult: QueryResponse = {
  tables: [
    {
      name: "PrimaryResult",
      columns: [{ name: "identity", type: "native-scalar<identity>" }],
      rows: [["alice@example.test"]],
    },
  ],
  truncation: { truncated: false, returnedRows: 1, maxRows: 500 },
};

const azureAlertColumns = [
  "SystemAlertId",
  "TimeGenerated",
  "DisplayName",
  "AlertSeverity",
  "Description",
  "Status",
  "AlertType",
  "VendorName",
  "ProductName",
  "ProviderName",
  "Tactics",
  "Techniques",
  "StartTime",
  "EndTime",
  "ProcessingEndTime",
  "CompromisedEntity",
  "Entities",
].map((name) => ({ name, type: "string" }));

const azureAlertValues: Record<string, unknown> = {
  SystemAlertId: "alert-1",
  TimeGenerated: "2026-08-23T10:02:00.000Z",
  DisplayName: "Suspicious authentication",
  AlertSeverity: "High",
  Description: "Authentication from an unusual network",
  Status: "New",
  AlertType: "AUTH-1",
  VendorName: "Microsoft",
  ProductName: "Microsoft Sentinel",
  ProviderName: "Scheduled Alerts",
  Tactics: "InitialAccess",
  Techniques: "T1078",
  StartTime: "2026-08-23T10:00:00.000Z",
  EndTime: "2026-08-23T10:01:00.000Z",
  ProcessingEndTime: "2026-08-23T10:03:00.000Z",
  CompromisedEntity: "alice@example.test",
  Entities: '[{"$id":"1","Type":"account","Name":"alice@example.test"}]',
};
const azureAlertRow = azureAlertColumns.map((column) => azureAlertValues[column.name]);

interface SourceFixture {
  source: SecurityDataSource;
  queries: string[];
}

interface SourceCase {
  name: string;
  create(options?: { queryError?: boolean }): SourceFixture;
}

function installFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): void {
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init),
    { preconnect: originalFetch.preconnect },
  );
}

const cases: SourceCase[] = [
  {
    name: "Mock Sentinel REST",
    create: (options = {}) => {
      const queries: string[] = [];
      installFetch((url, init) => {
        const path = new URL(url).pathname;
        if (path === "/alerts") return Response.json({ value: [nativeMockAlert] });
        if (path === "/alerts/alert-1") return Response.json(nativeMockAlert);
        if (path === "/schema") {
          return Response.json({ database: "MockSecurity", tables: schemaTables });
        }
        if (path === "/corpus") {
          return Response.json(
            { error: { code: "not_found", message: "Corpus identity is unavailable." } },
            { status: 404 },
          );
        }
        if (path === "/query") {
          const query = (JSON.parse(String(init?.body)) as { query: string }).query;
          queries.push(query);
          if (options.queryError === true) {
            return Response.json(
              { error: { code: "query_error", message: "bad column from native engine" } },
              { status: 400 },
            );
          }
          return Response.json(queryResult);
        }
        return new Response(null, { status: 404 });
      });
      return {
        source: new SentinelApiClient({ baseUrl: "https://mock.example.test" }),
        queries,
      };
    },
  },
  {
    name: "Azure Monitor Logs",
    create: (options = {}) => {
      const queries: string[] = [];
      const credential: TokenCredential = {
        getToken: () =>
          Promise.resolve({ token: "token", expiresOnTimestamp: Date.now() + 3_600_000 }),
      };
      installFetch((url, init) => {
        if (url.endsWith("/metadata")) {
          return Response.json({
            tables: schemaTables,
            workspaces: [
              {
                id: "workspace-id",
                name: "AzureSecurity",
                resourceId: "/subscriptions/test/workspaces/AzureSecurity",
              },
            ],
          });
        }
        if (url.endsWith("/query")) {
          const query = (JSON.parse(String(init?.body)) as { query: string }).query;
          queries.push(query);
          if (options.queryError === true) {
            return Response.json(
              { error: { code: "BadArgumentError", message: "bad column from native engine" } },
              { status: 400 },
            );
          }
          if (query.includes("project SystemAlertId")) {
            return Response.json({
              tables: [
                {
                  name: "PrimaryResult",
                  columns: azureAlertColumns,
                  rows: [azureAlertRow],
                },
              ],
            });
          }
          return Response.json({ tables: queryResult.tables });
        }
        return new Response(null, { status: 404 });
      });
      return {
        source: new AzureSentinelClient({ credential, workspaceId: "workspace-id" }),
        queries,
      };
    },
  },
];

for (const sourceCase of cases) {
  describe(`${sourceCase.name} SecurityDataSource contract`, () => {
    test("normalises stable triage fields while preserving entities and native evidence", async () => {
      const { source } = sourceCase.create();
      const [listed] = await source.listAlerts(1);
      expect(listed).toBeDefined();
      const fetched = await source.getAlert("alert-1");

      for (const alert of [listed, fetched]) {
        expect(alert).toMatchObject({
          id: "alert-1",
          title: "Suspicious authentication",
          description: "Authentication from an unusual network",
          severity: "High",
          status: "New",
          alertType: "AUTH-1",
          tactics: ["InitialAccess"],
          techniques: ["T1078"],
          compromisedEntity: "alice@example.test",
        });
        expect(alert?.entities).toEqual([
          expect.objectContaining({ type: "account", name: "alice@example.test" }),
        ]);
        expect(alert?.native).toBeDefined();
      }
    });

    test("preserves opaque schema types, positional rows and truncation", async () => {
      const { source, queries } = sourceCase.create();
      expect(await source.getSchema()).toEqual({ tables: schemaTables });

      const result = await source.query("source_table | project identity");
      expect(result).toEqual(queryResult);
      expect(queries).toHaveLength(1);
      expect(queries[0]).toStartWith("source_table | project identity");
      expect(await source.getCorpus()).toBeUndefined();
    });

    test("propagates an actionable native query diagnostic", async () => {
      const { source } = sourceCase.create({ queryError: true });
      const error = await source.query("bad source query").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SentinelApiError);
      expect(String(error)).toContain("bad column from native engine");
    });
  });
}
