// ---------------------------------------------------------------------------
// Foundry-parity Datasets API (v1 surface).
//
// A faithful imitation of Palantir Foundry's v2 Datasets resource, served under
// this backend's v1 path so any app on the platform can address a dataset by
// its RID:
//
//   POST /api/v1/datasets                      (Create Dataset)
//   GET  /api/v1/datasets/:datasetRid          (Get Dataset)
//   GET  /api/v1/datasets/:datasetRid/preview  (bounded data preview)
//
// (Foundry refs:
//   .../datasets-v2-resources/datasets/create-dataset/
//   .../datasets-v2-resources/datasets/get-dataset/ )
//
// Everything is keyed by the dataset RID — NOT by the sync/import that produced
// it — so Dataset Preview is an independent, app-agnostic resource view.
//
// This router is mounted FIRST on /api/v1/datasets. Its create route claims the
// bare POST; its by-RID GET routes claim only `ri.foundry.main.dataset.*` and
// fall through (next()) for the legacy UUID-keyed upload/object-explorer
// datasets routers, so those continue to work unchanged.
//
// Errors use the Conjure envelope { errorCode, errorName, errorInstanceId,
// parameters } — the same shape Foundry returns — with Foundry's public names:
//   Default:InvalidArgument · Default:Unauthorized · Default:Internal
//   Datasets:InvalidDisplayName · Datasets:CreateDatasetPermissionDenied
//   Datasets:FolderNotFound · Datasets:ResourceNameAlreadyExists
//   Datasets:DatasetNotFound · Datasets:ViewDatasetPermissionDenied
// ---------------------------------------------------------------------------

import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { ErrorCategory, ErrorDefinition } from "../lib/errors/registry";
import { buildEnvelope } from "../lib/errors/envelope";
import {
  createDataset,
  ParentFolderNotFound,
  DatasetNameAlreadyExists,
} from "../services/datasets/foundry-dataset.repo";
import {
  resolveDataset,
  latestBuildForImport,
  isFoundryDatasetRid,
} from "../services/datasets/dataset-resolver";
import { readSyncedPreview } from "../services/datasets/synced-dataset-reader";
import { readUploadedPreview } from "../services/datasets/uploaded-dataset-reader";
import { resolveDatasetColumns } from "../services/datasets/datasetColumns";
import { pool } from "../db";

/** Bare registry UUID form of a dataset reference (no RID wrapper). */
const BARE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Claim rule for the preview route.
 *
 * Canonical Foundry RIDs are always claimed. A bare UUID is claimed ONLY
 * when it resolves to an Iceberg-backed `foundry_datasets` row: those
 * datasets have a synthetic `iceberg://…` file_path that the legacy
 * object-storage preview (the fall-through handler) cannot read — it
 * fails with DATASOURCE_FILE_NOT_FOUND. Upload-backed bare UUIDs keep
 * falling through to the legacy preview so its established response
 * shape is preserved for existing consumers (pipeline builder, object
 * explorer).
 */
async function claimPreviewTarget(rawId: string): Promise<string | null> {
  if (isFoundryDatasetRid(rawId)) return rawId;
  if (!BARE_UUID_RE.test(rawId)) return null;
  const r = await pool.query<{ format: string | null; file_path: string | null }>(
    "SELECT format, file_path FROM foundry_datasets WHERE id = $1",
    [rawId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const icebergBacked =
    row.format === "iceberg" ||
    (typeof row.file_path === "string" && row.file_path.startsWith("iceberg://"));
  return icebergBacked ? `ri.foundry.main.dataset.${rawId}` : null;
}

export const foundryDatasetsV1Router = Router();

const PREVIEW_DEFAULT_ROWS = 50;
const PREVIEW_MAX_ROWS = 500;

// --- Foundry-exact error envelopes ------------------------------------------
function fdef(
  errorName: string,
  errorCode: ErrorCategory,
  httpStatus: number,
  description: string,
): ErrorDefinition {
  return { errorName, errorCode, httpStatus, description };
}
const ERR = {
  invalidArgument: fdef("Default:InvalidArgument", "INVALID_ARGUMENT", 400, "The request could not be parsed."),
  invalidName: fdef("Datasets:InvalidDisplayName", "INVALID_ARGUMENT", 400, "The provided display name is invalid."),
  unauthorized: fdef("Default:Unauthorized", "UNAUTHENTICATED", 401, "Authentication is required."),
  createDenied: fdef("Datasets:CreateDatasetPermissionDenied", "PERMISSION_DENIED", 403, "Could not create the Dataset."),
  viewDenied: fdef("Datasets:ViewDatasetPermissionDenied", "PERMISSION_DENIED", 403, "Could not view the Dataset."),
  folderNotFound: fdef("Datasets:FolderNotFound", "NOT_FOUND", 404, "The provided parent folder could not be found."),
  datasetNotFound: fdef("Datasets:DatasetNotFound", "NOT_FOUND", 404, "The requested dataset could not be found, or the client token does not have access to it."),
  nameExists: fdef("Datasets:ResourceNameAlreadyExists", "CONFLICT", 409, "A resource with the given name already exists in this folder."),
  internal: fdef("Default:Internal", "INTERNAL", 500, "An unexpected error occurred."),
} as const;

function sendErr(
  res: Response,
  def: ErrorDefinition,
  parameters: Record<string, unknown> = {},
): void {
  res.status(def.httpStatus).json(buildEnvelope(def, parameters));
}

// --- principal / scopes (globalAuth populates req.user) ----------------------
interface Principal {
  id: string;
  scopes: string[];
}
function readScopes(u: Record<string, unknown>): string[] {
  const raw = (u.scopes ?? u.scope ?? u.permissions ?? []) as
    | string[]
    | string
    | undefined;
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/\s+/).filter(Boolean)
      : [];
  const set = new Set<string>(list);
  const realm = (u.realm_access as { roles?: unknown } | undefined)?.roles;
  const roles = (u.roles ?? realm ?? []) as unknown;
  if (Array.isArray(roles)) {
    for (const r of roles) {
      if (typeof r === "string" && r.includes(":")) set.add(r);
    }
  }
  return [...set];
}
function principal(req: Request): Principal | null {
  const r = req as unknown as Record<string, unknown>;
  const u = (r.user ?? r.tellusUser ?? r.multipassUser) as
    | Record<string, unknown>
    | undefined;
  if (!u) return null;
  const id = (u.id ?? u.sub ?? u.userId) as string | undefined;
  if (!id) return null;
  return { id: String(id), scopes: readScopes(u) };
}
/**
 * Honour Foundry's `api:datasets-*` scopes (and the `api:*` / tellus
 * superuser wildcard). As a deployment-compatibility fallback, a principal
 * carrying no `api:` scopes at all (the typical role-scoped browser session) is
 * allowed — otherwise the endpoint would be unusable on stock tellus auth.
 * `write` implies `read`.
 */
function hasScope(scopes: string[], needed: "read" | "write"): boolean {
  if (scopes.includes("api:*") || scopes.includes("connectivity:*")) return true;
  if (scopes.includes("api:datasets-write")) return true;
  if (needed === "read" && scopes.includes("api:datasets-read")) return true;
  return !scopes.some((s) => s.startsWith("api:"));
}

// --- helpers -----------------------------------------------------------------
function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  return v == null ? "" : String(v);
}

function isValidDisplayName(name: string): boolean {
  if (typeof name !== "string") return false;
  if (name.trim().length === 0) return false;
  if (name.length > 255) return false;
  if (name.includes("/")) return false; // path separator
  if ([...name].some((ch) => ch.charCodeAt(0) < 0x20)) return false; // control chars
  return true;
}

// Generic RID shape (service.instance.type.locator); existence is checked by
// the repo lookup, which yields FolderNotFound.
const RID_RE = /^ri\.[a-z][a-z0-9-]*\.[a-z0-9-]*\.[a-z][a-z0-9-]*\..+$/;

// ---------------------------------------------------------------------------
// POST /  — Create Dataset
// ---------------------------------------------------------------------------
const CreateDatasetRequest = z.object({
  parentFolderRid: z.string(),
  name: z.string(),
});

foundryDatasetsV1Router.post("/", async (req: Request, res: Response) => {
  try {
    const user = principal(req);
    if (!user) {
      sendErr(res, ERR.unauthorized);
      return;
    }
    if (!hasScope(user.scopes, "write")) {
      sendErr(res, ERR.createDenied, { scope: "api:datasets-write" });
      return;
    }

    const parsed = CreateDatasetRequest.safeParse(req.body);
    if (!parsed.success) {
      sendErr(res, ERR.invalidArgument, { issues: parsed.error.issues });
      return;
    }
    const { parentFolderRid, name } = parsed.data;

    if (!RID_RE.test(parentFolderRid)) {
      sendErr(res, ERR.invalidArgument, { argument: "parentFolderRid" });
      return;
    }
    if (!isValidDisplayName(name)) {
      sendErr(res, ERR.invalidName, { name });
      return;
    }

    const created = await createDataset({ name, parentFolderRid, actor: user.id });
    res.status(200).json(created); // Foundry returns 200 with the Dataset
  } catch (err) {
    if (err instanceof ParentFolderNotFound) {
      sendErr(res, ERR.folderNotFound, { parentFolderRid: err.parentFolderRid });
      return;
    }
    if (err instanceof DatasetNameAlreadyExists) {
      sendErr(res, ERR.nameExists, {
        name: err.datasetName,
        parentFolderRid: err.parentFolderRid,
      });
      return;
    }
    sendErr(res, ERR.internal);
  }
});

// ---------------------------------------------------------------------------
// GET /:datasetRid  — Get Dataset (identity)
// ---------------------------------------------------------------------------
foundryDatasetsV1Router.get(
  "/:datasetRid",
  async (req: Request, res: Response, next: NextFunction) => {
    const datasetRid = decodeURIComponent(req.params.datasetRid);
    // Only claim Foundry dataset RIDs; let legacy UUID routers handle the rest.
    if (!isFoundryDatasetRid(datasetRid)) {
      next();
      return;
    }
    try {
      const user = principal(req);
      if (!user) {
        sendErr(res, ERR.unauthorized);
        return;
      }
      if (!hasScope(user.scopes, "read")) {
        sendErr(res, ERR.viewDenied, { scope: "api:datasets-read" });
        return;
      }
      const resolved = await resolveDataset(datasetRid);
      if (!resolved) {
        sendErr(res, ERR.datasetNotFound, { datasetRid });
        return;
      }
      // Surface the column schema so the "Create a new object type" wizard
      // (and any consumer of the Get Dataset identity) can mirror it. Prefers
      // the persisted `dataset_columns` scan and falls back to live-preview
      // inference when the scan is empty (failed / not run).
      const columns = await resolveDatasetColumns(resolved, PREVIEW_DEFAULT_ROWS);
      res.status(200).json({
        rid: resolved.rid,
        name: resolved.name,
        parentFolderRid: resolved.parentFolderRid,
        columns,
        schema_info: { columns },
      });
    } catch {
      sendErr(res, ERR.internal);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /:datasetRid/preview  — bounded data preview (rows + inferred schema)
// ---------------------------------------------------------------------------
foundryDatasetsV1Router.get(
  "/:datasetRid/preview",
  async (req: Request, res: Response, next: NextFunction) => {
    const rawId = decodeURIComponent(req.params.datasetRid);
    // Canonical RIDs always claim the route; bare UUIDs only when they
    // point at an Iceberg-backed dataset (see claimPreviewTarget).
    let datasetRid: string | null = null;
    try {
      datasetRid = await claimPreviewTarget(rawId);
    } catch {
      datasetRid = null; // registry probe failed — let legacy handlers try
    }
    if (!datasetRid) {
      next();
      return;
    }
    try {
      const user = principal(req);
      if (!user) {
        sendErr(res, ERR.unauthorized);
        return;
      }
      if (!hasScope(user.scopes, "read")) {
        sendErr(res, ERR.viewDenied, { scope: "api:datasets-read" });
        return;
      }

      let rowLimit = parseInt(String(req.query.rows ?? ""), 10);
      if (!Number.isFinite(rowLimit) || rowLimit < 1) rowLimit = PREVIEW_DEFAULT_ROWS;
      if (rowLimit > PREVIEW_MAX_ROWS) rowLimit = PREVIEW_MAX_ROWS;

      const resolved = await resolveDataset(datasetRid);
      if (!resolved) {
        sendErr(res, ERR.datasetNotFound, { datasetRid });
        return;
      }

      const producer = resolved.producer;
      const config = (producer?.config ?? {}) as {
        schema?: string;
        table?: string;
      };

      // Read the materialised data from the right backing store:
      //   - sync producer → the Iceberg table the table-import writes;
      //   - object-backed (file upload or pipeline-output CSV) → the object in
      //     MinIO/S3 (registry.filePath);
      //   - otherwise → no data yet (identity-only / not built).
      const objectPath = resolved.registry?.filePath ?? null;
      const preview = producer
        ? await readSyncedPreview(producer.config as never, producer.tenant, rowLimit)
        : objectPath && !objectPath.startsWith("iceberg://")
          ? await readUploadedPreview(objectPath, rowLimit)
          : { columns: [], rows: [], snapshot: null as null };

      const latestBuild = producer
        ? await latestBuildForImport(producer.importRid)
        : null;

      // Metadata falls back to the `foundry_datasets` registry row when there
      // is no sync producer (uploads, manually-created datasets), so the panel
      // shows real timestamps / row counts instead of nulls.
      const registry = resolved.registry;
      const totalRows =
        latestBuild?.rowsWritten ??
        preview.snapshot?.addedRecords ??
        registry?.rowCount ??
        preview.rows.length;

      res.status(200).json({
        // Foundry dataset identity
        rid: resolved.rid,
        datasetRid: resolved.rid,
        name: resolved.name,
        displayName: resolved.name, // kept for the preview UI
        parentFolderRid: resolved.parentFolderRid,
        // Producer / lineage context (null when the dataset has no data yet)
        producerKind: producer?.kind ?? null,
        importRid: producer?.importRid ?? null,
        connectionRid: producer?.connectionRid ?? null,
        connectionName: producer?.connectionName ?? null,
        schema: config.schema ?? null,
        table: config.table ?? null,
        mode: (producer?.config as { mode?: string } | undefined)?.mode ?? null,
        state: producer?.status?.state ?? registry?.status ?? "draft",
        // Derived origin ("Updated via") — see DatasetProvenance. Never null.
        provenance: resolved.provenance,
        createdAt: producer
          ? toIso(producer.createdAt)
          : registry?.createdAt
            ? toIso(registry.createdAt)
            : null,
        updatedAt: producer
          ? toIso(producer.updatedAt)
          : registry?.updatedAt
            ? toIso(registry.updatedAt)
            : null,
        createdBy: producer?.createdBy ?? registry?.createdBy ?? null,
        lastBuild: latestBuild
          ? {
              rid: latestBuild.rid,
              status: latestBuild.status,
              endedAt: latestBuild.endedAt ? toIso(latestBuild.endedAt) : null,
              rowsWritten: latestBuild.rowsWritten,
            }
          : null,
        // Data
        snapshot: preview.snapshot,
        columns: preview.columns,
        rows: preview.rows,
        totalRows,
        previewRowCount: preview.rows.length,
        requestedRows: rowLimit,
      });
    } catch {
      sendErr(res, ERR.internal);
    }
  },
);

export default foundryDatasetsV1Router;
