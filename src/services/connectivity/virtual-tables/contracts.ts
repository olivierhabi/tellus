// ---------------------------------------------------------------------------
// B8 — Virtual Tables contracts (spec §B8 line 400).
//
// A Virtual Table registers a remote PG table as a Tellus Iceberg-facing
// dataset without copying data. Reads federate via the SQL builder.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { ConnectionRid, VirtualTableRid, DatasetRid } from "../contracts";

const SAFE_IDENT = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const VirtualTable = z.object({
  rid: VirtualTableRid,
  connectionRid: ConnectionRid,
  datasetRid: DatasetRid,
  displayName: z.string().min(1).max(200),
  source: z.object({
    schema: SAFE_IDENT,
    table: SAFE_IDENT,
  }),
  /**
   * Discovered schema snapshot — refreshed by refreshSchema and on first read
   * if missing. Used by pushdown to plan column projection.
   */
  schema: z.array(
    z.object({
      columnName: z.string(),
      pgOid: z.number().int(),
      tellusType: z.object({
        name: z.string(),
        precision: z.number().int().optional(),
        scale: z.number().int().optional(),
      }),
    }),
  ),
  /** Lazy refresh flag — true if schema is empty/needs discovery. */
  schemaStale: z.boolean().default(false),
  version: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  createdBy: z.string().uuid(),
});
export type VirtualTableT = z.infer<typeof VirtualTable>;

export const VirtualTableCreateRequest = z.object({
  connectionRid: ConnectionRid,
  datasetRid: DatasetRid,
  displayName: z.string().min(1).max(200),
  source: z.object({
    schema: SAFE_IDENT,
    table: SAFE_IDENT,
  }),
});
export type VirtualTableCreateRequestT = z.infer<typeof VirtualTableCreateRequest>;
