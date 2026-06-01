// ---------------------------------------------------------------------------
// Connectivity credential vault (B2).
//
// Public surface (used by handlers + worker credential-fetch):
//   - createOrRotate(connectionRid, tenant, field, plaintext, actor)
//       inserts a NEW version row; older rows stay readable (until cleanup).
//   - read(connectionRid, tenant, field) → { wrapped, ciphertext, version }
//       returns the highest-version row for the field.
//   - unwrap(connectionRid, tenant, field, actor, ctx) → Uint8Array (plaintext)
//       reads + decrypts; writes an audit row regardless of outcome.
//   - supersede(connectionRid, tenant, field, actor)
//       marks versions superseded; future unwraps reject.
//
// Cache: process-local LRU keyed by (rid, field, version). Capacity 256;
// TTL 60s. Rotation calls invalidate the LRU entry. Capped on the
// assumption that production workers fetch credentials lazily and a small
// cache covers steady-state.
// ---------------------------------------------------------------------------

import { LRUCache } from "lru-cache";
import { getKmsAdapter } from "../../../lib/kms";
import { decrypt, encrypt, generateDek } from "./aesgcm";
import * as store from "./store.repo";
import * as audit from "./audit.repo";

export type CredentialField = store.CredentialField;

export interface UnwrapContext {
  requestId?: string;
  clientIp?: string;
  scopes?: string[];
}

const cache = new LRUCache<string, Uint8Array>({
  max: 256,
  ttl: 60_000,
});

function cacheKey(rid: string, field: string, version: number): string {
  return `${rid}\u0000${field}\u0000${version}`;
}

export async function createOrRotate(
  connectionRid: string,
  tenant: string,
  field: CredentialField,
  plaintext: Uint8Array,
  actor: string,
): Promise<{ version: number }> {
  const kms = getKmsAdapter();
  const dek = generateDek();
  const wrapped = await kms.wrap(dek, { tenant });
  const ciphertext = encrypt(plaintext, dek);

  const next = await store.insertNewVersion({
    connectionRid,
    tenant,
    field,
    ciphertext,
    wrappedDek: wrapped.ciphertext,
    kmsAdapter: wrapped.adapter,
    kmsKeyId: wrapped.keyId,
    createdBy: actor,
  });

  await audit.write({
    connectionRid,
    tenant,
    field,
    version: next.version,
    operation: next.version === 1 ? "create" : "rotate",
    actor,
    outcome: "success",
  });

  // Invalidate any old-version cache entry — the new version is now the
  // authoritative read target.
  for (let v = 1; v < next.version; v++) {
    cache.delete(cacheKey(connectionRid, field, v));
  }

  // Best-effort plaintext scrub (Node lacks explicit secure-erase but a
  // fill is correct; the GC retains the buffer until reclamation).
  plaintext.fill(0);
  dek.fill(0);

  return next;
}

export async function unwrap(
  connectionRid: string,
  tenant: string,
  field: CredentialField,
  actor: string,
  ctx: UnwrapContext = {},
): Promise<Uint8Array> {
  const head = await store.headVersion(connectionRid, tenant, field);
  if (!head) {
    await audit.write({
      connectionRid,
      tenant,
      field,
      version: 0,
      operation: "unwrap",
      actor,
      outcome: "failure",
      reason: "no credential row",
      requestId: ctx.requestId,
      clientIp: ctx.clientIp,
      scopes: ctx.scopes,
    });
    return new Uint8Array();
  }
  const cached = cache.get(cacheKey(connectionRid, field, head.version));
  if (cached) {
    await audit.write({
      connectionRid,
      tenant,
      field,
      version: head.version,
      operation: "unwrap",
      actor,
      outcome: "success",
      reason: "cache_hit",
      requestId: ctx.requestId,
      clientIp: ctx.clientIp,
      scopes: ctx.scopes,
    });
    // Return a copy so callers can scrub without affecting the cache buffer.
    return new Uint8Array(cached);
  }
  const kms = getKmsAdapter();
  try {
    const dek = await kms.unwrap(
      {
        ciphertext: head.wrappedDek,
        keyId: head.kmsKeyId,
        adapter: head.kmsAdapter,
      },
      { tenant },
    );
    const plaintext = decrypt(head.ciphertext, dek);
    cache.set(cacheKey(connectionRid, field, head.version), new Uint8Array(plaintext));
    dek.fill(0);
    await audit.write({
      connectionRid,
      tenant,
      field,
      version: head.version,
      operation: "unwrap",
      actor,
      outcome: "success",
      requestId: ctx.requestId,
      clientIp: ctx.clientIp,
      scopes: ctx.scopes,
    });
    return plaintext;
  } catch (e) {
    await audit.write({
      connectionRid,
      tenant,
      field,
      version: head.version,
      operation: "unwrap",
      actor,
      outcome: "failure",
      reason: (e as Error).message?.slice(0, 200) ?? "unknown",
      requestId: ctx.requestId,
      clientIp: ctx.clientIp,
      scopes: ctx.scopes,
    });
    throw e;
  }
}

export async function supersede(
  connectionRid: string,
  tenant: string,
  field: CredentialField,
  actor: string,
): Promise<number> {
  const n = await store.supersedeAll(connectionRid, tenant, field);
  await audit.write({
    connectionRid,
    tenant,
    field,
    version: 0,
    operation: "supersede",
    actor,
    outcome: "success",
    reason: `${n} rows superseded`,
  });
  // Clear cache for the rid+field.
  for (const key of cache.keys()) {
    if (key.startsWith(`${connectionRid}\u0000${field}\u0000`)) {
      cache.delete(key);
    }
  }
  return n;
}

/** Test helper: drop the process cache. */
export function _clearCacheForTest(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// B2 — rotation primitives. The worker uses these to re-wrap material
// non-destructively (the existing version stays readable until cleanup).
// ---------------------------------------------------------------------------

/**
 * Default leeway (days) before `rotate_after_days` expiry that the worker
 * pre-emptively rotates. Spec: rotate within 24h of expiry → 1 day.
 */
export const ROTATION_LEEWAY_DAYS = 1;

import type { PoolClient } from "pg";
import { randomBytes } from "node:crypto";

/**
 * Re-wrap an existing credential field with a freshly generated password.
 * Runs inside the worker's transaction. Audit logging is the worker's job.
 * Returns the new version number.
 */
export async function rewrap(
  _client: PoolClient,
  connectionRid: string,
  field: string,
): Promise<{ version: number }> {
  // Look up the current row to discover its tenant + actor.
  const head = await store.headVersion(connectionRid, "default", field as CredentialField);
  if (!head) {
    throw new Error(
      `vault.rewrap: no current credential at rid=${connectionRid} field=${field}`,
    );
  }
  // Generate a new password — 32 bytes URL-safe, 256 bits of entropy.
  const fresh = new Uint8Array(randomBytes(32));
  const tenant = (head as { tenant?: string }).tenant ?? "default";
  const result = await createOrRotate(
    connectionRid,
    tenant,
    field as CredentialField,
    fresh,
    "system:rotation-worker",
  );
  return { version: result.version };
}
