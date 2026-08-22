import {
  AlertListResponse,
  ApiError,
  CorpusIdentity,
  QueryResponse,
  SchemaResponse,
  SecurityAlertResource,
} from "@soc/contracts";

import { SentinelApiError } from "./errors.ts";

/** The complete Sentinel capability consumed by investigator and console code. */
export interface SentinelClient {
  listAlerts(top?: number): Promise<SecurityAlertResource[]>;
  getAlert(id: string): Promise<SecurityAlertResource>;
  getSchema(): Promise<SchemaResponse>;
  query(kql: string, timespan?: string): Promise<QueryResponse>;
  getCorpus(): Promise<CorpusIdentity | undefined>;
}

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
export class SentinelApiClient implements SentinelClient {
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

  /**
   * Which corpus this environment holds, or `undefined` when it cannot say (PRD-6 §6.8).
   *
   * `undefined` rather than a throw on 404, deliberately: an older Mock Sentinel, or a database
   * built before the marker table existed, must not break `bun run investigate`. The artifact then
   * records no corpus and the report prints `corpus unknown` rather than a fabricated match.
   *
   * Every other failure still throws. A Sentinel that is unreachable is not a Sentinel without a
   * corpus, and collapsing the two would hide an outage behind a missing field.
   */
  async getCorpus(): Promise<CorpusIdentity | undefined> {
    try {
      return CorpusIdentity.parse(await this.#request("GET", "/corpus"));
    } catch (error) {
      if (error instanceof SentinelApiError && error.status === 404) return undefined;
      throw error;
    }
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
