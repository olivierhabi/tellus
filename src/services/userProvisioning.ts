/**
 * userProvisioning.ts
 * -------------------
 * Translates Keycloak identities into local `users` rows.
 *
 * Tellus's domain tables (projects.owner_id, project_members.user_id,
 * personal_access_tokens.user_id, …) are all keyed on the local
 * `users.id` UUID. Keycloak tokens only carry the Keycloak `sub`
 * UUID, which is a different value. Anything that needs to enforce
 * ownership or membership against a Keycloak-authenticated request
 * must first map `claims` → a local `users.id`.
 *
 * The mapping is done by email (the stable identity Keycloak shares
 * with the tellus realm). If no local row exists for the user yet,
 * a shadow row is inserted on first sight so downstream foreign keys
 * keep working without a separate sync job.
 *
 * `users.display_name` is a cache of the Keycloak profile name. It is
 * seeded from the `name`/`given_name`/`family_name` claims on insert and
 * lazily re-synced on subsequent authentications (see `nameFromClaims` +
 * the update branch below) so project-member rosters show a human name,
 * not an email, without a separate backfill job. `scripts/backfill-user-
 * display-names.ts` does a one-shot immediate backfill for deploy.
 */

import crypto from 'crypto';
import { Knex } from 'knex';
import { TellusClaims } from './tellusAuthService';

/**
 * Compose a human display name from the Keycloak profile claims,
 * preferring `name` then `given_name + family_name`. Returns '' when
 * the token carries no profile claims (PAT principals, realms without
 * the default `profile` client scope) — callers fall back to
 * `preferred_username`/`email` for those.
 *
 * Mirrors the FE `tokenInfoToUser` composition so the local
 * `users.display_name` cache and the FE greeting agree.
 */
export function nameFromClaims(claims: TellusClaims): string {
  const composed =
    claims.name?.trim() ||
    (claims.given_name || claims.family_name
      ? [claims.given_name, claims.family_name].filter(Boolean).join(' ').trim()
      : '') ||
    undefined;
  return composed ?? '';
}

export async function ensureLocalUserForClaims(
  knex: Knex,
  claims: TellusClaims,
): Promise<string> {
  const email = (
    claims.email ||
    claims.preferred_username ||
    `${claims.sub}@tellus.local`
  ).toLowerCase();

  const nameFromIdp = nameFromClaims(claims);

  const existing = await knex('users').where({ email }).first();
  if (existing) {
    // Lazy backfill + sync: if the IdP now carries a human name that
    // differs from the cached display_name (the row was seeded from
    // preferred_username/email before name-claim provisioning shipped,
    // or the user edited their Keycloak profile), refresh the cache so
    // project-member rosters show a name, not an email. Only a real
    // (non-empty) IdP name triggers an update — never overwrite a cached
    // value with an email-shaped fallback. Idempotent: after the first
    // sync the comparison is a no-op, so this stays cheap on the
    // per-request middleware path. (users.updated_at is auto-maintained
    // by the trg_users_updated_at BEFORE UPDATE trigger.)
    if (nameFromIdp && nameFromIdp !== existing.display_name) {
      await knex('users')
        .where({ id: existing.id })
        .update({ display_name: nameFromIdp });
    }
    return existing.id;
  }

  const [row] = await knex('users')
    .insert({
      email,
      password_hash: crypto.randomBytes(32).toString('hex'),
      display_name: nameFromIdp || claims.preferred_username || email,
    })
    .returning(['id']);
  return row.id;
}
