// ---------------------------------------------------------------------------
// B1 — Stemma smart-HTTP Express app factory.
//
// Mounts the smart-HTTP router at `/stemma/git/v1` so the URL space
// is `/stemma/git/v1/<rid>/info/refs` etc. The path is deliberately
// distinct from the admin Conjure surface (`/stemma/api/v1`) so on-
// call can mux the two through different load balancers / WAFs.
// ---------------------------------------------------------------------------

import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import type { Pool } from "pg";

import { stemmaSmartHttpRouter } from "./routes";
import { buildEnvelope, ERROR_CODES } from "../../codeRepos/contracts/errors";

export interface StemmaSmartHttpAppDeps {
  readonly pool: Pool;
  readonly maxBodyBytes?: number;
}

export function createStemmaSmartHttpApp(deps: StemmaSmartHttpAppDeps): Express {
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

  app.use("/stemma/git/v1", stemmaSmartHttpRouter(deps));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    res.status(500).json(
      buildEnvelope({
        errorCode: ERROR_CODES.INTERNAL,
        errorName: "Stemma:Internal",
        parameters: { reason: err instanceof Error ? err.message : String(err) },
      }),
    );
  });

  return app;
}
