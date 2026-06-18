// ---------------------------------------------------------------------------
// Code Repositories — Idempotency-Key contract
//
// Spec: tasks/code-repository/code-repository-tasks.md §1.4 (line 79).
// Contract IDs:
//   G-C-20  Every mutating POST requires Idempotency-Key (UUIDv4)
//   G-C-21  Server stores (idempotency_key, request_hash) for ≥ 24h
//   G-C-22  Replay same key + same hash → byte-identical original response
//   G-C-23  Replay same key + different hash → 409 + IdempotencyConflict
//
// This file provides ONLY the pure pieces:
//   - Idempotency key validator (UUIDv4)
//   - Canonical request hashing (deterministic JSON + SHA-256)
//   - Replay decision: NEW | REPLAY | CONFLICT
//
// The store interface (Postgres-backed) lives separately in
// `services/codeRepos/idempotencyStore.ts` (added in Wave 2 when B2 needs it).
// ---------------------------------------------------------------------------

import { createHash } from "crypto";
import { canonicalJson } from "../../audit/canonicalJson";
import { UUIDV4_REGEX } from "./rid";

export const IDEMPOTENCY_KEY_TTL_SECONDS = 24 * 60 * 60; // G-C-21 (≥ 24h)

export function isValidIdempotencyKey(key: string): boolean {
  return typeof key === "string" && UUIDV4_REGEX.test(key);
}

/**
 * Hash a request body deterministically. Inputs:
 *   - body: parsed JSON value (any plain JSON-able object)
 *   - method, path: kept in the hash so the same key replayed against a
 *     different endpoint cannot satisfy the replay invariant.
 *
 * Implementation: canonical-JSON (sorted keys, deterministic numbers) + SHA-256.
 *
 * The canonical JSON encoder is shared with the audit-log path so the same
 * deterministic bytes drive both audit hashes (G-C-54) and idempotency
 * comparisons (G-C-22). One source of truth, one set of bugs.
 */
export function hashRequest(args: {
  method: string;
  path: string;
  body: unknown;
}): string {
  const payload = canonicalJson({
    method: args.method.toUpperCase(),
    path: args.path,
    body: args.body ?? null,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export type ReplayDecision =
  | { readonly kind: "new" }
  | { readonly kind: "replay"; readonly storedResponseId: string }
  | { readonly kind: "conflict" };

/**
 * Pure replay decision: given a previously-stored hash for the same key
 * and the current request hash, what should the route do?
 *
 *   - storedHash === undefined  → kind:"new"   — first time we've seen this key
 *   - storedHash === incoming   → kind:"replay" — return the original response
 *   - storedHash !== incoming   → kind:"conflict" — 409 IdempotencyConflict
 */
export function decideReplay(
  storedHash: string | undefined,
  storedResponseId: string | undefined,
  incomingHash: string
): ReplayDecision {
  if (storedHash === undefined) return { kind: "new" };
  if (storedHash === incomingHash) {
    if (!storedResponseId) {
      throw new Error(
        "Idempotency store invariant violated: hash present without response id"
      );
    }
    return { kind: "replay", storedResponseId };
  }
  return { kind: "conflict" };
}
