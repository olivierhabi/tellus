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
import { requireOperation } from "../../codeRepos/middleware/compass.js";
import type { StemmaAdapter } from "../adapters/types.js";
import { startBuild, retryBuild } from "./buildService.js";
import { runTransformDryRun } from "./testHarness.js";
import { runTransformPreview, sanitizeFileOverrides } from "./previewHarness.js";
import { transformPrincipalFrom, type TransformPrincipal } from "./authz.js";
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

/** Project the code-repos principal (req.codeReposPrincipal) into the
 * TransformPrincipal the build path authorizes against. Falls back to the
 * "unknown" userId when no principal is attached (shouldn't happen past auth). */
function principalOf(req: Request): TransformPrincipal {
  const p = (req as { codeReposPrincipal?: { userId?: string; roles?: readonly string[] } })
    .codeReposPrincipal;
  return transformPrincipalFrom(p?.userId ?? "unknown", p?.roles);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createTransformsRouter(deps: TransformRoutesDeps): Router {
  const router = Router();
  const auth = requireCodeReposAuth();
  const json = express.json({ limit: "64kb" });

  // Gap 8 (authz): per-repo Compass authorization on every mutating endpoint
  // (G-C-10). A principal without WRITE (READER-only, or no roles at all) is
  // DENIED on build/retry/dry-run; DENY maps to 404 (IDOR-as-404, G-C-09) so an
  // unauthorized caller cannot probe repo existence. READ on the GET endpoints
  // lets a READER read build status but not start/retry builds. (Previously the
  // transforms router used authN only — any authenticated principal could build
  // against any repo.)
  const repoRid = (req: Request) => req.params.rid ?? null;
  const writeRepo = requireOperation({
    resourceRidFrom: repoRid,
    resourceType: "Repository",
    operation: "WRITE",
    errorNameOnDeny: "Stemma:RepositoryNotFound",
  });
  const readRepo = requireOperation({
    resourceRidFrom: repoRid,
    resourceType: "Repository",
    operation: "READ",
    errorNameOnDeny: "Stemma:RepositoryNotFound",
  });

  // -- dry-run a transform against fixtures (no side effects) ----------------
  // Runs one @transform against caller-provided fixture rows (no
  // resolveDatasetByRid, no materializeOutput — no committed transaction).
  router.post(
    "/code-repositories/:rid/transforms/test",
    auth,
    writeRepo,
    express.json({ limit: "256kb" }),
    async (req: Request, res: Response) => {
      try {
        const rid = req.params.rid;
        const branch = typeof req.body?.branch === "string" && req.body.branch.length > 0 ? req.body.branch : "master";
        const entryPoint = req.body?.entryPoint;
        const fixtures = req.body?.fixtures ?? {};
        if (typeof entryPoint !== "string" || entryPoint.length === 0) {
          return sendErr(res, transformError("Transform:InvalidArgument", { message: "entryPoint (string) required" }));
        }
        const result = await runTransformDryRun({
          stemma: deps.stemma,
          repositoryRid: rid,
          branch,
          entryPoint,
          fixtures,
        });
        return res.status(200).json(result);
      } catch (e) {
        return sendErr(res, transformError("Transform:Internal", { message: String(e) }));
      }
    },
  );

  // -- preview a transform against REAL inputs (no commit) ------------------
  // Foundry-faithful Preview: runs one @transform against its real committed
  // input datasets (resolveDatasetByRid, read-only) and returns SAMPLE output
  // rows + per-input sample rows + logs — NO materializeOutput (no committed
  // dataset_transaction). Sibling of /transforms/test (which uses fixtures +
  // drops output rows). Optional fileOverrides {path->content} merge unsaved
  // editor drafts over the committed tree (edit -> Preview, no commit needed).
  router.post(
    "/code-repositories/:rid/transforms/preview",
    auth,
    writeRepo,
    express.json({ limit: "256kb" }),
    async (req: Request, res: Response) => {
      try {
        const rid = req.params.rid;
        const branch = typeof req.body?.branch === "string" && req.body.branch.length > 0 ? req.body.branch : "master";
        const entryPoint = req.body?.entryPoint;
        if (typeof entryPoint !== "string" || entryPoint.length === 0) {
          return sendErr(res, transformError("Transform:InvalidArgument", { message: "entryPoint (string) required" }));
        }
        const fileOverrides = sanitizeFileOverrides(req.body?.fileOverrides);
        const result = await runTransformPreview({
          stemma: deps.stemma,
          repositoryRid: rid,
          branch,
          entryPoint,
          fileOverrides,
          principal: principalOf(req),
        });
        return res.status(200).json(result);
      } catch (e) {
        return sendErr(res, transformError("Transform:Internal", { message: String(e) }));
      }
    },
  );

  // -- start a build --------------------------------------------------------
  router.post(
    "/code-repositories/:rid/builds",
    auth,
    writeRepo,
    json,
    async (req: Request, res: Response) => {
      try {
        const rid = req.params.rid;
        const branch =
          typeof req.body?.branch === "string" && req.body.branch.length > 0
            ? req.body.branch
            : "master";
        const idempotencyKey = req.get("Idempotency-Key");
        const result = await startBuild(
          { stemma: deps.stemma },
          { repositoryRid: rid, branch, actor: actorOf(req), principal: principalOf(req) },
        );
        if (!result.ok) return sendErr(res, result.error);
        // 200 on an idempotent replay (existing build returned); 202 on a fresh enqueue.
        const code = result.value.replayed ? 200 : 202;
        return res.status(code).json({
          buildRid: result.value.buildRid,
          status: result.value.status,
          transforms: result.value.transforms,
          branch,
          replayed: result.value.replayed === true,
        });
      } catch (e) {
        return sendErr(res, transformError("Transform:Internal", { message: String(e) }));
      }
    },
  );

  // -- retry a FAILED build (Gap 2: durable/resumable scheduling) ------------
  // Creates a fresh execution of the original's repo+branch, linked via
  // retry_of, retry_count+1, bounded by max_retries (429 at the cap).
  // Idempotent via Idempotency-Key. 409 if the original is still in-flight.
  router.post(
    "/code-repositories/:rid/builds/:buildId/retry",
    auth,
    writeRepo,
    json,
    async (req: Request, res: Response) => {
      try {
        const { rid, buildId } = req.params;
        const idempotencyKey = req.get("Idempotency-Key");
        const result = await retryBuild(
          { stemma: deps.stemma },
          {
            repositoryRid: rid,
            buildId,
            actor: actorOf(req),
            principal: principalOf(req),
            idempotencyKey: idempotencyKey ?? null,
          },
        );
        if (!result.ok) return sendErr(res, result.error);
        const code = result.value.replayed ? 200 : 202;
        return res.status(code).json({
          buildRid: result.value.buildRid,
          status: result.value.status,
          transforms: result.value.transforms,
          retryOf: buildId,
          replayed: result.value.replayed === true,
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
    readRepo,
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
    readRepo,
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
        // Recursive (multi-hop) lineage: walk the transform_lineage graph BOTH
        // upstream (datasets that feed the focus) AND downstream (datasets the
        // focus feeds) transitively, then return every edge + node touching the
        // reachable set. (Was single-hop: WHERE output=$1 OR input=$1 — which
        // missed a->b->c when querying a or c.)
        const nodesetQ = await pool.query<{ node: string }>(
          `WITH RECURSIVE lineage_nodes(node) AS (
               SELECT $1::uuid
               UNION
               SELECT CASE WHEN t.output_dataset_id = l.node THEN t.input_dataset_id ELSE t.output_dataset_id END
                 FROM lineage_nodes l, transform_lineage t
                WHERE t.output_dataset_id = l.node OR t.input_dataset_id = l.node
             )
             SELECT node FROM lineage_nodes`,
          [datasetId],
        );
        const ids = new Set<string>([datasetId]);
        for (const r of nodesetQ.rows) ids.add(r.node);
        const idArr = [...ids];
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
            WHERE output_dataset_id = ANY($1::uuid[]) OR input_dataset_id = ANY($1::uuid[])`,
          [idArr],
        );
        const nodesQ = await pool.query<{
          dataset_id: string;
          name: string;
          rid: string | null;
          total_rows: number;
        }>(
          `SELECT dataset_id, name, rid, total_rows FROM dataset WHERE dataset_id = ANY($1::uuid[])`,
          [idArr],
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

  // -- UNIFIED lineage (Gap 4) ----------------------------------------------
  // The two lineage universes are unjoined by any FK: transform_lineage lives
  // over `dataset` (PK dataset_id, has rid) and dataset_lineage lives over
  // `foundry_datasets` (PK id, no rid). The only shared attribute is `name`.
  // This endpoint returns BOTH universes' edges for a focus dataset id,
  // bridging dataset <-> foundry_datasets by name (clearly labelled as a
  // name-based bridge — names are not guaranteed unique, so the bridge field
  // records which foundry_datasets.id it matched). One endpoint, both graphs.
  router.get(
    "/transforms/datasets/:datasetId/lineage/unified",
    auth,
    async (req: Request, res: Response) => {
      try {
        const datasetId = req.params.datasetId;
        if (!UUID_RE.test(datasetId)) {
          return sendErr(res, transformError("Transform:InvalidArgument", { datasetId }));
        }
        // The focus dataset (universe A). Must exist.
        const ds = await pool.query<{ dataset_id: string; name: string; rid: string | null; total_rows: number }>(
          `SELECT dataset_id, name, rid, total_rows FROM dataset WHERE dataset_id = $1`,
          [datasetId],
        );
        if (ds.rowCount === 0) {
          return sendErr(res, transformError("Transform:DatasetNotFound", { datasetId }));
        }
        const focus = ds.rows[0];

        // --- Universe A: recursive transform_lineage walk from the focus. ---
        const nodesetA = await pool.query<{ node: string }>(
          `WITH RECURSIVE lineage_nodes(node) AS (
               SELECT $1::uuid
               UNION
               SELECT CASE WHEN t.output_dataset_id = l.node THEN t.input_dataset_id ELSE t.output_dataset_id END
                 FROM lineage_nodes l, transform_lineage t
                WHERE t.output_dataset_id = l.node OR t.input_dataset_id = l.node
             )
             SELECT node FROM lineage_nodes`,
          [datasetId],
        );
        const idsA = new Set<string>([datasetId]);
        for (const r of nodesetA.rows) idsA.add(r.node);
        const idArrA = [...idsA];
        const [nodesA, edgesA] = await Promise.all([
          pool.query<{ dataset_id: string; name: string; rid: string | null; total_rows: number }>(
            `SELECT dataset_id, name, rid, total_rows FROM dataset WHERE dataset_id = ANY($1::uuid[])`,
            [idArrA],
          ),
          pool.query<{
            output_dataset_id: string;
            input_dataset_id: string;
            transform_name: string;
            build_rid: string | null;
            edge_type: string;
            created_at: string;
          }>(
            `SELECT output_dataset_id, input_dataset_id, transform_name, build_rid, edge_type, created_at
               FROM transform_lineage
              WHERE output_dataset_id = ANY($1::uuid[]) OR input_dataset_id = ANY($1::uuid[])`,
            [idArrA],
          ),
        ]);

        // --- Universe B: bridge by name -> foundry_datasets.id -> walk. ---
        // The bridge is by NAME (the only shared column). If multiple
        // foundry_datasets share the name, each is walked + reported.
        const foundryBy = await pool.query<{ id: string; name: string }>(
          `SELECT id, name FROM foundry_datasets WHERE name = $1`,
          [focus.name],
        );
        const foundryUniverse: Array<{
          foundryDatasetId: string;
          name: string;
          nodes: unknown[];
          edges: unknown[];
        }> = [];
        for (const fb of foundryBy.rows) {
          const nodesetB = await pool.query<{ node: string }>(
            `WITH RECURSIVE foundry_nodes(node) AS (
                 SELECT $1::uuid
                 UNION
                 SELECT CASE WHEN d.downstream_dataset_id = l.node THEN d.upstream_dataset_id ELSE d.downstream_dataset_id END
                   FROM foundry_nodes l, dataset_lineage d
                  WHERE d.downstream_dataset_id = l.node OR d.upstream_dataset_id = l.node
               )
               SELECT node FROM foundry_nodes`,
            [fb.id],
          );
          const idsB = new Set<string>([fb.id]);
          for (const r of nodesetB.rows) idsB.add(r.node);
          const idArrB = [...idsB];
          const [nodesB, edgesB] = await Promise.all([
            pool.query<{ id: string; name: string; row_count: number | null; status: string }>(
              `SELECT id, name, row_count, status FROM foundry_datasets WHERE id = ANY($1::uuid[])`,
              [idArrB],
            ),
            pool.query<{
              downstream_dataset_id: string;
              upstream_dataset_id: string;
              edge_type: string;
              edge_metadata: unknown;
              created_at: string;
            }>(
              `SELECT downstream_dataset_id, upstream_dataset_id, edge_type, edge_metadata, created_at
                 FROM dataset_lineage
                WHERE downstream_dataset_id = ANY($1::uuid[]) OR upstream_dataset_id = ANY($1::uuid[])`,
              [idArrB],
            ),
          ]);
          foundryUniverse.push({
            foundryDatasetId: fb.id,
            name: fb.name,
            nodes: nodesB.rows.map((n) => ({
              foundryDatasetId: n.id,
              name: n.name,
              rowCount: n.row_count,
              status: n.status,
            })),
            edges: edgesB.rows.map((e) => ({
              from: e.upstream_dataset_id,
              to: e.downstream_dataset_id,
              edgeType: e.edge_type,
              edgeMetadata: e.edge_metadata,
            })),
          });
        }

        return res.status(200).json({
          focus: datasetId,
          focusDataset: { datasetId: focus.dataset_id, name: focus.name, rid: focus.rid, rowCount: focus.total_rows },
          // Universe A: transform_lineage over `dataset`.
          transformUniverse: {
            nodes: nodesA.rows.map((n) => ({
              datasetId: n.dataset_id,
              name: n.name,
              rid: n.rid,
              rowCount: n.total_rows,
            })),
            edges: edgesA.rows.map((e) => ({
              from: e.input_dataset_id,
              to: e.output_dataset_id,
              transform: e.transform_name,
              buildRid: e.build_rid,
              edgeType: e.edge_type,
            })),
          },
          // Universe B: dataset_lineage over `foundry_datasets`, bridged by name.
          // `bridge.byName` makes explicit that this is a NAME match (not an FK);
          // a name collision would surface multiple entries here.
          foundryUniverse,
          bridge: { byName: focus.name, matches: foundryBy.rowCount ?? 0 },
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
