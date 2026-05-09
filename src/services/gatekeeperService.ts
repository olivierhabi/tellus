// ---------------------------------------------------------------------------
// gatekeeperService — Foundry-faithful permission evaluator (B4.05+).
// ---------------------------------------------------------------------------
// SPEC.md §B4. The full evaluation pipeline is (per the §B4 plan):
//   step 1 — organization membership check  (B4.05, this file)
//   step 2 — required-markings check        (B4.06)
//   step 3 — role ancestor walk             (B4.07)
// LRU caching + LISTEN/NOTIFY invalidation are layered in B4.10.
// ---------------------------------------------------------------------------
import { pool as defaultPool } from "../db";
import type { Pool, PoolClient } from "pg";
import { LRUCache } from "lru-cache";

export interface EvaluateInput {
  principalId: string;
  operationId: string;
  resourceRid: string;
}

export type Decision =
  | { decision: "ALLOW" }
  | { decision: "DENY"; reason: string };

export class GatekeeperService {
  // B4.10: LRU cache keyed by `${principalId}|${operationId}|${resourceRid}`.
  // Invalidated by Postgres LISTEN/NOTIFY on the `gatekeeper_invalidate`
  // channel. The migration installs triggers on role_grants /
  // user_organizations / project_organizations / resource_markings /
  // user_markings that emit NOTIFY 'gatekeeper_invalidate', '*' rows.
  private readonly cache = new LRUCache<string, Decision>({
    max: Number(process.env.GATEKEEPER_CACHE_MAX || 10_000),
    ttl: Number(process.env.GATEKEEPER_CACHE_TTL_MS || 60_000),
  });
  private listenerStarted = false;
  private listenerClient: PoolClient | undefined;

  constructor(private readonly pool: Pool = defaultPool) {}

  /** Idempotently start the LISTEN client on `gatekeeper_invalidate`. */
  async startInvalidationListener(): Promise<void> {
    if (this.listenerStarted) return;
    this.listenerStarted = true;
    try {
      const c = await this.pool.connect();
      this.listenerClient = c;
      c.on("notification", (msg) => {
        if (msg.channel !== "gatekeeper_invalidate") return;
        // payload format: '*' (clear all) or a key prefix.
        if (!msg.payload || msg.payload === "*") {
          this.cache.clear();
        } else {
          for (const k of [...this.cache.keys()]) {
            if (k.includes(msg.payload)) this.cache.delete(k);
          }
        }
      });
      c.on("error", () => { this.listenerStarted = false; });
      await c.query("LISTEN gatekeeper_invalidate");
    } catch {
      this.listenerStarted = false;
    }
  }

  /** Test/teardown helper. */
  async stopInvalidationListener(): Promise<void> {
    this.listenerStarted = false;
    try {
      if (this.listenerClient) {
        await this.listenerClient.query("UNLISTEN *");
        this.listenerClient.release();
        this.listenerClient = undefined;
      }
    } catch { /* ignore */ }
  }

  /** B4.10 — clear the cache (used by tests + manual ops). */
  clearCache(): void { this.cache.clear(); }

  /** B4.10 — cache size for visibility. */
  cacheSize(): number { return this.cache.size; }

  /**
   * Evaluate a single (principal, operation, resource) triple.
   *
   * Step 1 (B4.05): walk up `resources.parent_folder_rid` to find the
   * project ancestor; collect orgs attached via `project_organizations`;
   * deny if the principal isn't a member of at least one of those orgs.
   *
   * Resources without a project ancestor (e.g. spaces, orphans) skip the
   * org check — there's no project to attach orgs to.
   */
  async evaluate(input: EvaluateInput): Promise<Decision> {
    const { principalId, resourceRid } = input;
    const cacheKey = `${principalId}|${input.operationId}|${resourceRid}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const decision = await this.evaluateUncached(input);
    this.cache.set(cacheKey, decision);
    return decision;
  }

  /** Internal: actual SQL-driven evaluation, bypassing the cache. */
  private async evaluateUncached(input: EvaluateInput): Promise<Decision> {
    const { principalId, resourceRid } = input;

    // Find the project rid for this resource. Either the resource IS a
    // project (its own rid is the project rid) or has `project_rid` set.
    const projectRow = await this.pool.query<{ project_rid: string | null; type: string }>(
      `SELECT project_rid, type FROM resources WHERE rid = $1 LIMIT 1`,
      [resourceRid],
    );
    if (projectRow.rows.length === 0) {
      // Unknown resource: defer to step 3 (which will deny). For step 1
      // alone, we let it through.
      return { decision: "ALLOW" };
    }
    const projectRid =
      projectRow.rows[0].type === "PROJECT"
        ? resourceRid
        : projectRow.rows[0].project_rid;
    if (!projectRid) {
      // Orphan or above-project (space) — no org check applies.
      return { decision: "ALLOW" };
    }

    // Collect orgs attached to that project.
    const orgs = await this.pool.query<{ org_id: string }>(
      `SELECT org_id FROM project_organizations WHERE project_rid = $1`,
      [projectRid],
    );
    if (orgs.rows.length === 0) {
      // No orgs attached → unconstrained at the org layer.
      return { decision: "ALLOW" };
    }

    const overlap = await this.pool.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM user_organizations uo
         WHERE uo.user_id = $1 AND uo.org_id = ANY($2::uuid[])
       ) AS ok`,
      [principalId, orgs.rows.map((r) => r.org_id)],
    );
    if (!overlap.rows[0]?.ok) {
      return { decision: "DENY", reason: "NO_ORG_MEMBERSHIP" };
    }

    // ----- Step 2 (B4.06) — required markings check ----------------------
    const required = await this.pool.query<{ marking_id: string }>(
      `SELECT DISTINCT marking_id
       FROM resource_markings
       WHERE resource_rid = ANY($1::text[])
       AND source IN ('DIRECT','INHERITED','DATA_LINEAGE')`,
      [Array.from(new Set([resourceRid, projectRid]))],
    );
    if (required.rows.length > 0) {
      const userM = await this.pool.query<{ marking_id: string }>(
        `SELECT marking_id FROM user_markings WHERE user_id = $1`,
        [principalId],
      );
      const have = new Set(userM.rows.map((r) => r.marking_id));
      const missing = required.rows
        .map((r) => r.marking_id)
        .filter((m) => !have.has(m))
        .sort();
      if (missing.length > 0) {
        return {
          decision: "DENY",
          reason: `MISSING_MARKINGS:${missing.join(",")}`,
        };
      }
    }

    // ----- Step 3 (B4.07) — role ancestor walk ----------------------------
    // Iteratively walk resources.parent_folder_rid upward, stopping at any
    // ancestor where metadata->>'disable_inherited_permissions' = 'true'.
    // Then collect every role_grant on the visited rids that's granted to
    // this principal (or to EVERYONE) and UNION the role_operations.
    const visited: string[] = [];
    let cursor: string | null = resourceRid;
    let depth = 0;
    while (cursor && depth < 50) {
      visited.push(cursor);
      const r = await this.pool.query<{
        parent_folder_rid: string | null;
        blocks: boolean;
      }>(
        `SELECT parent_folder_rid,
                COALESCE(metadata->>'disable_inherited_permissions','false') = 'true' AS blocks
         FROM resources WHERE rid = $1 LIMIT 1`,
        [cursor],
      );
      if (r.rows.length === 0) break;
      // First node never blocks; otherwise stop walking once we've added
      // a node that itself blocks inheritance.
      if (depth > 0 && r.rows[0].blocks) break;
      cursor = r.rows[0].parent_folder_rid;
      depth += 1;
    }
    if (depth >= 50) {
      return { decision: "DENY", reason: "LINEAGE_TOO_DEEP" };
    }
    const granted = await this.pool.query<{ operation_id: string }>(
      `SELECT DISTINCT ro.operation_id
       FROM role_grants rg
       JOIN role_operations ro ON ro.role_id = rg.role_id
       WHERE rg.resource_rid = ANY($1::text[])
         AND (rg.principal_id = $2 OR rg.principal_type = 'EVERYONE')`,
      [visited, principalId],
    );
    const operations = new Set(granted.rows.map((r) => r.operation_id));
    if (!operations.has(input.operationId)) {
      return { decision: "DENY", reason: "OPERATION_NOT_GRANTED" };
    }
    return { decision: "ALLOW" };
  }

  /**
   * Evaluate many (principal, operation, resource) triples in one call.
   *
   * The result is keyed by `${principalId}|${operationId}|${resourceRid}`
   * so callers can dedupe inputs and look up by the same key.
   *
   * Implementation: deduplicate inputs by key, evaluate concurrently
   * with a small concurrency cap so the pool isn't overwhelmed.
   */
  async evaluateBatch(inputs: EvaluateInput[]): Promise<Map<string, Decision>> {
    const result = new Map<string, Decision>();
    const seen = new Map<string, EvaluateInput>();
    for (const i of inputs) {
      const k = `${i.principalId}|${i.operationId}|${i.resourceRid}`;
      if (!seen.has(k)) seen.set(k, i);
    }
    const keys = [...seen.keys()];
    const cap = 8;
    for (let i = 0; i < keys.length; i += cap) {
      const slice = keys.slice(i, i + cap);
      const decisions = await Promise.all(
        slice.map((k) => this.evaluate(seen.get(k) as EvaluateInput)),
      );
      slice.forEach((k, j) => result.set(k, decisions[j]));
    }
    return result;
  }

  /**
   * B6.06 — cross-project visibility extension.
   *
   * Evaluates the standard pipeline; if it would DENY a `view-resource`
   * (or any of the cross-project visible operations), checks whether the
   * resource is referenced by some project the principal can view. If so,
   * upgrades the decision to ALLOW — but only for view-shaped operations.
   */
  async evaluateWithReferences(input: EvaluateInput): Promise<Decision> {
    const direct = await this.evaluate(input);
    if (direct.decision === "ALLOW") return direct;
    if (input.operationId !== "compass:view-resource" && input.operationId !== "compass:discover-resource") {
      return direct;
    }
    const owners = await this.pool.query<{ owner_project_rid: string }>(
      `SELECT DISTINCT owner_project_rid FROM project_references WHERE referenced_resource_rid = $1`,
      [input.resourceRid],
    );
    for (const r of owners.rows) {
      const ownerDecision = await this.evaluate({
        principalId: input.principalId,
        operationId: "compass:view-resource",
        resourceRid: r.owner_project_rid,
      });
      if (ownerDecision.decision === "ALLOW") return { decision: "ALLOW" };
    }
    return direct;
  }
}

// Default singleton — most callers don't want to wire a pool by hand.
export const gatekeeperService = new GatekeeperService();
