import type { SchemaTable } from "@soc/contracts";
import type { SecurityDataSource } from "@soc/sentinel-client";

import type { SecuritySourceProfile } from "../source-profile.ts";

export interface SecurityToolSource {
  client: SecurityDataSource;
  profile: SecuritySourceProfile;
  tables: Map<string, SchemaTable>;
}

export interface SecurityToolSources {
  sources: ReadonlyMap<string, SecurityToolSource>;
  primaryId: string;
  onUse?: (sourceId: string, toolName: string) => void;
}

export function resolveToolSource(
  available: SecurityToolSources,
  requested: string | undefined,
  toolName: string,
): { id: string; source: SecurityToolSource } {
  const id = requested ?? available.primaryId;
  const source = available.sources.get(id);
  if (source === undefined) {
    throw new Error(
      `Unknown or inactive security source "${id}". Active sources: ${[...available.sources.keys()].join(", ")}.`,
    );
  }
  available.onUse?.(id, toolName);
  return { id, source };
}
