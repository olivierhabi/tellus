// ---------------------------------------------------------------------------
// /api/v1/projects/:projectId/{trashed,file-references,external-references}
//
// Production project-workspace endpoints supporting the new sub-tabs:
//   - GET  /trashed              — list resources in TRASHED state
//   - GET  /file-references      — resource_dependencies edges within project
//   - GET  /external-references  — project_references rows (cross-project imports)
//
// Plus, mounted separately at /api/v1/resources:
//   - POST /:rid/restore               — clear trash flag (+descendants)
//   - POST /:rid/permanently-delete    — hard delete trashed rows
//
// All routes are auth-gated (project membership), zod-validated, and
// emit the standard `{ success, data }` envelope.
// ---------------------------------------------------------------------------
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { TrashService } from "../services/trashService";
import { ProjectReferenceService } from "../services/projectReferenceService";
import { buildTrashedQuery } from "../services/trashedQuery";
import { pool } from "../db";
import { toIso, toIsoRequired } from "../utils/dates";

interface AuthedRequest extends Request {
  user?: { id: string; role?: string; roles?: string[] };
}

function userId(req: Request): string {
  const u = (req as AuthedRequest).user;
  if (!u?.id) {
    const err: Error & { status?: number } = new Error("UNAUTHENTICATED");
    err.status = 401;
    throw err;
  }
  return u.id;
}

// ---------------------------------------------------------------------------
// Zod schemas at the trust boundary — fail-loud on bad input.
// ---------------------------------------------------------------------------

const TrashedQuery = z.object({
  parentRid: z.string().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
const ResourceRidParam = z.object({
  rid: z.string().min(1).regex(/^ri\.[a-z0-9-]+\.[a-z0-9-]+\.[a-z0-9-_]+\..+$/, "INVALID_RID"),
});

// ---------------------------------------------------------------------------
// Project-scoped router (mounted at /api/v1/projects/:projectId)
// ---------------------------------------------------------------------------
export const projectWorkspaceRouter: Router = Router({ mergeParams: true });

const trashService = new TrashService(pool);
const projectReferenceService = new ProjectReferenceService(pool);

// GET /trashed?parentRid=&pageSize=
//
// Lists trashed resources scoped to the project. When `parentRid` is set,
// scopes to a folder; otherwise lists every trashed row whose
// `project_rid` matches this project's root.
projectWorkspaceRouter.get(
  "/trashed",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      userId(req); // throws 401 if missing
      const projectId = req.params.projectId as string;
      const parsed = TrashedQuery.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          success: false,
          error: { code: "INVALID_ARGUMENT", message: "Invalid query parameters", issues: parsed.error.issues },
        });
      }
      // SQL composition is extracted to `services/trashedQuery.ts` so
      // the scope-semantics decision (no parentRid → project-wide; with
      // parentRid → folder-scoped) is unit-testable. See
      // `tests/unit/services/trashedQuery-unit.test.ts` for the pinned
      // contract that prevents the wrong-rid regression from shipping
      // again.
      const { sql, params } = buildTrashedQuery({
        projectId,
        parentRid: parsed.data.parentRid,
        pageSize: parsed.data.pageSize,
      });

      const result = await pool.query<{
        rid: string;
        display_name: string;
        type: string;
        trash_status: string;
        trashed_at: Date | string | null;
        trashed_by: string | null;
        retention_until: Date | string | null;
        parent_folder_rid: string | null;
        created_at: Date | string;
        updated_at: Date | string;
        trashed_by_email: string | null;
      }>(sql, params);

      res.json({
        success: true,
        data: {
          items: result.rows.map((r) => ({
            rid: r.rid,
            displayName: r.display_name,
            type: r.type,
            trashStatus: r.trash_status,
            trashedAt: toIso(r.trashed_at),
            trashedBy: r.trashed_by,
            trashedByEmail: r.trashed_by_email,
            retentionUntil: toIso(r.retention_until),
            parentFolderRid: r.parent_folder_rid,
            createdAt: toIsoRequired(r.created_at),
            updatedAt: toIsoRequired(r.updated_at),
          })),
          pageSize: parsed.data.pageSize,
        },
      });
    } catch (err) {
      const e = err as { status?: number };
      if (e.status === 401) return res.status(401).json({ success: false, error: { code: "UNAUTHENTICATED", message: "Authentication required" } });
      next(err);
    }
  },
);

// GET /file-references
//
// Lists resource-graph edges (resource_dependencies) where the
// upstream OR downstream is a resource owned by this project. Returns
// pairs split into "outgoing" (project → other project's resource) and
// "incoming" (someone else's resource → this project) so the FE can
// render two lists.
projectWorkspaceRouter.get(
  "/file-references",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      userId(req);
      const projectId = req.params.projectId as string;
      const projectRid = `ri.compass.main.project.${projectId}`;

      // Edges where one endpoint belongs to this project (resources.project_rid = projectRid).
      const sql = `
        WITH project_rids AS (
          SELECT rid FROM resources WHERE project_rid = $1 OR rid = $1
        )
        SELECT
          rd.upstream_rid,
          rd.downstream_rid,
          rd.edge_type,
          rd.created_at,
          ru.display_name AS upstream_name,
          ru.type AS upstream_type,
          ru.project_rid AS upstream_project_rid,
          rd_.display_name AS downstream_name,
          rd_.type AS downstream_type,
          rd_.project_rid AS downstream_project_rid,
          CASE
            WHEN rd.upstream_rid IN (SELECT rid FROM project_rids) THEN 'outgoing'
            WHEN rd.downstream_rid IN (SELECT rid FROM project_rids) THEN 'incoming'
            ELSE 'unknown'
          END AS direction
        FROM resource_dependencies rd
        LEFT JOIN resources ru ON ru.rid = rd.upstream_rid
        LEFT JOIN resources rd_ ON rd_.rid = rd.downstream_rid
        WHERE rd.upstream_rid IN (SELECT rid FROM project_rids)
           OR rd.downstream_rid IN (SELECT rid FROM project_rids)
        ORDER BY rd.created_at DESC
        LIMIT 500`;

      const { rows } = await pool.query(sql, [projectRid]);
      const outgoing: unknown[] = [];
      const incoming: unknown[] = [];
      for (const r of rows) {
        const item = {
          upstreamRid: r.upstream_rid,
          downstreamRid: r.downstream_rid,
          upstreamName: r.upstream_name,
          upstreamType: r.upstream_type,
          downstreamName: r.downstream_name,
          downstreamType: r.downstream_type,
          edgeType: r.edge_type,
          createdAt: toIso(r.created_at) ?? "",
        };
        if (r.direction === "outgoing") outgoing.push(item);
        else if (r.direction === "incoming") incoming.push(item);
      }
      res.json({ success: true, data: { outgoing, incoming } });
    } catch (err) {
      const e = err as { status?: number };
      if (e.status === 401) return res.status(401).json({ success: false, error: { code: "UNAUTHENTICATED", message: "Authentication required" } });
      next(err);
    }
  },
);

// GET /external-references
//
// Lists project_references rows for this project (resources from OTHER
// projects that this project imports), plus inverse rows (other
// projects that import resources from this project).
projectWorkspaceRouter.get(
  "/external-references",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      userId(req);
      const projectId = req.params.projectId as string;
      const projectRid = `ri.compass.main.project.${projectId}`;

      // Outgoing: this project owns the reference.
      const outRids = await projectReferenceService.listReferences(projectRid);
      // Incoming: this project's resources are referenced by someone else.
      const incomingProjects = await pool.query<{ owner_project_rid: string; referenced_resource_rid: string; reference_type: string; created_at: Date }>(
        `SELECT pr.owner_project_rid, pr.referenced_resource_rid, pr.reference_type, pr.created_at
         FROM project_references pr
         JOIN resources r ON r.rid = pr.referenced_resource_rid
         WHERE r.project_rid = $1 OR r.rid = $1`,
        [projectRid],
      );

      // Hydrate outgoing rids with display metadata.
      let outgoing: unknown[] = [];
      if (outRids.length > 0) {
        const meta = await pool.query<{ rid: string; display_name: string; type: string; project_rid: string | null }>(
          `SELECT rid, display_name, type, project_rid FROM resources WHERE rid = ANY($1::text[])`,
          [outRids],
        );
        const byRid = new Map(meta.rows.map((r) => [r.rid, r]));
        outgoing = outRids.map((rid) => {
          const m = byRid.get(rid);
          return {
            referencedRid: rid,
            referencedName: m?.display_name ?? null,
            referencedType: m?.type ?? null,
            referencedProjectRid: m?.project_rid ?? null,
          };
        });
      }

      res.json({
        success: true,
        data: {
          outgoing,
          incoming: incomingProjects.rows.map((r) => ({
            ownerProjectRid: r.owner_project_rid,
            referencedRid: r.referenced_resource_rid,
            referenceType: r.reference_type,
            // toIso handles both `Date` and `string` arrivals. Direct
            // `.toISOString()` here was a latent crash identical to the
            // one fixed in /trashed (pg pool can return strings).
            createdAt: toIso(r.created_at) ?? "",
          })),
        },
      });
    } catch (err) {
      const e = err as { status?: number };
      if (e.status === 401) return res.status(401).json({ success: false, error: { code: "UNAUTHENTICATED", message: "Authentication required" } });
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Resource-scoped router (mounted at /api/v1/resources)
// ---------------------------------------------------------------------------
export const resourceLifecycleRouter: Router = Router();

// Restore a trashed resource.
//
// Two modes, dispatched on `resources.type`:
//   1. FOUNDRY_DATASET — the resources row is a snapshot mirror. Restore
//      means re-creating the dataset (and its columns/versions) from
//      `metadata.snapshot`, then dropping the mirror row.
//   2. Everything else — the resources row IS the source of truth.
//      Restore means flipping `trash_status` back to NOT_TRASHED via
//      the generic TrashService.
//
// Both paths run atomically: a partial failure rolls back so the user
// either sees the row fully restored or fully trashed, never half.
resourceLifecycleRouter.post(
  "/:rid/restore",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actorId = userId(req);
      const parsed = ResourceRidParam.safeParse(req.params);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "Invalid RID", issues: parsed.error.issues } });
      }
      const rid = parsed.data.rid;

      // Look up the row's `type` so we know which restore path to take.
      const lookup = await pool.query<{ type: string; metadata: { snapshot?: unknown } | null }>(
        `SELECT type, metadata FROM resources WHERE rid = $1`,
        [rid],
      );
      if (lookup.rows.length === 0) {
        return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Resource not found" } });
      }
      const { type, metadata } = lookup.rows[0];

      // FOUNDRY_DATASET mirror — re-create the dataset from snapshot.
      if (type === "FOUNDRY_DATASET" && metadata && (metadata as { snapshot?: unknown }).snapshot) {
        const snap = (metadata as { snapshot: { dataset: Record<string, unknown>; columns?: Array<Record<string, unknown>>; versions?: Array<Record<string, unknown>> } }).snapshot;
        const ds = snap.dataset;

        const client = await pool.connect();
        try {
          await client.query("BEGIN");

          // Re-INSERT the dataset row with its original ID. ON CONFLICT
          // is defensive — if for some reason the row exists already
          // (operator manually undid the delete), don't double-create.
          // markings is `text[]` (not jsonb) — pass the JS array directly
          // and let pg drive the array codec.  schema_info is jsonb.
          await client.query(
            `INSERT INTO foundry_datasets (
               id, name, folder_id, project_id,
               file_path, original_filename, mime_type,
               file_size_bytes, row_count, row_count_exact, column_count,
               schema_info, markings, status, format, content_hash,
               last_output_schema_fingerprint,
               created_at, updated_at, created_by, updated_by
             ) VALUES (
               $1, $2, $3, $4,
               $5, $6, $7,
               $8, $9, $10, $11,
               $12::jsonb, $13::text[], $14, $15, $16,
               $17,
               $18, now(), $19, $20
             )
             ON CONFLICT (id) DO NOTHING`,
            [
              ds.id, ds.name, ds.folder_id, ds.project_id,
              ds.file_path, ds.original_filename, ds.mime_type,
              ds.file_size_bytes, ds.row_count, ds.row_count_exact, ds.column_count,
              ds.schema_info ? JSON.stringify(ds.schema_info) : null,
              Array.isArray(ds.markings) ? ds.markings : null,
              ds.status, ds.format, ds.content_hash,
              ds.last_output_schema_fingerprint,
              ds.created_at, ds.created_by ?? actorId, actorId,
            ],
          );

          // Re-INSERT columns
          if (snap.columns && snap.columns.length > 0) {
            for (const c of snap.columns) {
              await client.query(
                `INSERT INTO dataset_columns (dataset_id, column_name, column_type, ordinal_position, nullable, sample_values)
                 VALUES ($1, $2, $3, $4, $5, $6::jsonb)
                 ON CONFLICT DO NOTHING`,
                [ds.id, c.column_name, c.column_type, c.ordinal_position, c.nullable, c.sample_values ? JSON.stringify(c.sample_values) : null],
              );
            }
          }

          // Re-INSERT versions
          if (snap.versions && snap.versions.length > 0) {
            for (const v of snap.versions) {
              await client.query(
                `INSERT INTO dataset_versions (id, dataset_id, version_number, file_path, row_count, row_count_exact, file_size_bytes, schema_info, content_hash, created_at, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
                 ON CONFLICT (id) DO NOTHING`,
                [v.id, ds.id, v.version_number, v.file_path, v.row_count, v.row_count_exact, v.file_size_bytes, v.schema_info ? JSON.stringify(v.schema_info) : null, v.content_hash, v.created_at, v.created_by ?? actorId],
              );
            }
          }

          // Restore the resources row to NOT_TRASHED + drop the snapshot
          // key from metadata. We don't DELETE the row because it may
          // have pre-existed our trash event (e.g., the dataset was
          // registered in compass at creation time) — deleting it would
          // remove that pre-existing registration. The snapshot is no
          // longer needed because the source-of-truth dataset is back.
          await client.query(
            `UPDATE resources SET
               trash_status = 'NOT_TRASHED',
               trashed_at = NULL,
               trashed_by = NULL,
               retention_until = NULL,
               metadata = metadata - 'snapshot',
               updated_by = $2,
               updated_at = now(),
               etag = etag + 1
             WHERE rid = $1`,
            [rid, actorId],
          );

          await client.query("COMMIT");
          return res.json({
            success: true,
            data: { restored: true, kind: "FOUNDRY_DATASET", datasetId: ds.id, displayName: ds.name },
          });
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
      }

      // Generic restore for non-mirror trashed rows (workspaces, folders, etc.).
      const result = await trashService.restore(rid, actorId);
      res.json({ success: true, data: result });
    } catch (err) {
      const e = err as { status?: number };
      if (e.status === 401) return res.status(401).json({ success: false, error: { code: "UNAUTHENTICATED", message: "Authentication required" } });
      next(err);
    }
  },
);

resourceLifecycleRouter.post(
  "/:rid/permanently-delete",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      userId(req);
      const parsed = ResourceRidParam.safeParse(req.params);
      if (!parsed.success) {
        return res.status(400).json({ success: false, error: { code: "INVALID_ARGUMENT", message: "Invalid RID", issues: parsed.error.issues } });
      }
      const result = await trashService.permanentlyDelete(parsed.data.rid);
      res.json({ success: true, data: result });
    } catch (err) {
      const e = err as { status?: number };
      if (e.status === 401) return res.status(401).json({ success: false, error: { code: "UNAUTHENTICATED", message: "Authentication required" } });
      next(err);
    }
  },
);

export default projectWorkspaceRouter;
