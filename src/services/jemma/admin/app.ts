// ---------------------------------------------------------------------------
// B6 — Jemma admin Express app factory.
// ---------------------------------------------------------------------------

import express, { type Express } from "express";
import type { Pool } from "pg";
import type { WorkerAdapter } from "../scheduler/types";
import { jemmaRouter } from "./routes";

export interface JemmaAppDeps {
  readonly pool: Pool;
  readonly worker: WorkerAdapter;
}

export function createJemmaApp(deps: JemmaAppDeps): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.disable("x-powered-by");

  app.use("/jemma/api/v1", jemmaRouter(deps));

  // Top-level error handler — guarantees §1.3 envelope on uncaught. The
  // 4-arg signature is required by Express to recognise this as an error
  // middleware; the underscore-prefixed params are intentionally unused.
  app.use(function jemma5xx(
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) {
    if (res.headersSent) return;
    res.status(500).json({
      errorCode: "INTERNAL",
      errorName: "Jemma:StageFailed",
      errorInstanceId: "internal",
      parameters: { message: (err as Error)?.message ?? "internal error" },
    });
  });

  return app;
}
