import type { RunArtifact } from "../data/runs.ts";
import type { ConsoleEnv } from "../env.ts";
import { duration } from "./format.ts";

export interface ConfigRow {
  label: string;
  thisRun: string;
  currentEnv: string;
}

const ABSENT = "—";

/**
 * What a run used, beside what this machine is set up to do.
 *
 * The two columns are never merged. They drift, and the drift is usually the answer to "why did
 * this run behave differently" (PRD-3 §8.6). A run recorded before PRD-3 added `config` shows
 * dashes rather than borrowing the current environment's values, which would be a fabrication.
 */
export function toConfigRows(run: RunArtifact | undefined, env: ConsoleEnv): ConfigRow[] {
  const config = run?.config;
  const model = run?.model;

  return [
    {
      label: "provider / model",
      thisRun:
        model?.provider === undefined || model.id === undefined
          ? ABSENT
          : `${model.provider} / ${model.id}`,
      currentEnv: `${env.INVESTIGATOR_PROVIDER} / ${env.INVESTIGATOR_MODEL}`,
    },
    {
      label: "thinking level",
      thisRun: config?.thinkingLevel ?? ABSENT,
      currentEnv: env.INVESTIGATOR_THINKING_LEVEL,
    },
    {
      label: "max turns",
      thisRun: run?.limits?.maxTurns === undefined ? ABSENT : String(run.limits.maxTurns),
      currentEnv: String(env.INVESTIGATOR_MAX_TURNS),
    },
    {
      label: "timeout",
      thisRun: duration(run?.limits?.timeoutMs),
      currentEnv: duration(env.INVESTIGATOR_TIMEOUT_MS),
    },
    {
      label: "result char budget",
      thisRun:
        config?.resultMaxChars === undefined ? ABSENT : config.resultMaxChars.toLocaleString("en"),
      currentEnv: env.INVESTIGATOR_RESULT_MAX_CHARS.toLocaleString("en"),
    },
    {
      label: "sentinel base url",
      thisRun: config?.sentinelBaseUrl ?? ABSENT,
      currentEnv: env.SENTINEL_BASE_URL,
    },
    {
      label: "brave web search",
      thisRun:
        config?.webSearchConfigured === undefined
          ? ABSENT
          : config.webSearchConfigured
            ? "configured"
            : "not configured",
      currentEnv: env.BRAVE_API_KEY === undefined ? "BRAVE_API_KEY unset" : "BRAVE_API_KEY set",
    },
    {
      label: "tracing",
      thisRun: run?.traceDir === undefined ? "off" : `on → ${run.traceDir}`,
      currentEnv: env.INVESTIGATOR_TRACE
        ? `on → ${env.INVESTIGATOR_TRACE_DIR}`
        : "INVESTIGATOR_TRACE=false",
    },
  ];
}

export const DATA_SOURCES: { label: string; detail: string }[] = [
  {
    label: "Mock Sentinel REST",
    detail: "/alerts  /alerts/:id  /schema  /query",
  },
  {
    label: "Public web",
    detail: "Brave Search API, https-only fetch",
  },
];
