import { azureWorkspaceUrl, defenderGraphUrl } from "@soc/sentinel-client";

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
 * What this machine is currently set up to query.
 *
 * Reads `SECURITY_SOURCES` rather than assuming Sentinel. The console must be able to sit beside a
 * Defender-standalone deployment and describe it truthfully — PRD-8 §4.1 D13 puts the console
 * explicitly among the things that may not assume a Sentinel profile exists.
 */
export function selectedSourceId(env: ConsoleEnv): string {
  const active = env.SECURITY_SOURCES.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return env.PRIMARY_ALERT_SOURCE ?? (active.length === 1 ? (active[0] ?? "sentinel") : "?");
}

function sourceKind(env: ConsoleEnv): string {
  return selectedSourceId(env) === "defender" ? "microsoft-defender-xdr" : "microsoft-sentinel";
}

function sentinelTarget(env: ConsoleEnv): string {
  if (selectedSourceId(env) === "defender") return defenderGraphUrl();
  if (env.SENTINEL_CONNECTOR === "mock") return env.SENTINEL_BASE_URL;
  return env.AZURE_LOG_ANALYTICS_WORKSPACE_ID === undefined
    ? "Azure workspace not configured"
    : azureWorkspaceUrl(env.AZURE_LOG_ANALYTICS_WORKSPACE_ID);
}

function sentinelConnector(env: ConsoleEnv): string {
  if (selectedSourceId(env) === "defender") return "microsoft-graph-security";
  return env.SENTINEL_CONNECTOR === "mock" ? "mock-sentinel-rest" : "azure-monitor-logs";
}

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
  const endpointRows: ConfigRow[] =
    config?.modelBaseUrl === undefined && env.LLAMA_SERVER_BASE_URL === undefined
      ? []
      : [
          {
            label: "model base url",
            thisRun: config?.modelBaseUrl ?? ABSENT,
            currentEnv: env.LLAMA_SERVER_BASE_URL ?? ABSENT,
          },
          {
            label: "model context window",
            thisRun:
              config?.modelContextWindow === undefined
                ? ABSENT
                : config.modelContextWindow.toLocaleString("en"),
            currentEnv:
              env.LLAMA_SERVER_CONTEXT_WINDOW === undefined
                ? ABSENT
                : env.LLAMA_SERVER_CONTEXT_WINDOW.toLocaleString("en"),
          },
          {
            label: "model max tokens",
            thisRun:
              config?.modelMaxTokens === undefined
                ? ABSENT
                : config.modelMaxTokens.toLocaleString("en"),
            currentEnv:
              env.LLAMA_SERVER_MAX_TOKENS === undefined
                ? ABSENT
                : env.LLAMA_SERVER_MAX_TOKENS.toLocaleString("en"),
          },
        ];

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
      label: "active sources",
      thisRun:
        config?.sources === undefined
          ? (config?.source?.kind ?? ABSENT)
          : config.sources.map((source) => source.id).join(", "),
      currentEnv: env.SECURITY_SOURCES.split(",")
        .map((id) => id.trim())
        .filter(Boolean)
        .join(", "),
    },
    {
      label: "source kind",
      thisRun: config?.source?.kind ?? ABSENT,
      currentEnv: sourceKind(env),
    },
    {
      label: "source connector",
      thisRun: config?.source?.connector ?? ABSENT,
      currentEnv: sentinelConnector(env),
    },
    {
      label: "source target",
      thisRun: config?.source?.target ?? ABSENT,
      currentEnv: sentinelTarget(env),
    },
    {
      label: "query language",
      thisRun: config?.source?.queryLanguage ?? ABSENT,
      currentEnv: "kql",
    },
    {
      label: "alert window",
      // Absent on every source that does not bound its queue by one, and absent stays absent:
      // borrowing the environment's window would claim the run drew from a queue it never saw.
      thisRun: config?.alertWindow ?? ABSENT,
      currentEnv: selectedSourceId(env) === "defender" ? env.DEFENDER_ALERT_WINDOW : ABSENT,
    },
    {
      label: "query row cap",
      thisRun:
        config?.queryMaxRows === undefined ? ABSENT : config.queryMaxRows.toLocaleString("en"),
      currentEnv:
        selectedSourceId(env) === "defender"
          ? env.DEFENDER_QUERY_MAX_ROWS.toLocaleString("en")
          : ABSENT,
    },
    ...endpointRows,
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
    label: "Security source",
    detail: "alerts, schema, read-only KQL",
  },
  {
    label: "Public web",
    detail: "Brave Search API, https-only fetch",
  },
];
