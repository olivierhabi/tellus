// B3 — Templates admin Express app factory.

import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { Pool } from "pg";
import { templatesError } from "../errors.js";
import { createTemplatesRouter, createScaffoldRouter } from "./routes.js";

export interface CreateTemplatesAppArgs {
  readonly pool: Pool;
}

export function createTemplatesApp(args: CreateTemplatesAppArgs): Express {
  const app = express();

  app.get("/health", (_req: Request, res: Response) => res.status(200).json({ status: "ok" }));
  app.get("/readiness", async (_req: Request, res: Response) => {
    try {
      await args.pool.query("SELECT 1");
      res.status(200).json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "unready" });
    }
  });

  // Each B3 resource gets its own mount, mirroring the live server in
  // src/server.ts (ADR-008). Mounting both at "/" via a single router
  // would re-introduce the cross-resource middleware leak the split fixes.
  app.use("/templates", createTemplatesRouter({ pool: args.pool }));
  app.use("/scaffold", createScaffoldRouter({ pool: args.pool }));

  // Final 5xx envelope.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    void _next;
    const env = templatesError("Templates:Internal", { message: (err as Error)?.message ?? "unknown" });
    res.status(env.status).type("application/json").send(JSON.stringify(env.envelope));
  });

  return app;
}
