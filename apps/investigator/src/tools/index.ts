import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SchemaTable } from "@soc/contracts";
import type { SentinelApiClient } from "@soc/sentinel-client";

import type { WebSearchClient } from "../clients/brave.ts";
import type { WebFetchClient } from "../clients/fetch.ts";
import type { InvestigationSummary } from "../contracts/summary.ts";
import { createGetSecuritySchemaTool } from "./get-security-schema.ts";
import { createQuerySecurityDataTool } from "./query-security-data.ts";
import { createSubmitInvestigationTool } from "./submit-investigation.ts";
import { createWebFetchTool } from "./web-fetch.ts";
import { createWebSearchTool } from "./web-search.ts";

export interface InvestigationToolDeps {
  /** The complete schema, loaded once at investigation startup. */
  tables: Map<string, SchemaTable>;
  sentinel: SentinelApiClient;
  webSearch: WebSearchClient;
  webFetch: WebFetchClient;
  onSubmit: (summary: InvestigationSummary) => void;
  /** Character budget for a single query result. */
  resultMaxChars?: number;
}

/**
 * Build the tool set for one investigation.
 *
 * Everything is a closure over per-investigation state, which is what lets a single harness run
 * concurrent investigations later without leaking between them (PRD-2 §5.1).
 *
 * No tool sets `executionMode`, so all inherit Pi's "parallel" default and independent calls in one
 * turn run concurrently (PRD-2 §13). That is load-bearing: marking any single tool "sequential"
 * would serialise every batch it appears in.
 *
 * There are deliberately no alert-family-specific tools here. The agent owns the investigative path
 * (PRD-2 §9).
 */
export function createInvestigationTools(deps: InvestigationToolDeps): AgentTool[] {
  return [
    createGetSecuritySchemaTool(deps.tables),
    createQuerySecurityDataTool(deps.sentinel, deps.resultMaxChars),
    createWebSearchTool(deps.webSearch),
    createWebFetchTool(deps.webFetch),
    createSubmitInvestigationTool(deps.onSubmit),
  ] as AgentTool[];
}
