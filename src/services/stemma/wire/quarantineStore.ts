// ---------------------------------------------------------------------------
// B1 — packfile quarantine store.
//
// On every accepted receive-pack push, the inbound packfile is hashed
// and a quarantine row is inserted to track the push lifecycle. The
// quarantine row is the audit trail for the push intent; it is
// promoted on accept and marked rejected on CAS failure. Packfile
// bytes themselves go to `stemma_packfile` (handled elsewhere; v1
// stores the sha256 fingerprint as an audit parameter only).
//
// State machine (matches 050_stemma_ddl.sql):
//   OPEN      — push intent received; refs not yet applied
//   PROMOTED  — refs applied successfully (alias: "accepted" in routes)
//   REJECTED  — refs CAS rejected
//   EXPIRED   — gc'd after 5 minutes of OPEN
//
// Spec contracts:
//   B1-C-23  packfile sha256 fingerprint persisted (audit param)
//   B1-C-24  quarantine entry per accepted push
// ---------------------------------------------------------------------------

import type { PoolClient } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { UUIDV4_REGEX } from "../../codeRepos/contracts/rid";

export type QuarantineState = "OPEN" | "PROMOTED" | "REJECTED" | "EXPIRED";

/** State alias accepted by the route layer (mapped to 050's terminology). */
export type RouteQuarantineState = "accepted" | "rejected";

export interface QuarantineEntry {
  readonly id: string;
  readonly repositoryRid: string;
  readonly principalSub: string;
  readonly state: QuarantineState;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/** Compute the sha256 of a packfile body in lowercase hex. B1-C-23. */
export function fingerprintPackfile(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * Resolve a UUID for the `principal_sub` column from a Code Repos
 * principal userId. Production keycloakSub IS a UUID; test-mode
 * principals (`alice`, `bob`) are not. We synthesise a fresh UUID per
 * non-UUID userId rather than mutate the column to nullable, since
 * 050 made it NOT NULL. The real principal_user_id is preserved on
 * the audit row.
 */
export function principalSubFor(userId: string): string {
  if (UUIDV4_REGEX.test(userId)) return userId;
  return randomUUID();
}

/** TTL for an OPEN quarantine row before gc. Mirrors 050's design. */
const QUARANTINE_TTL_MINUTES = 5;

/**
 * Insert a quarantine row in the `OPEN` state. Returns the row's id
 * so the caller can later transition it to `PROMOTED`/`REJECTED` once
 * the ref CAS resolves.
 */
export async function createQuarantineEntryWithinTx(
  client: PoolClient,
  args: {
    repositoryRid: string;
    principalUserId: string;
  },
): Promise<QuarantineEntry> {
  const id = randomUUID();
  const principalSub = principalSubFor(args.principalUserId);
  const expiresAt = new Date(Date.now() + QUARANTINE_TTL_MINUTES * 60 * 1000);
  const r = await client.query<{
    quarantine_id: string;
    repository_rid: string;
    principal_sub: string;
    state: QuarantineState;
    created_at: Date;
    expires_at: Date;
  }>(
    `INSERT INTO stemma_quarantine
       (quarantine_id, repository_rid, principal_sub, expires_at, state)
     VALUES ($1, $2, $3, $4, 'OPEN')
     RETURNING quarantine_id, repository_rid, principal_sub,
               state, created_at, expires_at`,
    [id, args.repositoryRid, principalSub, expiresAt.toISOString()],
  );
  const row = r.rows[0];
  return {
    id: row.quarantine_id,
    repositoryRid: row.repository_rid,
    principalSub: row.principal_sub,
    state: row.state,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/**
 * Transition a quarantine row from OPEN to PROMOTED (accepted) or
 * REJECTED. Maps the route-layer terminology to the DDL state names.
 */
export async function setQuarantineStateWithinTx(
  client: PoolClient,
  id: string,
  state: RouteQuarantineState,
): Promise<void> {
  const target: Exclude<QuarantineState, "OPEN" | "EXPIRED"> =
    state === "accepted" ? "PROMOTED" : "REJECTED";
  await client.query(
    `UPDATE stemma_quarantine
        SET state = $2
      WHERE quarantine_id = $1 AND state = 'OPEN'`,
    [id, target],
  );
}

/** Lookup by id (for tests + audit); returns null if not found. */
export async function getQuarantineEntry(
  client: PoolClient,
  id: string,
): Promise<QuarantineEntry | null> {
  const r = await client.query<{
    quarantine_id: string;
    repository_rid: string;
    principal_sub: string;
    state: QuarantineState;
    created_at: Date;
    expires_at: Date;
  }>(
    `SELECT quarantine_id, repository_rid, principal_sub,
            state, created_at, expires_at
       FROM stemma_quarantine
      WHERE quarantine_id = $1`,
    [id],
  );
  if (r.rowCount !== 1) return null;
  const row = r.rows[0];
  return {
    id: row.quarantine_id,
    repositoryRid: row.repository_rid,
    principalSub: row.principal_sub,
    state: row.state,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}
