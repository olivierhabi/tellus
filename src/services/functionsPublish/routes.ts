import { createHash } from "node:crypto";
import { Router } from "express";
import type { Pool } from "pg";

import { isRid, isStructurallyRid } from "../codeRepos/contracts/rid";
import { requireCodeReposAuth } from "../codeRepos/middleware/principal";
import { FunctionsPublishError, type FunctionsPublishService } from "./service";

export function functionsPublishRunsRouter(deps: { pool: Pool; service: FunctionsPublishService }): Router {
  const router = Router();
  router.use(requireCodeReposAuth());

  router.get("/runs", async (req, res, next) => {
    try {
      const repositoryRid = typeof req.query.repositoryRid === "string" ? req.query.repositoryRid : "";
      if (!isStructurallyRid(repositoryRid)) {
        return res.status(400).json({ errorName: "Jemma:InvalidArgument", parameters: { field: "repositoryRid" } });
      }
      const ref = typeof req.query.ref === "string" ? req.query.ref : null;
      const state = typeof req.query.state === "string" ? req.query.state : null;
      const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 25) || 25));
      const offset = Math.max(0, Number(req.query.cursor ?? 0) || 0);
      const result = await deps.pool.query(
        `SELECT r.*, p.semver, p.version_rid, p.artifact_sha256, p.function_rids
           FROM jemma_run r
           LEFT JOIN function_publish_request p ON p.run_rid = r.rid
          WHERE r.repository_rid = $1
            AND ($2::text IS NULL OR r.ref = $2)
            AND ($3::text IS NULL OR r.state = $3)
          ORDER BY r.queued_at DESC, r.rid DESC
          LIMIT $4 OFFSET $5`,
        [repositoryRid, ref, state, limit + 1, offset],
      );
      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      const stageRows = rows.length
        ? await deps.pool.query(`SELECT * FROM jemma_run_stage WHERE run_rid = ANY($1::text[])`, [rows.map((row) => row.rid)])
        : { rows: [] as Record<string, unknown>[] };
      res.json({
        items: rows.map((row) => runResponse(row, stageRows.rows.filter((stage) => stage.run_rid === row.rid))),
        nextPageToken: hasMore ? String(offset + limit) : null,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/runs/:rid", async (req, res, next) => {
    try {
      if (!isRid(req.params.rid)) return res.status(404).json({ errorName: "Jemma:RunNotFound" });
      const result = await deps.pool.query(
        `SELECT r.*, p.semver, p.version_rid, p.artifact_sha256, p.function_rids
           FROM jemma_run r LEFT JOIN function_publish_request p ON p.run_rid = r.rid
          WHERE r.rid = $1`,
        [req.params.rid],
      );
      if (!result.rowCount) return res.status(404).json({ errorName: "Jemma:RunNotFound" });
      const stages = await deps.pool.query(`SELECT * FROM jemma_run_stage WHERE run_rid = $1`, [req.params.rid]);
      res.setHeader("ETag", `W/"${result.rows[0].resource_version}"`);
      res.json(runResponse(result.rows[0], stages.rows));
    } catch (error) {
      next(error);
    }
  });

  router.get("/runs/:rid/stages", async (req, res, next) => {
    try {
      const result = await deps.pool.query(
        `SELECT * FROM jemma_run_stage WHERE run_rid = $1
          ORDER BY array_position(ARRAY['setup','lint','test','build','publish']::text[], stage_name)`,
        [req.params.rid],
      );
      res.json({ runRid: req.params.rid, stages: result.rows.map(stageResponse) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/runs/:rid/logs", async (req, res, next) => {
    try {
      const stage = typeof req.query.stage === "string" ? req.query.stage : null;
      const afterId = Math.max(0, Number(req.query.afterId ?? 0) || 0);
      const limit = Math.min(2_000, Math.max(1, Number(req.query.limit ?? 1_000) || 1_000));
      const result = await deps.pool.query(
        `SELECT id, stage_name, stream, message, created_at FROM jemma_run_log
          WHERE run_rid = $1 AND id > $2 AND ($3::text IS NULL OR stage_name = $3)
          ORDER BY id ASC LIMIT $4`,
        [req.params.rid, afterId, stage, limit],
      );
      res.json({
        runRid: req.params.rid,
        lines: result.rows.map((row) => ({
          id: Number(row.id), stageName: row.stage_name, stream: row.stream,
          message: row.message, createdAt: toIso(row.created_at),
        })),
        nextAfterId: result.rows.length ? Number(result.rows[result.rows.length - 1].id) : afterId,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/runs/:rid/cancel", async (req, res, next) => {
    try {
      const cancelled = await deps.service.cancel(req.params.rid);
      if (!cancelled) return res.status(409).json({ errorName: "Jemma:RunAlreadyTerminal" });
      const result = await deps.pool.query(`SELECT * FROM jemma_run WHERE rid = $1`, [req.params.rid]);
      const stages = await deps.pool.query(`SELECT * FROM jemma_run_stage WHERE run_rid = $1`, [req.params.rid]);
      res.json(runResponse(result.rows[0], stages.rows));
    } catch (error) {
      next(error);
    }
  });

  router.get("/runs/:rid/retry-eligibility", async (req, res, next) => {
    try {
      if (!isRid(req.params.rid)) {
        return res.status(404).json({ errorName: "Jemma:RunNotFound" });
      }
      try {
        return res.json(await deps.service.getRetryEligibility(req.params.rid));
      } catch (error) {
        if (error instanceof FunctionsPublishError && error.code === "RUN_NOT_FOUND") {
          return res.status(404).json({ errorName: "Jemma:RunNotFound" });
        }
        throw error;
      }
    } catch (error) {
      next(error);
    }
  });

  router.post("/runs/:rid/retrigger", async (req, res, next) => {
    try {
      if (!isRid(req.params.rid)) {
        return res.status(404).json({ errorName: "Jemma:RunNotFound" });
      }
      const principal = req.codeReposPrincipal;
      if (!principal) {
        return res.status(401).json({ errorName: "Stemma:Unauthenticated" });
      }
      const idempotencyKey = (req.header("Idempotency-Key") ?? "").trim();
      if (!isUuidV4(idempotencyKey)) {
        return res.status(400).json({
          errorName: "Jemma:InvalidArgument",
          parameters: { field: "Idempotency-Key", reason: "must be a UUID v4" },
        });
      }

      let retriggered;
      try {
        retriggered = await deps.service.retrigger({
          runRid: req.params.rid,
          triggeredBy: derivePrincipalSubUuid(principal.userId),
          idempotencyKey,
        });
      } catch (error) {
        if (error instanceof FunctionsPublishError) {
          if (error.code === "RUN_NOT_FOUND") {
            return res.status(404).json({ errorName: "Jemma:RunNotFound" });
          }
          if (error.code === "RUN_NOT_TERMINAL") {
            return res.status(409).json({
              errorName: "Jemma:RunNotTerminal",
              parameters: error.details,
            });
          }
          if (error.code === "RUN_ALREADY_ACTIVE") {
            return res.status(409).json({
              errorName: "Jemma:RunAlreadyActive",
              parameters: error.details,
            });
          }
          if (error.code === "RUN_NOT_RETRYABLE") {
            return res.status(409).json({
              errorName: "Jemma:RunNotRetryable",
              parameters: error.details,
            });
          }
        }
        throw error;
      }

      const result = await deps.pool.query(
        `SELECT r.*, p.semver, p.version_rid, p.artifact_sha256, p.function_rids
           FROM jemma_run r
           LEFT JOIN function_publish_request p ON p.run_rid = r.rid
          WHERE r.rid = $1`,
        [retriggered.runRid],
      );
      const stages = await deps.pool.query(
        `SELECT * FROM jemma_run_stage WHERE run_rid = $1`,
        [retriggered.runRid],
      );
      res.setHeader("Location", `/api/v1/jemma/runs/${encodeURIComponent(retriggered.runRid)}`);
      res.status(retriggered.replayed ? 200 : 202).json({
        ...runResponse(result.rows[0], stages.rows),
        retriggeredFrom: retriggered.sourceRunRid,
        replayed: retriggered.replayed,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function runResponse(row: any, stages: any[]): Record<string, unknown> {
  return {
    rid: row.rid,
    repositoryRid: row.repository_rid,
    ref: row.ref,
    commitSha: row.commit_sha,
    trigger: row.trigger_kind,
    triggeredBy: row.triggered_by,
    jobName: row.job_name ?? "repository-checks",
    state: row.state,
    failureReason: row.failure_reason,
    queuedAt: toIso(row.queued_at),
    startedAt: row.started_at ? toIso(row.started_at) : null,
    finishedAt: row.finished_at ? toIso(row.finished_at) : null,
    podName: row.pod_name,
    resourceVersion: row.resource_version,
    semver: row.semver ?? null,
    versionRid: row.version_rid ?? null,
    artifactSha256: row.artifact_sha256 ?? null,
    functionRids: row.function_rids ?? {},
    stages: stages
      .sort((a, b) => ["setup", "lint", "test", "build", "publish"].indexOf(a.stage_name)
        - ["setup", "lint", "test", "build", "publish"].indexOf(b.stage_name))
      .map(stageResponse),
  };
}

function stageResponse(row: any): Record<string, unknown> {
  return {
    name: row.stage_name,
    state: row.state,
    startedAt: row.started_at ? toIso(row.started_at) : null,
    finishedAt: row.finished_at ? toIso(row.finished_at) : null,
    logObjectUri: row.log_object_uri,
    exitCode: row.exit_code,
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isUuidV4(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function derivePrincipalSubUuid(userId: string): string {
  if (isUuidV4(userId)) return userId;
  const hash = createHash("sha256").update(`code-repos:principal:${userId}`).digest("hex");
  const variantNibble = (parseInt(hash[16], 16) & 0x3) | 0x8;
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${variantNibble.toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
