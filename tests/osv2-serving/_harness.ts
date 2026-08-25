// ---------------------------------------------------------------------------
// E2E harness for the isolated OSv2 lane — fixture builder + route mount.
// ---------------------------------------------------------------------------

import "dotenv/config";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { query } from "../../src/db";
import { deriveMainBranchId } from "../../src/services/branchContext";
import linksRouter from "../../src/routes/links";
import { __resetServingRolloutCache } from "../../src/services/serving/servingFlags";
import { ensureIndexTemplate } from "../../src/services/opensearch/templateRegistry";

let templateEnsured = false;
/**
 * Mirrors server.ts boot: the object indices carry a template that
 * amends max_result_window=100_000. Without this, OpenSearch (default
 * 10_000) refuses the `size: MAX_SOURCE` source-side lookup the service
 * composes — and its `catch {}` silently converts the refusal into an
 * empty result ("searchAround never works in the lane even though data exists").
 */
export async function ensureOsv2IndexTemplate(): Promise<void> {
  if (templateEnsured) return;
  await ensureIndexTemplate();
  templateEnsured = true;
}

export interface EdgeDomainFixture {
  ontologyId: string;
  branchId: string;
  sourceOtApiName: string;
  targetOtApiName: string;
  linkApiName: string;
  sourceOtId: string;
  targetOtId: string;
  sourcePKs: string[];
  targetPKs: string[];
  /** isolation keys stamped into edge rows + scoped onto the confirmation probes */
  scopeCfg: { tenant: string; branch: string };
}

/**
 * Create the minimal fixture for serving-path assertions. Returns the ids
 * needed to walk both sides of the chain — we do NOT seed empty public
 * columns w/ random defaults: nulls are respected. Markings attached to the
 * object_instances rows drive the fail-closed endpoint screening assertions.
 */
export async function buildEdgeDomain(tag?: string): Promise<EdgeDomainFixture> {
  await ensureOsv2IndexTemplate();
  const t = tag ?? `e2e_${Math.random().toString(36).slice(2, 8)}`;
  const ontologyId = "00000000-0000-0000-0000-000000000001"; // canonical singleton
  const branchId = deriveMainBranchId(ontologyId);
  const sourceOtApiName = `${t}_src`;
  const targetOtApiName = `${t}_tgt`;
  const linkApiName = `${t}_link`;
  const sourceOtId = randomUUID();
  const targetOtId = randomUUID();
  // Keys two levels deep: object_instances is constrained by branch FK.
  await query(
    `INSERT INTO object_type (object_type_id, ontology_id, api_name, display_name, version) VALUES ($1, $2, $3, $3, 1), ($4, $2, $5, $5, 1)`,
    [sourceOtId, ontologyId, sourceOtApiName, targetOtId, targetOtApiName],
  );
  await query(
    `INSERT INTO link_type
       (ontology_id, api_name, display_name, cardinality,
        source_object_type, target_object_type)
     VALUES ($1, $2, $2, 'MANY_TO_MANY', $3, $4)`,
    [ontologyId, linkApiName, sourceOtId, targetOtId],
  );
  const pks = (prefix: string, list: string[]) => list;
  const sourcePKs = pks("s", ["s-1", "s-2"]);
  const targetPKs = pks("t", ["t-1", "t-2"]);
  for (const pk of sourcePKs) {
    await query(
      `INSERT INTO object_instances (ontology_id, object_type_api_name, primary_key, properties, markings, branch_id)
       VALUES ($1, $2, $3, '{}'::jsonb, ARRAY['PUBLIC'], $4)`,
      [ontologyId, sourceOtApiName, pk, branchId],
    );
  }
  for (const pk of targetPKs) {
    await query(
      `INSERT INTO object_instances (ontology_id, object_type_api_name, primary_key, properties, markings, branch_id)
       VALUES ($1, $2, $3, '{}'::jsonb, ARRAY['PUBLIC'], $4)`,
      [ontologyId, targetOtApiName, pk, branchId],
    );
  }
  return {
    ontologyId,
    branchId,
    sourceOtApiName,
    targetOtApiName,
    linkApiName,
    sourceOtId,
    targetOtId,
    sourcePKs,
    targetPKs,
    scopeCfg: { tenant: "", branch: branchId },
  };
}

/**
 * Mount the PUBLIC link router as the server does (`/api/v1/ontology/:ontologyId/linkTypes`),
 * EXCEPT that the securityContext middleware is replaced with the test principal
 * shim. Mounts an ERROR envelope so failures surface as JSON, not 500 text/html.
 */
export function buildOsv2RouteApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as Record<string, unknown>).security = {
      userId: "e2e-serve-system",
      markings: ["PUBLIC"],
      organizations: [],
      cbac: { allowPatterns: [], denyPatterns: [] },
      markingMode: "disjunctive",
      systemPrincipal: true,
      markingBypass: true,
    };
    next();
  });
  // IMPORTANT: no lazy `require()` — vitest transpiles to ESM; the
  // explicit top-level import is the correct shape for both runtimes.
  const linkRouter = linksRouter;
  app.use("/api/v1/ontology/:ontologyId/linkTypes", linkRouter);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: { code: (err as { statusCode?: number }).statusCode ?? 500, message: err.message } });
  });
  return app;
}

/** Insert a serving_rollout row. Used by rollback + fail-close suites. */
export async function setServingMode(
  scopeKind: "global" | "link_type" | "capability" | "tenant" | "ontology" | "branch",
  scopeKey: string,
  mode: "legacy" | "shadow" | "indexed",
): Promise<void> {
  await query(
    `INSERT INTO serving_rollout (scope_kind, scope_key, mode, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (scope_kind, scope_key) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()`,
    [scopeKind, scopeKey, mode],
  );
  // Rollout LOADS are cached (TTL 15 s) — a flag written AFTER some
  // other call loaded the table is invisible until TTL expiry; the
  // tests' writes-follows-use pattern requires the explicit fix.
  __resetServingRolloutCache();
}
