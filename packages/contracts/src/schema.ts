import { z } from "zod";

/**
 * Contract for `GET /schema` — what can actually be queried right now.
 *
 * ADR 001 requires this be derived from the engine (`.show database <db>
 * schema`) rather than a hand-maintained list, so it cannot drift from
 * reality. It is also the startup context the future agent reasons over, which
 * is why the response stays deliberately small: table name, column name, column
 * type, nothing else.
 *
 * For scale: the loaded environment reports 22 tables and 1,133 columns, about
 * 60 KB of JSON.
 */

export const SchemaColumn = z.object({
  name: z.string().min(1),
  /** Kusto scalar type, normalised from the CLR name the engine reports. */
  type: z.string().min(1),
});
export type SchemaColumn = z.infer<typeof SchemaColumn>;

export const SchemaTable = z.object({
  name: z.string().min(1),
  columns: z.array(SchemaColumn),
});
export type SchemaTable = z.infer<typeof SchemaTable>;

export const SchemaResponse = z.object({
  /** The Kusto database backing the mock. Internal detail, useful in errors. */
  database: z.string().min(1),
  tables: z.array(SchemaTable),
});
export type SchemaResponse = z.infer<typeof SchemaResponse>;
