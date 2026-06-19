// ---------------------------------------------------------------------------
// B7 — CDC contracts (spec §B7 line 348).
//
// Zod schemas for PostgresCdcConfig and the CDC-specific import variant.
// Defaults mirror Foundry/Debezium parity (line 361):
//   snapshot.mode=never, decimal.handling.mode=string,
//   time.precision.mode=connect, tombstones.on.delete=false,
//   publication.autocreate.mode=disabled, provide.transaction.metadata=true
// ---------------------------------------------------------------------------

import { z } from "zod";
import { ConnectionRid, DatasetRid } from "../contracts";

const SAFE_IDENT = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const PostgresCdcConfig = z.object({
  slotName: SAFE_IDENT,
  publicationName: SAFE_IDENT,
  /** Tables to capture (schema-qualified). Empty -> all tables in publication. */
  tables: z
    .array(
      z.object({
        schema: SAFE_IDENT,
        table: SAFE_IDENT,
      }),
    )
    .default([]),
  /** Behaviour on DDL detection. */
  allowSchemaChanges: z.boolean().default(false),
  /** Kafka topic name; default `tellus.cdc.<importShort>` resolved at runtime. */
  topic: z.string().optional(),
  /** Topic partitions; default 12. */
  partitions: z.number().int().min(1).max(96).default(12),
  /** Debezium parity defaults — match v1. */
  snapshotMode: z.enum(["never", "initial", "always"]).default("never"),
  decimalHandling: z.enum(["string", "double", "precise"]).default("string"),
  timePrecisionMode: z.enum(["adaptive", "connect"]).default("connect"),
  tombstonesOnDelete: z.boolean().default(false),
  publicationAutocreate: z
    .enum(["disabled", "filtered", "all_tables"])
    .default("disabled"),
  provideTransactionMetadata: z.boolean().default(true),
});

export type PostgresCdcConfigT = z.infer<typeof PostgresCdcConfig>;

export const CdcImportCreateRequest = z.object({
  connectionRid: ConnectionRid,
  datasetRid: DatasetRid,
  displayName: z.string().min(1).max(200),
  config: PostgresCdcConfig,
});

export type CdcImportCreateRequestT = z.infer<typeof CdcImportCreateRequest>;

/**
 * Preflight result shape. Each check is pass/fail + optional fix-SQL string
 * the operator can copy-paste to remediate.
 */
export const PreflightResult = z.object({
  ok: z.boolean(),
  checks: z.array(
    z.object({
      name: z.string(),
      ok: z.boolean(),
      observed: z.string().optional(),
      expected: z.string().optional(),
      fixSql: z.string().optional(),
    }),
  ),
});
export type PreflightResultT = z.infer<typeof PreflightResult>;
