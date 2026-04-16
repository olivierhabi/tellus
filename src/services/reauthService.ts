/**
 * reauthService.ts
 * ----------------
 * Short-lived reauthentication tokens for gating sensitive operations.
 *
 * Flow:
 *   1. Client POSTs {password} to /api/v1/auth/me/reauth. Backend
 *      verifies the password via Keycloak direct grant (same path as
 *      /login step 1).
 *   2. On success the backend mints a 32-byte random reauth token,
 *      stores its sha-256 hash + the user's keycloak_sub in
 *      user_reauth_tokens with a 5-minute TTL, and returns the raw
 *      token to the client.
 *   3. Client passes the raw token in the X-Tellus-Reauth header of
 *      any subsequent sensitive request (disable TOTP, delete passkey,
 *      revoke PAT from /settings/tokens). The backend middleware
 *      requireFreshReauth() looks the hash up and refuses if expired
 *      or not owned by the caller.
 *
 * Keeping tokens in Postgres (not an in-memory map) means they survive
 * process restarts during the 5-minute window and let a horizontally-
 * scaled backend share them. The hash-only storage guarantees an admin
 * with read access to the table can't forge an existing session.
 */

import crypto from 'crypto';
import type { Knex } from 'knex';
import foundryDb from '../config/foundryDb';
import { AppError } from '../utils/foundryAppError';

const REAUTH_TTL_MS = 5 * 60 * 1000;

/** Budget: 10 wrong-password attempts per rolling 15-minute window. */
export const REAUTH_BUDGET_FAILURES = 10;
export const REAUTH_BUDGET_WINDOW_MS = 15 * 60 * 1000;

function hash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Mint a fresh reauth token for the given sub, return the raw value. */
export async function issueReauthToken(keycloakSub: string): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + REAUTH_TTL_MS);
  await (foundryDb as unknown as Knex)('user_reauth_tokens').insert({
    token_hash: hash(token),
    keycloak_sub: keycloakSub,
    expires_at: expiresAt,
  });
  return { token, expiresAt };
}

/** Validate a reauth token and return the owning sub. */
export async function consumeReauthToken(
  token: string,
  keycloakSub: string,
): Promise<void> {
  if (!token) {
    throw new AppError('Reauthentication required for this operation', 401, 'REAUTH_REQUIRED');
  }
  const knex = foundryDb as unknown as Knex;
  const row = await knex('user_reauth_tokens').where({ token_hash: hash(token) }).first();
  if (!row) {
    throw new AppError('Reauthentication token invalid', 401, 'REAUTH_INVALID');
  }
  if (row.keycloak_sub !== keycloakSub) {
    throw new AppError('Reauthentication token owned by a different user', 403, 'REAUTH_OWNER_MISMATCH');
  }
  if (new Date(row.expires_at) < new Date()) {
    await knex('user_reauth_tokens').where({ token_hash: hash(token) }).delete();
    throw new AppError('Reauthentication token expired — please re-enter your password', 401, 'REAUTH_EXPIRED');
  }
  // We intentionally leave the row in place for the full 5-minute
  // window so a FE that batches multiple sensitive actions can reuse
  // the same prompt answer. The purge sweeper cleans up expired rows.
}

/** Delete expired reauth rows — called from the auth challenge sweeper. */
export async function purgeExpiredReauthTokens(): Promise<number> {
  return (foundryDb as unknown as Knex)('user_reauth_tokens')
    .where('expires_at', '<', new Date())
    .delete();
}

/**
 * Per-user sliding-window rate limit for /me/reauth. Mirrors the MFA
 * budget helpers in totpService.ts — increments on failure, resets
 * when the window slides past, returns {blocked, retryAt} so the
 * caller can 429 with a useful Retry-After.
 */
export async function isReauthBudgetExhausted(
  keycloakSub: string,
): Promise<{ blocked: boolean; retryAt: Date | null }> {
  const knex = foundryDb as unknown as Knex;
  const row = await knex('reauth_attempt_budget').where({ keycloak_sub: keycloakSub }).first();
  if (!row) return { blocked: false, retryAt: null };
  const windowStart = new Date(row.window_start);
  if (Date.now() - windowStart.getTime() >= REAUTH_BUDGET_WINDOW_MS) {
    return { blocked: false, retryAt: null };
  }
  if (Number(row.failed_count ?? 0) > REAUTH_BUDGET_FAILURES) {
    return { blocked: true, retryAt: new Date(windowStart.getTime() + REAUTH_BUDGET_WINDOW_MS) };
  }
  return { blocked: false, retryAt: null };
}

export async function registerReauthFailure(
  keycloakSub: string,
): Promise<{ blocked: boolean; retryAt: Date | null }> {
  const knex = foundryDb as unknown as Knex;
  return knex.transaction(async (trx) => {
    const row = await trx('reauth_attempt_budget')
      .where({ keycloak_sub: keycloakSub })
      .forUpdate()
      .first();
    const now = new Date();
    if (!row) {
      await trx('reauth_attempt_budget').insert({
        keycloak_sub: keycloakSub,
        window_start: now,
        failed_count: 1,
      });
      return { blocked: false, retryAt: null };
    }
    const windowStart = new Date(row.window_start);
    if (now.getTime() - windowStart.getTime() >= REAUTH_BUDGET_WINDOW_MS) {
      await trx('reauth_attempt_budget').where({ keycloak_sub: keycloakSub }).update({
        window_start: now,
        failed_count: 1,
      });
      return { blocked: false, retryAt: null };
    }
    const nextCount = Number(row.failed_count ?? 0) + 1;
    await trx('reauth_attempt_budget').where({ keycloak_sub: keycloakSub }).update({ failed_count: nextCount });
    if (nextCount > REAUTH_BUDGET_FAILURES) {
      return { blocked: true, retryAt: new Date(windowStart.getTime() + REAUTH_BUDGET_WINDOW_MS) };
    }
    return { blocked: false, retryAt: null };
  });
}

export async function resetReauthBudget(keycloakSub: string): Promise<void> {
  await (foundryDb as unknown as Knex)('reauth_attempt_budget')
    .where({ keycloak_sub: keycloakSub })
    .delete();
}
