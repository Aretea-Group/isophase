import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * The console's configuration contract.
 *
 * Every key has a default and none is required, which is the whole point. The investigator's
 * `env.ts` validates and throws at import so a missing provider key stops a sweep before it starts
 * (ADR 005 §6); reusing it here would make the console refuse to open a two-week-old run because a
 * key for a model it is never going to call is absent (ADR 006 §3, PRD-3 §6.3).
 *
 * The investigator settings below supply console-started runs. The configuration view selects only
 * non-secret fields to show beside what a given run actually did (PRD-3 §8.6).
 */
export const env = createEnv({
  server: {
    /** Where run artifacts live. Resolved against the working directory, as the investigator does. */
    RUNS_DIR: z.string().min(1).default("runs"),
    INVESTIGATOR_TRACE_DIR: z.string().min(1).default("runs/traces"),
    /** Generated ids-only alert-to-scenario map (PRD-5 §7). Absent means "no markers", not an error. */
    BENCHMARK_MAP_PATH: z.string().min(1).default("fixtures/benchmark-map.generated.json"),
    /** Analyst classifications. A root outside `runs/`, which is documented as safe to delete. */
    FEEDBACK_DIR: z.string().min(1).default("feedback"),
    /** Ceiling on concurrent in-process runs — the only cost ceiling in the repo (PRD-5 §8). */
    CONSOLE_MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().default(2),

    // Used by console-started investigations; the configuration view exposes only safe fields.
    SENTINEL_BASE_URL: z.string().min(1).default("http://localhost:8787"),
    INVESTIGATOR_PROVIDER: z.string().min(1).default("openai"),
    INVESTIGATOR_MODEL: z.string().min(1).default("gpt-5.6-luna"),
    INVESTIGATOR_THINKING_LEVEL: z.string().min(1).default("medium"),
    INVESTIGATOR_MAX_TURNS: z.coerce.number().int().positive().default(50),
    INVESTIGATOR_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
    INVESTIGATOR_RESULT_MAX_CHARS: z.coerce.number().int().positive().default(40_000),
    LLAMA_SERVER_BASE_URL: z.string().min(1).optional(),
    LLAMA_SERVER_MODEL: z.string().min(1).optional(),
    LLAMA_SERVER_CONTEXT_WINDOW: z.coerce.number().int().positive().optional(),
    LLAMA_SERVER_MAX_TOKENS: z.coerce.number().int().positive().optional(),
    LLAMA_SERVER_BEARER_TOKEN: z.string().min(1).optional(),
    BRAVE_API_KEY: z.string().min(1).optional(),
    INVESTIGATOR_TRACE: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

export type ConsoleEnv = typeof env;
