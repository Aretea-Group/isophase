import type { Api, Model } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

export interface ResolvedModel {
  model: Model<Api>;
  /** Bound and ready to hand to `Agent`'s `streamFn`. */
  streamFn: ReturnType<typeof buildModels>["streamSimple"];
}

function buildModels() {
  const models = createModels();
  // Registered together so the provider is a configuration choice, not a code change. API keys are
  // resolved by pi-ai from the ambient environment; a provider with no key simply fails at call time.
  models.setProvider(openaiProvider());
  models.setProvider(anthropicProvider());
  models.setProvider(googleProvider());
  return models;
}

/**
 * Resolve the configured provider/model pair.
 *
 * Fails with the available ids rather than a bare undefined, because a typo'd model name is the
 * single most likely startup mistake and `getModel` returns `undefined` for both an unknown model
 * and an unknown provider.
 */
export function resolveModel(provider: string, id: string): ResolvedModel {
  const models = buildModels();
  const model = models.getModel(provider, id);

  if (!model) {
    const available = models.getModels(provider).map((m) => m.id);
    const detail =
      available.length === 0
        ? `Provider "${provider}" is not registered. Known providers: openai, anthropic, google.`
        : `Available ${provider} models: ${available.join(", ")}`;
    throw new Error(`Unknown model "${provider}/${id}". ${detail}`);
  }

  return { model, streamFn: models.streamSimple.bind(models) };
}
