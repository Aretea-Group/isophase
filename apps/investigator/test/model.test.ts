import { describe, expect, test } from "bun:test";

import {
  assertLlamaServerThinkingLevel,
  type LlamaServerAuth,
  type LlamaServerConfig,
  llamaServerAuthFromEnv,
  llamaServerConfigFromEnv,
  listAvailableModels,
  resolveModel,
} from "../src/model.ts";

const CONFIG: LlamaServerConfig = {
  baseUrl: "https://host.example/v1",
  modelId: "local-model",
  contextWindow: 65_536,
  maxTokens: 4_096,
};

async function sendTestRequest(
  llamaServerAuth?: LlamaServerAuth,
  reasoning?: "low" | "medium",
): Promise<{
  requestUrl: string | undefined;
  authorization: string | null | undefined;
  payload: unknown;
}> {
  const { model, streamFn } = await resolveModel(
    "llamacpp",
    "local-model",
    CONFIG,
    llamaServerAuth,
  );
  let requestUrl: string | undefined;
  let authorization: string | null | undefined;
  let payload: unknown;
  const fetchStub: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit) => {
      requestUrl = input instanceof Request ? input.url : input.toString();
      authorization =
        input instanceof Request
          ? input.headers.get("authorization")
          : new Headers(init?.headers).get("authorization");
      const body =
        input instanceof Request
          ? await input.clone().text()
          : typeof init?.body === "string"
            ? init.body
            : "";
      payload = body === "" ? undefined : JSON.parse(body);
      return new Response(
        'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"local-model","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n' +
          'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"local-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
    { preconnect: fetch.preconnect },
  );
  const stream = streamFn(
    model,
    { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
    { fetch: fetchStub, reasoning },
  );

  await stream.result();
  return { requestUrl, authorization, payload };
}

describe("llama-server configuration", () => {
  test("is absent when the complete group is absent", () => {
    expect(llamaServerConfigFromEnv({})).toBeUndefined();
    expect(llamaServerAuthFromEnv({}, undefined)).toBeUndefined();
  });

  test("normalizes one trailing slash and preserves the declared limits", () => {
    expect(
      llamaServerConfigFromEnv({
        LLAMA_SERVER_BASE_URL: "https://host.example/v1/",
        LLAMA_SERVER_MODEL: "local-model",
        LLAMA_SERVER_CONTEXT_WINDOW: 65_536,
        LLAMA_SERVER_MAX_TOKENS: 4_096,
      }),
    ).toEqual(CONFIG);
  });

  test("rejects a partial group and names the missing values", () => {
    expect(() =>
      llamaServerConfigFromEnv({ LLAMA_SERVER_BASE_URL: "https://host.example/v1" }),
    ).toThrow("LLAMA_SERVER_MODEL");
  });

  test("accepts an optional bearer token only with a complete endpoint", () => {
    expect(
      llamaServerAuthFromEnv({ LLAMA_SERVER_BEARER_TOKEN: "test-bearer-token" }, CONFIG),
    ).toEqual({ bearerToken: "test-bearer-token" });
    expect(() =>
      llamaServerAuthFromEnv({ LLAMA_SERVER_BEARER_TOKEN: "test-bearer-token" }, undefined),
    ).toThrow("requires the complete LLAMA_SERVER_* endpoint configuration");
  });

  test.each([
    "file:///tmp/v1",
    "relative/v1",
    "https://user:password@host.example/v1",
    "https://host.example/api",
    "https://host.example/v1?mode=test",
  ])("rejects an unsafe or incompatible base URL: %s", (baseUrl) => {
    expect(() =>
      llamaServerConfigFromEnv({
        LLAMA_SERVER_BASE_URL: baseUrl,
        LLAMA_SERVER_MODEL: "local-model",
        LLAMA_SERVER_CONTEXT_WINDOW: 65_536,
        LLAMA_SERVER_MAX_TOKENS: 4_096,
      }),
    ).toThrow();
  });

  test("rejects invalid limits", () => {
    expect(() =>
      llamaServerConfigFromEnv({
        LLAMA_SERVER_BASE_URL: "https://host.example/v1",
        LLAMA_SERVER_MODEL: "local-model",
        LLAMA_SERVER_CONTEXT_WINDOW: 0,
        LLAMA_SERVER_MAX_TOKENS: 1,
      }),
    ).toThrow();
    expect(() =>
      llamaServerConfigFromEnv({
        LLAMA_SERVER_BASE_URL: "https://host.example/v1",
        LLAMA_SERVER_MODEL: "local-model",
        LLAMA_SERVER_CONTEXT_WINDOW: 1_024,
        LLAMA_SERVER_MAX_TOKENS: 2_048,
      }),
    ).toThrow("must not exceed");
  });

  test("allows only mapped thinking levels when the local provider is active", () => {
    expect(() => assertLlamaServerThinkingLevel("llamacpp", "high")).toThrow(
      'must be "off", "low", or "medium"',
    );
    expect(() => assertLlamaServerThinkingLevel("llamacpp", "off")).not.toThrow();
    expect(() => assertLlamaServerThinkingLevel("llamacpp", "low")).not.toThrow();
    expect(() => assertLlamaServerThinkingLevel("llamacpp", "medium")).not.toThrow();
    expect(() => assertLlamaServerThinkingLevel("openai", "medium")).not.toThrow();
  });
});

describe("llama-server model registration", () => {
  test("does not register the provider without endpoint configuration", async () => {
    await expect(resolveModel("llamacpp", "local-model")).rejects.toThrow(
      'Provider "llamacpp" is not registered',
    );
  });

  test("resolves exactly the configured model and limits through the existing adapter", async () => {
    const { model } = await resolveModel("llamacpp", "local-model", CONFIG);
    expect(model).toMatchObject({
      provider: "llamacpp",
      id: "local-model",
      api: "openai-completions",
      baseUrl: "https://host.example/v1",
      reasoning: true,
      input: ["text"],
      contextWindow: 65_536,
      maxTokens: 4_096,
    });
  });

  test("names the only configured id when model resolution fails", async () => {
    await expect(resolveModel("llamacpp", "other-model", CONFIG)).rejects.toThrow(
      "Available llamacpp models: local-model",
    );
  });

  test("offers one configured local model without remote discovery", async () => {
    const available = await listAvailableModels(CONFIG);
    expect(available.filter((choice) => choice.provider === "llamacpp")).toEqual([
      { provider: "llamacpp", id: "local-model" },
    ]);
  });

  test("uses the adapter's minimum placeholder authorization for a keyless request", async () => {
    const { requestUrl, authorization, payload } = await sendTestRequest();
    expect(requestUrl).toBe("https://host.example/v1/chat/completions");
    expect(authorization).toBe("Bearer unused");
    expect(payload).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
    expect(JSON.stringify(payload)).not.toContain("reasoning_effort");
  });

  test("requests low reasoning through Qwen chat-template arguments", async () => {
    const { payload } = await sendTestRequest(undefined, "low");
    expect(payload).toMatchObject({
      chat_template_kwargs: { enable_thinking: true, reasoning_effort: "low" },
    });
  });

  test("requests medium reasoning through Qwen chat-template arguments", async () => {
    const { payload } = await sendTestRequest(undefined, "medium");
    expect(payload).toMatchObject({
      chat_template_kwargs: { enable_thinking: true, reasoning_effort: "medium" },
    });
  });

  test("sends the configured bearer token through the existing adapter", async () => {
    const { authorization } = await sendTestRequest({ bearerToken: "test-bearer-token" });
    expect(authorization).toBe("Bearer test-bearer-token");
  });
});
