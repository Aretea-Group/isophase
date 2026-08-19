import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { SentinelApiClient } from "@soc/sentinel-client";

const Params = Type.Object(
  {
    kql: Type.String({
      minLength: 1,
      description: "Read-only KQL. Control commands (anything starting with '.') are rejected.",
    }),
  },
  { additionalProperties: false },
);

/**
 * Arbitrary read-only KQL against the security telemetry (PRD-2 §11).
 *
 * The result is handed back verbatim: no summarisation, no evidence extraction, no semantic
 * normalisation. Understanding the rows is the model's job, and anything this layer decided to
 * emphasise would be an investigation playbook smuggled in through formatting.
 *
 * Failures are thrown rather than returned as content, which is how pi-agent-core wants tool errors
 * reported. `SentinelApiError.message` already carries the Kusto engine's own diagnostic, so it
 * propagates untouched — that string is what lets the model repair its own query.
 */
export function createQuerySecurityDataTool(sentinel: SentinelApiClient): AgentTool<typeof Params> {
  return {
    name: "query_security_data",
    label: "Query security data",
    description:
      "Run a read-only KQL query against the security telemetry and return the raw result. Results are capped at 500 rows and report whether they were truncated, so prefer summarize/count over dumping rows when looking at volume.",
    parameters: Params,
    execute: async (_toolCallId, params) => {
      const result = await sentinel.query(params.kql);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { kql: params.kql, truncation: result.truncation },
      };
    },
  };
}
