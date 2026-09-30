import { describe, expect, test } from "bun:test";

import { DefenderClient, findingsMarker, LocalFindingsPublisher } from "../src/index.ts";

/**
 * PRD-10 AC5, AC6, AC22 — the Graph publisher, against the shapes the probe measured.
 *
 * `fetch` is stubbed rather than reached, and the stub answers exactly what the live tenant answered
 * on 2026-09-16 (ADR 013 §6): `POST /security/incidents/{id}/comments` returns 200 echoing the
 * comments collection, and a plain `GET /security/incidents/{id}` carries `comments` inline. A stub
 * that invented friendlier shapes would pass while the real thing failed, which is the whole reason
 * PRD-8 §4.1 D12 makes the probe come first.
 *
 * The live half is `scripts/probe-defender.ts --only I --write-probe`, which is where these shapes
 * came from and where a Graph change would be caught.
 */

const ALERT = { id: "alert-1", title: "Suspicious sign-in", caseId: "2" };
const TOKEN = {
  getToken: () => Promise.resolve({ token: "t", expiresOnTimestamp: Date.now() + 3_600_000 }),
};

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

/** Answers with the tenant's measured shapes and records what was asked. */
function graphStub(existingComments: { comment: string }[]): {
  calls: Call[];
  fetch: typeof globalThis.fetch;
} {
  const calls: Call[] = [];
  const comments = [...existingComments];
  const fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, url, ...(body === undefined ? {} : { body }) });

    if (method === "POST" && url.endsWith("/comments")) {
      comments.push({ comment: String((body as { comment: string }).comment) });
      // The measured 200: Graph echoes the whole collection back.
      return Promise.resolve(
        new Response(JSON.stringify({ value: comments }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    // A plain incident GET carries `comments` inline — `$expand` and `/comments` both 400.
    return Promise.resolve(
      new Response(JSON.stringify({ id: "2", comments }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

function clientWith(fetchImpl: typeof globalThis.fetch): DefenderClient {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const client = new DefenderClient({ credential: TOKEN as never });
  globalThis.fetch = original;
  // The client captured nothing: it calls the global at request time, so swap for the duration.
  return client;
}

async function withStub<T>(fetchImpl: typeof globalThis.fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

describe("GraphFindingsPublisher (ADR 013 §6)", () => {
  test("AC5 — Given a credential, When findings are published, Then a comment is posted to the alert's incident", async () => {
    const { calls, fetch } = graphStub([]);
    const client = clientWith(fetch);

    const outcome = await withStub(fetch, () => client.publishFindings(ALERT, "the findings body"));

    expect(outcome.status).toBe("published");
    const post = calls.find((call) => call.method === "POST");
    expect(post?.url).toBe("https://graph.microsoft.com/v1.0/security/incidents/2/comments");
    // The `@odata.type` is required by Graph and was measured, not guessed.
    expect(post?.body).toEqual({
      "@odata.type": "microsoft.graph.security.alertComment",
      comment: "the findings body",
    });
    expect(outcome.caseRef).toContain(findingsMarker("alert-1"));
  });

  test("AC6, AC22 — Given the marker is already on the incident, When publishing runs again, Then no second comment is written", async () => {
    const { calls, fetch } = graphStub([
      { comment: `${findingsMarker("alert-1")}\n\nan earlier finding` },
    ]);
    const client = clientWith(fetch);

    const outcome = await withStub(fetch, () => client.publishFindings(ALERT, "a second attempt"));

    expect(outcome.status).toBe("alreadyPresent");
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
    expect(outcome.caseRef).toContain(findingsMarker("alert-1"));
  });

  test("a marker for a different alert does not suppress this one", async () => {
    // The marker keys on the alert, not the incident — several alerts share an incident, and each
    // must still get its own comment (ADR 013 §6).
    const { calls, fetch } = graphStub([
      { comment: `${findingsMarker("alert-OTHER")}\n\nsomeone else's finding` },
    ]);
    const client = clientWith(fetch);

    const outcome = await withStub(fetch, () => client.publishFindings(ALERT, "mine"));

    expect(outcome.status).toBe("published");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  test("an alert with no incident is refused rather than published somewhere invented", async () => {
    const { fetch } = graphStub([]);
    const client = clientWith(fetch);

    const attempt = withStub(fetch, () =>
      client.publishFindings({ id: "alert-2", title: "t" }, "body"),
    );

    await expect(attempt).rejects.toThrow("no incident id");
  });

  test("the local publisher needs no case and never reports alreadyPresent", async () => {
    const outcome = await new LocalFindingsPublisher().publishFindings(ALERT, "body");

    expect(outcome.status).toBe("published");
    expect(outcome.caseRef).toContain(findingsMarker("alert-1"));
  });
});
