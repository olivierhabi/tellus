import { Router, type NextFunction, type Request, type Response } from 'express';
import { authenticate } from '../middleware/auth';
import { dataPlaneGuard } from '../middleware/requireRole';
import { requireDatasetRole } from '../middleware/datasetRbac';
import { DatasetController } from '../controllers/datasetController';
import { DatasetService } from '../services/datasetService';
import { DatasetAclService, type PrincipalType, type DatasetRole } from '../services/datasetAcl';
import foundryDb from '../config/foundryDb';
import { AppError } from '../utils/foundryAppError';
import {
  createBranch,
  createTag,
  dropRef,
  listRefs,
  type DatasetRowLike,
} from '../services/pipelines/datasetBranches';
import { DatasetTransactionService } from '../services/datasets/transactionService';

const datasetService = new DatasetService(foundryDb);
const datasetController = new DatasetController(datasetService);
const datasetAcl = new DatasetAclService(foundryDb);

function principalId(req: Request): string | null {
  const p = (req as unknown as { tellusPrincipal?: { userId?: string }; user?: { id?: string } });
  return p.tellusPrincipal?.userId ?? p.user?.id ?? null;
}

export const folderDatasetsRouter = Router({ mergeParams: true });
folderDatasetsRouter.get('/', authenticate, datasetController.list);

export const datasetRouter = Router();
// Function-level authorization on the by-id dataset surface (the IDOR
// vector): update (PUT) requires ontology-editor, delete requires
// ontology-admin, and write-POSTs (duplicate/reparse) require editor. Reads
// (get/preview/download/status/summary) stay open. PATs are scope-gated
// upstream (datasets:* scopes); superadmin passes.
datasetRouter.use(dataPlaneGuard({ post: 'write' }));
// FOUNDRY-GAPS §6 — per-dataset ACLs layered ON TOP of the function-level
// dataPlaneGuard. requireDatasetRole(...) is OPT-IN (DATASET_RBAC_ENABLED=true)
// and no-ops otherwise, so default behaviour is unchanged. Reads need viewer,
// mutations editor, destructive delete owner. Resolution: dataset_acl →
// project_members fallback (a project role is a floor).
datasetRouter.get('/status-batch', authenticate, datasetController.getStatusBatch);
datasetRouter.get('/:datasetId', authenticate, requireDatasetRole('viewer'), datasetController.getById);
datasetRouter.get('/:datasetId/preview', authenticate, requireDatasetRole('viewer'), datasetController.preview);
datasetRouter.get('/:datasetId/status', authenticate, requireDatasetRole('viewer'), datasetController.getStatus);
datasetRouter.get('/:datasetId/summary', authenticate, requireDatasetRole('viewer'), datasetController.getSummary);
datasetRouter.get('/:datasetId/download', authenticate, requireDatasetRole('viewer'), datasetController.download);
datasetRouter.put('/:datasetId', authenticate, requireDatasetRole('editor'), datasetController.update);
datasetRouter.delete('/:datasetId', authenticate, requireDatasetRole('owner'), datasetController.delete);
datasetRouter.post('/:datasetId/duplicate', authenticate, requireDatasetRole('viewer'), datasetController.duplicate);
// Re-parse a dataset's source file — recovers schemas that were
// silently truncated by the pre-`sanitizeCsvHeader` ingestion path. See
// `DatasetController.reparse` and `runbooks/csv-header-sanitization.md`.
datasetRouter.post('/:datasetId/reparse', authenticate, requireDatasetRole('editor'), datasetController.reparse);

// FOUNDRY-GAPS §6 — per-dataset ACL management (owner-only), mirroring the
// pipeline ACL endpoints. List/grant/revoke owner/editor/viewer for users or
// groups on a single dataset.
datasetRouter.get(
  '/:datasetId/acl',
  authenticate,
  requireDatasetRole('owner'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await datasetAcl.list(req.params.datasetId as string);
      res.json({ success: true, data: { acl: rows } });
    } catch (error) {
      next(error);
    }
  },
);

datasetRouter.put(
  '/:datasetId/acl/:principalId',
  authenticate,
  requireDatasetRole('owner'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const grantedBy = principalId(req);
      if (!grantedBy) throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      const { role, principalType } = (req.body ?? {}) as {
        role?: DatasetRole;
        principalType?: PrincipalType;
      };
      const row = await datasetAcl.grant({
        datasetId: req.params.datasetId as string,
        principalId: req.params.principalId as string,
        principalType: principalType ?? 'user',
        role: role as DatasetRole,
        grantedBy,
      });
      res.json({ success: true, data: row });
    } catch (error) {
      next(error);
    }
  },
);

datasetRouter.delete(
  '/:datasetId/acl/:principalId',
  authenticate,
  requireDatasetRole('owner'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const principalType = ((req.query.principalType as string) ?? 'user') as PrincipalType;
      const result = await datasetAcl.revoke({
        datasetId: req.params.datasetId as string,
        principalId: req.params.principalId as string,
        principalType,
      });
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  },
);

// ---------------------------------------------------------------------------
// FOUNDRY-GAPS §6 — Iceberg branches & tags (Foundry "dataset branches"
// analog). Refs live in the Iceberg table metadata, so these routes only
// resolve the foundry_datasets row and delegate to the datasetBranches
// service. Authorization follows the router-level dataPlaneGuard above:
// GET is open (read), POST requires ontology-editor, DELETE requires
// ontology-admin.
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadDatasetRow(datasetId: string): Promise<DatasetRowLike> {
  if (!UUID_RE.test(datasetId)) {
    throw new AppError('Invalid dataset ID format', 400, 'VALIDATION_ERROR');
  }
  const row = await foundryDb('foundry_datasets')
    .where({ id: datasetId })
    .first(['id', 'format', 'file_path']);
  if (!row) {
    throw new AppError('Dataset not found', 404, 'NOT_FOUND');
  }
  return row as DatasetRowLike;
}

datasetRouter.get(
  '/:datasetId/refs',
  authenticate,
  requireDatasetRole('viewer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dataset = await loadDatasetRow(req.params.datasetId as string);
      const refs = await listRefs(dataset);
      res.json({ success: true, data: { refs } });
    } catch (error) {
      next(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Datasets v2 storage model (foundry_datasets, any format):
// every build commits a transaction on a branch (default `master`).
//   GET  /:datasetId/transactions              — branch history, newest first
//   GET  /:datasetId/transactions/:transactionId — 404 TransactionNotFound
//   GET  /:datasetId/branches                  — branch registry
//   POST /:datasetId/branches                  — 409 BranchAlreadyExists
// Iceberg formats keep their ref-based branches (see below); the PG branch
// registry serves csv/parquet/stream datasets.
// ---------------------------------------------------------------------------
const txService = new DatasetTransactionService(foundryDb);

datasetRouter.get(
  '/:datasetId/transactions',
  authenticate,
  requireDatasetRole('viewer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branch =
        typeof req.query.branch === 'string' ? req.query.branch : undefined;
      const limit =
        typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
      const rows = await txService.listTransactions(req.params.datasetId as string, {
        branch: branch || undefined,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      res.json({ success: true, data: rows });
    } catch (error) {
      next(error);
    }
  },
);

datasetRouter.get(
  '/:datasetId/transactions/:transactionId',
  authenticate,
  requireDatasetRole('viewer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const row = await txService.getTransaction(
        req.params.datasetId as string,
        req.params.transactionId as string,
      );
      res.json({ success: true, data: row });
    } catch (error) {
      next(error);
    }
  },
);

datasetRouter.get(
  '/:datasetId/branches',
  authenticate,
  requireDatasetRole('viewer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({
        success: true,
        data: await txService.listBranches(req.params.datasetId as string),
      });
    } catch (error) {
      next(error);
    }
  },
);

datasetRouter.post(
  '/:datasetId/branches',
  authenticate,
  requireDatasetRole('editor'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dataset = await loadDatasetRow(req.params.datasetId as string);
      const { name, fromSnapshotId } = (req.body ?? {}) as {
        name?: unknown;
        fromSnapshotId?: number | string;
      };
      if ((dataset.format ?? '').toLowerCase() !== 'iceberg') {
        // PG branch registry — Foundry's BranchAlreadyExists (409) contract.
        const row = await txService.createBranch(dataset.id, name as string);
        res.status(201).json({ success: true, data: row });
        return;
      }
      const result = await createBranch(dataset, name as string, fromSnapshotId);
      res.status(201).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  },
);

datasetRouter.post(
  '/:datasetId/tags',
  authenticate,
  requireDatasetRole('editor'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dataset = await loadDatasetRow(req.params.datasetId as string);
      const { name, fromSnapshotId } = (req.body ?? {}) as {
        name?: unknown;
        fromSnapshotId?: number | string;
      };
      const result = await createTag(dataset, name as string, fromSnapshotId);
      res.status(201).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  },
);

datasetRouter.delete(
  '/:datasetId/refs/:refName',
  authenticate,
  requireDatasetRole('editor'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dataset = await loadDatasetRow(req.params.datasetId as string);
      const result = await dropRef(dataset, req.params.refName as string);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  },
);
