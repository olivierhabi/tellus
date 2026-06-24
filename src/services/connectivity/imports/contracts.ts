// ---------------------------------------------------------------------------
// B5 — TableImport contracts (spec §B5 line 251).
//
// Zod schemas for:
//   - JdbcImportConfig (the user-facing config of a TableImport)
//   - TableImport (the entity stored in DB)
// ---------------------------------------------------------------------------

import { z } from "zod";
import {
  ConnectionRid,
  TableImportRid,
  DatasetRid,
} from "../contracts";

const SAFE_IDENT = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const JdbcImportConfig = z.object({
  schema: SAFE_IDENT,
  table: SAFE_IDENT,
  /** Optional override SELECT (parsed via libpg-query-node for safety). */
  customQuery: z.string().max(16_000).optional(),
  /** Snapshot or incremental append. */
  mode: z.enum(["snapshot", "append"]),
  /** Column to use as monotonic watermark (append mode only). */
  incrementalColumn: SAFE_IDENT.optional(),
  /** Allow source schema changes to flow through to Iceberg. */
  allowSchemaChanges: z.boolean().default(false),
  /** Iceberg target table (default = same as source table). */
  targetTable: SAFE_IDENT.optional(),
  /** Catalog adapter to use; default `local-fs`. */
  catalogAdapter: z
    .enum(["local-fs", "rest", "glue", "snowflake"])
    .default("local-fs"),
  /** Warehouse path (local-fs adapter). */
  warehouseRoot: z.string().optional(),
  /** Compression for Parquet writes. */
  parquetCompression: z.enum(["zstd", "snappy", "none"]).default("zstd"),
});

/**
 * Run cadence for a table import. `manual` (the default) means the import only
 * runs on explicit "Run"; an enabled schedule re-runs it every
 * `intervalMinutes`. `nextRunAt`/`lastRunAt` are server-computed and read-only.
 *
 * Interval (not raw cron) is intentional: it is dependency-free, deterministic,
 * and multi-replica safe. Common cadences map to minutes — hourly=60,
 * daily=1440, weekly=10080.
 */
export const TableImportSchedule = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(5).max(525_600).nullable(),
  /** Cron expression (Foundry-parity); driven by a Temporal Schedule. */
  cron: z.string().max(200).nullable().default(null),
  /** IANA timezone for cron evaluation (default UTC). */
  timezone: z.string().max(64).nullable().default(null),
  nextRunAt: z.string().datetime().nullable(),
  lastRunAt: z.string().datetime().nullable(),
});
export type TableImportScheduleT = z.infer<typeof TableImportSchedule>;

/**
 * Write shape for the schedule on the update endpoint (server computes the
 * rest). An enabled schedule is EITHER cron-based OR interval-based — exactly
 * one. Cron schedules run on the durable Temporal scheduler; interval schedules
 * additionally work under the DB-poll fallback when Temporal is unreachable.
 */
export const TableImportScheduleInput = z
  .object({
    enabled: z.boolean(),
    intervalMinutes: z.number().int().min(5).max(525_600).nullable().optional(),
    cron: z.string().max(200).nullable().optional(),
    timezone: z.string().max(64).nullable().optional(),
  })
  .refine(
    (s) =>
      !s.enabled ||
      (s.cron != null && s.cron.trim() !== "") !== (s.intervalMinutes != null),
    {
      message:
        "an enabled schedule requires exactly one of cron or intervalMinutes",
      path: ["cron"],
    },
  );
export type TableImportScheduleInputT = z.infer<typeof TableImportScheduleInput>;

export const TableImport = z.object({
  rid: TableImportRid,
  connectionRid: ConnectionRid,
  datasetRid: DatasetRid,
  displayName: z.string(),
  config: JdbcImportConfig,
  version: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  createdBy: z.string().uuid(),
  schedule: TableImportSchedule.default({
    enabled: false,
    intervalMinutes: null,
    cron: null,
    timezone: null,
    nextRunAt: null,
    lastRunAt: null,
  }),
  status: z
    .object({
      state: z.enum([
        "draft",
        "ready",
        "running",
        "succeeded",
        "failed",
        "cancelled",
      ]),
      lastBuildRid: z.string().optional(),
      lastWatermark: z.string().optional(),
      lastErrorReason: z.string().optional(),
    })
    .default({ state: "draft" }),
});

export type JdbcImportConfigT = z.infer<typeof JdbcImportConfig>;
export type TableImportT = z.infer<typeof TableImport>;

export const TableImportCreateRequest = z.object({
  connectionRid: ConnectionRid,
  datasetRid: DatasetRid,
  displayName: z.string().min(1).max(200),
  config: JdbcImportConfig,
});
export type TableImportCreateRequestT = z.infer<typeof TableImportCreateRequest>;

export const TableImportUpdateRequest = z.object({
  displayName: z.string().min(1).max(200).optional(),
  config: JdbcImportConfig.partial().optional(),
  schedule: TableImportScheduleInput.optional(),
});
export type TableImportUpdateRequestT = z.infer<typeof TableImportUpdateRequest>;
