import {
  AlertListResponse,
  ApiError,
  QueryResponse,
  SchemaResponse,
  SecurityAlertResource,
} from "@soc/contracts";

import { SentinelApiError } from "./errors.ts";

export interface SentinelApiClientOptions {
  /** Base URL of the Mock Sentinel REST facade, e.g. `http://localhost:8787`. */
  baseUrl: string;
  /** Per-request timeout. Applies to each call, not to a whole investigation. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Typed client for the Mock Sentinel REST boundary (PRD-1 §7).
 *
 * This is an API client, not a generalised connector abstraction (PRD-2 §5.2), and it holds no
 * agent-runtime types — the Pi tool adapters sit above it (PRD-2 §3.4). Every response is parsed
 * through the shared `@soc/contracts` schema so a drift in the service fails here rather than
 * silently downstream.
 */
export class SentinelApiClient {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(options: SentinelApiClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async listAlerts(top?: number): Promise<SecurityAlertResource[]> {
    const path = top === undefined ? "/alerts" : `/alerts?$top=${encodeURIComponent(top)}`;
    return AlertListResponse.parse(await this.#request("GET", path)).value;
  }

  async getAlert(id: string): Promise<SecurityAlertResource> {
    const path = `/alerts/${encodeURIComponent(id)}`;
    return SecurityAlertResource.parse(await this.#request("GET", path));
  }

  async getSchema(): Promise<SchemaResponse> {
    return SchemaResponse.parse(await this.#request("GET", "/schema"));
  }

  async query(kql: string, timespan?: string): Promise<QueryResponse> {
    const body = timespan === undefined ? { query: kql } : { query: kql, timespan };
    return QueryResponse.parse(await this.#request("POST", "/query", body));
  }

  async #request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const url = `${this.#baseUrl}${path}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";

    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.#timeoutMs) };
    if (body !== undefined) init.body = JSON.stringify(body);

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      // Connection refused, DNS failure, or the per-request timeout firing.
      const reason = error instanceof Error ? error.message : String(error);
      throw new SentinelApiError("unreachable", 0, `${method} ${url} failed: ${reason}`);
    }

    const text = await response.text();
    let payload: unknown;
    try {
      payload = text === "" ? undefined : JSON.parse(text);
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      const parsed = ApiError.safeParse(payload);
      if (parsed.success) {
        // Pass the service's message through untouched — for query failures it is the Kusto
        // diagnostic, which is the thing that lets a caller repair its own KQL.
        throw new SentinelApiError(
          parsed.data.error.code,
          response.status,
          parsed.data.error.message,
        );
      }
      const detail = text === "" ? response.statusText : text.slice(0, 500);
      throw new SentinelApiError(
        "unreachable",
        response.status,
        `${method} ${url} returned ${response.status}: ${detail}`,
      );
    }

    return payload;
  }
}
