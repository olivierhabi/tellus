// ---------------------------------------------------------------------------
// B10 — Stemma Events admin Express app factory (test-friendly).
//
// Mirrors the pattern from src/services/stemma/admin/app.ts: returns a
// fresh Express app wired with the admin router and a JSON 5xx envelope
// on uncaught errors. No globals; no singleton state.
// ---------------------------------------------------------------------------

import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import type { Pool } from "pg";

import { stemmaEventsAdminRouter } from "./routes";
import { buildEnvelope, ERROR_CODES } from "../../codeRepos/contracts/errors";

export interface StemmaEventsAdminAppDeps {
  readonly pool: Pool;
}

export function createStemmaEventsAdminApp(
  deps: StemmaEventsAdminAppDeps,
): Express {
  const app = express();

  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));
  app.get("/readiness", async (_req, res) => {
    try {
      await deps.pool.query("SELECT 1");
      res.status(200).json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "not-ready" });
    }
  });

  app.use("/stemma-events/api/v1", stemmaEventsAdminRouter(deps));

  // Global error catcher — every uncaught route error becomes the spec
  // envelope. We deliberately use a namespaced errorName so on-call can
  // distinguish a Stemma Events 500 from any other CodeRepos 500.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const env = buildEnvelope({
      errorCode: ERROR_CODES.INTERNAL,
      errorName: "StemmaEvents:Internal",
      parameters: { reason: err instanceof Error ? err.message : String(err) },
    });
    res.status(500).json(env);
  });

  return app;
}
