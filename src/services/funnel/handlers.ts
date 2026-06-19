/**
 * B9 — Funnel bindings HTTP handlers.
 * POST   /api/v1/funnel/bindings
 * GET    /api/v1/funnel/bindings/:rid
 * GET    /api/v1/funnel/bindings
 * POST   /api/v1/funnel/bindings/:rid/reindex
 * DELETE /api/v1/funnel/bindings/:rid
 */
import type { Request, Response, NextFunction, Router } from "express";
import { Router as makeRouter } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { TellusError, sendEnvelope } from "../../lib/errors/envelope";
import {
  FunnelUnauthorized,
  FunnelInvalidBinding,
  FunnelBindingNotFound,
  FunnelInternal,
} from "../../lib/errors/funnel.errors";
import { ObjectTypeBindingSchema } from "./contracts/object-type-binding";
import { FunnelBindingsRepo } from "./bindings/repo";
import type { CheckpointStore } from "./pipeline/streaming-consumer";

const CreateRequestSchema = ObjectTypeBindingSchema.omit({
  rid: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
});

function asUser(req: Request): { id: string; tenant: string } {
  const u = (req as { user?: { id?: string; tenant?: string } }).user;
  if (!u?.id || !u?.tenant) {
    throw new TellusError(FunnelUnauthorized);
  }
  return { id: u.id, tenant: u.tenant };
}

export function buildFunnelRouter(
  repo: FunnelBindingsRepo,
  // Reserved for future use (checkpoint admin endpoints).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _checkpoints?: CheckpointStore,
): Router {
  const r = makeRouter();

  r.post("/bindings", async (req, res, next) => {
    try {
      asUser(req);
      const body = CreateRequestSchema.parse(req.body);
      const rid = `ri.funnel.main.binding.${randomUUID()}`;
      const now = new Date().toISOString();
      const created = await repo.create({
        ...body,
        rid,
        status: "pending",
        version: 1,
        createdAt: now,
        updatedAt: now,
      } as Parameters<FunnelBindingsRepo["create"]>[0]);
      res.setHeader("ETag", `W/"${created.version}"`);
      res.status(201).json(created);
    } catch (e) {
      next(e);
    }
  });

  r.get("/bindings/:rid", async (req, res, next) => {
    try {
      const b = await repo.get(req.params.rid);
      if (!b) throw new TellusError(FunnelBindingNotFound, { rid: req.params.rid });
      res.setHeader("ETag", `W/"${b.version}"`);
      res.json(b);
    } catch (e) {
      next(e);
    }
  });

  r.get("/bindings", async (req, res, next) => {
    try {
      const list = await repo.list({
        objectTypeRid:
          typeof req.query.objectTypeRid === "string"
            ? req.query.objectTypeRid
            : undefined,
      });
      res.json({ items: list });
    } catch (e) {
      next(e);
    }
  });

  r.post("/bindings/:rid/reindex", async (req, res, next) => {
    try {
      asUser(req);
      const updated = await repo.markReindexing(req.params.rid);
      if (!updated) {
        throw new TellusError(FunnelBindingNotFound, { rid: req.params.rid });
      }
      res.status(202).json({ status: "queued", rid: updated.rid });
    } catch (e) {
      next(e);
    }
  });

  r.delete("/bindings/:rid", async (req, res, next) => {
    try {
      asUser(req);
      const ok = await repo.softDelete(req.params.rid);
      if (!ok) {
        throw new TellusError(FunnelBindingNotFound, { rid: req.params.rid });
      }
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  // Local error funnel.
  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      return sendEnvelope(res, FunnelInvalidBinding, { issues: err.issues });
    }
    if (err instanceof TellusError) {
      return err.send(res);
    }
    return sendEnvelope(res, FunnelInternal, {
      message: err instanceof Error ? err.message : String(err),
    });
  });

  return r;
}
