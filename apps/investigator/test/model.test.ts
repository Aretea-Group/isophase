import { describe, expect, test } from "bun:test";

import {
  assertLlamaServerThinkingLevel,
  type LlamaServerConfig,
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

describe("llama-server configuration", () => {
  test("is absent when the complete group is absent", () => {
    expect(llamaServerConfigFromEnv({})).toBeUndefined();
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

  test("requires off when the local provider is active", () => {
    expect(() => assertLlamaServerThinkingLevel("llamacpp", "medium")).toThrow('must be "off"');
    expect(() => assertLlamaServerThinkingLevel("llamacpp", "off")).not.toThrow();
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
      reasoning: false,
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
    const { model, streamFn } = await resolveModel("llamacpp", "local-model", CONFIG);
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
      {
        fetch: fetchStub,
      },
    );

    await stream.result();
    expect(requestUrl).toBe("https://host.example/v1/chat/completions");
    expect(authorization).toBe("Bearer unused");
    expect(payload).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
  });
});
