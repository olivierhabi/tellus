/**
 * B10 — Ontology binding HTTP handlers.
 * POST   /api/v1/ontology/bindings
 * GET    /api/v1/ontology/bindings/:rid
 * PUT    /api/v1/ontology/bindings/:rid   (If-Match required)
 * DELETE /api/v1/ontology/bindings/:rid   (If-Match required)
 * POST   /api/v1/ontology/bindings/:rid/regenerate-osdk
 * GET    /api/v1/ontology/bindings/by-object-type/:rid
 * GET    /api/v1/ontology/bindings/by-dataset/:rid
 */
import type { Request, Response, NextFunction, Router } from "express";
import { Router as makeRouter } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { TellusError, sendEnvelope } from "../../lib/errors/envelope";
import {
  OntologyUnauthorized,
  OntologyInvalidBinding,
  OntologyBindingNotFound,
  OntologyResourceVersionMismatch,
  OntologyInternal,
} from "../../lib/errors/ontology.errors";
import { OntologyBindingSchema } from "./contracts";
import { OntologyBindingsRepo } from "./repo";
import { triggerRegen } from "./osdk-regen";
import { parseIfMatch, emitEtag } from "../../middleware/connectivityEtag";

const CreateReq = OntologyBindingSchema.omit({
  rid: true,
  status: true,
  version: true,
  osdk_version: true,
});

function asUser(req: Request): { id: string; tenant: string } {
  const u = (req as { user?: { id?: string; tenant?: string } }).user;
  if (!u?.id || !u?.tenant) throw new TellusError(OntologyUnauthorized);
  return { id: u.id, tenant: u.tenant };
}

export function buildOntologyBindingsRouter(repo: OntologyBindingsRepo): Router {
  const r = makeRouter();

  r.post("/bindings", async (req, res, next) => {
    try {
      asUser(req);
      const body = CreateReq.parse(req.body);
      const rid = `ri.ontology.main.binding.${randomUUID()}`;
      const created = await repo.create({
        ...body,
        rid,
        status: "pending",
        osdk_version: null,
        version: 1,
      } as Parameters<typeof repo.create>[0]);
      emitEtag(res, created.version);
      res.status(201).json(created);
    } catch (e) {
      next(e);
    }
  });

  r.get("/bindings/:rid", async (req, res, next) => {
    try {
      const b = await repo.get(req.params.rid);
      if (!b) throw new TellusError(OntologyBindingNotFound, { rid: req.params.rid });
      emitEtag(res, b.version);
      res.json(b);
    } catch (e) {
      next(e);
    }
  });

  r.get("/bindings/by-object-type/:rid", async (req, res, next) => {
    try {
      res.json({ items: await repo.listByObjectType(req.params.rid) });
    } catch (e) {
      next(e);
    }
  });

  r.get("/bindings/by-dataset/:rid", async (req, res, next) => {
    try {
      res.json({ items: await repo.listByDataset(req.params.rid) });
    } catch (e) {
      next(e);
    }
  });

  r.put("/bindings/:rid", async (req, res, next) => {
    try {
      asUser(req);
      const expected = parseIfMatch(req);
      const patch = CreateReq.partial().parse(req.body);
      const updated = await repo.updateOcc(
        req.params.rid,
        expected as number,
        patch as Parameters<typeof repo.updateOcc>[2],
      );
      if (!updated) {
        throw new TellusError(OntologyResourceVersionMismatch, { rid: req.params.rid });
      }
      await triggerRegen(req.params.rid, "binding updated");
      emitEtag(res, updated.version);
      res.json(updated);
    } catch (e) {
      next(e);
    }
  });

  r.delete("/bindings/:rid", async (req, res, next) => {
    try {
      asUser(req);
      parseIfMatch(req);
      const ok = await repo.softDelete(req.params.rid);
      if (!ok) throw new TellusError(OntologyBindingNotFound, { rid: req.params.rid });
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  r.post("/bindings/:rid/regenerate-osdk", async (req, res, next) => {
    try {
      asUser(req);
      const jobId = await triggerRegen(req.params.rid, "manual");
      res.status(202).json({
        status: "queued",
        job_id: jobId,
        rid: req.params.rid,
      });
    } catch (e) {
      next(e);
    }
  });

  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      return sendEnvelope(res, OntologyInvalidBinding, { issues: err.issues });
    }
    if (err instanceof TellusError) return err.send(res);
    return sendEnvelope(res, OntologyInternal, {
      message: err instanceof Error ? err.message : String(err),
    });
  });

  return r;
}
