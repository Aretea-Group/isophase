export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchClient {
  search(query: string, signal?: AbortSignal): Promise<WebSearchResult[]>;
}

export interface BraveSearchClientOptions {
  apiKey: string;
  timeoutMs?: number;
  /** Results per query. Provider-specific tuning stays here, not in the agent contract (PRD-2 §12). */
  count?: number;
}

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

/**
 * Brave Search behind the narrow `WebSearchClient` interface.
 *
 * Everything provider-specific — result count, freshness, country, ranking — is configuration here
 * rather than a parameter the model can reach. The agent-facing contract is a query string and
 * nothing else (PRD-2 §12).
 */
export class BraveSearchClient implements WebSearchClient {
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #count: number;

  constructor(options: BraveSearchClientOptions) {
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#count = options.count ?? 10;
  }

  async search(query: string, signal?: AbortSignal): Promise<WebSearchResult[]> {
    const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&count=${this.#count}`;
    const timeout = AbortSignal.timeout(this.#timeoutMs);

    const response = await fetch(url, {
      headers: { accept: "application/json", "x-subscription-token": this.#apiKey },
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });

    if (!response.ok) {
      const body = (await response.text()).slice(0, 300);
      throw new Error(`Brave search failed with ${response.status}: ${body}`);
    }

    const payload = (await response.json()) as {
      web?: { results?: { title?: string; url?: string; description?: string }[] };
    };

    return (payload.web?.results ?? [])
      .filter(
        (r): r is { title: string; url: string; description?: string } =>
          typeof r.url === "string" && typeof r.title === "string",
      )
      .map((r) => ({ title: r.title, url: r.url, snippet: r.description ?? "" }));
  }
}
