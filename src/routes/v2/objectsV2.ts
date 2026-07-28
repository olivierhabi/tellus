// ---------------------------------------------------------------------------
// OSv2 objects routes — thin adapters over the canonical engine
//
//   GET  /api/v2/ontologies/:ontology/objects/:objectType
//   GET  /api/v2/ontologies/:ontology/objects/:objectType/:primaryKey
//   POST /api/v2/ontologies/:ontology/objects/:objectType/search
// ---------------------------------------------------------------------------

import { Router, Request, Response } from "express";
import {
  buildSecurityFilter,
  requireSecurityContext,
} from "../../middleware/securityContext";
import { readBranchHeader } from "../../middleware/branchHeader";
import { query } from "../../db";
import { executeGetObject } from "../../services/queryExecutor";
import { compileObjectSet } from "../../services/oss/objectSetCompiler";
import { loadObjectSet } from "../../services/oss/objectSetExecutor";
import {
  buildOssV2SecurityFilter,
  makeProductionExecutorDeps,
  makeProductionCompilerDeps,
} from "../../services/oss/productionDeps";
import { resolveRequestTenant } from "../../utils/requestTenant";
import {
  SearchJsonQueryV2 as SearchJsonQueryV2Schema,
} from "../../services/oss/objectSetDefinition";
import { toV2Error } from "../../services/oss/v2Errors";
import { requireOntology } from "./ontologyParam";
import { deriveMainBranchId } from "../../services/branchContext";
import { deterministicObjectRid } from "../../services/objectIdentity";

const router = Router({ mergeParams: true });

function publicLoadResponse(result: {
  data: Array<Record<string, unknown>>;
  nextPageToken: string | null;
  totalCount: string;
  propertySecurities: unknown[];
}) {
  const { nextPageToken, ...rest } = result;
  return {
    ...rest,
    ...(nextPageToken ? { nextPageToken } : {}),
  };
}

function executorFor(req: Request, ontologyId: string, snapshot: boolean) {
  const security = requireSecurityContext(req);
  const tenant = resolveRequestTenant(req);
  return {
    deps: makeProductionExecutorDeps(
      {
        securityFilter: buildSecurityFilter(security),
        branchId: readBranchHeader(req),
        ontologyId,
        userId: security.userId,
        tenant,
        markings: security.markings,
        cbac: security.cbac,
        organizations: security.organizations,
        markingBypass: security.markingBypass,
      },
      { snapshot },
    ),
    ctx: {
      ontologyRid: ontologyId,
      branchRid: readBranchHeader(req),
      tenant,
      transactionId: null,
      transactionVersion: null,
      scenarioRid: null,
      scenarioVersion: null,
      snapshot,
    },
  };
}

// GET list objects — base set over the object type.
router.get("/objects/:objectType", async (req: Request, res: Response) => {
  try {
    const ontologyId = await requireOntology(
      req.params.ontology,
      resolveRequestTenant(req),
    );
    const pageSize = req.query.pageSize
      ? Number(req.query.pageSize)
      : undefined;
    if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 10_000)) {
      throw Object.assign(new Error("pageSize must be 1..10000"), {
        errorName: "InvalidPageSize",
        parameters: { pageSize },
      });
    }
    const snapshot = req.query.snapshot === "true";
    const excludeRid = req.query.excludeRid === "true";
    const objectSet = { type: "base", objectType: req.params.objectType };
    const compiled = await compileObjectSet(
      objectSet,
      makeProductionCompilerDeps({
        tenant: resolveRequestTenant(req),
        ontologyRid: ontologyId,
        branchRid: readBranchHeader(req),
        userId: requireSecurityContext(req).userId,
      }),
    );
    const { deps, ctx } = executorFor(req, ontologyId, snapshot);
    const result = await loadObjectSet(
      compiled,
      {
        objectSet,
        orderBy: undefined,
        select: [],
        selectV2: [],
        pageToken: (req.query.pageToken as string) || undefined,
        pageSize,
        excludeRid,
        snapshot,
      },
      ctx,
      deps,
    );
    res.json(publicLoadResponse(result));
  } catch (err) {
    const { status, body } = toV2Error(err);
    res.status(status).json(body);
  }
});

// POST search objects — filter set over the object type.
router.post(
  "/objects/:objectType/search",
  async (req: Request, res: Response) => {
    try {
      const ontologyId = await requireOntology(
        req.params.ontology,
        resolveRequestTenant(req),
      );
      const where = SearchJsonQueryV2Schema.safeParse(req.body?.where);
      if (req.body?.where !== undefined && !where.success) {
        throw Object.assign(new Error("Invalid search query"), {
          errorName: "InvalidObjectSet",
          parameters: { issues: where.success ? [] : where.error.issues },
        });
      }
      const snapshot = req.body?.snapshot === true;
      const objectSet = where.success
        ? {
            type: "filter",
            objectSet: { type: "base", objectType: req.params.objectType },
            where: where.data,
          }
        : { type: "base", objectType: req.params.objectType };
      const compiled = await compileObjectSet(
        objectSet,
        makeProductionCompilerDeps({
          tenant: resolveRequestTenant(req),
          ontologyRid: ontologyId,
          branchRid: readBranchHeader(req),
          userId: requireSecurityContext(req).userId,
        }),
      );
      const { deps, ctx } = executorFor(req, ontologyId, snapshot);
      const result = await loadObjectSet(
        compiled,
        {
          objectSet,
          orderBy: req.body?.orderBy,
          select: req.body?.select ?? [],
          selectV2: req.body?.selectV2 ?? [],
          pageToken: req.body?.pageToken,
          pageSize: req.body?.pageSize,
          excludeRid: req.body?.excludeRid === true,
          snapshot,
        },
        ctx,
        deps,
      );
      res.json(publicLoadResponse(result));
    } catch (err) {
      const { status, body } = toV2Error(err);
      res.status(status).json(body);
    }
  },
);

// GET single object — existing fail-closed executor.
router.get(
  "/objects/:objectType/:primaryKey",
  async (req: Request, res: Response) => {
    try {
      const ontologyId = await requireOntology(
        req.params.ontology,
        resolveRequestTenant(req),
      );
      // Object-type existence is validated by the executor path.
      const obj = await executeGetObject(
        req.params.objectType,
        req.params.primaryKey,
        buildOssV2SecurityFilter(
          ontologyId,
          buildSecurityFilter(req.security!),
        ),
        readBranchHeader(req),
      );
      if (!obj) {
        throw Object.assign(
          new Error(`Object not found: ${req.params.primaryKey}`),
          {
            errorName: "ObjectNotFound",
            parameters: {
              objectType: req.params.objectType,
              primaryKey: req.params.primaryKey,
            },
          },
        );
      }
      const excludeRid = req.query.excludeRid === "true";
      const out: Record<string, unknown> = { ...obj };
      if (excludeRid) {
        delete out.__rid;
      } else {
        const branchId =
          readBranchHeader(req) ?? deriveMainBranchId(ontologyId);
        const persisted = await query(
          `SELECT rid
             FROM object_instances
            WHERE ontology_id = $1
              AND branch_id = $2::uuid
              AND object_type_api_name = $3
              AND primary_key = $4
              AND rid IS NOT NULL
            ORDER BY last_modified_at DESC
            LIMIT 1`,
          [
            ontologyId,
            branchId,
            req.params.objectType,
            req.params.primaryKey,
          ],
        );
        out.__rid =
          persisted.rows[0]?.rid ??
          out.__rid ??
          deterministicObjectRid(
            ontologyId,
            req.params.objectType,
            req.params.primaryKey,
          );
      }
      res.json(out);
    } catch (err) {
      const { status, body } = toV2Error(err);
      res.status(status).json(body);
    }
  },
);

export default router;
