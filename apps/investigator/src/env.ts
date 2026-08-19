import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * The investigator's configuration contract.
 *
 * Validated at module import, which is the point: a missing OPENAI_API_KEY should stop the process
 * before the first alert is fetched, not forty investigations into a sweep. Mock Sentinel uses a
 * hand-rolled `loadConfig()` for the same job; the difference is recorded in ADR 005.
 *
 * Model and every runtime limit are read from here so a run can be re-pointed without a code
 * change: `INVESTIGATOR_MODEL=gpt-5.6-sol bun run investigate`.
 */
export const env = createEnv({
  server: {
    /** Mock Sentinel REST facade. The investigator never talks to Kusto directly (PRD-1 §7). */
    SENTINEL_BASE_URL: z.url().default("http://localhost:8787"),
    SENTINEL_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

    INVESTIGATOR_PROVIDER: z.string().min(1).default("openai"),
    INVESTIGATOR_MODEL: z.string().min(1).default("gpt-5.6-luna"),
    INVESTIGATOR_THINKING_LEVEL: z
      .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
      .default("medium"),

    /** Ceiling on completed agent turns. Guards against runaway reasoning (PRD-2 §17). */
    INVESTIGATOR_MAX_TURNS: z.coerce.number().int().positive().default(50),
    /** Ceiling on elapsed time for one investigation. A different failure mode to max turns. */
    INVESTIGATOR_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),

    // Provider API keys are deliberately absent here. pi-ai reads them straight from the ambient
    // environment, so declaring them would imply this object supplies them. The provider-aware
    // check lives in model.ts, which can ask pi-ai which variable it would actually look for.

    BRAVE_API_KEY: z.string().min(1).optional(),
    BRAVE_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
    BRAVE_RESULT_COUNT: z.coerce.number().int().positive().max(20).default(10),
    WEB_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),

    RUNS_DIR: z.string().min(1).default("runs"),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

export type Env = typeof env;
