// scripts/backfill-user-display-names.ts
// ---------------------------------------------------------------
// One-shot ops backfill: refresh local `users.display_name` from the
// Keycloak profile (firstName + lastName). Run once on deploy so
// project-member rosters (memberService selects users.display_name) show
// names immediately, instead of waiting for each user to re-authenticate
// (the lazy sync in ensureLocalUserForClaims handles ongoing updates after
// a user's next login; this script is for the existing rows right now).
//
// Safe to re-run: only updates a row when the IdP carries a non-empty name
// that differs from the cached value. Leaves rows whose Keycloak profile has
// no name (PAT/service accounts) untouched.
//
// Usage:
//   npx tsx scripts/backfill-user-display-names.ts
//
// Reads PG* + KEYCLOAK_* env (same defaults as the app).
import knexLib from 'knex';
import { getKeycloakAdminService } from '../src/services/keycloakAdminService';

function composeName(u: { firstName: string | null; lastName: string | null }): string {
  return [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
}

async function main(): Promise<void> {
  const knex = knexLib({
    client: 'pg',
    connection: {
      host: process.env.PGHOST || 'localhost',
      port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER || 'tellus',
      password: process.env.PGPASSWORD || 'tellus123',
      database: process.env.PGDATABASE || 'tellus_db',
    },
  });
  const admin = getKeycloakAdminService();

  // Page through every Keycloak user (briefRepresentation still carries
  // firstName/lastName) and build an email -> name map for users that
  // actually have a profile name set.
  const emailToName = new Map<string, string>();
  let first = 0;
  const pageSize = 100;
  let totalKc = 0;
  for (;;) {
    const page = await admin.listUsers({ first, max: pageSize });
    if (page.length === 0) break;
    totalKc += page.length;
    for (const u of page) {
      const name = composeName(u);
      const email = (u.email ?? u.username)?.toLowerCase();
      if (name && email) emailToName.set(email, name);
    }
    if (page.length < pageSize) break;
    first += pageSize;
  }
  console.log(`[kc] ${totalKc} users fetched; ${emailToName.size} with a real name.`);

  const locals: Array<{ id: string; email: string; display_name: string }> = await knex('users')
    .select('id', 'email', 'display_name');
  let updated = 0;
  let skipped = 0;
  for (const row of locals) {
    const name = emailToName.get(row.email.toLowerCase());
    if (!name) {
      skipped++;
      continue;
    }
    if (name === row.display_name) continue;
    await knex('users').where({ id: row.id }).update({ display_name: name });
    updated++;
    console.log(`  ${row.email}: "${row.display_name}" -> "${name}"`);
  }
  console.log(
    `[done] ${updated}/${locals.length} rows updated; ${skipped} had no Keycloak name (left untouched).`,
  );
  await knex.destroy();
}

main().catch((e) => {
  console.error('FAIL:', e instanceof Error ? e.message : e);
  process.exit(1);
});
