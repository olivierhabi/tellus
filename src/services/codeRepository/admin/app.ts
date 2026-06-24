// ---------------------------------------------------------------------------
// B2 — Code Repository Service admin app factory.
//
// Mounts the codeRepositoryRouter under /api/v1/code-repositories plus
// /health and /readiness (G-C-41). The mount path mirrors the live server
// (src/server.ts) so integration tests exercise the same URL shape.
//
// The mount-path-as-resource convention follows the rest of /api/docs/*
// (datasets, projects, templates, ...) per the public API surface.
// ---------------------------------------------------------------------------

import express, { type Express } from "express";
import type { Pool } from "pg";

import { codeRepositoryRouter } from "./routes";
import type {
  CompassAdapter,
  StemmaAdapter,
  TemplateAdapter,
} from "../adapters/types";

export interface CodeRepositoryAppDeps {
  readonly pool: Pool;
  readonly compass: CompassAdapter;
  readonly stemma: StemmaAdapter;
  readonly template: TemplateAdapter;
}

export function createCodeRepositoryApp(deps: CodeRepositoryAppDeps): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", service: "code-repository" });
  });

  app.get("/readiness", async (_req, res) => {
    try {
      await deps.pool.query("SELECT 1");
      res.status(200).json({ ready: true });
    } catch {
      res.status(503).json({ ready: false });
    }
  });

  app.use("/api/v1/code-repositories", codeRepositoryRouter(deps));

  // 5xx envelope wrapper.
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (res.headersSent) {
        return next(err);
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({
        errorCode: "INTERNAL",
        errorName: "CodeRepos:Internal",
        errorInstanceId: "00000000-0000-0000-0000-000000000000",
        parameters: { message },
      });
    },
  );

  return app;
}
