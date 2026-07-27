// ---------------------------------------------------------------------------
// Action Lock Manager — Shared Mutation-Locking Protocol (§6)
//
// Every object and relationship mutation path uses the SAME protocol so
// referential-integrity checks and final-state validation are protected
// against concurrent writers.
//
// Lock acquisition:
//   1. Gather every object identity read or mutated by: create, modify,
//      modify-or-create, delete, addLink, removeLink, FK relationship update.
//   2. Deduplicate identities.
//   3. Sort deterministically by: ontologyId, branchId, objectType,
//      canonicalSerializedPrimaryKey.
//   4. Acquire transaction-scoped advisory locks (pg_advisory_xact_lock) for
//      every identity in that order.
//   5. For existing objects, also acquire row locks via SELECT ... FOR UPDATE.
//
// Advisory locks are needed because a create target may not yet have a row
// to lock. Row locks serialize against concurrent writers that already hold
// a row lock on the same object_instances row.
//
// Lock-key determinism: the advisory-lock big(integer key is derived from a
// SHA-256 hash of the canonical identity string (ontology|branch|type|pk).
// SHA-256 is deterministic across processes/platforms and is NOT JavaScript's
// in-memory object-identity hash. Acquiring locks in sorted key order is the
// classic serialization defense against deadlock between two transactions
// locking overlapping identity sets.
// ---------------------------------------------------------------------------

import crypto from "crypto";
import type { PoolClient } from "pg";
import type { PrimaryKeyValue } from "./objectReferenceResolver";

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

/** A canonical object identity used for dedup and lock acquisition. */
export interface LockIdentity {
  ontologyId: string;
  branchId: string;
  objectType: string;
  primaryKey: PrimaryKeyValue;
}

/** Deterministic canonical serialization of a primary-key value. */
export function canonicalPrimaryKey(pk: PrimaryKeyValue): string {
  if (typeof pk === "boolean") return pk ? "B1" : "B0";
  if (typeof pk === "number") return `N:${pk}`;
  return `S:${pk}`;
}

/** Deterministic canonical key string for an identity tuple. */
export function canonicalIdentityKey(id: LockIdentity): string {
  return [
    id.ontologyId,
    id.branchId,
    id.objectType,
    canonicalPrimaryKey(id.primaryKey),
  ].join("|");
}

/**
 * Deterministic signed 64-bit advisory-lock key derived from the canonical
 * identity string. SHA-256 over the tuple, take the first 8 bytes, interpret
 * as a signed two's-complement bigint. Stable across processes/platforms.
 */
export function deterministicLockKey(id: LockIdentity): bigint {
  const str = canonicalIdentityKey(id);
  const h = crypto.createHash("sha256").update(str, "utf8").digest();
  const hi = h.readUInt32BE(0);
  const lo = h.readUInt32BE(4);
  // Combine into a 64-bit unsigned bigint, then map to signed range
  // (pg_advisory_xact_lock accepts a single bigint argument).
  const u64 = BigInt(hi) * BigInt(0x100000000) + BigInt(lo);
  return toSignedInt64(u64);
}

/** Map an unsigned 64-bit bigint into signed two's-complement range. */
function toSignedInt64(u: bigint): bigint {
  const TWO_POW_64 = BigInt(1) << BigInt(64);
  const SIGN_BIT = BigInt(1) << BigInt(63);
  if (u & SIGN_BIT) {
    return u - TWO_POW_64;
  }
  return u;
}

/** Deterministic sort comparator for identities (sort before locking). */
export function compareIdentities(a: LockIdentity, b: LockIdentity): number {
  const ax = canonicalIdentityKey(a);
  const bx = canonicalIdentityKey(b);
  return ax < bx ? -1 : ax > bx ? 1 : 0;
}

/** Deduplicate identities by canonical key, preserving nothing order-dependent. */
export function dedupeIdentities(ids: LockIdentity[]): LockIdentity[] {
  const seen = new Map<string, LockIdentity>();
  for (const id of ids) {
    const k = canonicalIdentityKey(id);
    if (!seen.has(k)) seen.set(k, id);
  }
  return Array.from(seen.values());
}

/**
 * Return the identities to lock, deduplicated and deterministically
 * sorted. This is the exact order advisory locks are acquired in.
 */
export function sortedLockIdentities(ids: LockIdentity[]): LockIdentity[] {
  return dedupeIdentities(ids).sort(compareIdentities);
}

// ---------------------------------------------------------------------------
// Advisory lock acquisition (inside the caller's transaction)
// ---------------------------------------------------------------------------

/**
 * Acquire transaction-scoped advisory locks for every identity, in
 * deterministic order. Must be called inside the action's PG transaction.
 *
 * pg_advisory_xact_lock is released automatically at COMMIT/ROLLBACK — no
 * explicit release needed. Locks are taken in deterministic key order so
 * two transactions locking overlapping identity sets cannot deadlock on
 * advisory-lock acquisition.
 */
export async function acquireAdvisoryLocks(
  client: PoolClient,
  identities: LockIdentity[],
): Promise<void> {
  const ordered = sortedLockIdentities(identities);
  for (const id of ordered) {
    const key = deterministicLockKey(id);
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [key.toString()]);
  }
}

// ---------------------------------------------------------------------------
// Row locks for existing objects (SELECT ... FOR UPDATE)
// ---------------------------------------------------------------------------

/**
 * Acquire row locks on object_instances rows for identities that already
 * exist. Identities whose object does not yet exist (create target) are
 * skipped — advisory locks protect them. Returns the subset of identities
 * whose row was found and locked.
 */
export async function acquireRowLocks(
  client: PoolClient,
  identities: LockIdentity[],
): Promise<LockIdentity[]> {
  const ordered = sortedLockIdentities(identities);
  const locked: LockIdentity[] = [];
  for (const id of ordered) {
    const pk = canonicalPrimaryKey(id.primaryKey);
    try {
      const r = await client.query(
        `SELECT 1 FROM object_instances
           WHERE object_type_api_name = $1 AND primary_key = $2
           FOR UPDATE`,
        [id.objectType, String(id.primaryKey)],
      );
      if ((r.rowCount ?? 0) > 0) locked.push(id);
    } catch {
      // object_instances may not exist in transitional deployments — the
      // advisory lock still serializes against concurrent advisory lock
      // holders, so we don't fail the action here.
    }
  }
  return locked;
}

/**
 * Full shared protocol: acquire advisory locks then row locks, in the
 * exact order the §6 transaction sequence requires. Callers invoke this
 * AFTER `BEGIN` and BEFORE reloading object state / building the plan.
 */
export async function acquireActionLocks(
  client: PoolClient,
  identities: LockIdentity[],
): Promise<{ advisoryLocked: number; rowLockedCount: number }> {
  await acquireAdvisoryLocks(client, identities);
  const rowLocked = await acquireRowLocks(client, identities);
  return {
    advisoryLocked: sortedLockIdentities(identities).length,
    rowLockedCount: rowLocked.length,
  };
}
