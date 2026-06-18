// B7 — JobSpec admin routes.
//
// Surface (per spec lines 581-590):
//   POST /repositories/:rid/branches/:branch/job-specs    → PublishResult (internal)
//   GET  /job-specs?outputDatasetRid=&branch=             → JobSpec | 404
//   GET  /repositories/:rid/branches/:branch/job-specs    → JobSpec[]

import express, { type Request, type Response, type Router } from "express";
import type { Pool } from "pg";
import { requireCodeReposAuth } from "../../codeRepos/middleware/principal.js";
import { idempotencyMiddleware } from "../../codeRepos/middleware/idempotency.js";
import { isStructurallyRid } from "../../codeRepos/contracts/rid.js";
import { jobSpecError, type JobSpecError } from "../errors.js";
import {
  detectCircularDependencies,
  validateBranch,
  validateCommitSha,
  validateJobSpec,
  type JobSpecPayload,
} from "../validation.js";
import {
  getJobSpec,
  listForRepo,
  publishJobSpecs,
  type JobSpecRowToPublish,
} from "../store.js";

export interface JobSpecRouterDeps {
  readonly pool: Pool;
}

function sendError(res: Response, err: JobSpecError): void {
  res.status(err.status).type("application/json").send(JSON.stringify(err.envelope));
}

function isObjectRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

interface ParsedPublishBody {
  readonly commitSha: string;
  readonly jobSpecs: ReadonlyArray<JobSpecPayload>;
}

function validatePublishBody(body: unknown): { ok: true; body: ParsedPublishBody } | { ok: false; err: JobSpecError } {
  if (!isObjectRecord(body)) return { ok: false, err: jobSpecError("JobSpec:InvalidArgument", { reason: "body-not-object" }) };
  const { commitSha, jobSpecs } = body as Record<string, unknown>;
  if (typeof commitSha !== "string") return { ok: false, err: jobSpecError("JobSpec:InvalidArgument", { reason: "missing-commit-sha" }) };
  const sha = validateCommitSha(commitSha);
  if (!sha.ok) return { ok: false, err: jobSpecError(sha.errorName, sha.parameters) };
  if (!Array.isArray(jobSpecs)) return { ok: false, err: jobSpecError("JobSpec:InvalidArgument", { reason: "jobSpecs-not-array" }) };
  if (jobSpecs.length === 0) return { ok: false, err: jobSpecError("JobSpec:InvalidArgument", { reason: "jobSpecs-empty" }) };
  if (jobSpecs.length > 1000) return { ok: false, err: jobSpecError("JobSpec:InvalidArgument", { reason: "jobSpecs-too-many", max: 1000 }) };
  const out: JobSpecPayload[] = [];
  for (let i = 0; i < jobSpecs.length; i++) {
    const j = jobSpecs[i];
    if (!isObjectRecord(j)) return { ok: false, err: jobSpecError("JobSpec:InvalidArgument", { reason: "spec-not-object", index: i }) };
    const { outputDatasetRid, sourcePath, entryPoint, inputs, parameters, computeProfile } = j as Record<string, unknown>;
    if (typeof outputDatasetRid !== "string") return { ok: false, err: jobSpecError("JobSpec:InvalidArgument", { reason: "missing-outputDatasetRid", index: i }) };
    if (typeof sourcePath !== "string") return { ok: false, err: jobSpecError("JobSpec:InvalidArgument", { reason: "missing-sourcePath", index: i }) };
    if (typeof entryPoint !== "string") return { ok: false, err: jobSpecError("JobSpec:InvalidArgument", { reason: "missing-entryPoint", index: i }) };
    if (!Array.isArray(inputs)) return { ok: false, err: jobSpecError("JobSpec:InvalidArgument", { reason: "missing-inputs", index: i }) };
    const cp = typeof computeProfile === "string" && computeProfile.length > 0 ? computeProfile : "default";
    const p = parameters !== undefined && parameters !== null ? (parameters as Record<string, unknown>) : {};
    out.push({
      outputDatasetRid,
      sourcePath,
      entryPoint,
      inputs: inputs as ReadonlyArray<{ datasetRid: string; branch: string; view: "snapshot" | "incremental" }>,
      parameters: p,
      computeProfile: cp,
    });
  }
  // Per-spec validation.
  for (const spec of out) {
    const r = validateJobSpec(spec);
    if (!r.ok) return { ok: false, err: jobSpecError(r.errorName, r.parameters) };
  }
  // Cycle detection across the batch.
  const cyc = detectCircularDependencies(out);
  if (!cyc.ok) return { ok: false, err: jobSpecError(cyc.errorName, cyc.parameters) };
  // No duplicate output dataset within the batch.
  const seen = new Set<string>();
  for (const s of out) {
    if (seen.has(s.outputDatasetRid)) return { ok: false, err: jobSpecError("JobSpec:InvalidArgument", { reason: "duplicate-outputDatasetRid-in-batch", outputDatasetRid: s.outputDatasetRid }) };
    seen.add(s.outputDatasetRid);
  }
  return { ok: true, body: { commitSha, jobSpecs: out } };
}

export function createJobSpecRouter(deps: JobSpecRouterDeps): Router {
  const router = express.Router();
  router.use(express.json({ limit: "10mb" }));
  router.use(requireCodeReposAuth());
  router.use(idempotencyMiddleware({ pool: deps.pool }));

  router.post("/repositories/:rid/branches/:branch/job-specs", async (req: Request, res: Response) => {
    const { rid, branch } = req.params;
    if (!isStructurallyRid(rid)) {
      sendError(res, jobSpecError("JobSpec:InvalidArgument", { reason: "invalid-repository-rid" }));
      return;
    }
    const branchOk = validateBranch(branch);
    if (!branchOk.ok) {
      sendError(res, jobSpecError(branchOk.errorName, branchOk.parameters));
      return;
    }
    const v = validatePublishBody(req.body);
    if (!v.ok) {
      sendError(res, v.err);
      return;
    }
    const specs: JobSpecRowToPublish[] = v.body.jobSpecs.map((s) => ({
      outputDatasetRid: s.outputDatasetRid,
      sourcePath: s.sourcePath,
      entryPoint: s.entryPoint,
      inputs: s.inputs,
      parameters: s.parameters,
      computeProfile: s.computeProfile,
    }));
    try {
      const result = await publishJobSpecs(deps.pool, {
        repositoryRid: rid,
        branch,
        commitSha: v.body.commitSha,
        specs,
      });
      // If any rejections, return 409 OutputAlreadyOwned with the rejected list.
      if (result.rejected.length > 0) {
        sendError(
          res,
          jobSpecError("JobSpec:OutputAlreadyOwned", {
            rejected: result.rejected,
            published: result.published,
            deletedOrphans: result.deletedOrphans,
          }),
        );
        return;
      }
      res.status(200).json({
        published: result.published,
        rejected: result.rejected,
        deletedOrphans: result.deletedOrphans,
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "40001") {
        sendError(res, jobSpecError("JobSpec:ConflictingMutation", { reason: "serialization-conflict" }));
        return;
      }
      sendError(res, jobSpecError("JobSpec:Internal", { message: (e as Error)?.message ?? "unknown" }));
    }
  });

  router.get("/job-specs", async (req: Request, res: Response) => {
    const outputDatasetRid = typeof req.query.outputDatasetRid === "string" ? req.query.outputDatasetRid : undefined;
    const branch = typeof req.query.branch === "string" ? req.query.branch : undefined;
    if (outputDatasetRid === undefined || branch === undefined) {
      sendError(res, jobSpecError("JobSpec:InvalidArgument", { reason: "missing-query-params" }));
      return;
    }
    const branchOk = validateBranch(branch);
    if (!branchOk.ok) {
      sendError(res, jobSpecError(branchOk.errorName, branchOk.parameters));
      return;
    }
    const row = await getJobSpec(deps.pool, outputDatasetRid, branch);
    if (row === null) {
      sendError(res, jobSpecError("JobSpec:DatasetNotFound", { outputDatasetRid, branch }));
      return;
    }
    res.status(200).json(row);
  });

  router.get("/repositories/:rid/branches/:branch/job-specs", async (req: Request, res: Response) => {
    const { rid, branch } = req.params;
    if (!isStructurallyRid(rid)) {
      sendError(res, jobSpecError("JobSpec:InvalidArgument", { reason: "invalid-repository-rid" }));
      return;
    }
    const branchOk = validateBranch(branch);
    if (!branchOk.ok) {
      sendError(res, jobSpecError(branchOk.errorName, branchOk.parameters));
      return;
    }
    const rows = await listForRepo(deps.pool, rid, branch);
    res.status(200).json({ jobSpecs: rows });
  });

  return router;
}
