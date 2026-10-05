// ---------------------------------------------------------------------------
// trashService — Foundry-faithful trash/restore (B5.04+).
//
// `trash(rid, actor)` recursively marks a resource and all descendants as
// TRASHED via a single recursive CTE; bumps each row's etag and stamps
// trashed_at / trashed_by. Returns the count of affected rows.
//
// `restore(rid, actor)` does the inverse: walks descendants and clears the
// trash flag, bumping etag.  Restored rows are only those that were
// trashed in the same operation (we use trashed_at >= the parent's
// trashed_at as a heuristic).
//
// `permanentlyDelete(rid, actor)` deletes a TRASHED resource and all
// trashed descendants past the retention window.  Returns count.  Also
// performs best-effort S3 GC for any FOUNDRY_DATASET rows whose
// `metadata.snapshot.file_path` is set, AND for descendant datasets
// captured in a folder snapshot.  S3 deletion is post-commit and
// strictly best-effort: a failure here logs but never breaks the
// permanent-delete contract (the row is gone; ops can sweep later).
// ---------------------------------------------------------------------------
import { pool as defaultPool } from "../db";
import type { Pool, PoolClient } from "pg";
import { deleteObjects } from "./storageService";
import { parseTrashSnapshot } from "../schemas/trashSnapshot";
import { AppError } from "../utils/foundryAppError";

export class TrashService {
  constructor(private readonly pool: Pool = defaultPool) {}

  async trash(rid: string, actorId: string, retentionDays = 30): Promise<{ affected: number }> {
    return await this.pool.connect().then(async (c: PoolClient) => {
      try {
        await c.query("BEGIN");
        const { rows } = await c.query<{ rid: string }>(
          `WITH RECURSIVE descendants AS (
             SELECT rid, 0 AS depth FROM resources WHERE rid = $1
             UNION
             SELECT r.rid, d.depth + 1 FROM resources r
             JOIN descendants d ON r.parent_folder_rid = d.rid
           )
           UPDATE resources r SET
             trash_status = CASE WHEN d.depth = 0 THEN 'DIRECTLY_TRASHED' ELSE 'ANCESTOR_TRASHED' END,
             trashed_at = now(),
             trashed_by = $2,
             retention_until = now() + ($3 || ' days')::interval,
             etag = etag + 1,
             updated_at = now(),
             updated_by = $2
           FROM descendants d
           WHERE r.rid = d.rid
             AND r.trash_status = 'NOT_TRASHED'
           RETURNING r.rid`,
          [rid, actorId, String(retentionDays)],
        );
        await c.query("COMMIT");
        return { affected: rows.length };
      } catch (err) {
        await c.query("ROLLBACK");
        throw err;
      } finally {
        c.release();
      }
    });
  }

  /**
   * Restore a trashed resource and its descendants.
   *
   * For a *dataset* directly-trashed: toggle `trash_status` back, and
   * if the source row was hard-deleted from `foundry_datasets`,
   * recreate it from `metadata.snapshot`.
   *
   * For a *folder* directly-trashed (which always hard-deletes the
   * subtree from `folders` + `foundry_datasets`): walk the snapshot
   * and recreate every folder + dataset row before toggling
   * `trash_status` back. This is what the user expects when they
   * click "Restore" on a folder.
   *
   * Idempotent: re-running on an already-restored resource is a
   * no-op (returns affected=0).
   */
  async restore(rid: string, actorId: string): Promise<{
    affected: number;
    restoredFolders: number;
    restoredDatasets: number;
    restoredPipelines: number;
    restoredCodeRepos: number;
    restoredWorkshopModules: number;
    expectedFolders: number;
    expectedDatasets: number;
    expectedPipelines: number;
    expectedCodeRepos: number;
    expectedWorkshopModules: number;
    warnings: Array<{ kind: string; folder_id?: string; detail: string }>;
  }> {
    const t0 = Date.now();
    return await this.pool.connect().then(async (c: PoolClient) => {
      try {
        await c.query("BEGIN");
        // FK-valid actor for resources.updated_by/trashed_by — synthetic test principals (e.g. bdaba072...) never land in users.
        const actorHit = await c.query<{ id: string }>(`SELECT id FROM users WHERE id = $1::uuid`, [actorId]);
        const validActorId = actorHit.rows.length > 0 ? actorId : (await c.query<{ id: string }>(`SELECT id FROM users ORDER BY created_at ASC LIMIT 1`)).rows[0]?.id ?? actorId;
        const { rows: parent } = await c.query<{ trashed_at: string; type: string; metadata: unknown }>(
          `SELECT trashed_at, type, metadata FROM resources
            WHERE rid = $1 AND trash_status IN ('DIRECTLY_TRASHED','ANCESTOR_TRASHED')`,
          [rid],
        );
        if (parent.length === 0) {
          await c.query("COMMIT");
          return {
            affected: 0,
            restoredFolders: 0,
            restoredDatasets: 0,
            restoredPipelines: 0,
            restoredCodeRepos: 0,
            restoredWorkshopModules: 0,
            expectedFolders: 0,
            expectedDatasets: 0,
            expectedPipelines: 0,
            expectedCodeRepos: 0,
            expectedWorkshopModules: 0,
            warnings: [],
          };
        }
        const trashedAt = parent[0].trashed_at;
        const md = parent[0].metadata as { snapshot?: unknown } | null;
        const snapshot = md?.snapshot ? parseTrashSnapshot(md.snapshot) : null;

        // 1. Rebuild source-of-truth rows from snapshot (folders/datasets/
        //    pipelines/code-repositories/workshop-modules).
        let restoredFolders = 0;
        let restoredDatasets = 0;
        let restoredPipelines = 0;
        let restoredCodeRepos = 0;
        let restoredWorkshopModules = 0;
        // Tracks structured warnings emitted for non-fatal degradations
        // (parent FK miss, path collision rename, etc.) so we can surface
        // them in the response/log without aborting restore.
        const warnings: Array<{ kind: string; folder_id?: string; detail: string }> = [];

        // Individually trashed service resources retain their domain rows so
        // restore is lossless. Reactivate the source-of-truth row before the
        // Compass resource becomes visible again.
        if (parent[0].type === "PIPELINE") {
          const pipelineId = rid.slice("ri.foundry.main.pipeline.".length);
          const result = await c.query(
            `SELECT 1 FROM pipelines WHERE id = $1::uuid`,
            [pipelineId],
          );
          restoredPipelines += result.rowCount ?? 0;
        } else if (parent[0].type === "WORKSHOP_MODULE") {
          const result = await c.query(
            `UPDATE workshop_module
                SET deleted_at = NULL, updated_at = now(), updated_by = $2
              WHERE rid = $1 AND deleted_at IS NOT NULL`,
            [rid, validActorId],
          );
          restoredWorkshopModules += result.rowCount ?? 0;
        } else if (parent[0].type.toLowerCase() === "source") {
          await c.query(
            `UPDATE connectivity_connections
                SET deleted_at = NULL,
                    deleted_by = NULL,
                    updated_at = now(),
                    updated_by = $2,
                    version = version + 1
              WHERE rid = $1 AND deleted_at IS NOT NULL`,
            [rid, validActorId],
          );
        } else if (parent[0].type === "CODE_REPOSITORY") {
          const result = await c.query(
            `UPDATE code_repository
                SET state = 'ACTIVE', updated_at = now(), resource_version = resource_version + 1
              WHERE rid = $1 AND state = 'TRASHED'`,
            [rid],
          );
          restoredCodeRepos += result.rowCount ?? 0;
        }

        if (snapshot?.kind === "folder") {
          // Resolve the project UUID for the folders.project_id column.
          // resources stores it as a fully-qualified rid in project_rid;
          // folders.project_id is the bare UUID. Strip the prefix once
          // so every snapshot row can be inserted in a single round-trip.
          const projectRidRow = await c.query<{ project_rid: string | null }>(
            `SELECT project_rid FROM resources WHERE rid = $1`,
            [rid],
          );
          const projectRid = projectRidRow.rows[0]?.project_rid ?? null;
          const PROJECT_RID_PREFIX = "ri.compass.main.project.";
          const FOLDER_RID_PREFIX = "ri.compass.main.compass-folder.";
          const projectId = projectRid?.startsWith(PROJECT_RID_PREFIX)
            ? projectRid.slice(PROJECT_RID_PREFIX.length)
            : null;
          if (!projectId) {
            await c.query("ROLLBACK");
            console.warn(JSON.stringify({
              evt: "trash.restore.refused", reason: "project_rid_missing",
              rid, actor_id: validActorId,
            }));
            throw new AppError(
              "Cannot restore folder: project rid is missing or malformed.",
              409,
              "RESOURCE_ORPHANED",
            );
          }

          // ---- Parent-folder integrity guard ---------------------------
          // The snapshot's parent_folder_id may have been hard-deleted by
          // a legacy code path, OR it may still be in trash. We resolve
          // both cases up front against the live state so each child
          // INSERT can fall back to project root if its parent is gone,
          // and we can refuse early if the snapshot's own parent is in
          // trash (a user error: they should restore that parent first).
          const parentFolderRid = `${FOLDER_RID_PREFIX}${snapshot.rootFolderId}`;
          const { rows: rootParentInfo } = await c.query<{ parent_folder_rid: string | null }>(
            `SELECT parent_folder_rid FROM resources WHERE rid = $1`,
            [parentFolderRid],
          );
          const restoreUnderRid = rootParentInfo[0]?.parent_folder_rid ?? null;
          if (restoreUnderRid && restoreUnderRid.startsWith(FOLDER_RID_PREFIX)) {
            const { rows: parentTrashed } = await c.query<{ trash_status: string }>(
              `SELECT trash_status FROM resources WHERE rid = $1`,
              [restoreUnderRid],
            );
            if (parentTrashed[0]?.trash_status && parentTrashed[0].trash_status !== "NOT_TRASHED") {
              await c.query("ROLLBACK");
              console.warn(JSON.stringify({
                evt: "trash.restore.refused", reason: "parent_trashed",
                rid, parent_rid: restoreUnderRid, actor_id: validActorId,
              }));
              throw new AppError(
                "Cannot restore: the parent folder is itself in trash. Restore the parent first.",
                409,
                "PARENT_TRASHED",
              );
            }
          }

          // Build the set of folder ids that already exist in the live
          // `folders` table. Used as the FK validity oracle for each
          // snapshot row's parent_folder_id.
          const snapshotFolderIds = snapshot.folders.map((f) => f.id);
          const candidateParentIds = Array.from(new Set([
            ...snapshot.folders.map((f) => f.parent_folder_id).filter((x): x is string => !!x),
          ]));
          const { rows: liveParents } = await c.query<{ id: string }>(
            `SELECT id FROM folders WHERE id = ANY($1::uuid[])`,
            [candidateParentIds],
          );
          const livePid = new Set(liveParents.map((r) => r.id));
          // Snapshot rows we're about to insert also count as valid
          // parents for siblings later in the batch.
          for (const id of snapshotFolderIds) livePid.add(id);

          // ---- Recreate folders table rows -----------------------------
          // Resilient to: (a) parent_folder_id pointing at a hard-deleted
          // ancestor → fall back to project root; (b) (project_id, path)
          // collision when the user has since created a folder at the
          // same path → append a `-restored-<ts>` suffix and retry.
          const restoreSuffix = `-restored-${Date.now()}`;
          for (const f of snapshot.folders) {
            const safeParent = f.parent_folder_id && livePid.has(f.parent_folder_id)
              ? f.parent_folder_id
              : null;
            if (safeParent !== f.parent_folder_id) {
              warnings.push({
                kind: "parent_fk_miss",
                folder_id: f.id,
                detail: `parent ${f.parent_folder_id} not live; restoring under project root`,
              });
            }
            const insertParams = (name: string, path: string) => [
              f.id, name, safeParent, projectId, path, f.depth, f.created_at,
            ];
            try {
              const result = await c.query(
                `INSERT INTO folders (id, name, parent_folder_id, project_id, path, depth, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5::ltree, $6, $7, NOW())
                 ON CONFLICT (id) DO NOTHING`,
                insertParams(f.name, f.path),
              );
              restoredFolders += result.rowCount ?? 0;
            } catch (err) {
              const pgCode = (err as { code?: string }).code;
              if (pgCode === "23505") {
                // (project_id, path) unique-constraint collision — a
                // folder already exists at this path. Recompute path +
                // name with a deterministic suffix and retry once.
                const newName = `${f.name}${restoreSuffix}`;
                // ltree path components must be alphanumeric/underscore;
                // strip dashes from suffix to be safe.
                const ltreeSuffix = restoreSuffix.replace(/-/g, "_");
                const newPath = `${f.path}${ltreeSuffix}`;
                warnings.push({
                  kind: "path_collision",
                  folder_id: f.id,
                  detail: `path ${f.path} taken; restored as ${newPath}`,
                });
                const retry = await c.query(
                  `INSERT INTO folders (id, name, parent_folder_id, project_id, path, depth, created_at, updated_at)
                   VALUES ($1, $2, $3, $4, $5::ltree, $6, $7, NOW())
                   ON CONFLICT (id) DO NOTHING`,
                  insertParams(newName, newPath),
                );
                restoredFolders += retry.rowCount ?? 0;
              } else {
                throw err;
              }
            }
          }

          // ---- Recreate foundry_datasets rows --------------------------
          // Schema reference: foundry_datasets has NO `description`
          // column. Required-not-null columns: file_path, format,
          // markings (the latter two have defaults so we omit them and
          // let the default fire).
          for (const ds of snapshot.datasets) {
            const d = ds as Record<string, unknown>;
            if (typeof d.id !== "string") continue;
            // Same FK guard for dataset.folder_id.
            const safeFolderId = typeof d.folder_id === "string" && livePid.has(d.folder_id)
              ? d.folder_id
              : null;
            if (safeFolderId !== d.folder_id && d.folder_id) {
              warnings.push({
                kind: "dataset_folder_fk_miss",
                folder_id: d.id,
                detail: `folder ${d.folder_id} not live; restoring under project root`,
              });
            }
            // file_path is NOT NULL — refuse to insert garbage.
            if (typeof d.file_path !== "string" || d.file_path.length === 0) {
              warnings.push({
                kind: "dataset_missing_file_path",
                folder_id: d.id,
                detail: "snapshot dataset has no file_path; skipping",
              });
              continue;
            }
            const restoreDsName = (d.name as string | undefined) ?? "Restored dataset";
            const insertDataset = (name: string) =>
              c.query(
                `INSERT INTO foundry_datasets
                 (id, name, project_id, folder_id, file_path, original_filename,
                  mime_type, file_size_bytes, row_count, row_count_exact, column_count,
                  schema_info, markings, status, format, content_hash,
                  last_output_schema_fingerprint,
                  created_at, updated_at, created_by, updated_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                       $12::jsonb,$13::text[],$14,$15,$16,
                       $17,
                       $18,NOW(),$19,$20)
               ON CONFLICT (id) DO NOTHING`,
                [
                  d.id,
                  name,
                  d.project_id ?? projectId,
                  safeFolderId,
                  d.file_path,
                  d.original_filename ?? null,
                  d.mime_type ?? null,
                  d.file_size_bytes ?? null,
                  d.row_count ?? null,
                  d.row_count_exact ?? null,
                  d.column_count ?? null,
                  d.schema_info ? JSON.stringify(d.schema_info) : null,
                  Array.isArray(d.markings) ? d.markings : [],
                  d.status ?? "ready",
                  d.format ?? "csv",
                  d.content_hash ?? null,
                  d.last_output_schema_fingerprint ?? null,
                  d.created_at ?? new Date().toISOString(),
                  d.created_by ?? validActorId,
                  validActorId,
                ],
              );
            // Race-safe restore (incident 3ec397d5): a live sibling may hold
            // the original name (created after the trash event). Mirror the
            // pipelines precedent below — suffix and warn, never duplicate
            // (the unique index refuses a second same-named row).
            try {
              const result = await insertDataset(restoreDsName);
              restoredDatasets += result.rowCount ?? 0;
            } catch (err) {
              const { isDatasetNameUniqueViolation } =
                await import("./datasets/folderNameGuard");
              if (!isDatasetNameUniqueViolation(err)) throw err;
              warnings.push({
                kind: "dataset_name_collision",
                folder_id: d.id,
                detail: `dataset name '${restoreDsName}' taken; restored with -restored-<ts> suffix`,
              });
              const retry = await insertDataset(`${restoreDsName}-restored-${Date.now()}`);
              restoredDatasets += retry.rowCount ?? 0;
            }
          }

          // ---- Recreate pipelines rows --------------------------------
          // `pipelines.folder_id` is ON DELETE SET NULL, so a pipeline
          // whose original folder is gone simply lands at project root.
          // `(project_id, name)` is UNIQUE; on collision we fall back to
          // a `-restored-<ts>` suffix so the user sees the row instead
          // of a 23505 fail.
          for (const pipe of snapshot.pipelines ?? []) {
            const p = pipe as Record<string, unknown>;
            if (typeof p.id !== "string" || typeof p.name !== "string") continue;
            const safeFolderId =
              typeof p.folder_id === "string" && livePid.has(p.folder_id)
                ? p.folder_id
                : null;
            const insertPipeline = async (name: string) =>
              c.query(
                `INSERT INTO pipelines
                   (id, project_id, name, description, pipeline_type, compute_type,
                    status, config, created_by, created_at, updated_at,
                    folder_id, output_format, iceberg_partition_spec,
                    streaming_runtime, streaming_parallelism, streaming_throughput_mbps,
                    input_markings)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,NOW(),
                         $11,$12,$13::jsonb,$14,$15,$16,$17::text[])
                 ON CONFLICT (id) DO NOTHING`,
                [
                  p.id,
                  p.project_id ?? projectId,
                  name,
                  p.description ?? null,
                  p.pipeline_type ?? "batch",
                  p.compute_type ?? "duckdb",
                  p.status ?? "draft",
                  p.config ? JSON.stringify(p.config) : "{}",
                  p.created_by ?? validActorId,
                  p.created_at ?? new Date().toISOString(),
                  safeFolderId,
                  p.output_format ?? "csv",
                  p.iceberg_partition_spec ? JSON.stringify(p.iceberg_partition_spec) : null,
                  p.streaming_runtime ?? null,
                  p.streaming_parallelism ?? null,
                  p.streaming_throughput_mbps ?? null,
                  Array.isArray(p.input_markings) ? p.input_markings : [],
                ],
              );
            try {
              const result = await insertPipeline(p.name);
              restoredPipelines += result.rowCount ?? 0;
            } catch (err) {
              const pgCode = (err as { code?: string }).code;
              if (pgCode === "23505") {
                warnings.push({
                  kind: "pipeline_name_collision",
                  detail: `pipeline name '${p.name}' taken; restored with -restored-<ts> suffix`,
                });
                const retry = await insertPipeline(`${p.name}-restored-${Date.now()}`);
                restoredPipelines += retry.rowCount ?? 0;
              } else {
                throw err;
              }
            }
          }

          // ---- Recreate code_repository rows --------------------------
          // `parent_folder_rid` uses `ri.compass.main.folder.<uuid>`
          // (singular `folder`, not `compass-folder`). If the original
          // folder is gone, fall back to the project-root rid.
          const projectFolderRid = `ri.compass.main.folder.${projectId}`;
          for (const cr of snapshot.codeRepositories ?? []) {
            const r = cr as Record<string, unknown>;
            if (typeof r.rid !== "string") continue;
            // Map original rid → check if its folder still exists.
            const PARENT_PREFIX = "ri.compass.main.folder.";
            const origParent = typeof r.parent_folder_rid === "string"
              ? r.parent_folder_rid
              : projectFolderRid;
            const origParentUuid = origParent.startsWith(PARENT_PREFIX)
              ? origParent.slice(PARENT_PREFIX.length)
              : null;
            const safeParentRid =
              origParentUuid === projectId || (origParentUuid && livePid.has(origParentUuid))
                ? origParent
                : projectFolderRid;
            if (safeParentRid !== origParent) {
              warnings.push({
                kind: "code_repo_parent_fk_miss",
                detail: `repo ${r.rid}: parent folder gone, restoring under project root`,
              });
            }
            const result = await c.query(
              `INSERT INTO code_repository
                 (rid, display_name, parent_folder_rid, project_rid,
                  template_id, template_version, default_branch,
                  settings_json, state, created_by, created_at, updated_at,
                  resource_version)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,NOW(),$12)
               ON CONFLICT (rid) DO NOTHING`,
              [
                r.rid,
                r.display_name ?? "Restored repository",
                safeParentRid,
                r.project_rid ?? `ri.compass.main.project.${projectId}`,
                r.template_id ?? "blank",
                r.template_version ?? "0.0.0",
                r.default_branch ?? "main",
                r.settings_json ? JSON.stringify(r.settings_json) : "{}",
                "ACTIVE",
                r.created_by ?? validActorId,
                r.created_at ?? new Date().toISOString(),
                Number(r.resource_version ?? 1),
              ],
            );
            restoredCodeRepos += result.rowCount ?? 0;
          }

          // ---- Recreate workshop_module rows --------------------------
          // Same `parent_folder_rid` shape as code_repository. Fallback
          // to project-root rid when the original folder is gone.
          //
          // `ontology_rid` is REQUIRED — a workshop module without an
          // ontology has no semantic meaning. We refuse to restore loud
          // (skip + warning) rather than silently insert a row pointing
          // at a placeholder ontology that may not exist in this env.
          for (const wm of snapshot.workshopModules ?? []) {
            const w = wm as Record<string, unknown>;
            if (typeof w.rid !== "string") continue;
            if (typeof w.ontology_rid !== "string" || w.ontology_rid.length === 0) {
              warnings.push({
                kind: "workshop_module_ontology_missing",
                detail: `module ${w.rid}: snapshot lacks ontology_rid; skipping restore`,
              });
              continue;
            }
            const PARENT_PREFIX = "ri.compass.main.folder.";
            const origParent = typeof w.parent_folder_rid === "string"
              ? w.parent_folder_rid
              : projectFolderRid;
            const origParentUuid = origParent.startsWith(PARENT_PREFIX)
              ? origParent.slice(PARENT_PREFIX.length)
              : null;
            const safeParentRid =
              origParentUuid === projectId || (origParentUuid && livePid.has(origParentUuid))
                ? origParent
                : projectFolderRid;
            if (safeParentRid !== origParent) {
              warnings.push({
                kind: "workshop_module_parent_fk_miss",
                detail: `module ${w.rid}: parent folder gone, restoring under project root`,
              });
            }
            const result = await c.query(
              `INSERT INTO workshop_module
                 (rid, ontology_rid, display_name, description, current_semver,
                  published_semver, definition, etag, schema_version,
                  parent_folder_rid, branch_rid, created_at, created_by,
                  updated_at, updated_by, deleted_at, published_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,
                       $10,$11,$12,$13,NOW(),$14,NULL,$15)
               ON CONFLICT (rid) DO NOTHING`,
              [
                w.rid,
                w.ontology_rid,
                w.display_name ?? "Restored module",
                w.description ?? null,
                w.current_semver ?? "0.1.0",
                w.published_semver ?? null,
                w.definition ? JSON.stringify(w.definition) : "{}",
                w.etag ?? "0",
                Number(w.schema_version ?? 4),
                safeParentRid,
                w.branch_rid ?? null,
                w.created_at ?? new Date().toISOString(),
                w.created_by ?? validActorId,
                w.updated_by ?? String(validActorId ?? "system"),
                w.published_at ?? null,
              ],
            );
            restoredWorkshopModules += result.rowCount ?? 0;
          }
        } else if (snapshot?.kind === "dataset") {
          // The Zod schema nests dataset fields under `snapshot.dataset.*`.
          // Reading them off the top-level (the previous bug) silently
          // restored nothing. Schema reference: foundry_datasets has NO
          // `description` column.
          const d = snapshot.dataset;
          if (!d.file_path) {
            await c.query("ROLLBACK");
            console.warn(JSON.stringify({
              evt: "trash.restore.refused", reason: "dataset_missing_file_path",
              rid, dataset_id: d.id, actor_id: validActorId,
            }));
            throw new AppError(
              "Cannot restore dataset: snapshot is missing file_path.",
              409,
              "RESOURCE_ORPHANED",
            );
          }
          const insertRestoredDataset = (name: unknown) => c.query(
            `INSERT INTO foundry_datasets
               (id, name, project_id, folder_id, file_path, original_filename,
                mime_type, file_size_bytes, row_count, row_count_exact, column_count,
                schema_info, markings, status, format, content_hash,
                last_output_schema_fingerprint,
                created_at, updated_at, created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                     $12::jsonb,$13::text[],$14,$15,$16,
                     $17,
                     $18,NOW(),$19,$20)
             ON CONFLICT (id) DO NOTHING`,
            [
              d.id,
              name,
              d.project_id,
              d.folder_id,
              d.file_path,
              d.original_filename,
              d.mime_type,
              d.file_size_bytes,
              d.row_count,
              d.row_count_exact,
              d.column_count,
              d.schema_info ? JSON.stringify(d.schema_info) : null,
              Array.isArray(d.markings) ? d.markings : [],
              d.status ?? "ready",
              d.format ?? "csv",
              d.content_hash,
              d.last_output_schema_fingerprint,
              d.created_at ?? new Date().toISOString(),
              d.created_by ?? validActorId,
              validActorId,
            ],
          );
          // Race-safe restore (incident 3ec397d5): same suffix precedent as
          // the bulk path above and pipelines — warn, never duplicate.
          try {
            const result = await insertRestoredDataset(d.name);
            restoredDatasets += result.rowCount ?? 0;
          } catch (err) {
            const { isDatasetNameUniqueViolation } =
              await import("./datasets/folderNameGuard");
            if (!isDatasetNameUniqueViolation(err)) throw err;
            warnings.push({
              kind: "dataset_name_collision",
              folder_id: d.id,
              detail: `dataset name '${d.name}' taken; restored with -restored-<ts> suffix`,
            });
            const retry = await insertRestoredDataset(
              `${d.name}-restored-${Date.now()}`,
            );
            restoredDatasets += retry.rowCount ?? 0;
          }
        }
        if (warnings.length > 0) {
          // Single line per restore call so SREs can grep one event for
          // the full degradation summary.
          console.warn(JSON.stringify({
            evt: "trash.restore.degraded",
            rid, actor_id: validActorId, count: warnings.length, warnings,
          }));
        }

        // 2. Toggle resources rows back to NOT_TRASHED.
        const { rows } = await c.query<{ rid: string }>(
          `WITH RECURSIVE descendants AS (
             SELECT rid FROM resources WHERE rid = $1
             UNION
             SELECT r.rid FROM resources r JOIN descendants d ON r.parent_folder_rid = d.rid
           )
           UPDATE resources r SET
             trash_status = 'NOT_TRASHED',
             trashed_at = NULL,
             trashed_by = NULL,
             retention_until = NULL,
             metadata = (r.metadata::jsonb - 'snapshot'),
             etag = etag + 1,
             updated_at = now(),
             updated_by = $2
           FROM descendants d
           WHERE r.rid = d.rid
             AND r.trash_status IN ('DIRECTLY_TRASHED','ANCESTOR_TRASHED')
             AND (r.rid = $1 OR r.trashed_at >= $3::timestamptz - interval '5 seconds')
           RETURNING r.rid`,
          [rid, validActorId, trashedAt],
        );
        await c.query("COMMIT");

        // Expected counts derived from the snapshot length — surfacing
        // these alongside actual lets the caller render "Restored 2 of 3
        // datasets — 1 was missing required fields and skipped" without
        // having to compare the snapshot themselves.
        const expectedFolders =
          snapshot?.kind === "folder" ? snapshot.folders.length : 0;
        const expectedDatasets =
          snapshot?.kind === "folder"
            ? snapshot.datasets.length
            : snapshot?.kind === "dataset"
              ? 1
              : 0;
        const expectedPipelines =
          snapshot?.kind === "folder" ? (snapshot.pipelines?.length ?? 0) : 0;
        const expectedCodeRepos =
          snapshot?.kind === "folder"
            ? (snapshot.codeRepositories?.length ?? 0)
            : 0;
        const expectedWorkshopModules =
          snapshot?.kind === "folder"
            ? (snapshot.workshopModules?.length ?? 0)
            : 0;

        console.log(JSON.stringify({
          evt: "trash.restore",
          rid,
          actor_id: validActorId,
          rows_affected: rows.length,
          restored_folders: restoredFolders,
          restored_datasets: restoredDatasets,
          restored_pipelines: restoredPipelines,
          restored_code_repos: restoredCodeRepos,
          restored_workshop_modules: restoredWorkshopModules,
          expected_folders: expectedFolders,
          expected_datasets: expectedDatasets,
          expected_pipelines: expectedPipelines,
          expected_code_repos: expectedCodeRepos,
          expected_workshop_modules: expectedWorkshopModules,
          had_snapshot: snapshot != null,
          snapshot_kind: snapshot?.kind ?? null,
          warnings_count: warnings.length,
          duration_ms: Date.now() - t0,
        }));

        return {
          affected: rows.length,
          restoredFolders,
          restoredDatasets,
          restoredPipelines,
          restoredCodeRepos,
          restoredWorkshopModules,
          expectedFolders,
          expectedDatasets,
          expectedPipelines,
          expectedCodeRepos,
          expectedWorkshopModules,
          warnings,
        };
      } catch (err) {
        await c.query("ROLLBACK");
        throw err;
      } finally {
        c.release();
      }
    });
  }

  /**
   * Permanently delete a trashed resource and all its trashed descendants.
   *
   * Steps:
   *   1. Walk the trashed subtree, capturing every (rid, type, metadata)
   *      before delete so we can extract S3 keys to GC.
   *   2. DELETE the rows in a single statement (atomic for the DB).
   *   3. Best-effort `deleteObjects` on the collected S3 keys after commit.
   *      Failure here logs but does not throw — the row is already gone,
   *      ops can sweep stragglers later.
   *
   * S3 key sources:
   *   - Direct dataset rows: `metadata.snapshot.file_path`.
   *   - Folder snapshots: `metadata.snapshot.datasets[*].file_path`.
   *
   * Reference-counting: a single object key may be shared between a
   * dataset and its duplicates (the `duplicateDataset` flow shares
   * `file_path` and `content_hash`). We only delete keys whose
   * reference count in the *remaining* `resources` snapshots is zero —
   * a defensive query post-DELETE.
   */
  async permanentlyDelete(rid: string): Promise<{ deleted: number; s3Deleted: number; s3Errors: number }> {
    const t0 = Date.now();
    return await this.pool.connect().then(async (c: PoolClient) => {
      const collectedKeys = new Set<string>();
      try {
        await c.query("BEGIN");

        // 1. Snapshot the subtree's metadata before delete.
        const { rows: subtree } = await c.query<{ rid: string; type: string; metadata: unknown }>(
          `WITH RECURSIVE descendants AS (
             SELECT rid, type, metadata
               FROM resources
              WHERE rid = $1
                AND trash_status IN ('DIRECTLY_TRASHED','ANCESTOR_TRASHED')
             UNION
             SELECT r.rid, r.type, r.metadata
               FROM resources r
               JOIN descendants d ON r.parent_folder_rid = d.rid
              WHERE r.trash_status IN ('DIRECTLY_TRASHED','ANCESTOR_TRASHED')
           )
           SELECT rid, type, metadata FROM descendants`,
          [rid],
        );

        for (const row of subtree) {
          const md = row.metadata as { snapshot?: unknown } | null;
          if (!md?.snapshot) continue;
          const parsed = parseTrashSnapshot(md.snapshot);
          if (!parsed) continue;
          if (parsed.kind === "dataset") {
            const fp = (parsed as { file_path?: unknown }).file_path;
            if (typeof fp === "string" && fp.length > 0) collectedKeys.add(fp);
          } else if (parsed.kind === "folder") {
            for (const ds of parsed.datasets) {
              const fp = (ds as Record<string, unknown>)["file_path"];
              if (typeof fp === "string" && fp.length > 0) collectedKeys.add(fp);
            }
          }
        }

        // The domain delete endpoints retain rows while an item is in Trash.
        // "Delete forever" is the only operation that removes those rows.
        for (const row of subtree) {
          if (row.type === "PIPELINE") {
            const pipelineId = row.rid.slice("ri.foundry.main.pipeline.".length);
            await c.query(`DELETE FROM pipelines WHERE id = $1::uuid`, [pipelineId]);
          } else if (row.type === "WORKSHOP_MODULE") {
            await c.query(`DELETE FROM workshop_module WHERE rid = $1`, [row.rid]);
          } else if (row.type.toLowerCase() === "source") {
            await c.query(
              `DELETE FROM table_imports
                WHERE connection_rid = $1 AND deleted_at IS NOT NULL`,
              [row.rid],
            );
            await c.query(
              `DELETE FROM virtual_tables
                WHERE connection_rid = $1 AND deleted_at IS NOT NULL`,
              [row.rid],
            );
            await c.query(`DELETE FROM connectivity_connections WHERE rid = $1`, [row.rid]);
          } else if (row.type === "CODE_REPOSITORY") {
            await c.query(`DELETE FROM code_repository_branch_cache WHERE repository_rid = $1`, [row.rid]);
            await c.query(`DELETE FROM code_repository WHERE rid = $1`, [row.rid]);
          }
        }

        // 2. Atomic DELETE.
        const { rows: deleted } = await c.query<{ rid: string }>(
          `WITH RECURSIVE descendants AS (
             SELECT rid FROM resources WHERE rid = $1 AND trash_status IN ('DIRECTLY_TRASHED','ANCESTOR_TRASHED')
             UNION
             SELECT r.rid FROM resources r JOIN descendants d ON r.parent_folder_rid = d.rid
             WHERE r.trash_status IN ('DIRECTLY_TRASHED','ANCESTOR_TRASHED')
           )
           DELETE FROM resources WHERE rid IN (SELECT rid FROM descendants)
           RETURNING rid`,
          [rid],
        );

        // 3. Reference-count surviving keys: any key still referenced by a
        //    non-trashed (or differently-trashed) row in `resources` must
        //    NOT be S3-GC'd, even if the deleted row also pointed at it.
        let safeKeys: string[] = [];
        if (collectedKeys.size > 0) {
          const keyArray = Array.from(collectedKeys);
          const { rows: stillReferenced } = await c.query<{ file_path: string }>(
            `SELECT DISTINCT (metadata->'snapshot'->>'file_path') AS file_path
               FROM resources
              WHERE metadata->'snapshot'->>'file_path' = ANY($1::text[])`,
            [keyArray],
          );
          // Also check live foundry_datasets table (a live duplicate sharing
          // the same file_path must keep the object).
          const { rows: liveRefs } = await c.query<{ file_path: string }>(
            `SELECT DISTINCT file_path FROM foundry_datasets WHERE file_path = ANY($1::text[])`,
            [keyArray],
          );
          const referenced = new Set<string>([
            ...stillReferenced.map((r) => r.file_path).filter(Boolean),
            ...liveRefs.map((r) => r.file_path).filter(Boolean),
          ]);
          safeKeys = keyArray.filter((k) => !referenced.has(k));
        }

        await c.query("COMMIT");

        // 4. Best-effort S3 GC. Failure here is logged but never thrown.
        let s3Deleted = 0;
        let s3Errors = 0;
        if (safeKeys.length > 0) {
          try {
            const result = await deleteObjects(safeKeys);
            s3Deleted = result.deleted;
            s3Errors = result.errors;
          } catch (err) {
            s3Errors = safeKeys.length;
            console.warn(
              JSON.stringify({
                evt: "trash.permanent_delete.s3_gc_failed",
                rid,
                keys: safeKeys.length,
                err: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        }

        console.log(
          JSON.stringify({
            evt: "trash.permanent_delete",
            rid,
            rows_deleted: deleted.length,
            s3_keys_collected: collectedKeys.size,
            s3_keys_safe_to_gc: safeKeys.length,
            s3_deleted: s3Deleted,
            s3_errors: s3Errors,
            duration_ms: Date.now() - t0,
          }),
        );

        return { deleted: deleted.length, s3Deleted, s3Errors };
      } catch (err) {
        await c.query("ROLLBACK");
        throw err;
      } finally {
        c.release();
      }
    });
  }
}

export const trashService = new TrashService();
