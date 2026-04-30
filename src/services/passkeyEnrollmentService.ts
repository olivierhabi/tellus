/**
 * passkeyEnrollmentService.ts
 * ---------------------------
 * Owns the "mandatory passkey enrollment" handshake that sits between
 * a successful password login and the issuance of a real tellus
 * session. Mandatory enrollment is enforced when a user authenticates
 * with email+password but has no active WebAuthn credential on file —
 * we cannot hand them cookies because the security policy requires
 * every interactive session to be protected by a possession factor.
 *
 * Flow:
 *
 *   1. /api/v1/auth/login verifies the password via KC direct-grant.
 *   2. If the user has zero active WebAuthn credentials:
 *        a. We STASH the live KC access+refresh tokens in a
 *           passkey_enrollment_tokens row, keyed by a sha-256 hash
 *           of a fresh random bearer token (`tellus_enroll_*`).
 *        b. We return that bearer token to the caller in the JSON
 *           body — NO session cookies are set.
 *        c. The caller is expected to immediately run the WebAuthn
 *           registration ceremony against /enroll/passkey/options
 *           and /enroll/passkey/verify, authenticating those two
 *           calls with the enrollment bearer token.
 *        d. On a successful verify we look up the stashed tokens,
 *           set them as session cookies, mark the enrollment row
 *           consumed, and return the session JSON the caller would
 *           have seen from /login on the passkey-present path.
 *   3. If the enrollment row expires (default 10 min) or the
 *      caller tries to reuse a consumed token, we 401 and the
 *      caller restarts from /login.
 *
 * The bearer token is intentionally a separate token *type* from
 * JWTs, cookies, PATs, and reauth tokens. It:
 *   - has its own prefix (`tellus_enroll_`) so it can't be confused
 *     for anything else at the middleware layer
 *   - is NOT accepted by requireTellusAuth() or patSecurityGate
 *     (the enroll/* endpoints look it up directly)
 *   - is sha-256 hashed at rest so a DB leak doesn't leak live tokens
 *   - is single-use — consumption marks the row and the same hash
 *     cannot be resolved twice
 *
 * Recovery path: if an enrolled passkey is lost, the only recovery
 * is an admin-driven reset (delete the last credential row, which
 * pushes the user back into enrollment on next login). This is
 * intentional — the whole point of mandatory passkey is that a
 * password alone is never sufficient.
 */

import crypto from 'crypto';
import type { Knex } from 'knex';
import { AppError } from '../utils/foundryAppError';

const TOKEN_PREFIX = 'tellus_enroll_';
const DEFAULT_TTL_SECONDS = 10 * 60;

export interface EnrollmentTokenIssueResult {
  token: string;
  expiresAt: Date;
  id: string;
}

export interface ResolvedEnrollmentToken {
  id: string;
  keycloakSub: string;
  email: string | null;
  stashedAccessToken: string;
  stashedRefreshToken: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
}

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function randomBody(): string {
  // 32 bytes = 256 bits of entropy. base64url so it's URL-safe and
  // fits in an Authorization header without escaping.
  return crypto.randomBytes(32).toString('base64url');
}

export class PasskeyEnrollmentService {
  constructor(private readonly knex: Knex) {}

  /**
   * True iff the user currently has at least one ACTIVE WebAuthn
   * credential row. Used by /login to decide whether to gate the
   * caller into the enrollment flow.
   */
  async userHasActivePasskey(keycloakSub: string): Promise<boolean> {
    const row = await this.knex('user_webauthn_credentials')
      .where({ keycloak_sub: keycloakSub })
      .count<{ count: string }>('* as count')
      .first();
    return Number(row?.count ?? 0) > 0;
  }

  /**
   * Mint a short-lived enrollment token and stash the caller's
   * live KC tokens alongside it. The raw token is returned to the
   * caller exactly once; only its sha-256 hash is persisted.
   */
  async issueEnrollmentToken(opts: {
    keycloakSub: string;
    email: string | null;
    accessToken: string;
    refreshToken: string | null;
    ttlSeconds?: number;
  }): Promise<EnrollmentTokenIssueResult> {
    const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const raw = `${TOKEN_PREFIX}${randomBody()}`;
    const hash = hashToken(raw);
    const expiresAt = new Date(Date.now() + ttl * 1000);

    // Aggressively prune any stale enrollment rows for the same user
    // before inserting. This keeps the table small and prevents a
    // user who kept retrying from hoarding multiple live tokens.
    await this.knex('passkey_enrollment_tokens')
      .where({ keycloak_sub: opts.keycloakSub })
      .andWhere((qb) => {
        qb.where('expires_at', '<', new Date()).orWhereNotNull('consumed_at');
      })
      .delete();

    const [row] = await this.knex('passkey_enrollment_tokens')
      .insert({
        keycloak_sub: opts.keycloakSub,
        email: opts.email,
        token_hash: hash,
        stashed_access: opts.accessToken,
        stashed_refresh: opts.refreshToken,
        expires_at: expiresAt,
      })
      .returning<{ id: string }[]>('id');

    return { token: raw, expiresAt, id: row.id };
  }

  /**
   * Look up an enrollment token by its raw value. Rejects with a
   * spec-shaped AppError if the token is missing, expired, or has
   * already been consumed. Does NOT mark the row consumed — callers
   * must invoke consume() themselves on the happy path so the row
   * survives across options/verify round-trips.
   */
  async resolveEnrollmentToken(raw: string): Promise<ResolvedEnrollmentToken> {
    if (!raw || !raw.startsWith(TOKEN_PREFIX)) {
      throw new AppError(
        'Enrollment token missing or malformed',
        401,
        'ENROLLMENT_TOKEN_INVALID',
      );
    }
    const hash = hashToken(raw);
    const row = await this.knex('passkey_enrollment_tokens')
      .where({ token_hash: hash })
      .first<{
        id: string;
        keycloak_sub: string;
        email: string | null;
        stashed_access: string;
        stashed_refresh: string | null;
        expires_at: Date;
        consumed_at: Date | null;
      }>();
    if (!row) {
      throw new AppError('Enrollment token unknown', 401, 'ENROLLMENT_TOKEN_INVALID');
    }
    if (row.consumed_at) {
      throw new AppError(
        'Enrollment token already used',
        401,
        'ENROLLMENT_TOKEN_CONSUMED',
      );
    }
    const exp = new Date(row.expires_at).getTime();
    if (Number.isFinite(exp) && exp < Date.now()) {
      throw new AppError('Enrollment token expired', 401, 'ENROLLMENT_TOKEN_EXPIRED');
    }
    return {
      id: row.id,
      keycloakSub: row.keycloak_sub,
      email: row.email,
      stashedAccessToken: row.stashed_access,
      stashedRefreshToken: row.stashed_refresh,
      expiresAt: new Date(row.expires_at),
      consumedAt: row.consumed_at ? new Date(row.consumed_at) : null,
    };
  }

  /**
   * Mark the enrollment row consumed and scrub the stashed tokens.
   * Called from /enroll/passkey/verify after the WebAuthn ceremony
   * and credential insert have both succeeded. Idempotent: a second
   * call on the same id is a no-op that still returns true so the
   * caller can report success without caring about races.
   */
  async consumeEnrollmentToken(id: string): Promise<void> {
    await this.knex('passkey_enrollment_tokens')
      .where({ id })
      .whereNull('consumed_at')
      .update({
        consumed_at: new Date(),
        // Scrub the stashed tokens the moment we're done with them
        // so a later DB leak doesn't leak a live refresh token. We
        // can't drop the row entirely because the cleanup sweeper
        // keys on it to decide what to purge.
        stashed_access: '',
        stashed_refresh: null,
      });
  }

  /**
   * Invoked by the long-running sweeper (see server.ts). Drops any
   * consumed rows older than 1 hour AND any expired rows — the TTL
   * window on the happy path is 10 minutes, so a 1-hour floor is
   * plenty of grace for clock skew.
   */
  async purgeExpired(): Promise<number> {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    const n = await this.knex('passkey_enrollment_tokens')
      .where((qb) => {
        qb.where('expires_at', '<', new Date()).orWhere('consumed_at', '<', cutoff);
      })
      .delete();
    return n as unknown as number;
  }
}

let _singleton: PasskeyEnrollmentService | null = null;
export function getPasskeyEnrollmentService(knex: Knex): PasskeyEnrollmentService {
  if (!_singleton) _singleton = new PasskeyEnrollmentService(knex);
  return _singleton;
}

export { TOKEN_PREFIX as PASSKEY_ENROLLMENT_TOKEN_PREFIX };
