// ---------------------------------------------------------------------------
// OSv2 linked-objects route
//
//   GET /api/v2/ontologies/:ontology/objects/:objectType/:primaryKey/links/:linkType
//
// Delegates to the existing link resolver (marking- and
// branch-aware); only the envelope is v2-shaped.
// ---------------------------------------------------------------------------

import { Router, Request, Response } from "express";
import { buildSecurityFilter } from "../../middleware/securityContext";
import { readBranchHeader } from "../../middleware/branchHeader";
import { resolveLinks } from "../../services/linkResolverService";
import linkTypeModel, { resolveObjectTypeApiName } from "../../models/linkType";
import { toV2Error } from "../../services/oss/v2Errors";
import { requireOntology } from "./ontologyParam";
import { resolveRequestTenant } from "../../utils/requestTenant";
import { query } from "../../db";
import { deriveMainBranchId } from "../../services/branchContext";
import { deterministicObjectRid } from "../../services/objectIdentity";

const router = Router({ mergeParams: true });

router.get(
  "/objects/:objectType/:primaryKey/links/:linkType",
  async (req: Request, res: Response) => {
    try {
      const ontologyId = await requireOntology(
        req.params.ontology,
        resolveRequestTenant(req),
      );
      const pageSize = req.query.pageSize
        ? Number(req.query.pageSize)
        : undefined;
      if (
        pageSize !== undefined &&
        (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 10_000)
      ) {
        throw Object.assign(new Error("pageSize must be 1..10000"), {
          errorName: "InvalidPageSize",
          parameters: { pageSize },
        });
      }
      const lt = await linkTypeModel.getByApiName(
        ontologyId,
        req.params.linkType,
      );
      if (!lt) {
        throw Object.assign(
          new Error(`Link type not found: ${req.params.linkType}`),
          {
            errorName: "LinkTypeNotFound",
            parameters: { linkType: req.params.linkType },
          },
        );
      }
      const sourceApi = await resolveObjectTypeApiName(lt.source_object_type);
      const direction =
        sourceApi === req.params.objectType ? "forward" : "reverse";
      const result = await resolveLinks(
        lt,
        req.params.primaryKey,
        direction,
        {
          pageSize,
          pageToken: (req.query.pageToken as string) || undefined,
        },
        buildSecurityFilter(req.security!),
        readBranchHeader(req),
      );
      const excludeRid = req.query.excludeRid === "true";
      const data = (result.linkedObjects as Array<Record<string, unknown>>).map(
        (o) => {
          const out = { ...o };
          out.__apiName = out.__objectType ?? out.__apiName;
          if (excludeRid) delete out.__rid;
          return out;
        },
      );
      if (!excludeRid && data.length > 0) {
        const branchId =
          readBranchHeader(req) ?? deriveMainBranchId(ontologyId);
        const byType = new Map<string, string[]>();
        for (const object of data) {
          const type = String(object.__apiName ?? "");
          const pk = String(object.__primaryKey ?? object.__pk ?? "");
          if (type && pk) byType.set(type, [...(byType.get(type) ?? []), pk]);
        }
        for (const [type, primaryKeys] of byType) {
          const persisted = await query(
            `SELECT DISTINCT ON (primary_key) primary_key, rid
               FROM object_instances
              WHERE ontology_id = $1
                AND branch_id = $2::uuid
                AND object_type_api_name = $3
                AND primary_key = ANY($4::text[])
                AND rid IS NOT NULL
              ORDER BY primary_key, last_modified_at DESC`,
            [ontologyId, branchId, type, primaryKeys],
          );
          const ridByPk = new Map(
            persisted.rows.map((row) => [String(row.primary_key), row.rid]),
          );
          for (const object of data) {
            if (object.__apiName !== type) continue;
            const pk = String(object.__primaryKey ?? object.__pk ?? "");
            object.__rid =
              ridByPk.get(pk) ??
              object.__rid ??
              deterministicObjectRid(ontologyId, type, pk);
          }
        }
      }
      res.json({
        data,
        ...(result.nextPageToken
          ? { nextPageToken: result.nextPageToken }
          : {}),
      });
    } catch (err) {
      const { status, body } = toV2Error(err);
      res.status(status).json(body);
    }
  },
);

export default router;
