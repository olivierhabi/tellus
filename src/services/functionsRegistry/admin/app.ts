// B8 — Functions Registry admin Express app factory.

import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { Pool } from "pg";
import { functionsError } from "../errors.js";
import { createFunctionsRouter } from "./routes.js";

export interface CreateFunctionsAppArgs {
  readonly pool: Pool;
}

export function createFunctionsApp(args: CreateFunctionsAppArgs): Express {
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
  app.use("/", createFunctionsRouter({ pool: args.pool }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    void _next;
    const env = functionsError("Functions:Internal", { message: (err as Error)?.message ?? "unknown" });
    res.status(env.status).type("application/json").send(JSON.stringify(env.envelope));
  });
  return app;
}
