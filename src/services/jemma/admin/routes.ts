// ---------------------------------------------------------------------------
// B6 — Jemma admin HTTP routes.
//
// Mounts under /jemma/api/v1.
//
// Endpoints:
//   POST   /runs                     — startRun (idempotent, scheduler-driven)
//   GET    /runs/:rid                — getRun
//   GET    /runs                     — listRuns (cursor-paginated)
//   POST   /runs/:rid:cancel         — cancelRun
//   GET    /runs/:rid/stages         — getRunStages
//   GET    /health                   — liveness
//   GET    /readiness                — DB-touch readiness
//
// Cross-cutting:
//   - Bearer auth (G-C-07..11) via requireCodeReposAuth
//   - Idempotency-Key on POST  via idempotencyMiddleware (skip /runs/:rid:cancel)
//   - ETag on GET /runs/:rid (W/"<resource_version>")
//   - §1.3 envelope on every error path
//   - IDOR-as-404 (G-C-09) — getRun on unknown rid → 404 Jemma:RunNotFound
// ---------------------------------------------------------------------------

import { Router, type Request, type Response, type NextFunction } from "express";
import { createHash } from "node:crypto";
import type { Pool } from "pg";

import { isRid, isStructurallyRid } from "../../codeRepos/contracts/rid";
import { requireCodeReposAuth } from "../../codeRepos/middleware/principal";
import { idempotencyMiddleware } from "../../codeRepos/middleware/idempotency";
import { codeReposError } from "../../codeRepository/errors";
import { jemmaError } from "../errors";
import {
  cancelRunByUser,
  scheduleRun,
} from "../scheduler/scheduler";
import type { WorkerAdapter } from "../scheduler/types";
import {
  getRun,
  getRunStages,
  listActiveRunsForRepo,
  type RunRow,
} from "../store/runStore";
import { BRANCH_NAME_CHAR_REGEX } from "../../codeRepos/contracts/regex";
import type { ErrorEnvelope } from "../../codeRepos/contracts/errors";
import type { RunTrigger } from "../state/types";

const COMMIT_SHA_REGEX = /^[0-9a-f]{7,64}$/i;

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

export interface JemmaRoutesDeps {
  readonly pool: Pool;
  readonly worker: WorkerAdapter;
}

interface StartRunBody {
  repositoryRid?: unknown;
  ref?: unknown;
  commitSha?: unknown;
  trigger?: unknown;
  triggeringUserSub?: unknown;
}

const VALID_TRIGGERS: ReadonlySet<RunTrigger> = new Set(["PUSH", "PR", "TAG", "MANUAL"]);

// ---------------------------------------------------------------------------
// Builder.
// ---------------------------------------------------------------------------

export function jemmaRouter(deps: JemmaRoutesDeps): Router {
  const router = Router();
  const { pool, worker } = deps;

  // Health + readiness are unauthenticated by design (G-C-41). They MUST be
  // mounted before the auth middleware below.
  router.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });
  router.get("/readiness", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.status(200).json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });

  router.use(requireCodeReposAuth());

  // -------------------------------------------------------------------------
  // POST /runs
  // -------------------------------------------------------------------------
  router.post(
    "/runs",
    idempotencyMiddleware({ pool }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const principal = req.codeReposPrincipal;
        if (!principal) {
          return sendError(
            res,
            jemmaError("Jemma:StageFailed", { reason: "principal not bound" }),
          );
        }
        const idem = (req.header("Idempotency-Key") ?? "").trim();
        if (!idem) {
          return sendError(
            res,
            jemmaError("Jemma:StageFailed", { field: "Idempotency-Key" }),
          );
        }

        const body = (req.body ?? {}) as StartRunBody;
        const validation = validateStartBody(body);
        if (validation.kind === "invalid") {
          return sendError(res, codeReposError("CodeRepos:InvalidSettings", validation.parameters));
        }

        const triggeredBy =
          typeof body.triggeringUserSub === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            body.triggeringUserSub,
          )
            ? body.triggeringUserSub
            : derivePrincipalSubUuid(principal.userId);

        const outcome = await scheduleRun(
          { pool, worker },
          {
            repositoryRid: validation.body.repositoryRid,
            ref: validation.body.ref,
            commitSha: validation.body.commitSha,
            trigger: validation.body.trigger,
            triggeredBy,
            idempotencyKey: idem,
          },
        );

        switch (outcome.kind) {
          case "started":
          case "queued": {
            res.setHeader("ETag", `W/"${outcome.run.resourceVersion}"`);
            res.status(201).json({
              ...runToResponse(outcome.run),
              cancelledRid:
                outcome.kind === "started" ? (outcome as { cancelledRid: string | null }).cancelledRid : null,
            });
            return;
          }
          case "replay": {
            res.setHeader("ETag", `W/"${outcome.run.resourceVersion}"`);
            res.setHeader("X-Idempotent-Replay", "true");
            res.status(200).json(runToResponse(outcome.run));
            return;
          }
          case "capacity-exceeded":
            return sendError(res, jemmaError("Jemma:CapacityExceeded", { reason: outcome.reason }));
          case "image-unavailable":
            return sendError(res, jemmaError("Jemma:WorkerImageUnavailable"));
        }
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /runs/:rid
  // -------------------------------------------------------------------------
  router.get("/runs/:rid", async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) {
        return sendError(res, jemmaError("Jemma:RunNotFound", { rid }));
      }
      const run = await getRun(pool, rid);
      if (!run) {
        return sendError(res, jemmaError("Jemma:RunNotFound", { rid }));
      }
      res.setHeader("ETag", `W/"${run.resourceVersion}"`);
      res.status(200).json(runToResponse(run));
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /runs/:rid/stages
  // -------------------------------------------------------------------------
  router.get("/runs/:rid/stages", async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) {
        return sendError(res, jemmaError("Jemma:RunNotFound", { rid }));
      }
      const run = await getRun(pool, rid);
      if (!run) {
        return sendError(res, jemmaError("Jemma:RunNotFound", { rid }));
      }
      const stages = await getRunStages(pool, rid);
      res.status(200).json({
        runRid: rid,
        stages: stages.map((s) => ({
          name: s.stageName,
          state: s.state,
          startedAt: s.startedAt?.toISOString() ?? null,
          finishedAt: s.finishedAt?.toISOString() ?? null,
          logObjectUri: s.logObjectUri,
          exitCode: s.exitCode,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /runs/:rid/cancel
  //
  // Spec §B6 uses Conjure form `POST /runs/{rid}:cancel`; we expose the
  // RESTful equivalent `/runs/{rid}/cancel` (Express path parser cannot
  // accept literal `:cancel` adjacent to a `:rid` parameter). Conjure
  // clients map the verb-ish suffix transparently.
  // -------------------------------------------------------------------------
  router.post("/runs/:rid/cancel", async (req, res, next) => {
    try {
      const rid = req.params.rid;
      if (!isRid(rid)) {
        return sendError(res, jemmaError("Jemma:RunNotFound", { rid }));
      }
      const result = await cancelRunByUser({ pool, worker }, rid);
      if (result.kind === "not-found") {
        return sendError(res, jemmaError("Jemma:RunNotFound", { rid }));
      }
      if (result.kind === "already-terminal") {
        return sendError(res, jemmaError("Jemma:RunAlreadyTerminal", { rid }));
      }
      // 200 with the canonical run shape, fetched fresh.
      const fresh = await getRun(pool, rid);
      if (!fresh) {
        return sendError(res, jemmaError("Jemma:RunNotFound", { rid }));
      }
      res.setHeader("ETag", `W/"${fresh.resourceVersion}"`);
      res.status(200).json(runToResponse(fresh));
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /runs (cursor-paginated by query)
  // -------------------------------------------------------------------------
  router.get("/runs", async (req, res, next) => {
    try {
      const repoQ = String(req.query.repositoryRid ?? "");
      if (!isStructurallyRid(repoQ)) {
        return sendError(res, codeReposError("CodeRepos:InvalidSettings", { field: "repositoryRid" }));
      }
      // Optional ?ref filter.
      const ref = typeof req.query.ref === "string" ? req.query.ref : null;
      // For wave-11 we restrict to ACTIVE runs (sufficient for the dashboard
      // and the demo-flow gate); a fully cursor-paginated history list lands
      // in a follow-up wave.
      const runs = await listActiveRunsForRepo(pool, repoQ);
      const filtered = ref ? runs.filter((r) => r.ref === ref) : runs;
      res.status(200).json({
        items: filtered.map(runToResponse),
        nextPageToken: null,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function sendError(res: Response, err: { status: number; envelope: ErrorEnvelope }): void {
  res.status(err.status).json(err.envelope);
}

interface ValidStartArgs {
  repositoryRid: string;
  ref: string;
  commitSha: string;
  trigger: RunTrigger;
}

function validateStartBody(
  body: StartRunBody,
): { kind: "valid"; body: ValidStartArgs } | { kind: "invalid"; parameters: Record<string, unknown> } {
  if (typeof body.repositoryRid !== "string" || !isStructurallyRid(body.repositoryRid)) {
    return { kind: "invalid", parameters: { field: "repositoryRid" } };
  }
  if (typeof body.ref !== "string" || !BRANCH_NAME_CHAR_REGEX.test(body.ref)) {
    return { kind: "invalid", parameters: { field: "ref" } };
  }
  if (typeof body.commitSha !== "string" || !COMMIT_SHA_REGEX.test(body.commitSha)) {
    return { kind: "invalid", parameters: { field: "commitSha" } };
  }
  if (typeof body.trigger !== "string" || !VALID_TRIGGERS.has(body.trigger as RunTrigger)) {
    return { kind: "invalid", parameters: { field: "trigger" } };
  }
  return {
    kind: "valid",
    body: {
      repositoryRid: body.repositoryRid,
      ref: body.ref,
      commitSha: body.commitSha,
      trigger: body.trigger as RunTrigger,
    },
  };
}

function runToResponse(run: RunRow): Record<string, unknown> {
  return {
    rid: run.rid,
    repositoryRid: run.repositoryRid,
    ref: run.ref,
    commitSha: run.commitSha,
    trigger: run.trigger,
    triggeredBy: run.triggeredBy,
    state: run.state,
    podName: run.podName,
    queuedAt: run.queuedAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    failureReason: run.failureReason,
    resourceVersion: run.resourceVersion,
  };
}

function derivePrincipalSubUuid(userId: string): string {
  // Same logic as B2 routes — deterministic v4-shaped UUID for non-Keycloak
  // principals (PAT/test). Production keycloakSub is UUIDv4 by construction.
  const h = createHash("sha256").update(`code-repos:principal:${userId}`).digest("hex");
  const seg1 = h.slice(0, 8);
  const seg2 = h.slice(8, 12);
  const seg3 = "4" + h.slice(13, 16);
  const variantNibble = (parseInt(h[16], 16) & 0x3) | 0x8;
  const seg4 = variantNibble.toString(16) + h.slice(17, 20);
  const seg5 = h.slice(20, 32);
  return `${seg1}-${seg2}-${seg3}-${seg4}-${seg5}`;
}
