/**
 * Minimal HTTP client for the Kusto Emulator.
 *
 * The emulator is an internal dependency of Mock Sentinel (PRD-1 §7): this
 * module is the only place that speaks to it. It is deliberately shaped for
 * reuse by the future `/query` and `/schema` routes, not just the bootstrap
 * loader — which is why query errors are preserved verbatim rather than
 * normalised away (PRD-1 §4.4).
 */

export interface KustoColumn {
  name: string;
  /** Kusto scalar type (`string`, `datetime`, …), falling back to the CLR name. */
  type: string;
}

export interface KustoResult {
  columns: KustoColumn[];
  rows: unknown[][];
}

/**
 * A failure reported by Kusto itself, as opposed to a transport failure.
 *
 * `details` holds the response body exactly as received. The emulator answers
 * with `text/plain` for query errors (`General_BadRequest: …`), not JSON, so
 * this is a string more often than an object — callers must not assume either.
 */
export class KustoError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(message: string, status: number, details: unknown) {
    super(message);
    this.name = "KustoError";
    this.status = status;
    this.details = details;
  }
}

/** The engine could not be reached at all — distinct from a rejected query. */
export class KustoUnavailableError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "KustoUnavailableError";
    this.cause = cause;
  }
}

interface RawTable {
  TableName?: string;
  Columns?: { ColumnName?: string; ColumnType?: string; DataType?: string }[];
  Rows?: unknown[][];
}

function toResult(table: RawTable): KustoResult {
  return {
    columns: (table.Columns ?? []).map((c) => ({
      name: c.ColumnName ?? "",
      type: c.ColumnType ?? c.DataType ?? "string",
    })),
    rows: table.Rows ?? [],
  };
}

export interface KustoClientOptions {
  endpoint: string;
  timeoutMs?: number;
}

export class KustoClient {
  readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(options: KustoClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Runs a control command (`.create`, `.ingest`, `.show`, …). */
  async mgmt(csl: string, database?: string): Promise<KustoResult> {
    return this.first(await this.send("/v1/rest/mgmt", csl, database));
  }

  /** Runs a read-only KQL query. */
  async query(database: string, csl: string): Promise<KustoResult> {
    return this.first(await this.send("/v1/rest/query", csl, database));
  }

  /** Every table in the response; management commands often return several. */
  async mgmtTables(csl: string, database?: string): Promise<KustoResult[]> {
    return this.send("/v1/rest/mgmt", csl, database);
  }

  /** Cheap liveness check for `GET /health`. Never throws. */
  async isReachable(): Promise<boolean> {
    try {
      await this.mgmt(".show version");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether `database` exists and answers queries. Never throws.
   *
   * `isReachable` is not a substitute: `.show version` is cluster-scoped, so it
   * answers `true` against an engine holding no databases at all — which is
   * exactly what a freshly recreated container is. Everything a consumer can do
   * needs the database, so `GET /health` probes both. Deliberately `print 1`
   * rather than a row count: the failure this catches is an absent database, and
   * counting rows on every poll would flap while a fresh ingest settles.
   */
  async hasDatabase(database: string): Promise<boolean> {
    try {
      await this.query(database, "print 1");
      return true;
    } catch {
      return false;
    }
  }

  private first(tables: KustoResult[]): KustoResult {
    return tables[0] ?? { columns: [], rows: [] };
  }

  private async send(path: string, csl: string, database?: string): Promise<KustoResult[]> {
    const body = JSON.stringify(database === undefined ? { csl } : { db: database, csl });

    let response: Response;
    try {
      response = await fetch(`${this.endpoint}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new KustoUnavailableError(
        `Kusto at ${this.endpoint} is unreachable: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }

    const text = await response.text();

    if (!response.ok) {
      // The emulator returns text/plain here far more often than JSON; try to
      // recover structure, but keep whatever arrived so the caller can surface it.
      let details: unknown = text;
      try {
        details = JSON.parse(text);
      } catch {
        /* plain text is the common case, not an exception */
      }
      throw new KustoError(
        describeError(details, text) || `Kusto returned HTTP ${response.status}`,
        response.status,
        details,
      );
    }

    let parsed: { Tables?: RawTable[] };
    try {
      parsed = JSON.parse(text) as { Tables?: RawTable[] };
    } catch {
      throw new KustoError("Kusto returned a non-JSON success response", response.status, text);
    }

    return (parsed.Tables ?? []).map(toResult);
  }
}

/**
 * Extracts a human-useful sentence from a Kusto failure.
 *
 * The emulator answers `text/plain` when asked plainly, but structured JSON
 * when the request sends `Accept: application/json` — which this client does.
 * Taking the first line blindly therefore yields `{`, so the JSON shape is
 * unwrapped first. `@message` carries the semantic detail an author actually
 * needs ("SEM0100: Failed to resolve table or column expression named 'Foo'"),
 * where `message` is only the generic "Request is invalid and cannot be
 * executed."
 */
function describeError(details: unknown, raw: string): string {
  if (details !== null && typeof details === "object") {
    const error = (details as { error?: Record<string, unknown> }).error;
    if (error !== undefined) {
      for (const key of ["@message", "message"]) {
        const value = error[key];
        if (typeof value === "string" && value.trim() !== "") return value.trim();
      }
    }
  }
  return raw.split("\n", 1)[0]?.trim() ?? "";
}
