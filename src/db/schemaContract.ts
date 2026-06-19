// ---------------------------------------------------------------------------
// schemaContract.ts — startup-time guard against table column drift.
//
// Why this exists:
//   The trash service (and any other service that writes to a domain
//   table via raw SQL) embeds column names into INSERT statements as
//   string literals. When the schema evolves — a column is added,
//   renamed, or removed — the SQL silently drifts out of sync with the
//   live DB. The first sign of drift is a `42703 undefined_column`
//   error reaching a user request, which (a) maps to a generic 500 and
//   (b) gets discovered in production by a customer rather than CI.
//
//   This module turns "drift" into a boot-time, fail-closed event.
//   Every table this codebase writes to via raw SQL registers a
//   contract: the columns it expects to find. At server startup,
//   `verifySchemaContract(pool)` queries `information_schema.columns`,
//   diffs expected vs actual, and exits the process on any violation.
//
//   Result: a deploy that ships drifted SQL fails the readiness probe
//   *before* serving a single request. K8s/Apollo treats it as a
//   failed rollout and stops the deploy.
//
// Design properties:
//   * Fail-closed: any drift exits with code 1, mirroring how the
//     migration gate handles its own drift class.
//   * Contracts are explicit, not introspected from code — copy/paste
//     of an INSERT does not silently update the contract.
//   * "Required" columns must exist; "writable" columns are the union
//     used by raw INSERT/UPDATE statements (subset or equal to the
//     full table). Extra columns in the DB are allowed (additive
//     migrations don't break old code paths).
//   * One round-trip per table — efficient even with dozens of tables.
//   * Diagnostic detail in the failure log: every missing column is
//     enumerated so an operator sees the full picture, not just the
//     first violation.
// ---------------------------------------------------------------------------

import type { Pool } from "pg";

// ---------------------------------------------------------------------------
// Contract registry — single source of truth for "what columns must
// exist on this table for the raw SQL paths to work".
//
// To add a new table:
//   1. Add an entry below.
//   2. List EVERY column the codebase writes to that table by name in
//      raw SQL. Omit columns only the ORM touches (those are checked
//      by the ORM's own schema diff).
//
// To remove a column:
//   1. Remove the column from the SQL.
//   2. Remove it from this contract.
//   3. Ship the migration that drops it.
//   The order matters: removing from this contract before removing
//   from the SQL would let drifted code limp along; removing from the
//   SQL before removing from the contract would fail this guard until
//   the next deploy.
// ---------------------------------------------------------------------------
export interface TableContract {
  table: string;
  /**
   * Columns that the raw SQL paths reference by name. Every entry must
   * exist on the live table or boot fails.
   */
  required: readonly string[];
}

export const SCHEMA_CONTRACTS: readonly TableContract[] = [
  {
    table: "foundry_datasets",
    required: [
      "id",
      "name",
      "project_id",
      "folder_id",
      "file_path",
      "original_filename",
      "mime_type",
      "file_size_bytes",
      "row_count",
      "row_count_exact",
      "column_count",
      "schema_info",
      "markings",
      "status",
      "format",
      "content_hash",
      "last_output_schema_fingerprint",
      "created_at",
      "updated_at",
      "created_by",
      "updated_by",
    ],
  },
  {
    table: "folders",
    required: [
      "id",
      "name",
      "parent_folder_id",
      "project_id",
      "path",
      "depth",
      "created_at",
      "updated_at",
    ],
  },
  {
    table: "resources",
    required: [
      "rid",
      "type",
      "display_name",
      "parent_folder_rid",
      "project_rid",
      "space_rid",
      "trash_status",
      "trashed_at",
      "trashed_by",
      "retention_until",
      "metadata",
      "etag",
      "created_at",
      "updated_at",
      "created_by",
      "updated_by",
    ],
  },
  // The trash service rebuilds these tables from snapshot during
  // restore (see trashService.restore folder branch), so column drift
  // here would surface as a failed restore in production.
  {
    table: "pipelines",
    required: [
      "id",
      "project_id",
      "name",
      "description",
      "pipeline_type",
      "compute_type",
      "status",
      "config",
      "created_by",
      "created_at",
      "updated_at",
      "folder_id",
      "output_format",
      "iceberg_partition_spec",
      "streaming_runtime",
      "streaming_parallelism",
      "streaming_throughput_mbps",
      "input_markings",
    ],
  },
  {
    table: "code_repository",
    required: [
      "rid",
      "display_name",
      "parent_folder_rid",
      "project_rid",
      "template_id",
      "template_version",
      "default_branch",
      "settings_json",
      "state",
      "created_by",
      "created_at",
      "updated_at",
      "resource_version",
    ],
  },
  {
    table: "workshop_module",
    required: [
      "rid",
      "ontology_rid",
      "display_name",
      "description",
      "current_semver",
      "published_semver",
      "definition",
      "etag",
      "schema_version",
      "parent_folder_rid",
      "branch_rid",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "deleted_at",
      "published_at",
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// Verification.
// ---------------------------------------------------------------------------
export interface ContractViolation {
  table: string;
  missing: readonly string[];
}

export class SchemaContractError extends Error {
  public readonly violations: readonly ContractViolation[];
  constructor(violations: readonly ContractViolation[]) {
    const summary = violations
      .map((v) => `  ${v.table}: missing ${v.missing.join(", ")}`)
      .join("\n");
    super(
      `Schema contract violated. The live database is missing columns ` +
        `that the application code writes to via raw SQL. This will surface ` +
        `as a 42703 undefined_column at runtime. Refusing to start.\n\n` +
        summary,
    );
    this.name = "SchemaContractError";
    this.violations = violations;
  }
}

/**
 * Validate every registered contract against the live DB. Returns the
 * full list of violations (empty when the schema matches). Throws no
 * synthetic errors — the caller decides how to react.
 */
export async function verifySchemaContract(
  pool: Pool,
): Promise<readonly ContractViolation[]> {
  const violations: ContractViolation[] = [];

  // One round-trip per table is acceptable here (we typically have <20
  // tables registered and this only runs once at boot). The query is
  // intentionally read-only and does not lock anything.
  for (const contract of SCHEMA_CONTRACTS) {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = $1`,
      [contract.table],
    );
    const live = new Set(rows.map((r) => r.column_name));
    if (live.size === 0) {
      // Table itself is missing — this is a migration error, not a
      // contract error, but we surface it the same way so boot fails
      // loudly instead of silently waiting for the first INSERT.
      violations.push({ table: contract.table, missing: ["<table missing>"] });
      continue;
    }
    const missing = contract.required.filter((col) => !live.has(col));
    if (missing.length > 0) {
      violations.push({ table: contract.table, missing });
    }
  }

  return violations;
}

/**
 * Boot-time entry point. Logs success or detailed violations and
 * exits the process on any drift. Mirrors the migration gate's
 * fail-closed contract.
 */
export async function enforceSchemaContract(pool: Pool): Promise<void> {
  const t0 = Date.now();
  let violations: readonly ContractViolation[];
  try {
    violations = await verifySchemaContract(pool);
  } catch (err) {
    // Information_schema query itself failed — connectivity/permissions
    // problem. Fail closed with a clear marker.
    console.error(
      JSON.stringify({
        type: "schema_contract.error",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    throw err;
  }
  if (violations.length > 0) {
    console.error(
      JSON.stringify({
        type: "schema_contract.drift",
        violations,
        duration_ms: Date.now() - t0,
      }),
    );
    throw new SchemaContractError(violations);
  }
  console.log(
    JSON.stringify({
      type: "schema_contract.ok",
      tables_checked: SCHEMA_CONTRACTS.length,
      duration_ms: Date.now() - t0,
    }),
  );
}
