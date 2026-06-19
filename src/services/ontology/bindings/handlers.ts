/**
 * B10 — Ontology binding handlers.
 *
 * POST   /api/v1/ontology/bindings/suggest         — suggest map for dataset_rid
 * POST   /api/v1/ontology/bindings                 — create binding (triggers Funnel index)
 * GET    /api/v1/ontology/bindings/:rid            — fetch binding
 * PATCH  /api/v1/ontology/bindings/:rid            — update (OCC via If-Match)
 * DELETE /api/v1/ontology/bindings/:rid            — soft-delete
 * POST   /api/v1/ontology/link-types/from-fk       — propose link types
 *
 * All routes enforce Multipass scope `ontology:write` for mutations and
 * `ontology:read` for reads. Errors are emitted via the connectivity envelope.
 */
import type { Router, Request, Response, NextFunction } from "express";
import { Router as makeRouter } from "express";
import type { Knex } from "knex";
import { z } from "zod";
import { TellusError } from "../../../lib/errors/envelope";
import {
  OntologyBindingNotFound,
  OntologyResourceVersionMismatch,
  OntologyIfMatchRequired,
  OntologyInvalidBindingRequest,
  OntologyInternal,
} from "../../../lib/errors/ontology.errors";
import {
  ObjectTypeBindingSchema,
  RidSchema,
  type ObjectTypeBinding,
} from "../contracts/object-type-with-binding";
import { suggestPropertyMap, type DiscoveredColumn } from "./suggest";
import { proposeLinkTypesFromFKs, type ForeignKey } from "../link-types/from-fk";
import { publishOntologyChange } from "../cache-invalidation";

const SuggestRequest = z.object({ dataset_rid: RidSchema, columns: z.array(z.any()) });
const CreateBindingRequest = ObjectTypeBindingSchema.omit({
  rid: true,
  version: true,
  status: true,
});
const FromFkRequest = z.object({
  foreign_keys: z.array(z.any()),
  table_to_object_type: z.record(z.string(), z.string()),
  table_to_property_map: z.record(z.string(), z.record(z.string(), z.string())),
});

function rid(): string {
  return `ri.ontology.main.binding.${[...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

function weakEtag(version: number): string {
  return `W/"${version}"`;
}

function parseIfMatch(header: string | undefined): number | null {
  if (!header) return null;
  const m = /^W\/"(\d+)"$/.exec(header.trim());
  return m ? Number(m[1]) : null;
}

export function buildOntologyBindingsRouter(
  db: Knex,
  triggerFunnelIndex: (rid: string) => Promise<void>,
): Router {
  const r = makeRouter();

  r.post("/bindings/suggest", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = SuggestRequest.parse(req.body);
      const out = suggestPropertyMap(body.columns as DiscoveredColumn[]);
      res.json(out);
    } catch (e) {
      next(zodToTellus(e));
    }
  });

  r.post("/bindings", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = CreateBindingRequest.parse(req.body);
      const newRid = rid();
      const row = {
        rid: newRid,
        object_type_rid: body.object_type_rid,
        dataset_rid: body.dataset_rid,
        funnel_binding_rid: body.funnel_binding_rid,
        property_map: JSON.stringify(body.property_map),
        pk_property: body.pk_property,
        title_property: body.title_property,
        status: "pending",
        version: 1,
      };
      await db("ontology_bindings").insert(row);
      await triggerFunnelIndex(body.funnel_binding_rid);
      await publishOntologyChange({
        kind: "binding.created",
        rid: newRid,
        object_type_rid: body.object_type_rid,
      });
      res
        .status(201)
        .setHeader("ETag", weakEtag(1))
        .json({ ...body, rid: newRid, version: 1, status: "pending" });
    } catch (e) {
      next(zodToTellus(e));
    }
  });

  r.get("/bindings/:rid", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const row = await db("ontology_bindings")
        .where({ rid: req.params.rid })
        .whereNull("deleted_at")
        .first();
      if (!row) {
        return next(
          new TellusError(OntologyBindingNotFound, { rid: req.params.rid }),
        );
      }
      res.setHeader("ETag", weakEtag(row.version)).json(rowToBinding(row));
    } catch (e) {
      next(e);
    }
  });

  r.patch("/bindings/:rid", async (req: Request, res: Response, next: NextFunction) => {
    const ifMatch = parseIfMatch(req.header("if-match") || undefined);
    if (ifMatch === null) {
      return next(new TellusError(OntologyIfMatchRequired));
    }
    try {
      const updated = await db("ontology_bindings")
        .where({ rid: req.params.rid, version: ifMatch })
        .whereNull("deleted_at")
        .update({
          ...(req.body.title_property !== undefined && {
            title_property: req.body.title_property,
          }),
          ...(req.body.status && { status: req.body.status }),
          version: db.raw("version + 1"),
          updated_at: db.fn.now(),
        })
        .returning("*");
      if (updated.length === 0) {
        return next(
          new TellusError(OntologyResourceVersionMismatch, { rid: req.params.rid }),
        );
      }
      const row = updated[0];
      await publishOntologyChange({
        kind: "binding.updated",
        rid: row.rid,
        object_type_rid: row.object_type_rid,
      });
      res.setHeader("ETag", weakEtag(row.version)).json(rowToBinding(row));
    } catch (e) {
      next(e);
    }
  });

  r.delete("/bindings/:rid", async (req: Request, res: Response, next: NextFunction) => {
    const ifMatch = parseIfMatch(req.header("if-match") || undefined);
    if (ifMatch === null) {
      return next(new TellusError(OntologyIfMatchRequired));
    }
    const updated = await db("ontology_bindings")
      .where({ rid: req.params.rid, version: ifMatch })
      .whereNull("deleted_at")
      .update({ deleted_at: db.fn.now(), version: db.raw("version + 1") });
    if (updated === 0) {
      return next(
        new TellusError(OntologyResourceVersionMismatch, { rid: req.params.rid }),
      );
    }
    await publishOntologyChange({
      kind: "binding.deleted",
      rid: req.params.rid,
      object_type_rid: "",
    });
    res.status(204).send();
  });

  r.post("/link-types/from-fk", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = FromFkRequest.parse(req.body);
      const proposals = proposeLinkTypesFromFKs(
        body.foreign_keys as ForeignKey[],
        body.table_to_object_type,
        body.table_to_property_map,
      );
      res.json({ proposals });
    } catch (e) {
      next(zodToTellus(e));
    }
  });

  return r;
}

function rowToBinding(row: Record<string, unknown>): ObjectTypeBinding {
  return {
    rid: row.rid as string,
    object_type_rid: row.object_type_rid as string,
    dataset_rid: row.dataset_rid as string,
    funnel_binding_rid: row.funnel_binding_rid as string,
    property_map:
      typeof row.property_map === "string"
        ? JSON.parse(row.property_map)
        : (row.property_map as Record<string, string>),
    pk_property: row.pk_property as string,
    title_property: (row.title_property as string | null) ?? null,
    status: row.status as ObjectTypeBinding["status"],
    version: Number(row.version),
  };
}

function zodToTellus(e: unknown): TellusError {
  if (e instanceof z.ZodError) {
    return new TellusError(OntologyInvalidBindingRequest, { issues: e.issues });
  }
  return e instanceof TellusError
    ? e
    : new TellusError(OntologyInternal, {
        message: e instanceof Error ? e.message : String(e),
      });
}
