// Workshop B03 — module versioning + publish + resolve.
//
// Spec: tasks/workshop/workshop-tasks.md §B03.
// Decisions: D-04 (in-process resolve cache + Postgres LISTEN/NOTIFY in lieu
// of Redis), D-08 (canonical-JSON ETag for version content addressing).
//
// Surface (in-process; routes wrap each function):
//   publishVersion(rid, semver, actor, idempotency)
//   getVersion(rid, semver) -> ModuleVersionResponse
//   resolveLatest(rid)      -> ResolvedModule (cache-first)
//   resolveDev(rid)         -> ResolvedModule (head from B01 row)
//   rollback(rid, toSemver, actor) -> publishVersion replay tagged
//                                     WORKSHOP_MODULE_ROLLED_BACK
//
// Idempotency: publish is keyed by `(idempotency_key, user_id, route)` per
// G-03. Same key + same body returns the cached response; same key +
// different body -> 409 IdempotencyKeyReused. Two concurrent publishes of
// the same (rid, semver) both succeed (both return 200 with the same
// response shape) — the spec calls this "publish-is-idempotent".

import type { PoolClient } from "pg";
import { getWorkshopDb } from "./db";
import { computeEtag, canonicalizeJson } from "./etag";
import { captureSnapshot } from "../autosaveService";

// Project-root folder rid format: ri.compass.main.folder.<projectId>
const FOLDER_RID_RE = /^ri\.compass\.main\.folder\.([0-9a-fA-F-]{36})$/;

/**
 * Map a Compass folder rid to the project_id that owns it. Returns null
 * if the rid doesn't resolve (orphaned workshop, malformed rid, etc.) so
 * the caller can skip snapshot capture without failing the mutation.
 */
async function resolveProjectIdFromFolderRid(
  client: PoolClient,
  folderRid: string,
): Promise<string | null> {
  const m = FOLDER_RID_RE.exec(folderRid);
  if (!m) return null;
  const uuid = m[1].toLowerCase();
  const { rows } = await client.query<{ project_id: string }>(
    `SELECT id::text AS project_id FROM projects WHERE id = $1
     UNION ALL
     SELECT project_id::text FROM folders WHERE id = $1
     LIMIT 1`,
    [uuid],
  );
  return rows.length > 0 ? rows[0].project_id : null;
}
import {
  invalidSemver,
  moduleNotFound,
  moduleNotPublished,
  moduleVersionNotFound,
} from "./errors";
import { validateModule } from "./validator";
import { hashBody, recordResponse, lookupIdempotency } from "./idempotency";
import { emitWorkshopAudit } from "./audit";
import type { Actor, IdempotencyOptions } from "./moduleService";
import {
  histPublish,
  histResolve,
  counterResolve,
  counterResolveCacheHit,
} from "./metrics";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PublishRequest {
  semver: string;
}

export interface ModuleVersionResponse {
  rid: string;
  semver: string;
  schemaVersion: number;
  definition: unknown;
  compiled: unknown;
  publishedAt: string;
  publishedBy: string;
  /**
   * The version's content-addressed ETag. Useful for
   * "did this version change?" probes; not used for If-Match because
   * versions are immutable.
   */
  etag: string;
}

export interface ResolvedModule {
  rid: string;
  semver: string | null;
  schemaVersion: number;
  definition: unknown;
  compiled: unknown;
  /**
   * For `latest`, this is the publish timestamp. For `dev` this is the
   * working-copy `updated_at`. Clients use it for cache freshness.
   */
  asOf: string;
  source: "latest" | "dev";
}

export interface PublishedModule {
  version: ModuleVersionResponse;
  fromCache: boolean;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

// Strict semver per https://semver.org/, no pre-release/build metadata to
// keep tag space simple per spec. We accept e.g. `1.2.3` — not `1.2`,
// `v1.2.3`, or `1.2.3-rc1`.
const SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function assertSemver(semver: string): void {
  if (!SEMVER_REGEX.test(semver)) throw invalidSemver(semver);
}

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

const SELECT_HEAD = `
  rid, schema_version, definition, etag, updated_at,
  published_semver, published_at, parent_folder_rid, display_name
`;

interface ModuleHeadRow {
  rid: string;
  schema_version: number;
  definition: unknown;
  etag: string;
  updated_at: string;
  published_semver: string | null;
  published_at: string | null;
  parent_folder_rid: string;
  display_name: string;
}

/**
 * Publish (or rollback to) a specific semver. Implementation:
 *   1) lookup idempotency cache → return early if hit.
 *   2) load workshop_module row (FOR SHARE — no need to block writers).
 *   3) recompute B02 compiled artifact against current head definition;
 *      reject if invalid.
 *   4) insert workshop_module_version row.
 *   5) update workshop_module.published_semver/published_at.
 *   6) issue NOTIFY for cache invalidation (D-04).
 *   7) audit WORKSHOP_MODULE_PUBLISHED (or _ROLLED_BACK if `isRollback`).
 */
export async function publishVersion(
  rid: string,
  request: PublishRequest,
  actor: Actor,
  idempotency: IdempotencyOptions,
  options: { isRollback?: boolean } = {},
): Promise<PublishedModule> {
  const t0 = process.hrtime.bigint();
  let metricResult: "success" | "error" = "success";
  try {
    return await _publishVersionInner(rid, request, actor, idempotency, options);
  } catch (e) {
    metricResult = "error";
    throw e;
  } finally {
    const ns = Number(process.hrtime.bigint() - t0);
    histPublish.observe({ result: metricResult }, ns / 1e9);
  }
}

async function _publishVersionInner(
  rid: string,
  request: PublishRequest,
  actor: Actor,
  idempotency: IdempotencyOptions,
  options: { isRollback?: boolean } = {},
): Promise<PublishedModule> {
  assertSemver(request.semver);

  const isRollback = options.isRollback ?? false;
  const route = idempotency.route;
  const bodyHash = hashBody(idempotency.body);

  // Step 1 — idempotency lookup. `lookupIdempotency` itself throws
  // IdempotencyKeyReused (409) on body mismatch.
  if (idempotency.key) {
    const hit = await lookupIdempotency({
      key: idempotency.key,
      userId: actor.userId,
      route,
      bodySha256: bodyHash,
    });
    if (hit) {
      return {
        version: hit.responseBody as unknown as ModuleVersionResponse,
        fromCache: true,
      };
    }
  }

  const result = await getWorkshopDb().withTransaction(
    async (client: PoolClient) => {
      // Serialize concurrent publishes on the same rid via a transaction-
      // scoped advisory lock. Without this, two concurrent publishes that
      // commit in the same microsecond collide on the (rid, published_at)
      // PK and one returns 500. Spec §B03 acceptance requires concurrent
      // publishes of the same (rid, semver) to be idempotent.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [rid]);
      const head = await loadHead(client, rid);

      // Step 3 — recompile (defense-in-depth; B01 already validated on
      // PUT, but the spec is explicit: publish revalidates).
      const compileResult = validateModule(head.definition);

      // Step 4 — insert immutable version row. Re-publishing the same
      // (rid, semver) produces a NEW row (rollback timeline) per the
      // composite PK on (rid, published_at).
      const inserted = await client.query<{
        published_at: string;
        published_by: string;
      }>(
        `INSERT INTO workshop_module_version
           (rid, semver, schema_version, definition, compiled, published_by)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
         RETURNING published_at::text, published_by`,
        [
          rid,
          request.semver,
          head.schema_version,
          JSON.stringify(head.definition),
          JSON.stringify(compileResult.compiled),
          actor.userId,
        ],
      );
      const publishedAt = inserted.rows[0].published_at;

      // Step 5 — flip workshop_module.published_semver to point at this
      // tag (whether forward-publish or rollback).
      await client.query(
        `UPDATE workshop_module
            SET published_semver = $2,
                published_at     = $3::timestamptz
          WHERE rid = $1`,
        [rid, request.semver, publishedAt],
      );

      // Step 6 — invalidate latest-resolve cache via Postgres NOTIFY.
      await client.query(
        `SELECT pg_notify('workshop_module_published', $1)`,
        [JSON.stringify({ rid, semver: request.semver })],
      );

      // Step 6.5 — capture autosave snapshot inside the same transaction
      // so the history row commits atomically with the version write.
      // Project id is resolved from parent_folder_rid (Foundry-faithful
      // convention: project root folder uuid == project uuid; otherwise
      // look up the folder's project_id).
      try {
        const projectId = await resolveProjectIdFromFolderRid(
          client,
          head.parent_folder_rid,
        );
        if (projectId !== null) {
          await captureSnapshot(
            {
              resourceRid: rid,
              resourceKind: "workshop-module",
              projectId,
              parentFolderRid: head.parent_folder_rid,
              actorId: null, // workshop actor.userId is the JWT sub, not a tellus user uuid
              actorEmail: null,
              changeKind: "published",
              changeSummary: `Published ${request.semver}`,
              payload: {
                kind: "workshop-module",
                displayName: head.display_name,
                parentFolderRid: head.parent_folder_rid,
                publishedSemver: request.semver,
                currentSemver: request.semver,
                publishedAt,
              },
            },
            client,
          );
        }
      } catch (snapErr) {
        // Snapshot failure must not break the publish — autosave is a
        // history-keeping concern, not a correctness concern. Log and
        // continue. The user's publish still succeeded.
        // eslint-disable-next-line no-console
        console.warn(
          "[workshop:publish] autosave snapshot capture failed",
          snapErr instanceof Error ? snapErr.message : snapErr,
        );
      }

      const versionEtag = computeEtag(head.definition, 0);
      const response: ModuleVersionResponse = {
        rid,
        semver: request.semver,
        schemaVersion: head.schema_version,
        definition: head.definition,
        compiled: compileResult.compiled,
        publishedAt,
        publishedBy: actor.userId,
        etag: versionEtag,
      };
      return response;
    },
  );

  // Step 1 — record idempotency response (after commit, so retries see
  // the same response shape).
  if (idempotency.key) {
    await recordResponse(
      {
        key: idempotency.key,
        userId: actor.userId,
        route,
        bodySha256: bodyHash,
      },
      200,
      result as unknown as Record<string, unknown>,
      result.etag,
    );
  }

  // Step 7 — audit.
  await emitWorkshopAudit({
    actorSubject: actor.userId,
    action: isRollback
      ? "WORKSHOP_MODULE_ROLLED_BACK"
      : "WORKSHOP_MODULE_PUBLISHED",
    rid,
    result: "SUCCESS",
    details: {
      semver: request.semver,
      branchRid: actor.branchRid ?? null,
    },
  });

  // Step 6 — local cache invalidation (in-process). Other processes pick
  // it up via LISTEN/NOTIFY. See cacheStore.invalidate below.
  cacheStore.invalidate(rid);

  return { version: result, fromCache: false };
}

/**
 * Rollback is a publish with `isRollback: true`. Server emits
 * WORKSHOP_MODULE_ROLLED_BACK rather than _PUBLISHED so the audit log
 * preserves the operator intent.
 */
export async function rollback(
  rid: string,
  toSemver: string,
  actor: Actor,
  idempotency: IdempotencyOptions,
): Promise<PublishedModule> {
  return publishVersion(rid, { semver: toSemver }, actor, idempotency, {
    isRollback: true,
  });
}

// ---------------------------------------------------------------------------
// getVersion / resolveLatest / resolveDev
// ---------------------------------------------------------------------------

export async function getVersion(
  rid: string,
  semver: string,
): Promise<ModuleVersionResponse> {
  assertSemver(semver);
  const db = getWorkshopDb();
  const r = await db.query(
    `SELECT rid, semver, schema_version, definition, compiled,
            published_at::text, published_by
       FROM workshop_module_version
      WHERE rid = $1 AND semver = $2
   ORDER BY published_at DESC
      LIMIT 1`,
    [rid, semver],
  );
  if (r.rows.length === 0) throw moduleVersionNotFound(rid, semver);
  const row = r.rows[0] as {
    rid: string;
    semver: string;
    schema_version: number;
    definition: unknown;
    compiled: unknown;
    published_at: string;
    published_by: string;
  };
  return {
    rid: row.rid,
    semver: row.semver,
    schemaVersion: row.schema_version,
    definition: row.definition,
    compiled: row.compiled,
    publishedAt: row.published_at,
    publishedBy: row.published_by,
    etag: computeEtag(row.definition, 0),
  };
}

interface CacheEntry {
  resolved: ResolvedModule;
  expiresAt: number;
}

export class ResolveCache {
  private map = new Map<string, CacheEntry>();
  private ttlMs = 30_000; // §B03 SLO assumes 30s.
  private hits = 0;
  private misses = 0;

  get(rid: string): ResolvedModule | null {
    const entry = this.map.get(rid);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (entry.expiresAt < Date.now()) {
      this.map.delete(rid);
      this.misses++;
      return null;
    }
    this.hits++;
    return entry.resolved;
  }

  put(rid: string, resolved: ResolvedModule) {
    this.map.set(rid, {
      resolved,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  invalidate(rid: string) {
    this.map.delete(rid);
  }

  stats() {
    return { hits: this.hits, misses: this.misses, size: this.map.size };
  }

  reset() {
    this.map.clear();
    this.hits = 0;
    this.misses = 0;
  }

  setTtl(ms: number) {
    this.ttlMs = ms;
  }
}

export const cacheStore = new ResolveCache();

/**
 * Resolve the latest published version of a module. Cache-first; on miss,
 * single index lookup. Cache TTL is 30s (per §B03 SLO assumption); the
 * publish path invalidates synchronously via `cacheStore.invalidate(rid)`,
 * and out-of-process invalidation rides on Postgres NOTIFY (D-04). When
 * Redis is provisioned the cache class is swapped in place; the public
 * API does not change.
 */
export async function resolveLatest(rid: string): Promise<ResolvedModule> {
  const t0 = process.hrtime.bigint();
  let mResult: "success" | "error" = "success";
  let cacheLabel: "hit" | "miss" = "miss";
  try {
    const cached = cacheStore.get(rid);
    if (cached) {
      cacheLabel = "hit";
      counterResolveCacheHit.inc({ track: "latest" }, 1);
      return cached;
    }
    const fresh = await _resolveLatestInner(rid);
    return fresh;
  } catch (e) {
    mResult = "error";
    throw e;
  } finally {
    const ns = Number(process.hrtime.bigint() - t0);
    histResolve.observe(
      { track: "latest", cache_hit: cacheLabel },
      ns / 1e9,
    );
    counterResolve.inc({ track: "latest", result: mResult }, 1);
  }
}

async function _resolveLatestInner(rid: string): Promise<ResolvedModule> {
  const cached = cacheStore.get(rid);
  if (cached) return cached;

  const db = getWorkshopDb();
  const r = await db.query(
    `SELECT v.rid, v.semver, v.schema_version, v.definition, v.compiled,
            v.published_at::text
       FROM workshop_module_version v
       JOIN workshop_module m
         ON m.rid = v.rid
        AND m.published_semver = v.semver
        AND m.published_at = v.published_at
      WHERE m.rid = $1 AND m.deleted_at IS NULL`,
    [rid],
  );
  if (r.rows.length === 0) {
    // Decide: not-published vs not-found. If the module exists but has no
    // published_semver, surface NotPublished; otherwise NotFound.
    const exists = await db.query(
      `SELECT 1 FROM workshop_module
        WHERE rid = $1 AND deleted_at IS NULL`,
      [rid],
    );
    if (exists.rows.length === 0) throw moduleNotFound(rid);
    throw moduleNotPublished(rid);
  }
  const row = r.rows[0] as {
    rid: string;
    semver: string;
    schema_version: number;
    definition: unknown;
    compiled: unknown;
    published_at: string;
  };
  const resolved: ResolvedModule = {
    rid: row.rid,
    semver: row.semver,
    schemaVersion: row.schema_version,
    definition: row.definition,
    compiled: row.compiled,
    asOf: row.published_at,
    source: "latest",
  };
  cacheStore.put(rid, resolved);
  return resolved;
}

/**
 * Resolve the working-copy ("dev") head from workshop_module. No cache —
 * dev reads should reflect every PUT instantly; cache here would be a
 * footgun.
 */
export async function resolveDev(rid: string): Promise<ResolvedModule> {
  const t0 = process.hrtime.bigint();
  let mResult: "success" | "error" = "success";
  try {
    return await _resolveDevInner(rid);
  } catch (e) {
    mResult = "error";
    throw e;
  } finally {
    const ns = Number(process.hrtime.bigint() - t0);
    histResolve.observe({ track: "dev", cache_hit: "miss" }, ns / 1e9);
    counterResolve.inc({ track: "dev", result: mResult }, 1);
  }
}

async function _resolveDevInner(rid: string): Promise<ResolvedModule> {
  const db = getWorkshopDb();
  const r = await db.query(
    `SELECT rid, schema_version, definition, updated_at::text
       FROM workshop_module
      WHERE rid = $1 AND deleted_at IS NULL`,
    [rid],
  );
  if (r.rows.length === 0) throw moduleNotFound(rid);
  const row = r.rows[0] as {
    rid: string;
    schema_version: number;
    definition: unknown;
    updated_at: string;
  };
  // Re-run B02 to populate compiled (ephemeral; not persisted on dev
  // path — keeps this endpoint always-fresh).
  const compileResult = validateModule(row.definition);
  return {
    rid: row.rid,
    semver: null,
    schemaVersion: row.schema_version,
    definition: row.definition,
    compiled: compileResult.compiled,
    asOf: row.updated_at,
    source: "dev",
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function loadHead(
  client: PoolClient,
  rid: string,
): Promise<ModuleHeadRow> {
  const r = await client.query<ModuleHeadRow>(
    `SELECT ${SELECT_HEAD}
       FROM workshop_module
      WHERE rid = $1 AND deleted_at IS NULL
      FOR SHARE`,
    [rid],
  );
  if (r.rows.length === 0) throw moduleNotFound(rid);
  return r.rows[0];
}

// Re-export for consumers that want canonical JSON (e.g. for content-
// addressed comparisons).
export { canonicalizeJson };
