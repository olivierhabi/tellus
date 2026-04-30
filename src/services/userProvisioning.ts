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
 */

import crypto from 'crypto';
import { Knex } from 'knex';
import { TellusClaims } from './tellusAuthService';

export async function ensureLocalUserForClaims(
  knex: Knex,
  claims: TellusClaims,
): Promise<string> {
  const email = (
    claims.email ||
    claims.preferred_username ||
    `${claims.sub}@tellus.local`
  ).toLowerCase();

  const existing = await knex('users').where({ email }).first();
  if (existing) return existing.id;

  const [row] = await knex('users')
    .insert({
      email,
      password_hash: crypto.randomBytes(32).toString('hex'),
      display_name: claims.preferred_username || email,
    })
    .returning(['id']);
  return row.id;
}
