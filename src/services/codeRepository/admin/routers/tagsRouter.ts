// ---------------------------------------------------------------------------
// Tags router — extracted from admin/routes.ts.
//
//   POST /:rid/tags  — Tag & Release (Foundry parity A16/B5): publish ONE
//   immutable function_version row carrying the whole bundle.
//
// Mounted by codeRepositoryRouter() in ../routes.ts in the original
// registration order.
// ---------------------------------------------------------------------------

import { Router, type Request, type Response, type NextFunction } from "express";
import { createHash, randomUUID } from "node:crypto";
import { idempotencyMiddleware } from "../../../codeRepos/middleware/idempotency";
import { codeReposError } from "../../errors";
import { isRid, mintFunctionVersionRid } from "../../../codeRepos/contracts/rid";
import { publishVersion, listVersions } from "../../../functionsRegistry/store";
import { authorizePublish } from "../../../functions/executionPolicy";
import { parseFunctionPath } from "../../../functions/discovery";
import { parseSemver, compareSemver, isPreviewRelease } from "../../../functionsRegistry/semver";
import {
  createS3FunctionArtifactStore,
  FunctionArtifactError,
} from "../../../functionsRegistry/artifactStore";
import { FunctionsPublishError } from "../../../functionsPublish/service";
import { derivePrincipalSubUuid, sendError } from "../routeHelpers";
import type { CodeRepositoryRouteContext } from "../routeContext";

export function createTagsRouter(ctx: CodeRepositoryRouteContext): Router {
  const router = Router();

  // POST /:rid/tags  — Tag & Release (Foundry parity A16/B5).
  //
  // This is the load-bearing bridge from repository → functions registry that
  // makes TypeScript Functions v2 actually publishable. Steps (mirroring
  // Foundry's "Tag and release publishes ALL functions in the repository"):
  //
  //   1. Resolve the branch + its content-pinned tree hash (the publish's
  //      commit identifier).
  //   2. Discover every function under src/functions/*.ts (one default export
  //      per file; basename = apiName).
  //   3. Build each artifact (transpile-validate; a compile error fails the
  //      whole release — Foundry blocks publish on a failing build).
  //   4. Backward-compatibility check vs the prior highest version on the
  //      branch: a dropped function requires a MAJOR bump.
  //   5. Publish ONE immutable function_version row carrying the whole bundle
  //      (manifest.exports = [apiNames], manifest.sources = {apiName: src}),
  //      content-addressed by artifact_sha256. Immutability is enforced by the
  //      registry store's unique index.
  //
  //   Body: { tag | semver: "X.Y.Z", branch?, message? }
  //   201  { version, functions: [...], deduplicated? }
  // -------------------------------------------------------------------------
  router.post("/:rid/tags", ctx.auth, idempotencyMiddleware({ pool: ctx.pool }), async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));

      // Publish authorization gate (execution security boundary): the
      // current executor is worker_threads + vm — NOT an untrusted-code
      // sandbox — so publishing executable Functions requires the publish
      // role, an active function_publish_grants entry, the legacy env
      // allowlist (deprecated), or open-development mode (never honored in
      // production). Every decision is persisted to
      // function_publish_audit_log; an allow whose audit write fails is
      // refused. See functions/executionPolicy.ts and
      // docs/operations/automate-function-invocation-contract.md.
      const publishPrincipal = req.codeReposPrincipal;
      if (!publishPrincipal) {
        return sendError(res, codeReposError("CodeRepos:Internal", { reason: "principal not bound" }));
      }
      // Read the tag early so the audit record can carry release_tag; full
      // SemVer validation happens below after the authorization check.
      const requestedTag = typeof (req.body as { semver?: unknown })?.semver === "string"
        ? ((req.body as { semver: string }).semver)
        : typeof (req.body as { tag?: unknown })?.tag === "string"
          ? ((req.body as { tag: string }).tag)
          : null;
      const publishDecision = await authorizePublish(ctx.pool, {
        localUserId: publishPrincipal.userId,
        keycloakSub: publishPrincipal.keycloakSub,
        roles: publishPrincipal.roles,
        repositoryRid: rid,
        releaseTag: requestedTag,
      });
      if (!publishDecision.allowed) {
        console.warn(
          JSON.stringify({
            type: "functions.publish.authorization_denied",
            repositoryRid: rid,
            userId: publishPrincipal.userId,
            reason: publishDecision.reason,
          }),
        );
        if (publishDecision.auditFailed) {
          return sendError(
            res,
            codeReposError("CodeRepos:Internal", { reason: "publish-audit-unavailable" }),
          );
        }
        return sendError(
          res,
          codeReposError("CodeRepos:PermissionDenied", {
            reason: publishDecision.reason,
          }),
        );
      }

      const b = (req.body ?? {}) as { tag?: unknown; semver?: unknown; branch?: unknown; message?: unknown };
      const semverStr = typeof b.semver === "string" ? b.semver : typeof b.tag === "string" ? b.tag : "";
      let parsedSemver;
      try {
        parsedSemver = parseSemver(semverStr.replace(/^v/, ""));
      } catch {
        return sendError(res, codeReposError("CodeRepos:InvalidSettings", { field: "semver", reason: "must be a valid SemVer X.Y.Z[-prerelease]" }));
      }
      const semver = semverStr.replace(/^v/, "");

      const { rows: repoRows } = await ctx.pool.query<{ default_branch: string; state: string }>(
        `SELECT default_branch, state FROM code_repository WHERE rid = $1`,
        [rid],
      );
      if (repoRows.length === 0 || repoRows[0].state === "TRASHED") {
        return sendError(res, codeReposError("CodeRepos:RepositoryNotFound", { rid }));
      }
      const defaultBranch = repoRows[0].default_branch;
      const branch = typeof b.branch === "string" && b.branch.length > 0 ? b.branch : defaultBranch;
      // Preview vs stable: single shared predicate (see
      // functionsRegistry/semver.ts) — non-default branch or a
      // prerelease SemVer is a preview build.
      const isPreview = isPreviewRelease(branch, defaultBranch, semver);

      // TypeScript v2 uses the durable functions-publish pipeline. Keep the
      // legacy synchronous implementation below as a compatibility fallback
      // for standalone route tests that do not inject the worker service.
      if (ctx.functionsPublisher) {
        const principal = req.codeReposPrincipal;
        if (!principal) {
          return sendError(res, codeReposError("CodeRepos:Internal", { reason: "principal not bound" }));
        }
        try {
          const run = await ctx.functionsPublisher.enqueue({
            repositoryRid: rid,
            branch,
            defaultBranch,
            semver,
            message: typeof b.message === "string" ? b.message.slice(0, 1024) : null,
            triggeredBy: derivePrincipalSubUuid(principal.userId),
            idempotencyKey: (req.header("Idempotency-Key") ?? randomUUID()).trim(),
          });
          res.setHeader("Location", `/api/v1/jemma/runs/${encodeURIComponent(run.runRid)}`);
          return res.status(run.replayed ? 200 : 202).json({
            run,
            status: run.state,
            deduplicated: run.replayed,
          });
        } catch (error) {
          if (error instanceof FunctionsPublishError) {
            if (error.code === "BRANCH_NOT_FOUND") {
              return sendError(res, codeReposError("CodeRepos:BranchNotFound", { branch }));
            }
            if (error.code === "NO_FUNCTIONS") {
              return sendError(res, codeReposError("CodeRepos:NoFunctionsToPublish", { branch }));
            }
            if (error.code === "RUN_ALREADY_ACTIVE") {
              return sendError(res, codeReposError("CodeRepos:RunAlreadyActive", {
                branch,
                ...error.details,
              }));
            }
            return sendError(res, codeReposError("CodeRepos:VersionConflict", {
              reason: error.message,
              ...error.details,
            }));
          }
          throw error;
        }
      }

      // 1 + 2 — tree + function discovery.
      const tree = await ctx.stemma.listTree({ repositoryRid: rid, branch, path: "", depth: 6 });
      if (tree.kind === "branch-not-found") {
        return sendError(res, codeReposError("CodeRepos:BranchNotFound", { branch }));
      }
      if (tree.kind !== "ok") {
        return sendError(res, codeReposError("CodeRepos:Internal", { reason: "tree-read-failed" }));
      }
      const commitSha = tree.treeSha; // content-pinned identifier of the release tree
      const discovered: Array<{ apiName: string; path: string }> = [];
      for (const entry of tree.entries) {
        if (entry.type !== "blob") continue;
        // Shared identity rules (functions/discovery.ts): nested folders
        // under src/functions/ are first-class; the path is the identity.
        const parsed = parseFunctionPath(entry.path);
        if (parsed !== null && parsed.runtime === "NODE_20") {
          discovered.push({ apiName: parsed.apiName, path: entry.path });
        }
      }
      if (discovered.length === 0) {
        return sendError(res, codeReposError("CodeRepos:NoFunctionsToPublish", { branch }));
      }

      // 3 — build each artifact (read + transpile-validate).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ts = require("typescript") as typeof import("typescript");
      const sources: Record<string, string> = {};
      const exportsList: string[] = [];
      for (const fn of discovered.sort((a, c) => a.apiName.localeCompare(c.apiName))) {
        const blob = await ctx.stemma.readBlob({ repositoryRid: rid, branch, path: fn.path });
        if (blob.kind !== "ok") {
          return sendError(res, codeReposError("CodeRepos:ReleaseCompileError", { apiName: fn.apiName, reason: "source unreadable" }));
        }
        const src = new TextDecoder("utf-8").decode(blob.content);
        const out = ts.transpileModule(src, {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, isolatedModules: true },
          fileName: `${fn.apiName}.ts`,
        });
        if (out.diagnostics && out.diagnostics.length > 0) {
          return sendError(res, codeReposError("CodeRepos:ReleaseCompileError", { apiName: fn.apiName, reason: "transpile diagnostics" }));
        }
        sources[fn.apiName] = src;
        exportsList.push(fn.apiName);
      }

      // 4 — backward-compatibility check vs prior highest version on branch.
      let prior: { semver: string; exports: string[] } | null = null;
      const existing = await listVersions(ctx.pool, rid, { branch, includeYanked: false });
      for (const v of existing) {
        const exp = Array.isArray((v.manifest as { exports?: unknown }).exports)
          ? ((v.manifest as { exports: unknown[] }).exports.filter((x): x is string => typeof x === "string"))
          : [];
        if (prior === null || compareSemver(parseSemver(v.semver), parseSemver(prior.semver)) > 0) {
          prior = { semver: v.semver, exports: exp };
        }
      }
      if (prior !== null) {
        const cmp = compareSemver(parsedSemver, parseSemver(prior.semver));
        // Strictly-lower version → reject. Equal version falls through to the
        // registry's idempotent dedupe (same artifact → 200) or immutability
        // conflict (different artifact → 409); we must not pre-empt that here.
        if (cmp < 0) {
          return sendError(res, codeReposError("CodeRepos:VersionConflict", { reason: "semver must be greater than the latest published version", latest: prior.semver }));
        }
        const removed = prior.exports.filter((e) => !exportsList.includes(e));
        const majorBump = parseSemver(semver).major > parseSemver(prior.semver).major;
        if (removed.length > 0 && !majorBump) {
          return sendError(res, codeReposError("CodeRepos:BackwardIncompatible", {
            reason: "functions were removed without a major version bump",
            removedFunctions: removed,
            requiredBump: "major",
            latest: prior.semver,
          }));
        }
      }

      // 5 — publish the immutable bundle.
      const canonical = JSON.stringify({ exports: exportsList, sources });
      const artifactSha256 = createHash("sha256").update(canonical).digest("hex");
      const artifactBytes = Buffer.byteLength(canonical, "utf8");
      // Track 2 #8: real content-addressed blob — the same
      // store as the worker pipeline. The manifest carries no
      // source text; there is no inline fallback anywhere.
      let artifactBlobId: string;
      try {
        const put = await createS3FunctionArtifactStore().put({
          digest: artifactSha256,
          bundle: canonical,
        });
        artifactBlobId = put.blobId;
      } catch (e) {
        if (e instanceof FunctionArtifactError && e.code === "ARTIFACT_TOO_LARGE") {
          return sendError(res, codeReposError("CodeRepos:InvalidSettings", { reason: e.message }));
        }
        throw e;
      }
      const manifest = {
        exports: exportsList,
        artifactFormat: "functions-publish-bundle/v1",
        runtime: "NODE_20" as const,
        functionCount: exportsList.length,
        message: typeof b.message === "string" ? b.message.slice(0, 1024) : null,
      };

      let publishResult;
      try {
        publishResult = await publishVersion(ctx.pool, {
          rid: mintFunctionVersionRid(),
          repositoryRid: rid,
          branch,
          isPreview,
          semver,
          commitSha,
          runtime: "NODE_20",
          artifactBlobId,
          artifactSha256,
          artifactBytes,
          manifest,
        });
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "23505") {
          return sendError(res, codeReposError("CodeRepos:VersionConflict", { reason: "version already exists", semver }));
        }
        throw e;
      }
      if (publishResult.outcome === "immutable-conflict") {
        return sendError(res, codeReposError("CodeRepos:VersionConflict", {
          reason: "this version already exists with a different artifact (immutable)",
          semver,
        }));
      }

      const status = publishResult.outcome === "inserted" ? 201 : 200;
      res.setHeader("ETag", `W/"${semver}"`);
      return res.status(status).type("application/json").send(JSON.stringify({
        version: {
          rid: publishResult.row.rid,
          repositoryRid: rid,
          branch,
          semver,
          isPreview,
          commitSha,
          runtime: "NODE_20",
          state: publishResult.row.state,
          artifactSha256,
          publishedAt: publishResult.row.publishedAt,
        },
        functions: exportsList,
        deduplicated: publishResult.outcome === "deduplicated",
      }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
