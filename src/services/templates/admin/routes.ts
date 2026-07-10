// B3 — Templates admin routes.
//
// Surface (per spec lines 343-349):
//   GET  /templates                                  → Template[]
//   GET  /templates/:templateId/versions/:version    → TemplateManifest
//   POST /scaffold                                   → ScaffoldResult (internal, called by B2 saga)
//
// Cross-cutting: Bearer auth + IDOR-as-404 + envelope §1.3 + Idempotency-Key on /scaffold.

import express, { type NextFunction, type Request, type Response, type Router } from "express";
import type { Pool } from "pg";
import { requireCodeReposAuth } from "../../codeRepos/middleware/principal.js";
import { idempotencyMiddleware } from "../../codeRepos/middleware/idempotency.js";
import { templatesError, type TemplatesError } from "../errors.js";
import {
  getTemplateManifest,
  listLatestTemplateManifests,
  type TemplateManifest,
} from "../manifest.js";
import { scaffold, type ScaffoldResult } from "../scaffold.js";
import { listTemplates, getTemplate } from "../store.js";

export interface TemplatesRouterDeps {
  readonly pool: Pool;
}

function sendError(res: Response, err: TemplatesError): void {
  res.status(err.status).type("application/json").send(JSON.stringify(err.envelope));
}

function asTemplateSummary(m: TemplateManifest): Record<string, unknown> {
  return {
    templateId: m.templateId,
    version: m.version,
    displayName: m.displayName,
    language: m.language,
    category: m.category,
    description: m.description,
    parameters: m.parameters,
    deprecated: m.deprecated,
  };
}

function asTemplateManifest(m: TemplateManifest): Record<string, unknown> {
  // Spec asks for the full manifest including files. For very large templates
  // future revisions may switch to a content-tree pointer; v1 returns inline.
  return {
    templateId: m.templateId,
    version: m.version,
    displayName: m.displayName,
    language: m.language,
    category: m.category,
    description: m.description,
    parameters: m.parameters,
    files: m.files.map((f) => ({
      path: f.path,
      mode: f.mode,
      isBinary: f.isBinary,
      content: f.content,
    })),
    deprecated: m.deprecated,
  };
}

function isPrintableString(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}

function isObjectRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

interface ScaffoldBody {
  readonly templateId: string;
  readonly version: string;
  readonly repositoryRid: string;
  readonly repoDisplayName: string;
  readonly parameters: Record<string, string>;
}

function validateScaffoldBody(body: unknown): { ok: true; body: ScaffoldBody } | { ok: false; err: TemplatesError } {
  if (!isObjectRecord(body)) return { ok: false, err: templatesError("Templates:InvalidArgument", { reason: "body-not-object" }) };
  const { templateId, version, repositoryRid, repoDisplayName, parameters } = body as Record<string, unknown>;
  if (!isPrintableString(templateId, 128)) return { ok: false, err: templatesError("Templates:InvalidArgument", { reason: "invalid-templateId" }) };
  if (!isPrintableString(version, 64)) return { ok: false, err: templatesError("Templates:InvalidArgument", { reason: "invalid-version" }) };
  if (!isPrintableString(repositoryRid, 256)) return { ok: false, err: templatesError("Templates:InvalidArgument", { reason: "invalid-repositoryRid" }) };
  if (!isPrintableString(repoDisplayName, 128)) return { ok: false, err: templatesError("Templates:InvalidArgument", { reason: "invalid-repoDisplayName" }) };
  let params: Record<string, string> = {};
  if (parameters !== undefined && parameters !== null) {
    if (!isObjectRecord(parameters)) return { ok: false, err: templatesError("Templates:InvalidArgument", { reason: "parameters-not-object" }) };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parameters)) {
      if (typeof v !== "string") return { ok: false, err: templatesError("Templates:InvalidArgument", { reason: "parameter-not-string", parameterName: k }) };
      out[k] = v;
    }
    params = out;
  }
  return { ok: true, body: { templateId, version, repositoryRid, repoDisplayName, parameters: params } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Architecture (ADR-008 — router auth scoping).
//
// The B3 surface is two distinct resources, `/templates` and `/scaffold`, so
// it ships as TWO router factories. Each is mounted at its OWN resource
// prefix on the live server (`app.use("/api/v1/templates", ...)` /
// `app.use("/api/v1/scaffold", ...)`).
//
// Internal route paths are RELATIVE to the mount, not absolute. This keeps
// every mounted middleware (json parser, auth, idempotency) strictly scoped
// to the resource — siblings under `/api/v1` never see them. The previous
// single-router design with `router.use(requireCodeReposAuth())` shipped a
// 401 leak across `/api/v1/*` (including `/api/v1/auth/login`); ADR-008
// codifies the rule that produced this split.
// ─────────────────────────────────────────────────────────────────────────────

/** GET /  → list templates (mount at /api/v1/templates). */
/** GET /:templateId/versions/:version → manifest. */
export function createTemplatesRouter(deps: TemplatesRouterDeps): Router {
  const router = express.Router();
  router.use(express.json({ limit: "1mb" }));
  const auth = requireCodeReposAuth();

  router.get("/", auth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const category = req.query.category as string | undefined;
      // First pass v1: list from in-memory catalog. The DB cache is hydrated
      // on service boot via upsertTemplatesIndex; the cache is what powers
      // the deprecation flag for live templates.
      const cacheRows = await listTemplates(deps.pool, {
        category: category === "functions" || category === "transforms" ? category : undefined,
        includeDeprecated: req.query.includeDeprecated === "true",
      });
      const cacheKey = new Set(cacheRows.map((r) => `${r.templateId}@${r.version}`));
      // Cross-reference with manifest catalog to surface anything not yet hydrated.
      // listLatestTemplateManifests dedupes to the newest version per templateId
      // (Foundry-faithful: "bootstrapped with the latest version") so the picker
      // shows one row per template — required once transforms-python ships 2.0.0.
      const all = listLatestTemplateManifests().filter((m) => {
        if (category === "functions" && m.category !== "functions") return false;
        if (category === "transforms" && m.category !== "transforms") return false;
        return true;
      });
      const cacheById = new Map(cacheRows.map((r) => [`${r.templateId}@${r.version}`, r]));
      const out = all.map((m) => {
        const cache = cacheById.get(`${m.templateId}@${m.version}`);
        return {
          ...asTemplateSummary(m),
          deprecated: cache?.isDeprecated ?? m.deprecated,
        };
      });
      res.status(200).json({ templates: out });
      void cacheKey;
    } catch (e) {
      next(e);
    }
  });

  router.get("/:templateId/versions/:version", auth, async (req: Request, res: Response) => {
    const { templateId, version } = req.params;
    const m = getTemplateManifest(templateId, version);
    if (m === null) {
      sendError(res, templatesError("Templates:NotFound", { templateId, version }));
      return;
    }
    // Check deprecation in DB (admins may flip at runtime).
    const cache = await getTemplate(deps.pool, templateId, version);
    const isDeprecated = cache?.isDeprecated ?? m.deprecated;
    res.status(200).json({ ...asTemplateManifest(m), deprecated: isDeprecated });
  });

  return router;
}

/** POST / → scaffold (mount at /api/v1/scaffold). Internal saga endpoint. */
export function createScaffoldRouter(deps: TemplatesRouterDeps): Router {
  const router = express.Router();
  router.use(express.json({ limit: "1mb" }));
  const auth = requireCodeReposAuth();
  const idem = idempotencyMiddleware({ pool: deps.pool });

  router.post("/", auth, idem, async (req: Request, res: Response) => {
    const v = validateScaffoldBody(req.body);
    if (!v.ok) {
      sendError(res, v.err);
      return;
    }
    const m = getTemplateManifest(v.body.templateId, v.body.version);
    if (m === null) {
      sendError(res, templatesError("Templates:NotFound", { templateId: v.body.templateId, version: v.body.version }));
      return;
    }
    // Honour DB deprecation flag at runtime.
    const cache = await getTemplate(deps.pool, v.body.templateId, v.body.version);
    if (cache?.isDeprecated || m.deprecated) {
      sendError(res, templatesError("Templates:VersionDeprecated", { templateId: v.body.templateId, version: v.body.version }));
      return;
    }
    let result: ScaffoldResult;
    try {
      result = scaffold({
        manifest: m,
        parameters: v.body.parameters,
        repositoryRid: v.body.repositoryRid,
        repoDisplayName: v.body.repoDisplayName,
      });
    } catch (e) {
      const env = (e as { envelope?: unknown }).envelope;
      const status = (e as { status?: number }).status ?? 500;
      if (env !== undefined) {
        res.status(status).type("application/json").send(JSON.stringify(env));
      } else {
        sendError(res, templatesError("Templates:Internal", { reason: "scaffold-failure" }));
      }
      return;
    }
    res.status(201).json({
      commitSha: result.commitSha,
      fileCount: result.fileCount,
      totalBytes: result.totalBytes,
      // Files are returned for the saga to push into Stemma; final API may strip.
      files: result.files.map((f) => ({ path: f.path, mode: f.mode, isBinary: f.isBinary, content: f.content })),
    });
  });

  return router;
}
