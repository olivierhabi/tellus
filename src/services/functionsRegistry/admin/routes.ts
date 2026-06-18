// B8 — Functions Registry admin routes.

import express, { type Request, type Response, type Router } from "express";
import type { Pool } from "pg";
import { requireCodeReposAuth } from "../../codeRepos/middleware/principal.js";
import { idempotencyMiddleware } from "../../codeRepos/middleware/idempotency.js";
import { isStructurallyRid, mintFunctionVersionRid } from "../../codeRepos/contracts/rid.js";
import { functionsError, type FunctionsError } from "../errors.js";
import { parseRange, parseSemver } from "../semver.js";
import {
  getVersion,
  listVersions,
  publishVersion,
  resolveTarget,
  yankVersion,
} from "../store.js";

export interface FunctionsRouterDeps {
  readonly pool: Pool;
}

function sendError(res: Response, err: FunctionsError): void {
  res.status(err.status).type("application/json").send(JSON.stringify(err.envelope));
}

function isObjectRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

interface PublishVersionBody {
  readonly branch: string;
  readonly isPreview: boolean;
  readonly semver: string;
  readonly commitSha: string;
  readonly runtime: "NODE_20" | "PY_311";
  readonly artifactBlobId: string;
  readonly artifactSha256: string;
  readonly artifactBytes: number;
  readonly manifest: Record<string, unknown>;
}

function validatePublishBody(body: unknown): { ok: true; body: PublishVersionBody } | { ok: false; err: FunctionsError } {
  if (!isObjectRecord(body)) return { ok: false, err: functionsError("Functions:InvalidArgument", { reason: "body-not-object" }) };
  const b = body as Record<string, unknown>;
  if (typeof b.branch !== "string" || b.branch.length === 0 || b.branch.length > 255) {
    return { ok: false, err: functionsError("Functions:InvalidArgument", { reason: "invalid-branch" }) };
  }
  if (typeof b.isPreview !== "boolean") return { ok: false, err: functionsError("Functions:InvalidArgument", { reason: "invalid-isPreview" }) };
  if (typeof b.semver !== "string") return { ok: false, err: functionsError("Functions:InvalidArgument", { reason: "missing-semver" }) };
  try {
    parseSemver(b.semver);
  } catch {
    return { ok: false, err: functionsError("Functions:InvalidArgument", { reason: "invalid-semver", semver: b.semver }) };
  }
  if (typeof b.commitSha !== "string" || !/^[0-9a-f]{7,64}$/.test(b.commitSha)) {
    return { ok: false, err: functionsError("Functions:InvalidArgument", { reason: "invalid-commit-sha" }) };
  }
  if (b.runtime !== "NODE_20" && b.runtime !== "PY_311") {
    return { ok: false, err: functionsError("Functions:InvalidArgument", { reason: "invalid-runtime" }) };
  }
  if (typeof b.artifactBlobId !== "string" || b.artifactBlobId.length === 0) {
    return { ok: false, err: functionsError("Functions:InvalidArgument", { reason: "missing-artifactBlobId" }) };
  }
  if (typeof b.artifactSha256 !== "string" || !/^[0-9a-f]{64}$/.test(b.artifactSha256)) {
    return { ok: false, err: functionsError("Functions:InvalidArgument", { reason: "invalid-artifactSha256" }) };
  }
  if (typeof b.artifactBytes !== "number" || !Number.isInteger(b.artifactBytes) || b.artifactBytes < 0) {
    return { ok: false, err: functionsError("Functions:InvalidArgument", { reason: "invalid-artifactBytes" }) };
  }
  if (!isObjectRecord(b.manifest)) return { ok: false, err: functionsError("Functions:InvalidArgument", { reason: "missing-manifest" }) };
  return {
    ok: true,
    body: {
      branch: b.branch,
      isPreview: b.isPreview,
      semver: b.semver,
      commitSha: b.commitSha,
      runtime: b.runtime,
      artifactBlobId: b.artifactBlobId,
      artifactSha256: b.artifactSha256,
      artifactBytes: b.artifactBytes,
      manifest: b.manifest,
    },
  };
}

export function createFunctionsRouter(deps: FunctionsRouterDeps): Router {
  const router = express.Router();
  router.use(express.json({ limit: "10mb" }));
  router.use(requireCodeReposAuth());
  router.use(idempotencyMiddleware({ pool: deps.pool }));

  router.post("/functions/:repositoryRid/versions", async (req: Request, res: Response) => {
    const { repositoryRid } = req.params;
    if (!isStructurallyRid(repositoryRid)) {
      sendError(res, functionsError("Functions:InvalidArgument", { reason: "invalid-repository-rid" }));
      return;
    }
    const v = validatePublishBody(req.body);
    if (!v.ok) {
      sendError(res, v.err);
      return;
    }
    try {
      const result = await publishVersion(deps.pool, {
        rid: mintFunctionVersionRid(),
        repositoryRid,
        branch: v.body.branch,
        isPreview: v.body.isPreview,
        semver: v.body.semver,
        commitSha: v.body.commitSha,
        runtime: v.body.runtime,
        artifactBlobId: v.body.artifactBlobId,
        artifactSha256: v.body.artifactSha256,
        artifactBytes: v.body.artifactBytes,
        manifest: v.body.manifest,
      });
      if (result.outcome === "immutable-conflict") {
        sendError(res, functionsError("Functions:VersionImmutable", {
          reason: "artifact-sha-mismatch",
          existingArtifactSha256: result.existingArtifactSha256,
        }));
        return;
      }
      const status = result.outcome === "inserted" ? 201 : 200;
      res.status(status).json(result.row);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "23505") {
        // Race lost in the same transactional boundary; treat as dedup failure.
        sendError(res, functionsError("Functions:VersionImmutable", { reason: "concurrent-publish" }));
        return;
      }
      if (code === "40001") {
        sendError(res, functionsError("Functions:Internal", { reason: "serialization-conflict-retry-required" }));
        return;
      }
      sendError(res, functionsError("Functions:Internal", { message: (e as Error)?.message ?? "unknown" }));
    }
  });

  router.get("/functions/:repositoryRid/versions", async (req: Request, res: Response) => {
    const { repositoryRid } = req.params;
    if (!isStructurallyRid(repositoryRid)) {
      sendError(res, functionsError("Functions:InvalidArgument", { reason: "invalid-repository-rid" }));
      return;
    }
    const branch = typeof req.query.branch === "string" ? req.query.branch : undefined;
    const includeYanked = req.query.includeYanked === "true";
    const rows = await listVersions(deps.pool, repositoryRid, { branch, includeYanked });
    res.status(200).json({ versions: rows });
  });

  router.get("/functions/:repositoryRid/versions/:semver", async (req: Request, res: Response) => {
    const { repositoryRid, semver } = req.params;
    if (!isStructurallyRid(repositoryRid)) {
      sendError(res, functionsError("Functions:InvalidArgument", { reason: "invalid-repository-rid" }));
      return;
    }
    const branch = typeof req.query.branch === "string" ? req.query.branch : undefined;
    const row = await getVersion(deps.pool, repositoryRid, semver, branch);
    if (row === null) {
      sendError(res, functionsError("Functions:VersionNotFound", { repositoryRid, semver }));
      return;
    }
    res.status(200).json(row);
  });

  router.get("/functions/:repositoryRid/resolve", async (req: Request, res: Response) => {
    const { repositoryRid } = req.params;
    if (!isStructurallyRid(repositoryRid)) {
      sendError(res, functionsError("Functions:InvalidArgument", { reason: "invalid-repository-rid" }));
      return;
    }
    const versionTarget = typeof req.query.versionTarget === "string" ? req.query.versionTarget : undefined;
    const branch = typeof req.query.branch === "string" ? req.query.branch : "main";
    const defaultBranch = typeof req.query.defaultBranch === "string" ? req.query.defaultBranch : "main";
    if (versionTarget === undefined) {
      sendError(res, functionsError("Functions:InvalidArgument", { reason: "missing-versionTarget" }));
      return;
    }
    let range;
    try {
      range = parseRange(versionTarget);
    } catch {
      sendError(res, functionsError("Functions:InvalidArgument", { reason: "invalid-versionTarget", versionTarget }));
      return;
    }
    const winner = await resolveTarget(deps.pool, {
      repositoryRid,
      versionRange: range,
      requestedBranch: branch,
      defaultBranch,
    });
    if (winner === null) {
      sendError(res, functionsError("Functions:VersionTargetUnsatisfied", { versionTarget, branch, defaultBranch }));
      return;
    }
    res.status(200).json(winner);
  });

  router.post("/functions/:repositoryRid/versions/:semver/yank", async (req: Request, res: Response) => {
    const { repositoryRid, semver } = req.params;
    if (!isStructurallyRid(repositoryRid)) {
      sendError(res, functionsError("Functions:InvalidArgument", { reason: "invalid-repository-rid" }));
      return;
    }
    const branch = typeof req.query.branch === "string" ? req.query.branch : undefined;
    const row = await getVersion(deps.pool, repositoryRid, semver, branch);
    if (row === null) {
      sendError(res, functionsError("Functions:VersionNotFound", { repositoryRid, semver }));
      return;
    }
    if (row.state === "YANKED") {
      // Idempotent yank: no change.
      res.status(200).json(row);
      return;
    }
    const updated = await yankVersion(deps.pool, row.rid);
    res.status(200).json(updated);
  });

  return router;
}
