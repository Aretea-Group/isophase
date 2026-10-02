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
/**
 * The schema, reachable as a function (PRD-11 §4.1 D6).
 *
 * `isophase init` validates the `.env` it has just written, and it runs before any `.env` exists —
 * so it cannot import `env` below, which would validate the process environment instead and throw.
 * The singleton calls this with `process.env`; the behaviour at import is unchanged, and both reject
 * the same input with the same error because they are the same call.
 */
export function parseInvestigatorEnv(source: Record<string, string | undefined>) {
  return createEnv({
    server: {
      SENTINEL_CONNECTOR: z.enum(["mock", "azure"]).default("mock"),
      /** Mock Sentinel REST facade. Ignored by the Azure branch. */
      SENTINEL_BASE_URL: z.url().default("http://localhost:8787"),
      SENTINEL_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
      AZURE_TENANT_ID: z.string().min(1).optional(),
      AZURE_CLIENT_ID: z.string().min(1).optional(),
      AZURE_CLIENT_SECRET: z.string().min(1).optional(),
      AZURE_LOG_ANALYTICS_WORKSPACE_ID: z.string().min(1).optional(),

      /**
       * Which security sources this run selects, in order (PRD-8 §4.1 D6).
       *
       * Defaults to `sentinel` so a zero-credential checkout keeps working against Mock Sentinel.
       * Standalone Defender is `SECURITY_SOURCES=defender` — an explicit opt-in rather than an
       * accident of configuration, and a first-class deployment rather than a degraded one (D13).
       * Phase 1 accepts exactly one id; the list shape is what Phase 2 grows into.
       */
      SECURITY_SOURCES: z.string().min(1).default("sentinel"),
      PRIMARY_ALERT_SOURCE: z.string().min(1).optional(),

      // All three required together, with no developer fallback (D2). Deliberately a divergence from
      // ADR 009 §3's Azure CLI / Azure PowerShell chain: developer sign-in is not a verified path to
      // ThreatHunting.Read.All. See docs/defender-setup.md.
      DEFENDER_TENANT_ID: z.string().min(1).optional(),
      DEFENDER_CLIENT_ID: z.string().min(1).optional(),
      DEFENDER_CLIENT_SECRET: z.string().min(1).optional(),
      /** Optional. Targets one Log Analytics workspace onboarded into the Defender portal. */
      DEFENDER_WORKSPACE_ID: z.string().min(1).optional(),
      DEFENDER_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
      /**
       * Row cap pushed into the query text, with `take` and `truncation` derived from it (D15).
       *
       * A fetch-cost bound, not an evidence bound: `INVESTIGATOR_RESULT_MAX_CHARS` below is what
       * limits what reaches the model, it is a property of the model rather than of any source, and
       * it stays source-neutral. Probe measurement behind the 500: the widest table sampled
       * (`CloudAppEvents`) serialises at ~5,000 characters per whole row, so the character budget
       * binds first for any realistic projection — which is the band D15 asks the cap to sit in.
       */
      DEFENDER_QUERY_MAX_ROWS: z.coerce.number().int().positive().default(500),
      /** ISO 8601 duration bounding `listAlerts()`. `alerts_v2` has no `$orderby` (D14). */
      DEFENDER_ALERT_WINDOW: z.string().min(1).default("P7D"),

      INVESTIGATOR_PROVIDER: z.string().min(1).default("openai"),
      INVESTIGATOR_MODEL: z.string().min(1).default("gpt-5.6-luna"),
      INVESTIGATOR_THINKING_LEVEL: z
        .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
        .default("medium"),

      LLAMA_SERVER_BASE_URL: z.string().min(1).optional(),
      LLAMA_SERVER_MODEL: z.string().min(1).optional(),
      LLAMA_SERVER_CONTEXT_WINDOW: z.coerce.number().int().positive().optional(),
      LLAMA_SERVER_MAX_TOKENS: z.coerce.number().int().positive().optional(),
      LLAMA_SERVER_REASONING_PROFILE: z.enum(["off", "binary", "effort"]).default("off"),
      LLAMA_SERVER_BEARER_TOKEN: z.string().min(1).optional(),

      /** Ceiling on completed agent turns. Guards against runaway reasoning (PRD-2 §17). */
      INVESTIGATOR_MAX_TURNS: z.coerce.number().int().positive().default(50),
      /** Ceiling on elapsed time for one investigation. A different failure mode to max turns. */
      INVESTIGATOR_TIMEOUT_MS: z.coerce.number().int().positive().default(1_200_000),
      /**
       * Character budget for a single query result (ADR 002, "result-size limits"). Measured against
       * this environment, one unbounded wide-table query serialises to ~88k tokens compact, which
       * exceeds a typical per-minute token budget on its own.
       */
      INVESTIGATOR_RESULT_MAX_CHARS: z.coerce.number().int().positive().default(40_000),

      // Hosted-provider API keys are deliberately absent here. pi-ai reads them straight from the
      // ambient environment, so declaring them would imply this object supplies them. The custom
      // llama-server credential is declared above because model.ts supplies it to that provider.

      BRAVE_API_KEY: z.string().min(1).optional(),
      BRAVE_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
      BRAVE_RESULT_COUNT: z.coerce.number().int().positive().max(20).default(10),
      WEB_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),

      RUNS_DIR: z.string().min(1).default("runs"),

      // --- The unattended loop (PRD-10 Phase 3). Read only by `--watch`. ---
      /** How often the loop polls the primary source for alerts created since the last window. */
      WATCH_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
      /**
       * The window `--watch` draws its queue from, overriding the one-shot default (PRD-10 §4.1 D10).
       *
       * `P7D` suits a backfill; a polling loop wants a window sized to its interval, because the 500
       * cap against a week of a busy tenant returns an arbitrary 500 and coverage becomes random.
       */
      WATCH_ALERT_WINDOW: z.string().min(1).default("PT6H"),
      /** How many poll intervals the window must cover. Startup refuses below this (AC18). */
      WATCH_WINDOW_INTERVAL_RATIO: z.coerce.number().positive().default(3),
      /** Stop when this much has been spent. Unset means no ceiling, which is a choice to make. */
      WATCH_SPEND_CEILING_USD: z.coerce.number().positive().optional(),
      /** Park an alert after this many failed investigations, for the process lifetime (AC10). */
      WATCH_MAX_FAILURES_PER_ALERT: z.coerce.number().int().positive().default(2),
      /**
       * Vendor status strings to skip, comma-separated (PRD-10 §4.1 D11).
       *
       * Empty by default and deliberately so: a wrong default silently skips alerts, which is worse
       * than a visible cost. The loop prints the status values it saw in its first cycle so this can
       * be set from the tenant's own vocabulary rather than guessed.
       */
      WATCH_SKIP_STATUSES: z.string().default(""),
      /**
       * Where the watch process listens for a console (PRD-10 §4.1 D4).
       *
       * Under `runs/` because that directory is already the one both programs agree on, and because a
       * socket beside the artifacts it describes is easier to find than one in a temp directory whose
       * name nobody wrote down. Unix domain only — see PRD-10 §3.
       */
      WATCH_CONTROL_SOCKET: z.string().min(1).default("runs/control.sock"),
      /**
       * Ceiling on a single backoff wait after a failed poll (ADR 013 §11).
       *
       * 15 minutes by default, matching the cycle Graph documents for the hunting CPU allowance —
       * waiting less than that on a throttled tenant spends a request that cannot succeed.
       *
       * Raising it past `WATCH_ALERT_WINDOW ÷ WATCH_WINDOW_INTERVAL_RATIO` makes startup refuse:
       * backing off widens the effective gap between polls, and a gap wider than the window loses
       * alerts silently.
       */
      WATCH_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(900_000),
      /**
       * Write findings back to the source's case (PRD-10 §4.1 D5, ADR 013 §6, §7).
       *
       * **Off by default, deliberately.** Selecting Defender as a source must not start commenting on
       * someone's live incidents as a side effect; `docs/defender-setup.md` presents the read-only
       * permission pair as a complete configuration and this keeps that true. With it on, a source
       * that cannot publish falls back to recording publication locally rather than failing.
       */
      PUBLISH_FINDINGS: z
        .enum(["true", "false"])
        .default("false")
        .transform((value) => value === "true"),

      /**
       * Capture the full Pi transcript per investigation. Off by default — the run artifact is the
       * durable output (PRD-2 §19). Worth turning on while the system is new: the first live runs
       * died on provider token limits with no record of which queries filled the context.
       */
      INVESTIGATOR_TRACE: z
        .enum(["true", "false"])
        .default("false")
        .transform((value) => value === "true"),
      INVESTIGATOR_TRACE_DIR: z.string().min(1).default("runs/traces"),
      /**
       * Persist streaming deltas too. Off by default — they were 96% of the first traces we wrote
       * and add nothing that `message_end` does not already carry.
       */
      INVESTIGATOR_TRACE_STREAM: z
        .enum(["true", "false"])
        .default("false")
        .transform((value) => value === "true"),
    },
    runtimeEnv: source,
    emptyStringAsUndefined: true,
  });
}

export const env = parseInvestigatorEnv(process.env);

export type Env = typeof env;
