// ---------------------------------------------------------------------------
// Indexing close-out — migration ledger + reversibility (checklist 1.10).
//
// Against the live CI Postgres (the same database the app booted and
// migrated):
//   1. the ledger records every close-out migration (192–195) as applied;
//   2. each forward migration is idempotent (re-applying is a no-op);
//   3. each .down.sql really reverses its forward migration, is itself
//      idempotent, and the forward migration re-applies cleanly afterwards.
//
// Steps 2–3 run on ONE dedicated client inside BEGIN … ROLLBACK, so the
// shared database is never left altered — Postgres DDL is transactional.
// ---------------------------------------------------------------------------

import { LANE } from "../../laneEnv";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

void LANE;

const MIGRATIONS_DIR = path.resolve(process.cwd(), "src/migrations");

interface CloseoutMigration {
  name: string;
  present: (c: Client) => Promise<boolean>;
}

type Client = Pick<import("pg").PoolClient, "query">;

async function columnExists(c: Client, table: string, column: string): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return r.rows.length === 1;
}

async function tableExists(c: Client, table: string): Promise<boolean> {
  const r = await c.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [table]);
  return r.rows[0]?.ok === true;
}

async function indexExists(c: Client, index: string): Promise<boolean> {
  return tableExists(c, index);
}

const MIGRATIONS: CloseoutMigration[] = [
  {
    name: "192_indexing_last_progress",
    present: async (c) =>
      (await columnExists(c, "funnel_state", "last_progress_at")) &&
      (await indexExists(c, "idx_funnel_state_progress_watch")),
  },
  {
    name: "193_merge_bucket_checkpoints",
    present: (c) => tableExists(c, "funnel_merge_bucket"),
  },
  {
    name: "194_indexing_lease_heartbeat",
    present: async (c) =>
      (await columnExists(c, "funnel_state", "lease_heartbeat_at")) &&
      (await indexExists(c, "idx_funnel_state_lease_watch")),
  },
  {
    name: "195_merge_staging_instances",
    present: async (c) =>
      (await tableExists(c, "merge_staging_instances")) &&
      (await indexExists(c, "idx_merge_staging_instances_owner")),
  },
];

function readSql(file: string): string {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
}

let db: typeof import("../../../src/db");

beforeAll(async () => {
  db = await import("../../../src/db");
});

describe("indexing close-out migrations (192–195)", () => {
  it("every close-out migration has forward + down SQL on disk", () => {
    for (const m of MIGRATIONS) {
      expect(fs.existsSync(path.join(MIGRATIONS_DIR, `${m.name}.sql`)), `${m.name}.sql`).toBe(true);
      expect(fs.existsSync(path.join(MIGRATIONS_DIR, `${m.name}.down.sql`)), `${m.name}.down.sql`).toBe(true);
    }
  });

  it("the ledger records every close-out migration as applied", async () => {
    const r = await db.query(
      `SELECT migration_name FROM schema_migrations_applied WHERE migration_name = ANY($1::text[])`,
      [MIGRATIONS.map((m) => `${m.name}.sql`)],
    );
    const applied = new Set(r.rows.map((x: { migration_name: string }) => x.migration_name));
    for (const m of MIGRATIONS) {
      expect(applied.has(`${m.name}.sql`), `ledger missing ${m.name}.sql`).toBe(true);
    }
  });

  it("forward is idempotent; down reverses (idempotently); forward re-applies — all rolled back", { timeout: 120_000 }, async () => {
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '20s'");

      // Live schema must already carry every object.
      for (const m of MIGRATIONS) {
        expect(await m.present(client), `${m.name} objects present before test`).toBe(true);
      }
      // Forward re-apply is a no-op (IF NOT EXISTS everywhere).
      for (const m of MIGRATIONS) {
        await client.query(readSql(`${m.name}.sql`));
        expect(await m.present(client), `${m.name} present after forward re-apply`).toBe(true);
      }
      // Down in reverse order; each must remove its objects, twice safely.
      for (const m of [...MIGRATIONS].reverse()) {
        await client.query(readSql(`${m.name}.down.sql`));
        expect(await m.present(client), `${m.name} removed by down`).toBe(false);
        await client.query(readSql(`${m.name}.down.sql`));
        expect(await m.present(client), `${m.name} still removed after second down`).toBe(false);
      }
      // Forward again from the reversed state.
      for (const m of MIGRATIONS) {
        await client.query(readSql(`${m.name}.sql`));
        expect(await m.present(client), `${m.name} present after re-apply`).toBe(true);
      }
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
    // Shared schema untouched by the rolled-back exercise.
    const check = await db.pool.connect();
    try {
      for (const m of MIGRATIONS) {
        expect(await m.present(check), `${m.name} present after ROLLBACK`).toBe(true);
      }
    } finally {
      check.release();
    }
  });
});
