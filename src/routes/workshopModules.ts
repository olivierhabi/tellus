// Workshop B01 — Express router for /api/v1/workshop/modules.
//
// Spec: tasks/workshop/workshop-tasks.md §B01.
// Mounts under `/api/v1/workshop` from server.ts (single point of mount).
// Authentication is supplied by the global `globalAuth` middleware mounted
// before all routes — req.user.id is guaranteed (G-06).

import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import { currentUser } from "../middleware/currentUser";
import {
  IDEMPOTENCY_KEY_HEADER,
} from "../services/workshop/idempotency";
import {
  WorkshopError,
  invalidModuleSchema,
} from "../services/workshop/errors";
import {
  Actor,
  createModule,
  deleteModule,
  getModule,
  listModules,
  updateModule,
} from "../services/workshop/moduleService";
import { listModuleActivity } from "../services/workshop/activityService";
import {
  createModuleRequestSchema,
  moduleDefinitionSchema,
  updateModuleRequestSchema,
} from "../services/workshop/types";
import { validateModule } from "../services/workshop/validator";
import { workshopRateLimitMiddleware } from "../services/workshop/rateLimit";
import { requireRole, requireModuleRole } from "../services/workshop/rbac";

const router: Router = Router();

function actorFromRequest(req: Request): Actor {
  const userId = currentUser(req);
  // §0.5: branch is forwarded verbatim everywhere. We accept it as a query
  // param on every route; it threads into the actor and from there to any
  // downstream adapter.
  const rawBranch = (req.query.branch as string | undefined) ?? null;
  return { userId, branchRid: rawBranch && rawBranch.length > 0 ? rawBranch : null };
}

function ifMatchHeader(req: Request): string | null {
  const raw = req.header("If-Match");
  return raw ? raw.trim() : null;
}

function idempotencyKeyHeader(req: Request): string | null {
  const raw = req.header(IDEMPOTENCY_KEY_HEADER);
  return raw ? raw.trim() : null;
}

// ---- POST /api/v1/workshop/modules/_validate -------------------------------
//
// Standalone validate endpoint per spec §B02. Used by the editor (F01)
// for instant feedback. Same validator runs in-process inside B01
// PUT/POST so the route is canonical for both online and offline checks.

router.post(
  "/modules/_validate",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = z
        .object({ definition: moduleDefinitionSchema })
        .strict()
        .safeParse(req.body);
      if (!parsed.success) {
        throw invalidModuleSchema("_validate body did not validate", {
          issues: parsed.error.issues,
        });
      }
      const result = validateModule(parsed.data.definition);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ---- POST /api/v1/workshop/modules -----------------------------------------

router.post(
  "/modules",
  requireRole("editor"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = createModuleRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw invalidModuleSchema("create-module body did not validate", {
          issues: parsed.error.issues,
        });
      }
      const actor = actorFromRequest(req);
      const idemKey = idempotencyKeyHeader(req);
      const result = await createModule(parsed.data, actor, {
        key: idemKey,
        route: "POST /api/v1/workshop/modules",
        body: parsed.data,
      });
      res.setHeader("ETag", result.etag);
      res.setHeader(
        "Location",
        `/api/v1/workshop/modules/${result.module.rid}`,
      );
      res.status(result.fromCache ? 200 : 201).json(result.module);
    } catch (err) {
      next(err);
    }
  },
);

// ---- GET /api/v1/workshop/modules?parentFolderRid=...&pageToken=... ---------

const listQuerySchema = z
  .object({
    parentFolderRid: z.string().min(1),
    pageToken: z.string().optional(),
    pageSize: z
      .preprocess(
        (v) => (typeof v === "string" ? parseInt(v, 10) : v),
        z.number().int().min(1).max(200),
      )
      .optional(),
    branch: z.string().optional(),
  })
  .strict();

router.get(
  "/modules",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw invalidModuleSchema("list-modules query did not validate", {
          issues: parsed.error.issues,
        });
      }
      const result = await listModules({
        parentFolderRid: parsed.data.parentFolderRid,
        pageToken: parsed.data.pageToken ?? null,
        pageSize: parsed.data.pageSize,
      });
      res.status(200).json({
        modules: result.modules,
        nextPageToken: result.nextPageToken,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---- GET /api/v1/workshop/modules:activity ---------------------------------
//
// The composite home-table read: the caller's recently-viewed ∪ favorited
// modules, joined to live (non-trashed) modules and enriched with folder
// paths + principal display names. Replaces a client-side N+1 (recents +
// N getModule + N breadcrumb + user directory) with one call, and filters
// stale recents rows server-side.

const activityQuerySchema = z
  .object({
    limit: z
      .preprocess(
        (v) => (typeof v === "string" ? parseInt(v, 10) : v),
        z.number().int().min(1).max(100),
      )
      .optional(),
    branch: z.string().optional(),
  })
  .strict();

router.get(
  "/modules:activity",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = activityQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw invalidModuleSchema("modules:activity query did not validate", {
          issues: parsed.error.issues,
        });
      }
      const result = await listModuleActivity(currentUser(req), {
        limit: parsed.data.limit,
      });
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ---- GET /api/v1/workshop/modules/{rid} ------------------------------------

router.get(
  "/modules/:rid",
  requireModuleRole("editor"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const module = await getModule(req.params.rid);
      // ETag returned on every read of a mutable resource (G-02).
      // We re-fetch via getModule which returns the persisted etag — the
      // service layer trusts what's in the DB column.
      res.setHeader("ETag", await persistedEtag(module.rid));
      res.status(200).json(module);
    } catch (err) {
      next(err);
    }
  },
);

async function persistedEtag(rid: string): Promise<string> {
  // Inline import to avoid a circular dep between routes ↔ service ↔ etag.
  const { getModuleEtag } = await import(
    "../services/workshop/moduleService"
  );
  return (await getModuleEtag(rid)).etag;
}

// ---- PUT /api/v1/workshop/modules/{rid} ------------------------------------

router.put(
  "/modules/:rid",
  requireModuleRole("editor"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = updateModuleRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        console.error("[route-debug] UPDATE MODULE ZOD PARSE FAILURE:", JSON.stringify(parsed.error.issues, null, 2));
        console.error("[route-debug] BODY RECEIVED:", JSON.stringify(req.body, null, 2));
        throw invalidModuleSchema("update-module body did not validate", {
          issues: parsed.error.issues,
        });
      }
      const actor = actorFromRequest(req);
      const result = await updateModule(
        req.params.rid,
        ifMatchHeader(req),
        parsed.data,
        actor,
      );
      res.setHeader("ETag", result.etag);
      res.status(200).json(result.module);
    } catch (err) {
      next(err);
    }
  },
);

// ---- DELETE /api/v1/workshop/modules/{rid} ---------------------------------

router.delete(
  "/modules/:rid",
  requireModuleRole("editor"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const actor = actorFromRequest(req);
      await deleteModule(req.params.rid, ifMatchHeader(req), actor);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

// ---- B03: POST /api/v1/workshop/modules/{rid}/versions:publish -------------

const publishBodySchema = z
  .object({
    semver: z.string().min(1),
  })
  .strict();

router.post(
  "/modules/:rid/versions:publish",
  requireModuleRole("editor"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = publishBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw invalidModuleSchema("publish body did not validate", {
          issues: parsed.error.issues,
        });
      }
      const { publishVersion } = await import(
        "../services/workshop/versionService"
      );
      const actor = actorFromRequest(req);
      const idemKey = idempotencyKeyHeader(req);
      const result = await publishVersion(
        req.params.rid,
        parsed.data,
        actor,
        {
          key: idemKey,
          route: "POST /api/v1/workshop/modules/:rid/versions:publish",
          body: parsed.data,
        },
      );
      res.setHeader("ETag", result.version.etag);
      res.status(200).json(result.version);
    } catch (err) {
      next(err);
    }
  },
);

// ---- B03: POST /api/v1/workshop/modules/{rid}:rollback ---------------------

router.post(
  "/modules/:rid/actions/rollback",
  requireModuleRole("editor"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = publishBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw invalidModuleSchema("rollback body did not validate", {
          issues: parsed.error.issues,
        });
      }
      const { rollback } = await import(
        "../services/workshop/versionService"
      );
      const actor = actorFromRequest(req);
      const idemKey = idempotencyKeyHeader(req);
      const result = await rollback(
        req.params.rid,
        parsed.data.semver,
        actor,
        {
          key: idemKey,
          route: "POST /api/v1/workshop/modules/:rid/actions/rollback",
          body: parsed.data,
        },
      );
      res.setHeader("ETag", result.version.etag);
      res.status(200).json(result.version);
    } catch (err) {
      next(err);
    }
  },
);

// ---- B03: GET /api/v1/workshop/modules/{rid}/versions ----------------------

router.get(
  "/modules/:rid/versions",
  requireModuleRole("viewer"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { listVersions } = await import(
        "../services/workshop/versionService"
      );
      const versions = await listVersions(req.params.rid);
      res.status(200).json({ versions });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/modules/:rid/versions/:semver",
  requireModuleRole("viewer"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { getVersion } = await import(
        "../services/workshop/versionService"
      );
      const v = await getVersion(req.params.rid, req.params.semver);
      res.setHeader("ETag", v.etag);
      res.status(200).json(v);
    } catch (err) {
      next(err);
    }
  },
);

// ---- P1: GET /api/v1/workshop/modules/{rid}/published — viewer-safe ----
//
// Returns the published snapshot definition + metadata. Does NOT expose
// the mutable head. Viewers use this instead of GET /modules/:rid to avoid
// receiving draft definitions.

router.get(
  "/modules/:rid/published",
  requireModuleRole("viewer"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { resolveLatest } = await import(
        "../services/workshop/versionService"
      );
      const { getModule } = await import(
        "../services/workshop/moduleService"
      );
      const mod = await getModule(req.params.rid);
      const resolved = await resolveLatest(req.params.rid);
      res.status(200).json({
        rid: mod.rid,
        displayName: mod.displayName,
        description: mod.description,
        ontologyRid: mod.ontologyRid,
        branchRid: mod.branchRid,
        semver: resolved.semver,
        publishedAt: resolved.asOf,
        schemaVersion: resolved.schemaVersion,
        definition: resolved.definition,
        compiled: resolved.compiled,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---- P1: GET /api/v1/workshop/modules/{rid}/effectiveRole ----------------
//
// Lightweight endpoint for the editor UI to determine whether the current
// user should be redirected to view mode.

router.get(
  "/modules/:rid/effectiveRole",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = currentUser(req);
      const { getModuleEffectiveRole } = await import(
        "../services/workshop/grantService"
      );
      const user = (req as unknown as { user?: { roles?: unknown; groups?: unknown } }).user ?? {};
      const role = await getModuleEffectiveRole(req.params.rid, {
        userId,
        roles: Array.isArray(user.roles) ? user.roles as string[] : [],
        groups: Array.isArray(user.groups) ? user.groups as string[] : [],
      });
      res.status(200).json({ rid: req.params.rid, role });
    } catch (err) {
      next(err);
    }
  },
);

// ---- P1: GET /api/v1/workshop/modules/{rid}/grants — list grants ---------

router.get(
  "/modules/:rid/grants",
  requireRole("editor"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { listModuleGrants } = await import(
        "../services/workshop/grantService"
      );
      const grants = await listModuleGrants(req.params.rid);
      res.status(200).json({ grants });
    } catch (err) {
      next(err);
    }
  },
);

// ---- P1: POST /api/v1/workshop/modules/{rid}/grants — upsert grant ------

const grantBodySchema = z
  .object({
    principalType: z.enum(["user", "group"]),
    principalId: z.string().min(1),
    role: z.enum(["viewer", "editor"]),
  })
  .strict();

router.post(
  "/modules/:rid/grants",
  requireRole("editor"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = grantBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw invalidModuleSchema("grant body did not validate", {
          issues: parsed.error.issues,
        });
      }
      const { upsertModuleGrant } = await import(
        "../services/workshop/grantService"
      );
      const actor = actorFromRequest(req);
      const grant = await upsertModuleGrant(
        req.params.rid,
        parsed.data.principalType,
        parsed.data.principalId,
        parsed.data.role,
        actor.userId,
      );
      res.status(200).json(grant);
    } catch (err) {
      next(err);
    }
  },
);

// ---- P1: DELETE /api/v1/workshop/modules/{rid}/grants/:principalType/:principalId

router.delete(
  "/modules/:rid/grants/:principalType/:principalId",
  requireRole("editor"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { removeModuleGrant } = await import(
        "../services/workshop/grantService"
      );
      const deleted = await removeModuleGrant(
        req.params.rid,
        req.params.principalType as "user" | "group",
        req.params.principalId,
      );
      if (!deleted) {
        throw new WorkshopError("NOT_FOUND", "Tellus:Workshop:GrantNotFound", {
          rid: req.params.rid,
          principalType: req.params.principalType,
          principalId: req.params.principalId,
        });
      }
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

// ---- B03: GET /api/v1/workshop/resolve/latest?rid=... ----------------------

const resolveQuerySchema = z
  .object({
    rid: z.string().min(1),
    branch: z.string().optional(),
  })
  .strict();

router.get(
  "/resolve/latest",
  requireModuleRole("viewer"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = resolveQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw invalidModuleSchema("resolve/latest query did not validate", {
          issues: parsed.error.issues,
        });
      }
      const { resolveLatest } = await import(
        "../services/workshop/versionService"
      );
      const r = await resolveLatest(parsed.data.rid);
      res.status(200).json(r);
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/resolve/dev",
  requireModuleRole("editor"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = resolveQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw invalidModuleSchema("resolve/dev query did not validate", {
          issues: parsed.error.issues,
        });
      }
      const { resolveDev } = await import(
        "../services/workshop/versionService"
      );
      const r = await resolveDev(parsed.data.rid);
      res.status(200).json(r);
    } catch (err) {
      next(err);
    }
  },
);

// ---- B06: GET /api/v1/workshop/object-types & /action-types ---------------

const omsListQuerySchema = z
  .object({
    ontologyRid: z.string().min(1),
    branch: z.string().optional(),
  })
  .strict();

router.get(
  "/object-types",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = omsListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw invalidModuleSchema("object-types query did not validate", {
          issues: parsed.error.issues,
        });
      }
      const { listObjectTypes } = await import(
        "../services/workshop/omsFacade"
      );
      const list = await listObjectTypes(parsed.data.ontologyRid);
      res.status(200).json({ objectTypes: list });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/object-types/:idOrApiName",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = omsListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw invalidModuleSchema("object-type query did not validate", {
          issues: parsed.error.issues,
        });
      }
      const { getObjectType } = await import(
        "../services/workshop/omsFacade"
      );
      const ot = await getObjectType(
        parsed.data.ontologyRid,
        req.params.idOrApiName,
      );
      res.status(200).json(ot);
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/action-types",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = omsListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw invalidModuleSchema("action-types query did not validate", {
          issues: parsed.error.issues,
        });
      }
      const { listActionTypes } = await import(
        "../services/workshop/omsFacade"
      );
      const list = await listActionTypes(parsed.data.ontologyRid);
      res.status(200).json({ actionTypes: list });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/action-types/:idOrApiName",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = omsListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw invalidModuleSchema("action-type query did not validate", {
          issues: parsed.error.issues,
        });
      }
      const { getActionType } = await import(
        "../services/workshop/omsFacade"
      );
      const at = await getActionType(
        parsed.data.ontologyRid,
        req.params.idOrApiName,
      );
      res.status(200).json(at);
    } catch (err) {
      next(err);
    }
  },
);

// ---- B05 — Object set load proxy ------------------------------------------
//
// Spec §B05. POST /api/v1/workshop/object-sets/_load
// Body: { ontologyRid, objectTypeApiName, schema, filters, pageSize,
//         pageToken?, orderBy?, executionMode?, snapshotConsistency? }
// Branch is read from ?branch=… (§0.5).
// JWT (§0.6): pulled from globalAuth-set req.user.token, propagated verbatim
// to OSS via the OssRequestContext.

const propertyTypeSchema = z.enum([
  "string",
  "integer",
  "long",
  "double",
  "boolean",
  "date",
  "timestamp",
  "id",
]);

const filterValueSchema = z.object({
  uiKind: z.enum([
    "string-eq",
    "string-multi",
    "string-in",
    "string-default",
    "number-histogram",
    "number-multi",
    "number-default",
    "number-range",
    "date-timeline",
    "id-multi",
    "enum-multi",
    "boolean-single",
  ]),
  property: z.string().min(1),
  value: z.unknown(),
  operator: z.enum(["is", "null", "contain"]).optional(),
  negated: z.boolean().optional(),
});

const loadObjectSetSchema = z.object({
  ontologyRid: z.string().min(1),
  objectTypeApiName: z.string().min(1),
  schema: z.record(z.string(), propertyTypeSchema),
  filters: z.array(filterValueSchema),
  pageSize: z.number().int().positive(),
  pageToken: z.string().nullish(),
  orderBy: z
    .array(
      z.object({
        field: z.string().min(1),
        direction: z.enum(["asc", "desc"]),
      }),
    )
    .optional(),
  executionMode: z.enum(["PREFER_ACCURACY", "PREFER_SPEED"]).nullish(),
  snapshotConsistency: z.enum(["EVENTUAL", "STRONG"]).nullish(),
});

router.post(
  "/object-sets/_load",
  workshopRateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = loadObjectSetSchema.safeParse(req.body);
      if (!parsed.success) {
        throw invalidModuleSchema("object-set load body did not validate", {
          issues: parsed.error.issues,
        });
      }
      const { loadObjectSet } = await import(
        "../services/workshop/objectSetService"
      );
      const userId = currentUser(req);
      const branchRid = actorFromRequest(req).branchRid ?? null;
      const jwt =
        ((req as unknown as { user?: { token?: string } }).user?.token ?? "");
      const security = (req as unknown as { security?: { markings?: string[]; markingBypass?: boolean } }).security;
      const ctx = {
        jwt, branchRid, userRid: userId,
        markings: security?.markings,
        markingBypass: security?.markingBypass,
      };
      const out = await loadObjectSet(
        {
          ontologyRid: parsed.data.ontologyRid,
          objectTypeApiName: parsed.data.objectTypeApiName,
          schema: parsed.data.schema,
          filters: parsed.data.filters,
          pageSize: parsed.data.pageSize,
          pageToken: parsed.data.pageToken ?? null,
          orderBy: parsed.data.orderBy ?? [],
          executionMode: parsed.data.executionMode ?? null,
          snapshotConsistency: parsed.data.snapshotConsistency ?? null,
        },
        ctx,
      );
      res.status(200).json(out);
    } catch (err) {
      next(err);
    }
  },
);

// ---- B08 — Aggregation proxy ----------------------------------------------
//
// Spec §B08. POST /api/v1/workshop/object-sets/_aggregate
// Same predicate compiler as B05; chartKind drives groupBy defaults.

const aggregationDefSchema = z.object({
  name: z.string().min(1),
  property: z.string().min(1),
  groupBy: z
    .union([
      z.object({ kind: z.literal("exact") }),
      z.object({
        kind: z.literal("fixedWidthBuckets"),
        width: z.number(),
        minBuckets: z.number().int().positive().optional(),
      }),
      z.object({
        kind: z.literal("dateRangeBuckets"),
        ranges: z.array(
          z.object({ from: z.string().optional(), to: z.string().optional() }),
        ),
      }),
      z.object({ kind: z.literal("topN"), n: z.number().int().positive() }),
    ])
    .optional(),
  aggregation: z.union([
    z.object({ kind: z.literal("count") }),
    z.object({ kind: z.literal("sum"), on: z.string().min(1) }),
    z.object({ kind: z.literal("avg"), on: z.string().min(1) }),
    z.object({ kind: z.literal("min"), on: z.string().min(1) }),
    z.object({ kind: z.literal("max"), on: z.string().min(1) }),
    z.object({ kind: z.literal("approxDistinct"), on: z.string().min(1) }),
  ]),
});

const aggregateSchema = z.object({
  ontologyRid: z.string().min(1),
  objectTypeApiName: z.string().min(1),
  schema: z.record(z.string(), propertyTypeSchema),
  filters: z.array(filterValueSchema),
  aggregations: z.array(aggregationDefSchema).min(1),
  chartKind: z.enum(["pie", "barXy", "stackedBar", "metric"]).optional(),
  executionMode: z.enum(["PREFER_ACCURACY", "PREFER_SPEED"]).nullish(),
});

router.post(
  "/object-sets/_aggregate",
  workshopRateLimitMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = aggregateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw invalidModuleSchema("aggregation body did not validate", {
          issues: parsed.error.issues,
        });
      }
      const { aggregate } = await import(
        "../services/workshop/aggregationService"
      );
      const userId = currentUser(req);
      const branchRid = actorFromRequest(req).branchRid ?? null;
      const jwt =
        ((req as unknown as { user?: { token?: string } }).user?.token ?? "");
      const security = (req as unknown as { security?: { markings?: string[]; markingBypass?: boolean } }).security;
      const ctx = {
        jwt, branchRid, userRid: userId,
        markings: security?.markings,
        markingBypass: security?.markingBypass,
      };
      const out = await aggregate(
        {
          ontologyRid: parsed.data.ontologyRid,
          objectTypeApiName: parsed.data.objectTypeApiName,
          schema: parsed.data.schema,
          filters: parsed.data.filters,
          aggregations: parsed.data.aggregations,
          chartKind: parsed.data.chartKind,
          executionMode: parsed.data.executionMode ?? null,
        },
        ctx,
      );
      res.status(200).json(out);
    } catch (err) {
      next(err);
    }
  },
);

// ---- B09 — Action Type Wizard ---------------------------------------------
//
// Spec §B09 + §C Phase 6 Step 1. Workshop's UI lets a user create an action
// type with parameters + submission criteria. After save, the new action
// type is visible to B06 OMS picker (cache invalidated immediately).
//
// POST /api/v1/workshop/action-types — Idempotency-Key required.

router.post(
  "/action-types",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { actionTypeRequestSchema, createActionType } = await import(
        "../services/workshop/actionTypeWizard"
      );
      const parsed = actionTypeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw invalidModuleSchema("action-type body did not validate", {
          issues: parsed.error.issues,
        });
      }
      const idemKey = idempotencyKeyHeader(req);
      if (!idemKey) {
        throw new WorkshopError(
          "INVALID_ARGUMENT",
          "Tellus:Workshop:IdempotencyKeyRequired",
          { route: "POST /action-types" },
        );
      }
      const userId = currentUser(req);
      const { hashBody, isValidIdempotencyKey, lookupIdempotency, recordResponse } =
        await import("../services/workshop/idempotency");
      if (!isValidIdempotencyKey(idemKey)) {
        throw new WorkshopError(
          "INVALID_ARGUMENT",
          "Tellus:Workshop:IdempotencyKeyMalformed",
          { idempotencyKey: idemKey },
        );
      }
      const idemCtx = {
        key: idemKey,
        userId,
        route: "POST /api/v1/workshop/action-types",
        bodySha256: hashBody(parsed.data),
      };
      const hit = await lookupIdempotency(idemCtx);
      if (hit) {
        res.status(hit.responseStatus).json(hit.responseBody);
        return;
      }
      const actor = actorFromRequest(req);
      const out = await createActionType(parsed.data, actor);
      await recordResponse(idemCtx, 201, out.row, out.etag);
      res.status(201).setHeader("ETag", out.etag).json(out.row);
    } catch (err) {
      next(err);
    }
  },
);

// ---- B04 — Module Bootstrap ----------------------------------------------
//
// Spec §B04 + §C Phase 5 Step 1. Composes B01 (createModule) + B06
// (getObjectType) to produce a fresh, seeded Workshop module document.
//
// POST /api/v1/workshop/modules:bootstrap
// Body: { parentFolderRid, ontologyRid, displayName,
//         seedObjectTypeApiName?, description? }
// Idempotency-Key required (G-03).

router.post(
  "/modules:bootstrap",
  requireRole("editor"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { bootstrapRequestSchema, bootstrapModule } = await import(
        "../services/workshop/bootstrapService"
      );
      const parsed = bootstrapRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw invalidModuleSchema("bootstrap body did not validate", {
          issues: parsed.error.issues,
        });
      }
      const idemKey = idempotencyKeyHeader(req);
      // Bootstrap composes a write; per §0.3 + B01 convention, Idempotency-Key
      // is required because the caller can otherwise create accidental
      // duplicates on retry. Same shape as POST /modules.
      if (!idemKey) {
        throw new WorkshopError(
          "INVALID_ARGUMENT",
          "Tellus:Workshop:IdempotencyKeyRequired",
          { route: "/modules:bootstrap" },
        );
      }
      const actor = actorFromRequest(req);
      const result = await bootstrapModule(parsed.data, actor, idemKey);
      res
        .status(result.fromCache ? 200 : 201)
        .setHeader("ETag", result.etag)
        .setHeader(
          "Location",
          `/api/v1/workshop/modules/${result.module.rid}`,
        )
        .json(result.module);
    } catch (err) {
      next(err);
    }
  },
);

// ---- B10 — Action validate + apply ----------------------------------------
//
// Spec §B10. POST /api/v1/workshop/actions/_validate and /actions/_apply.
// _apply requires Idempotency-Key (UUID v4); _validate is read-only and does
// not. Branch is forwarded via ?branch=…  JWT via the user.token field.

const actionApplyBodySchema = z.object({
  ontologyRid: z.string().min(1),
  actionTypeApiName: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
});

router.post(
  "/actions/_validate",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = actionApplyBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw invalidModuleSchema("actions/_validate body did not validate", {
          issues: parsed.error.issues,
        });
      }
      const { validate } = await import(
        "../services/workshop/actionApplyService"
      );
      const userId = currentUser(req);
      const branchRid = actorFromRequest(req).branchRid ?? null;
      const jwt =
        ((req as unknown as { user?: { token?: string } }).user?.token ?? "");
      const ctx = { jwt, branchRid, userRid: userId };
      const out = await validate(parsed.data, ctx);
      res.status(200).json(out);
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/actions/_apply",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = actionApplyBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw invalidModuleSchema("actions/_apply body did not validate", {
          issues: parsed.error.issues,
        });
      }
      const idemKey = idempotencyKeyHeader(req);
      if (!idemKey) {
        throw new WorkshopError(
          "INVALID_ARGUMENT",
          "Tellus:Workshop:IdempotencyKeyRequired",
          { route: "/actions/_apply" },
        );
      }
      const userId = currentUser(req);
      const { hashBody, isValidIdempotencyKey, lookupIdempotency, recordResponse } =
        await import("../services/workshop/idempotency");
      if (!isValidIdempotencyKey(idemKey)) {
        throw new WorkshopError(
          "INVALID_ARGUMENT",
          "Tellus:Workshop:IdempotencyKeyMalformed",
          { idempotencyKey: idemKey },
        );
      }
      const idemCtx = {
        key: idemKey,
        userId,
        route: "POST /api/v1/workshop/actions/_apply",
        bodySha256: hashBody(parsed.data),
      };
      const hit = await lookupIdempotency(idemCtx);
      if (hit) {
        res.status(hit.responseStatus).json(hit.responseBody);
        return;
      }
      const { apply } = await import(
        "../services/workshop/actionApplyService"
      );
      const branchRid = actorFromRequest(req).branchRid ?? null;
      const jwt =
        ((req as unknown as { user?: { token?: string } }).user?.token ?? "");
      const ctx = { jwt, branchRid, userRid: userId };
      const out = await apply(parsed.data, ctx);
      await recordResponse(idemCtx, 200, out, null);
      res.status(200).json(out);
    } catch (err) {
      next(err);
    }
  },
);

// ---- GET /api/v1/workshop/metrics — Prometheus scrape ---------------------
//
// G-04: every workshop metric named in the spec is registered against the
// prom-client default registry by `services/workshop/metrics.ts`. This
// endpoint surfaces them in the standard `text/plain; version=0.0.4`
// format so a Prometheus scrape can collect them. Per §0.4: per-RID
// labels are NOT used; everything here is low-cardinality.
//
// Note: the existing /api/metrics route is funnel-specific. We expose a
// dedicated workshop endpoint so dashboards can scope their scrape rules
// to Workshop without picking up unrelated services.
router.get("/metrics", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Lazy require — same pattern as services/workshop/metrics.ts; if
    // prom-client is unavailable, return 503 instead of 500.
    type PromClientShape = {
      register: { metrics(): Promise<string>; contentType: string };
    };
    let prom: PromClientShape | null = null;
    try {
      // Dynamic import keeps prom-client a soft dep — same pattern as
      // services/workshop/metrics.ts, but expressed without `require` so
      // we keep the no-var-requires lint rule happy.
      const mod = (await import("prom-client")) as unknown as PromClientShape;
      prom = mod;
    } catch {
      prom = null;
    }
    if (!prom) {
      res
        .status(503)
        .type("text/plain")
        .send("# prom-client unavailable in this build\n");
      return;
    }
    res.setHeader("Content-Type", prom.register.contentType);
    res.send(await prom.register.metrics());
  } catch (e) {
    next(e);
  }
});

// ---- error mapper for WorkshopError ---------------------------------------
//
// Mounted at the end of this router so the global error handler doesn't
// have to know about Workshop's envelope. Any `WorkshopError` thrown in
// downstream code converts here; everything else is passed to the next
// error handler.
router.use(
  (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof WorkshopError) {
      res.status(err.httpStatus).json(err.toEnvelope());
      return;
    }
    next(err);
  },
);

export default router;
