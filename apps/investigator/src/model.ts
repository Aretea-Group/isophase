import type { Api, Model } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

export interface ModelChoice {
  provider: string;
  id: string;
}

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
export async function resolveModel(provider: string, id: string): Promise<ResolvedModel> {
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

const PROVIDERS = ["openai", "anthropic", "google"] as const;

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
 */
export async function listAvailableModels(): Promise<ModelChoice[]> {
  const models = buildModels();
  const available: ModelChoice[] = [];

  for (const provider of PROVIDERS) {
    const catalogue = models.getModels(provider);
    const probe = catalogue[0];
    if (probe === undefined) continue;
    // eslint-disable-next-line no-await-in-loop -- three providers, and each probe is independent
    const auth = await models.getAuth(probe).catch(() => undefined);
    if (!auth) continue;
    available.push(...catalogue.map((model) => ({ provider, id: model.id })));
  }

  return available.toSorted(
    (a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
  );
}
