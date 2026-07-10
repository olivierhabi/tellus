// ===========================================================================
// Dataset materialization for transform builds.
//
// Bridges a transform's Output("ri...")/Input("ri...") RIDs to rows in the
// singular `dataset` table (the same table the upload route + dataset preview
// use). Output is written as a committed dataset_transaction (SNAPSHOT, or
// APPEND for incremental), so a materialized transform output is immediately
// viewable through the existing dataset preview UI by its UUID.
//
// Replicates the INSERT contract of src/routes/datasets.ts so the rows are
// indistinguishable from an uploaded dataset.
// ===========================================================================
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { pool, getClient } from "../../../db.js";
import { scanFile } from "../../fileScannerService.js";
import { getObjectStream, uploadObject, deleteObject } from "../../storageService.js";
import { assertDatasetAccess, type TransformPrincipal } from "./authz.js";

// Absolute so stored file_path values resolve regardless of a child process's
// cwd (the python executor runs in a temp workdir).
const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");

export type TransactionType = "SNAPSHOT" | "APPEND";

export interface ResolvedInput {
  readonly datasetId: string;
  readonly filePath: string;
  readonly fileFormat: string;
}

export interface MaterializeResult {
  readonly datasetId: string;
  readonly rid: string;
  readonly rowCount: number;
  readonly columns: string[];
  readonly transactionId: string;
  readonly transactionType: TransactionType;
}

/** Resolve an input dataset RID to its latest committed data file on disk,
 * scoped to `branch` (branch-specific txs, falling back to legacy NULL-branch
 * rows). A build on branch A reads A's txs, NOT sibling branch B's. */
export async function resolveDatasetByRid(
  rid: string,
  branch?: string | null,
): Promise<ResolvedInput | null> {
  const ds = await pool.query<{
    dataset_id: string;
    file_format: string;
    storage_path: string | null;
  }>(
    `SELECT dataset_id, file_format, storage_path FROM dataset WHERE rid = $1`,
    [rid],
  );
  if (ds.rowCount === 0) return null;
  const row = ds.rows[0];

  // Branch-scoped: branch = $2 (this branch's txs) OR branch IS NULL (legacy
  // pre-branching rows). Sibling branches' txs are excluded.
  const tx = await pool.query<{ file_path: string | null }>(
    `SELECT file_path FROM dataset_transaction
       WHERE dataset_id = $1 AND status = 'committed'
         AND (branch = $2 OR branch IS NULL)
       ORDER BY committed_at DESC NULLS LAST
       LIMIT 1`,
    [row.dataset_id, branch ?? null],
  );
  const rawPath =
    ((tx.rowCount ?? 0) > 0 ? tx.rows[0].file_path : null) ?? row.storage_path;
  if (!rawPath) return null;
  // Resolve relative paths (legacy rows) against the server CWD.
  const filePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(rawPath);

  return { datasetId: row.dataset_id, filePath, fileFormat: row.file_format };
}

/**
 * Resolve the PREVIOUS committed transaction file for a dataset RID (the
 * second-newest committed transaction). Used by Input.dataframe(mode='previous')
 * on incremental builds to read an input's *prior version* (the transaction
 * before the current build's). Returns null when fewer than 2 committed
 * transactions exist (first build, or an input with no prior version).
 *
 * NOTE: this is NOT used to decide ctx.is_incremental. is_incremental is an
 * EXISTENCE check (does the OUTPUT have >=1 prior committed transaction),
 * which buildService computes via resolveDatasetByRid(outputRid) — using
 * OFFSET 1 here for is_incremental was a bug (it returned null on build 2,
 * which has exactly 1 prior tx, leaving is_incremental=false so the second
 * build ran a full SNAPSHOT instead of APPEND).
 */
export async function resolvePreviousTransaction(
  rid: string,
  branch?: string | null,
): Promise<{ filePath: string } | null> {
  const ds = await pool.query<{ dataset_id: string }>(
    `SELECT dataset_id FROM dataset WHERE rid = $1`,
    [rid],
  );
  if (ds.rowCount === 0) return null;
  const tx = await pool.query<{ file_path: string | null }>(
    `SELECT file_path FROM dataset_transaction
       WHERE dataset_id = $1 AND status = 'committed'
         AND (branch = $2 OR branch IS NULL)
       ORDER BY committed_at DESC NULLS LAST
       LIMIT 1 OFFSET 1`,
    [ds.rows[0].dataset_id, branch ?? null],
  );
  const rawPath = (tx.rowCount ?? 0) > 0 ? tx.rows[0].file_path : null;
  if (!rawPath) return null;
  const filePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(rawPath);
  return { filePath };
}

// ===========================================================================
// Transform INPUT resolution — bridges the transform runtime to BOTH dataset
// stores. `resolveDatasetByRid` (above) only reads the `dataset` table (the
// transform/upload store, slug-`<8hex>` rids, files on local disk). But the
// platform's catalog also has `foundry_datasets` (the Foundry-style file
// catalog — uploads + sync outputs; files live in object storage, addressed by
// a UUID `id`). The catalog/preview UI bridges both (datasets.ts fallthrough +
// foundryDatasetsV1.resolveDataset + dataPreview checks both tables); the
// transform runtime historically did NOT — so `Input("ri.foundry.main.dataset.
// <uuid>")` on a catalog CSV could not be read by a transform, surfacing as
// "input dataset not found" even though the dataset plainly exists in the UI.
//
// `resolveTransformInput` mirrors that catalog bridge for the executor path
// (used by both previewHarness + buildService): on a `dataset`-table miss, if
// the rid suffix is a `foundry_datasets.id` UUID, stream the object to a temp
// CSV + return its local path (the python driver reads local CSV paths). The
// caller MUST clean `stagedPath` after the transform finishes.
//
// `resolveDatasetByRid` stays dataset-table-only: it is also used for the
// `is_incremental` OUTPUT existence check (buildService) + resolvePrevious
// transaction, where staging an object would be wrong (wasteful + would make a
// foundry OUTPUT look pre-existing). The bridge is INPUT-only by design.
// ===========================================================================

/** A transform input resolved to a local CSV path the python driver can read,
 * plus the cleanup the caller owes when the source was staged from object
 * storage. `stagedPath` is null for on-disk `dataset`-table inputs (permanent
 * file, no cleanup). */
export interface ResolvedTransformInput {
  readonly datasetId: string;
  readonly filePath: string;
  readonly fileFormat: string;
  /** Non-null when the input was streamed from object storage to a temp file;
   * the caller MUST `rmSync(path.dirname(stagedPath))` after the transform
   * finishes (success OR failure). Null for permanent on-disk inputs. */
  readonly stagedPath: string | null;
  /** `"dataset-table"` = a transform/upload dataset (slug-`<8hex>` rid, on
   * disk, a valid `dataset.dataset_id` for FK'd lineage edges); `"foundry-
   * bridge"` = a Foundry catalog file (UUID rid, NOT in `dataset` → its
   * datasetId is NOT a valid `dataset.dataset_id` for `transform_lineage`). */
  readonly origin: "dataset-table" | "foundry-bridge";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Last dot-segment of a Foundry RID is its locator (a `foundry_datasets.id`
 * UUID for catalog files, or a slug for `dataset`-table rids). */
function ridSuffix(rid: string): string {
  return rid.split(".").pop() ?? rid;
}

/** A `foundry_datasets.file_path` may carry a `#foundry-dataset:` tag suffix
 * (synced/bridged datasources); the real S3 object key is everything before it.
 * Pure-upload rows are just `projects/<id>/…/file.csv`. (Local copy of
 * reindexService.stripFoundryTags — not exported there.) */
function stripFoundryTags(filePath: string): string {
  const idx = filePath.indexOf("#foundry-dataset:");
  return idx >= 0 ? filePath.slice(0, idx) : filePath;
}

/** Resolve a transform Input RID to a local CSV path + cleanup. Tries the
 * `dataset` table first (the transform/upload store); on a miss, falls back to
 * the Foundry catalog (`foundry_datasets`) when the rid suffix is a UUID,
 * streaming the object to a temp CSV. Returns null only when the rid is
 * unknown to BOTH stores (→ "input dataset not found").
 *
 * `principal` enforces per-dataset READ access before a foundry-bridge input
 * is staged (P0 authz — assertDatasetAccess). Threading it is mandatory for
 * real callers; tests pass a superadmin principal to exercise the resolution
 * path (the bypass skips the check). */
export async function resolveTransformInput(
  rid: string,
  branch: string | null | undefined,
  principal: TransformPrincipal,
): Promise<ResolvedTransformInput | null> {
  // 1. The transform/upload dataset table (slug-<8hex> rids, on-disk files).
  // Reuses resolveDatasetByRid (branch-scoped committed transaction + legacy
  // storage_path fallback) — no behavior change for existing inputs.
  const ds = await resolveDatasetByRid(rid, branch);
  if (ds) {
    return {
      datasetId: ds.datasetId,
      filePath: ds.filePath,
      fileFormat: ds.fileFormat,
      stagedPath: null,
      origin: "dataset-table",
    };
  }

  // 2. Foundry-catalog fallback: the rid suffix is a foundry_datasets.id UUID.
  //    The `dataset` table + foundry_datasets are independent stores; only the
  //    catalog lookup matches when the suffix is a UUID (slug suffixes never
  //    match a uuid `id` column). This is the bridge that lets a transform read
  //    a catalog CSV the UI already shows.
  const uuid = ridSuffix(rid);
  if (!UUID_RE.test(uuid)) return null;
  const fr = await pool.query<{
    file_path: string | null;
    format: string | null;
    mime_type: string | null;
    status: string | null;
  }>(
    `SELECT file_path, format, mime_type, status FROM foundry_datasets WHERE id = $1`,
    [uuid],
  );
  if (fr.rowCount === 0) return null;
  const row = fr.rows[0];
  if (!row.file_path) return null;
  if (row.status && row.status !== "ready") return null;
  // The python executor reads a local CSV path (pyspark/pandas parse it).
  // Only CSV-backed catalog rows are bridgeable today; Iceberg/json rows have
  // no local-file representation the driver can read (would need a PyIcegram/
  // table reader — out of scope).
  const fmt = `${row.format ?? ""} ${row.mime_type ?? ""}`.toLowerCase();
  if (!fmt.includes("csv")) return null;

  const s3Key = stripFoundryTags(row.file_path);
  // P0 authz: before staging (reading) a foundry-catalog input, assert the
  // principal has READ access to it. Throws Transform:PermissionDenied on
  // deny / check-error (fail-closed) — BEFORE any data is streamed to disk.
  await assertDatasetAccess({ principal, datasetUuid: uuid, op: "read", datasetRid: rid });
  const stagedPath = await stageFoundryInputToCsv(s3Key);
  return {
    datasetId: uuid,
    filePath: stagedPath,
    fileFormat: "csv",
    stagedPath,
    origin: "foundry-bridge",
  };
}

/** Stream a foundry-catalog object (S3/MinIO) to a temp CSV file the python
 * transform driver can read. Streams bytes straight to disk — never
 * materializes the whole object as a Buffer (an 854MB / 5.6M-row CSV would
 * OOM). The CALLER owns the temp dir + must `rmSync(path.dirname(stagedPath))`
 * after the transform finishes. Throws if the object can't be read (caller
 * surfaces as an input-resolution failure). */
async function stageFoundryInputToCsv(s3Key: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tellus-foundry-input-"));
  const stagedPath = path.join(dir, "input.csv");
  const readable = await getObjectStream(s3Key);
  await new Promise<void>((resolve, reject) => {
    const writer = fs.createWriteStream(stagedPath);
    readable.pipe(writer);
    writer.on("finish", () => resolve());
    writer.on("error", reject);
    readable.on("error", reject);
  });
  return stagedPath;
}

function moveInto(src: string, destDir: string, destName: string): string {
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, destName);
  try {
    fs.renameSync(src, dest);
  } catch {
    fs.copyFileSync(src, dest);
    try {
      fs.unlinkSync(src);
    } catch {
      /* best-effort */
    }
  }
  return dest;
}

/**
 * Materialize a CSV file at `csvFilePath` as a committed transaction on the
 * dataset identified by `rid` (creating the dataset row if it does not exist).
 * SNAPSHOT replaces the dataset contents; APPEND adds to them.
 */
export async function materializeOutput(args: {
  rid: string;
  name: string;
  description?: string;
  csvFilePath: string;
  transactionType: TransactionType;
  actor: string;
  /** The build's branch — written on the tx + scopes the SNAPSHOT supersede
   * (a SNAPSHOT on branch A supersedes only A's prior txs, NOT sibling B's). */
  branch?: string | null;
  /** The build RID — recorded on the schema_version row (which build introduced
   * this schema). */
  buildRid?: string | null;
  /** P0 authz: the principal to authorize the OUTPUT write against. Required
   * for foundry-catalog outputs (the write-check runs before the S3 upload). */
  principal: TransformPrincipal;
}): Promise<MaterializeResult> {
  const branch = args.branch ?? null;
  const scan = await scanFile(args.csvFilePath, "csv");
  const size = fs.statSync(args.csvFilePath).size;
  const schemaDef = JSON.stringify({
    columns: scan.columnNames,
    inferredTypes: scan.inferredTypes,
  });
  const fileName = `${args.name.replace(/[^a-zA-Z0-9._-]/g, "_")}.csv`;

  // Foundry-catalog output bridge: if this output rid is a Foundry-catalog
  // dataset (a `foundry_datasets` row keyed by the rid's UUID suffix), the
  // build must ALSO update the catalog backing — the dataset page reads
  // `foundry_datasets.file_path` (MinIO) via readUploadedPreview, NOT the
  // `dataset` table the build normally writes. Without this, a transform
  // Output("ri.foundry.main.dataset.<uuid>") materializes to the dataset table
  // but the catalog keeps the pre-build file (the dual-store gap for OUTPUTS —
  // the mirror of the resolveTransformInput INPUT bridge). Slug-rid outputs
  // (lightweight-preview-out etc.) never match a uuid `id` -> no-op. Declared
  // before the try so the catch can clean up an orphaned upload.
  let foundryOutput: { uuid: string; s3Key: string } | null = null;

  const client = await getClient();
  try {
    // Detect + upload the catalog backing BEFORE BEGIN (S3 isn't transactional).
    // On DB rollback the catch below deletes the orphan so a failed build leaves
    // no dangling transform-outputs object.
    const outUuid = ridSuffix(args.rid);
    if (UUID_RE.test(outUuid)) {
      const fr = await client.query<{ project_id: string | null }>(
        `SELECT project_id::text FROM foundry_datasets WHERE id = $1`,
        [outUuid],
      );
      if ((fr.rowCount ?? 0) > 0) {
        const projId = fr.rows[0].project_id ?? "unknown";
        const buildSeg = args.buildRid ?? crypto.randomUUID();
        const s3Key = `projects/${projId}/transform-outputs/${buildSeg}/${fileName}`;
        // P0 authz: before overwriting the foundry-catalog OUTPUT's backing,
        // assert the principal has WRITE access. Throws
        // Transform:PermissionDenied on deny / check-error (fail-closed) — BEFORE
        // the S3 upload, so an unauthorized build leaves the output unchanged.
        await assertDatasetAccess({ principal: args.principal, datasetUuid: outUuid, op: "write", datasetRid: args.rid });
        // Streamed body (never buffered) — safe for large outputs.
        await uploadObject(s3Key, fs.createReadStream(args.csvFilePath), "text/csv", undefined, size);
        foundryOutput = { uuid: outUuid, s3Key };
      }
    }

    await client.query("BEGIN");

    // Resolve-or-create the dataset row by RID.
    let datasetId: string;
    const existing = await client.query<{ dataset_id: string }>(
      `SELECT dataset_id FROM dataset WHERE rid = $1 FOR UPDATE`,
      [args.rid],
    );
    if ((existing.rowCount ?? 0) > 0) {
      datasetId = existing.rows[0].dataset_id;
    } else {
      const ins = await client.query<{ dataset_id: string }>(
        `INSERT INTO dataset
           (name, description, file_format, rid, schema_definition,
            total_rows, total_size_bytes, created_by)
         VALUES ($1, $2, 'csv', $3, $4, 0, 0, $5)
         RETURNING dataset_id`,
        [args.name, args.description ?? null, args.rid, schemaDef, args.actor],
      );
      datasetId = ins.rows[0].dataset_id;
    }

    // Stage the file into the dataset's permanent transaction directory.
    const transactionId = crypto.randomUUID();
    const destDir = path.join(
      DATA_DIR,
      "datasets",
      datasetId,
      "transactions",
      transactionId,
    );
    const permanentPath = moveInto(args.csvFilePath, destDir, fileName);

    // SNAPSHOT supersedes prior committed transactions ON THE SAME BRANCH ONLY
    // (branch IS NOT DISTINCT FROM $3 handles NULL = NULL). Sibling branches'
    // txs are left intact — the data-branching isolation guarantee.
    if (args.transactionType === "SNAPSHOT") {
      await client.query(
        `UPDATE dataset_transaction
            SET metadata = COALESCE(metadata,'{}'::jsonb) || '{"superseded": true}'::jsonb
          WHERE dataset_id = $1 AND status = 'committed'
            AND branch IS NOT DISTINCT FROM $3
            AND transaction_id != $2`,
        [datasetId, transactionId, branch],
      );
    }

    await client.query(
      `INSERT INTO dataset_transaction
         (transaction_id, dataset_id, transaction_type, status, file_path,
          file_name, file_size_bytes, row_count, schema_definition, metadata, branch, committed_at)
       VALUES ($1, $2, $3, 'committed', $4, $5, $6, $7, $8, $9, $10, NOW())`,
      [
        transactionId,
        datasetId,
        args.transactionType,
        permanentPath,
        fileName,
        size,
        scan.rowCount,
        schemaDef,
        JSON.stringify({ source: "transform-build", schemaHash: scan.schemaHash }),
        branch,
      ],
    );

    // Schema evolution (gap 7): diff the new schema vs the latest committed
    // dataset_schema_version. add-column = compatible; dropped-column =
    // breaking -> ROLLBACK + throw BreakingSchemaChange (the build fails
    // loudly; the breaking output is NOT materialized).
    const latestVer = await client.query<{ version: number; schema_hash: string; column_names: string[] }>(
      `SELECT version, schema_hash, column_names
         FROM dataset_schema_version WHERE dataset_id = $1 ORDER BY version DESC LIMIT 1`,
      [datasetId],
    );
    let nextVersion = 1;
    let breaking = false;
    const dropped: string[] = [];
    const added: string[] = [];
    if ((latestVer.rowCount ?? 0) > 0) {
      const lv = latestVer.rows[0];
      nextVersion = lv.version + 1;
      if (scan.schemaHash !== lv.schema_hash) {
        const oldCols = new Set<string>(Array.isArray(lv.column_names) ? lv.column_names : []);
        const newCols = new Set<string>(scan.columnNames);
        for (const c of oldCols) if (!newCols.has(c)) dropped.push(c);
        for (const c of newCols) if (!oldCols.has(c)) added.push(c);
        breaking = dropped.length > 0;
      }
    }
    await client.query(
      `INSERT INTO dataset_schema_version (dataset_id, version, column_names, inferred_types, schema_hash, introduced_by_build_rid, breaking)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [datasetId, nextVersion, JSON.stringify(scan.columnNames), JSON.stringify(scan.inferredTypes), scan.schemaHash, args.buildRid ?? null, breaking],
    );
    if (breaking) {
      throw Object.assign(
        new Error(`BreakingSchemaChange: transform output schema drops column(s) [${dropped.join(", ")}] vs the latest committed schema (added: [${added.join(", ")}]). Refusing to materialize a breaking schema change. Evolve the schema compatibly (add-only) or migrate downstream consumers first.`),
        { breakingSchema: true, dropped, added },
      );
    }

    // Roll up dataset totals + schema (SNAPSHOT replaces, APPEND adds).
    if (args.transactionType === "SNAPSHOT") {
      await client.query(
        `UPDATE dataset
            SET total_rows = $1, total_size_bytes = $2, storage_path = $3,
                file_format = 'csv', schema_definition = $4, updated_at = now()
          WHERE dataset_id = $5`,
        [scan.rowCount, size, permanentPath, schemaDef, datasetId],
      );
    } else {
      await client.query(
        `UPDATE dataset
            SET total_rows = total_rows + $1, total_size_bytes = total_size_bytes + $2,
                updated_at = now()
          WHERE dataset_id = $3`,
        [scan.rowCount, size, datasetId],
      );
    }

    // Foundry-catalog output: update the catalog backing atomically with the
    // dataset-table write (both or neither). The catalog row now points at the
    // build output's S3 object — readUploadedPreview (the dataset-page preview)
    // then reads the build output, not the pre-build file. schema_info mirrors
    // the upload-path shape ({columns:[{name,type,nullable}], previewRows});
    // the live data preview is sourced by readUploadedPreview reading the file.
    if (foundryOutput) {
      const schemaInfo = JSON.stringify({
        columns: scan.columnNames.map((c) => ({
          name: c,
          type: scan.inferredTypes[c] ?? "string",
          nullable: false,
        })),
        previewRows: [],
      });
      await client.query(
        `UPDATE foundry_datasets
            SET file_path = $1, schema_info = $2, row_count = $3, file_size_bytes = $4,
                format = 'csv', mime_type = 'text/csv', status = 'ready',
                original_filename = $5, updated_at = now()
          WHERE id = $6`,
        [foundryOutput.s3Key, schemaInfo, scan.rowCount, size, fileName, foundryOutput.uuid],
      );
    }

    await client.query("COMMIT");
    return {
      datasetId,
      rid: args.rid,
      rowCount: scan.rowCount,
      columns: scan.columnNames,
      transactionId,
      transactionType: args.transactionType,
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    // The S3 upload ran before BEGIN; if the DB tx rolled back (breaking
    // schema, a query error, etc.), the uploaded object is orphaned. Best-
    // effort delete so a failed build leaves no dangling catalog pointer.
    if (foundryOutput) {
      try { await deleteObject(foundryOutput.s3Key); } catch { /* best-effort */ }
    }
    throw e;
  } finally {
    client.release();
  }
}
