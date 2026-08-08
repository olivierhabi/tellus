// scripts/import-function-trusted-authors.ts
// ---------------------------------------------------------------
// One-shot migration: move the legacy FUNCTION_TRUSTED_AUTHOR_IDS env
// allowlist into the database-backed grant model (migration 164).
//
// For each id in the allowlist this creates a GLOBAL function_publish_grants
// row with granted_by="migration", no expiry, and reason recording the
// provenance. Ids already present as local `users.id` are classified as
// subject_type='local_user'; everything else is treated as a Keycloak sub
// (the two identities the authorizer matches).
//
// Safe to re-run: the (subject, scope) active-grant unique index makes the
// import idempotent — existing rows are skipped.
//
// Prerequisite: migration 164 applied (npm run migrate).
//
// Usage:
//   npx tsx scripts/import-function-trusted-authors.ts
//   FUNCTION_TRUSTED_AUTHOR_IDS="sub-1 sub-2" npx tsx scripts/import-function-trusted-authors.ts
//
// Reads PG* + FUNCTION_TRUSTED_AUTHOR_IDS env (same defaults as the app).

import { Pool } from "pg";

async function main(): Promise<void> {
  const raw = process.env.FUNCTION_TRUSTED_AUTHOR_IDS ?? "";
  const ids = raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (ids.length === 0) {
    console.log("FUNCTION_TRUSTED_AUTHOR_IDS is empty — nothing to import.");
    return;
  }

  const pool = new Pool({
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || "tellus",
    password: process.env.PGPASSWORD || "tellus123",
    database: process.env.PGDATABASE || "tellus_db",
  });

  try {
    // Distinguish local users.id entries from Keycloak subs.
    const { rows: locals } = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM users WHERE id::text = ANY($1::text[])`,
      [ids],
    );
    const localIds = new Set(locals.map((r) => r.id));

    let imported = 0;
    for (const id of ids) {
      const subjectType = localIds.has(id) ? "local_user" : "keycloak_sub";
      // ON CONFLICT on the partial unique index cannot target its COALESCE
      // expression, so guard with a SELECT first; the unique index remains
      // the race-safe backstop.
      const existing = await pool.query(
        `SELECT 1 FROM function_publish_grants
          WHERE revoked_at IS NULL
            AND subject_type = $1 AND subject_id = $2
            AND scope_type = 'global'`,
        [subjectType, id],
      );
      if ((existing.rowCount ?? 0) > 0) {
        console.log(`skip   ${id} (${subjectType}) — active grant already exists`);
        continue;
      }
      await pool.query(
        `INSERT INTO function_publish_grants
           (subject_type, subject_id, scope_type, scope_rid, granted_by, reason, expires_at)
         VALUES ($1, $2, 'global', NULL, 'migration', $3, NULL)`,
        [subjectType, id, "migrated from FUNCTION_TRUSTED_AUTHOR_IDS"],
      );
      console.log(`import ${id} (${subjectType})`);
      imported += 1;
    }
    console.log(
      `done: ${imported} imported, ${ids.length - imported} skipped (of ${ids.length}). ` +
        `Verify, then remove FUNCTION_TRUSTED_AUTHOR_IDS from the deployment env.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
