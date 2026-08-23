import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";
import type { SchemaTable } from "@soc/contracts";

import type { WebSearchClient } from "../clients/brave.ts";
import type { WebFetchClient } from "../clients/fetch.ts";
import type { InvestigationSummary } from "../contracts/summary.ts";
import type { SecuritySourceBundle, SecuritySourceProfile } from "../source-profile.ts";
import { createGetSecuritySchemaTool, GET_SECURITY_SCHEMA } from "./get-security-schema.ts";
import {
  createQuerySecurityDataTool,
  QUERY_SECURITY_DATA,
  querySecurityDataParameters,
} from "./query-security-data.ts";
import { createSubmitInvestigationTool, SUBMIT_INVESTIGATION } from "./submit-investigation.ts";
import { createWebFetchTool, WEB_FETCH } from "./web-fetch.ts";
import { createWebSearchTool, WEB_SEARCH } from "./web-search.ts";

export interface InvestigationToolDeps {
  /** The complete schema, loaded once at investigation startup. */
  tables: Map<string, SchemaTable>;
  source: SecuritySourceBundle;
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
/**
 * The five tool bases, in the order the factory builds them.
 *
 * One source, read by `createInvestigationTools`, by the console's name-only view and by the prompt
 * hash — so a sixth tool cannot reach the agent without also reaching the overlay that describes it
 * and the hash that identifies it.
 *
 * Query-facing descriptions come from the selected profile; stable names and the other three
 * descriptors remain beside their implementations. This list keeps capability order shared without
 * constructing closures over live clients.
 */
const TOOLS = [
  GET_SECURITY_SCHEMA,
  QUERY_SECURITY_DATA,
  WEB_SEARCH,
  WEB_FETCH,
  SUBMIT_INVESTIGATION,
] as const;

/**
 * The agent's whole capability surface, by name, in factory order.
 *
 * Rendered by the console before an investigation spends money (PRD-5 §8), which is why the order is
 * the factory's and not alphabetical: it is a description of the agent, read by a person.
 */
export const INVESTIGATION_TOOL_NAMES = TOOLS.map((tool) => tool.name);

export function createInvestigationTools(deps: InvestigationToolDeps): AgentTool[] {
  // Same order as `TOOLS`; `tool-surface.test.ts` asserts it stays that way.
  return [
    createGetSecuritySchemaTool(deps.tables, deps.source.profile.schemaToolDescription),
    createQuerySecurityDataTool(
      deps.source.client,
      deps.source.profile.queryToolDescription,
      deps.source.profile.queryParameterDescription,
      deps.resultMaxChars,
    ),
    createWebSearchTool(deps.webSearch),
    createWebFetchTool(deps.webFetch),
    createSubmitInvestigationTool(deps.onSubmit),
  ] as AgentTool[];
}

export interface ToolDescriptor {
  name: string;
  description: string;
  parameters: TSchema;
}

/**
 * The tool surface as the model sees it, without building one (PRD-6 §6.6).
 *
 * `createInvestigationTools` needs live clients and a loaded schema, so hashing the tools through
 * it would mean fabricating stubs. This assembles the same active profile descriptions and stable
 * metadata without building executable tools.
 *
 * Name order, so the hash does not move when the array above is reordered. This is the *whole*
 * surface: a tool added to `createInvestigationTools` and not to this list would change the agent's
 * capabilities without changing its prompt hash, which is why both read the same five constants.
 */
export function toolDescriptors(profile: SecuritySourceProfile): ToolDescriptor[] {
  return [
    {
      name: GET_SECURITY_SCHEMA.name,
      description: profile.schemaToolDescription,
      parameters: GET_SECURITY_SCHEMA.parameters,
    },
    {
      name: QUERY_SECURITY_DATA.name,
      description: profile.queryToolDescription,
      parameters: querySecurityDataParameters(profile.queryParameterDescription),
    },
    ...[WEB_SEARCH, WEB_FETCH, SUBMIT_INVESTIGATION].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as TSchema,
    })),
  ].toSorted((a, b) => a.name.localeCompare(b.name));
}
