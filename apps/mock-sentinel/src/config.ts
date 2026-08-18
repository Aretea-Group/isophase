import { z } from "zod";

const port = z.coerce.number().int().min(1).max(65_535);

/**
 * Environment contract for the Mock Sentinel service.
 *
 * Everything the service needs is declared here and validated once at startup
 * (ADR 003: Zod owns runtime/config boundaries). Nothing else in the service
 * may read `process.env` directly.
 */
export const ConfigSchema = z.object({
  /** Port the REST facade listens on. */
  PORT: port.default(8787),
  HOST: z.string().min(1).default("0.0.0.0"),

  /** Reported by `GET /health`; injected by the container build. */
  SERVICE_VERSION: z.string().min(1).default("0.0.0-dev"),

  /**
   * Kusto Emulator query endpoint. Internal dependency — never exposed to
   * consumers of the REST facade (PRD-1 §7).
   */
  KUSTO_ENDPOINT: z.url().default("http://localhost:8080"),
  KUSTO_DATABASE: z.string().min(1).default("SentinelLab"),
  KUSTO_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  /** Upper bound on rows returned by `POST /query` before truncation is flagged. */
  QUERY_MAX_ROWS: z.coerce.number().int().positive().default(500),

  /**
   * Instant the newest telemetry event is shifted onto, as ISO 8601.
   *
   * The Training Lab records events from 2019, 2021 and 2026, so relative-time
   * KQL (`ago(1h)`) — which every Microsoft detection rule and most natural
   * analyst queries use — would match nothing against the raw data. The loader
   * therefore moves the whole dataset forward by one constant offset.
   *
   * One offset for everything, not one per era: shifting eras independently
   * would collapse the five-year gap between the 2021 Windows logs and the 2026
   * cloud attack chain, manufacturing correlations that do not exist. A single
   * delta preserves every interval in the data exactly (ADR 001).
   *
   * Defaults to the bootstrap's start time. Pin it to make a run byte-for-byte
   * reproducible — tests do.
   */
  TELEMETRY_TIME_ANCHOR: z.iso.datetime().optional(),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Parses and validates configuration, failing fast with a readable report.
 * Called once from the process entrypoint; tests build a `Config` directly.
 */
export function loadConfig(env: Record<string, string | undefined> = Bun.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid Mock Sentinel configuration:\n${issues}`);
  }
  return result.data;
}
