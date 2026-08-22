import type { Api, Model } from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { z } from "zod";

export interface LlamaServerConfig {
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
}

const LlamaServerEnvironment = z.object({
  LLAMA_SERVER_BASE_URL: z.string().min(1).optional(),
  LLAMA_SERVER_MODEL: z.string().min(1).optional(),
  LLAMA_SERVER_CONTEXT_WINDOW: z.coerce.number().int().positive().optional(),
  LLAMA_SERVER_MAX_TOKENS: z.coerce.number().int().positive().optional(),
});

type LlamaServerEnvironment = z.infer<typeof LlamaServerEnvironment>;

function normalizeBaseUrl(value: string): string {
  const baseUrl = value.endsWith("/") ? value.slice(0, -1) : value;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("LLAMA_SERVER_BASE_URL must be an absolute http or https URL ending in /v1.");
  }

  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !baseUrl.endsWith("/v1")) {
    throw new Error("LLAMA_SERVER_BASE_URL must be an absolute http or https URL ending in /v1.");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("LLAMA_SERVER_BASE_URL must not contain a username or password.");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error("LLAMA_SERVER_BASE_URL must not contain a query string or fragment.");
  }
  return baseUrl;
}

/** Build the one safe, persistable endpoint configuration from its all-or-nothing env group. */
export function llamaServerConfigFromEnv(
  source: LlamaServerEnvironment,
): LlamaServerConfig | undefined {
  const input = LlamaServerEnvironment.parse(source);
  const keys = [
    "LLAMA_SERVER_BASE_URL",
    "LLAMA_SERVER_MODEL",
    "LLAMA_SERVER_CONTEXT_WINDOW",
    "LLAMA_SERVER_MAX_TOKENS",
  ] as const;
  const present = keys.filter((key) => input[key] !== undefined);
  if (present.length === 0) return undefined;

  const missing = keys.filter((key) => input[key] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Incomplete llama-server configuration. Set ${missing.join(", ")} together with the other LLAMA_SERVER_* values.`,
    );
  }

  const complete = LlamaServerEnvironment.required().parse(input);
  const baseUrl = normalizeBaseUrl(complete.LLAMA_SERVER_BASE_URL);
  const modelId = complete.LLAMA_SERVER_MODEL;
  const contextWindow = complete.LLAMA_SERVER_CONTEXT_WINDOW;
  const maxTokens = complete.LLAMA_SERVER_MAX_TOKENS;
  if (maxTokens > contextWindow) {
    throw new Error("LLAMA_SERVER_MAX_TOKENS must not exceed LLAMA_SERVER_CONTEXT_WINDOW.");
  }
  return { baseUrl, modelId, contextWindow, maxTokens };
}

/** This first slice records no model-specific reasoning contract, so only Pi's off mode is honest. */
export function assertLlamaServerThinkingLevel(
  provider: string,
  thinkingLevel: string | undefined,
): void {
  if (provider === "llamacpp" && thinkingLevel !== undefined && thinkingLevel !== "off") {
    throw new Error(
      'INVESTIGATOR_THINKING_LEVEL must be "off" when INVESTIGATOR_PROVIDER is "llamacpp".',
    );
  }
}

export interface ModelChoice {
  provider: string;
  id: string;
}

export interface ResolvedModel {
  model: Model<Api>;
  /** Bound and ready to hand to `Agent`'s `streamFn`. */
  streamFn: ReturnType<typeof buildModels>["streamSimple"];
}

function buildModels(llamaServer?: LlamaServerConfig) {
  const models = createModels();
  // Registered together so the provider is a configuration choice, not a code change. API keys are
  // resolved by pi-ai from the ambient environment; a provider with no key simply fails at call time.
  models.setProvider(openaiProvider());
  models.setProvider(anthropicProvider());
  models.setProvider(googleProvider());
  if (llamaServer !== undefined) {
    const model: Model<"openai-completions"> = {
      id: llamaServer.modelId,
      name: llamaServer.modelId,
      api: "openai-completions",
      provider: "llamacpp",
      baseUrl: llamaServer.baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: llamaServer.contextWindow,
      maxTokens: llamaServer.maxTokens,
      samplingParams: { chat_template_kwargs: { enable_thinking: false } },
      compat: {
        supportsDeveloperRole: false,
        supportsStrictMode: false,
        supportsStore: false,
        maxTokensField: "max_tokens",
      },
    };
    models.setProvider(
      createProvider({
        id: "llamacpp",
        name: "llama.cpp",
        baseUrl: llamaServer.baseUrl,
        auth: {
          apiKey: {
            name: "Keyless llama-server",
            resolve: () =>
              Promise.resolve({ auth: { apiKey: "unused" }, source: "keyless endpoint" }),
          },
        },
        models: [model],
        api: openAICompletionsApi(),
      }),
    );
  }
  return models;
}

/**
 * Resolve the configured provider/model pair.
 *
 * Fails with the available ids rather than a bare undefined, because a typo'd model name is the
 * single most likely startup mistake and `getModel` returns `undefined` for both an unknown model
 * and an unknown provider.
 */
export async function resolveModel(
  provider: string,
  id: string,
  llamaServer?: LlamaServerConfig,
): Promise<ResolvedModel> {
  const models = buildModels(llamaServer);
  const model = models.getModel(provider, id);

  if (!model) {
    const available = models.getModels(provider).map((m) => m.id);
    const detail =
      available.length === 0
        ? `Provider "${provider}" is not registered. Known providers: ${models
            .getProviders()
            .map((registered) => registered.id)
            .join(", ")}.`
        : `Available ${provider} models: ${available.join(", ")}`;
    throw new Error(`Unknown model "${provider}/${id}". ${detail}`);
  }

  // Fail before the first investigation rather than turning every alert in a sweep into a provider
  // error. getAuth resolves the credential the same way a real request would, and returns undefined
  // when the provider is unconfigured.
  const auth = await models.getAuth(model);
  if (!auth) {
    throw new Error(
      `No credentials for provider "${provider}". Set the provider's API key (e.g. OPENAI_API_KEY for openai, ANTHROPIC_API_KEY for anthropic) and retry.`,
    );
  }

  return { model, streamFn: models.streamSimple.bind(models) };
}

/**
 * The models worth pointing at an investigation, newest first within each provider.
 *
 * A credential filter alone is not enough. Holding an OpenAI key makes 38 ids reachable, and the
 * list includes `gpt-realtime-2.1`, two `codex` variants, `gpt-4`, `o1` and four dated `gpt-4o`
 * snapshots; Google's 22 include robotics, computer-use, image and `gemma`. None of those is a
 * security analyst, and a picker that offers them is asking the operator to know which of 38 names
 * is a real choice — which is the same failure as offering models with no key, one level up.
 *
 * Hand-maintained on purpose. There is no capability flag on the catalogue that distinguishes "can
 * investigate" from "can generate audio", so any automatic rule would be a guess encoded as a regex
 * that silently admits the next specialist model to ship. A short list goes stale visibly — a new
 * model simply does not appear until someone adds it — and that is the failure mode to prefer.
 *
 * Order is intentional and survives to the picker: best first, cheap option last.
 */
const CURATED_MODELS: readonly ModelChoice[] = [
  { provider: "openai", id: "gpt-5.6-luna" },
  { provider: "openai", id: "gpt-5.6-sol" },
  { provider: "openai", id: "gpt-5.6-terra" },
  { provider: "openai", id: "gpt-5.5" },
  { provider: "openai", id: "gpt-5.5-pro" },
  { provider: "openai", id: "gpt-5.4-mini" },
  { provider: "anthropic", id: "claude-opus-5" },
  { provider: "anthropic", id: "claude-sonnet-5" },
  { provider: "anthropic", id: "claude-haiku-4-5" },
  { provider: "google", id: "gemini-3.1-pro-preview" },
  { provider: "google", id: "gemini-3.7-flash" },
];

/**
 * The models this machine can actually run (PRD-5 §9).
 *
 * Filtered by credential, not merely registered. `buildModels()` registers all three providers so
 * the provider is a configuration choice rather than a code change — which means the raw catalogue
 * is a wishlist, listing hundreds of models for providers with no key. Offering those in a picker
 * is worse than useless: choosing one produces a run that dies at `resolveModel` before it
 * investigates anything, and the analyst has no way to know which entries are real.
 *
 * `getAuth` is the same resolution a live request performs and returns undefined when a provider is
 * unconfigured, so it is exactly the right predicate — and it is the one `resolveModel` already
 * uses below, which keeps "offered" and "runnable" from drifting apart.
 *
 * Probed once per provider rather than once per model: a provider's credential does not vary by
 * model, and the catalogues run to dozens of entries each.
 *
 * Then narrowed to `CURATED_MODELS`, intersected rather than substituted: a curated id that the
 * provider has since retired must not be offered either, or the picker starts lying in the other
 * direction. **The fallback matters** — a provider that is configured but contributes no curated
 * entry yields its whole catalogue rather than nothing, because "your key works and the picker is
 * empty" is the one outcome an operator cannot act on.
 */
export async function listAvailableModels(llamaServer?: LlamaServerConfig): Promise<ModelChoice[]> {
  const models = buildModels(llamaServer);
  const available: ModelChoice[] = [];

  for (const provider of models.getProviders().map((registered) => registered.id)) {
    const catalogue = models.getModels(provider);
    const probe = catalogue[0];
    if (probe === undefined) continue;
    // eslint-disable-next-line no-await-in-loop -- small provider set; each probe is independent
    const auth = await models.getAuth(probe).catch(() => undefined);
    if (!auth) continue;

    const ids = new Set(catalogue.map((model) => model.id));
    const curated = CURATED_MODELS.filter(
      (model) => model.provider === provider && ids.has(model.id),
    );
    available.push(
      ...(curated.length > 0
        ? curated
        : catalogue
            .map((model) => ({ provider, id: model.id }))
            .toSorted((a, b) => a.id.localeCompare(b.id))),
    );
  }

  return available;
}
