// ===========================================================================
// Transform build + lineage routes. Mounted at /api/v1 (after the
// code-repositories router). Per-route auth via requireCodeReposAuth (ADR-008)
// so the router is safe at any prefix.
//
//   POST /code-repositories/:rid/builds            -> start a build (202)
//   GET  /code-repositories/:rid/builds            -> list builds
//   GET  /code-repositories/:rid/builds/:buildId   -> build detail + events
//   GET  /datasets/:datasetId/lineage              -> input->output lineage
// ===========================================================================
import { Router, type Request, type Response } from "express";
import express from "express";
import { pool } from "../../../db.js";
import { requireCodeReposAuth } from "../../codeRepos/middleware/principal.js";
import type { StemmaAdapter } from "../adapters/types.js";
import { startBuild } from "./buildService.js";
import { transformError, type TransformError } from "./errors.js";

export interface TransformRoutesDeps {
  readonly stemma: StemmaAdapter;
}

function sendErr(res: Response, err: TransformError): void {
  res.status(err.status).json(err.envelope);
}

function actorOf(req: Request): string {
  return (
    (req as { codeReposPrincipal?: { userId?: string } }).codeReposPrincipal?.userId ?? "unknown"
  );
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createTransformsRouter(deps: TransformRoutesDeps): Router {
  const router = Router();
  const auth = requireCodeReposAuth();
  const json = express.json({ limit: "64kb" });

  // -- start a build --------------------------------------------------------
  router.post(
    "/code-repositories/:rid/builds",
    auth,
    json,
    async (req: Request, res: Response) => {
      try {
        const rid = req.params.rid;
        const branch =
          typeof req.body?.branch === "string" && req.body.branch.length > 0
            ? req.body.branch
            : "master";
        const result = await startBuild(
          { stemma: deps.stemma },
          { repositoryRid: rid, branch, actor: actorOf(req) },
        );
        if (!result.ok) return sendErr(res, result.error);
        return res.status(202).json({
          buildRid: result.value.buildRid,
          status: result.value.status,
          transforms: result.value.transforms,
          branch,
        });
      } catch (e) {
        return sendErr(res, transformError("Transform:Internal", { message: String(e) }));
      }
    },
  );

  // -- list builds ----------------------------------------------------------
  router.get(
    "/code-repositories/:rid/builds",
    auth,
    async (req: Request, res: Response) => {
      try {
        const rid = req.params.rid;
        const rows = await pool.query(
          `SELECT rid, repository_rid, branch, commit_sha, actor, status,
                  transform_count, outputs, reason, enqueued_at, started_at, ended_at
             FROM transform_build
            WHERE repository_rid = $1
            ORDER BY enqueued_at DESC
            LIMIT 50`,
          [rid],
        );
        return res.status(200).json({ builds: rows.rows.map(serializeBuild) });
      } catch (e) {
        return sendErr(res, transformError("Transform:Internal", { message: String(e) }));
      }
    },
  );

  // -- build detail + events ------------------------------------------------
  router.get(
    "/code-repositories/:rid/builds/:buildId",
    auth,
    async (req: Request, res: Response) => {
      try {
        const { rid, buildId } = req.params;
        const b = await pool.query(
          `SELECT rid, repository_rid, branch, commit_sha, actor, status,
                  transform_count, outputs, reason, enqueued_at, started_at, ended_at
             FROM transform_build WHERE rid = $1 AND repository_rid = $2`,
          [buildId, rid],
        );
        if (b.rowCount === 0) {
          return sendErr(res, transformError("Transform:BuildNotFound", { buildRid: buildId }));
        }
        const ev = await pool.query(
          `SELECT kind, ts, data FROM transform_build_event
            WHERE build_rid = $1 ORDER BY ts ASC, id ASC`,
          [buildId],
        );
        return res.status(200).json({
          build: serializeBuild(b.rows[0]),
          events: ev.rows.map((r) => ({ kind: r.kind, ts: r.ts, data: r.data })),
        });
      } catch (e) {
        return sendErr(res, transformError("Transform:Internal", { message: String(e) }));
      }
    },
  );

  // -- dataset lineage (input -> output transform edges) --------------------
  // Mounted under /transforms/ (not /datasets/) so it is not shadowed by the
  // datasets routers' router-level auth.
  router.get(
    "/transforms/datasets/:datasetId/lineage",
    auth,
    async (req: Request, res: Response) => {
      try {
        const datasetId = req.params.datasetId;
        if (!UUID_RE.test(datasetId)) {
          return sendErr(res, transformError("Transform:InvalidArgument", { datasetId }));
        }
        const exists = await pool.query(`SELECT 1 FROM dataset WHERE dataset_id = $1`, [datasetId]);
        if (exists.rowCount === 0) {
          return sendErr(res, transformError("Transform:DatasetNotFound", { datasetId }));
        }
        const edgesQ = await pool.query<{
          output_dataset_id: string;
          input_dataset_id: string;
          transform_name: string;
          build_rid: string | null;
          edge_type: string;
          created_at: string;
        }>(
          `SELECT output_dataset_id, input_dataset_id, transform_name, build_rid, edge_type, created_at
             FROM transform_lineage
            WHERE output_dataset_id = $1 OR input_dataset_id = $1`,
          [datasetId],
        );
        const ids = new Set<string>([datasetId]);
        for (const e of edgesQ.rows) {
          ids.add(e.output_dataset_id);
          ids.add(e.input_dataset_id);
        }
        const nodesQ = await pool.query<{
          dataset_id: string;
          name: string;
          rid: string | null;
          total_rows: number;
        }>(
          `SELECT dataset_id, name, rid, total_rows FROM dataset WHERE dataset_id = ANY($1::uuid[])`,
          [[...ids]],
        );
        return res.status(200).json({
          focus: datasetId,
          nodes: nodesQ.rows.map((n) => ({
            datasetId: n.dataset_id,
            name: n.name,
            rid: n.rid,
            rowCount: n.total_rows,
          })),
          edges: edgesQ.rows.map((e) => ({
            from: e.input_dataset_id,
            to: e.output_dataset_id,
            transform: e.transform_name,
            buildRid: e.build_rid,
            edgeType: e.edge_type,
          })),
        });
      } catch (e) {
        return sendErr(res, transformError("Transform:Internal", { message: String(e) }));
      }
    },
  );

  return router;
}

function serializeBuild(r: Record<string, unknown>): Record<string, unknown> {
  return {
    rid: r.rid,
    repositoryRid: r.repository_rid,
    branch: r.branch,
    commitSha: r.commit_sha,
    actor: r.actor,
    status: r.status,
    transformCount: r.transform_count,
    outputs: r.outputs,
    reason: r.reason,
    enqueuedAt: r.enqueued_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}
