// Workshop migrations 058/059/060 — reversibility test (DoD).
//
// Per the brief: "DDL migrations are reversible; the down-migration is
// tested." For each migration, the test:
//   1. Applies up
//   2. Verifies the table exists
//   3. Applies down
//   4. Verifies the table no longer exists
//   5. Applies up again
//   6. Verifies the table is back

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  openTestSchema,
  type SchemaContext,
} from "../code-repos/_helpers/pg";

let ctx: SchemaContext | null = null;
let pgAvailable = true;

beforeAll(async () => {
  try {
    ctx = await openTestSchema("workshop_migrations");
  } catch (err) {
    pgAvailable = false;
    // eslint-disable-next-line no-console
    console.warn(
      `[migrations] Postgres unavailable; tests skipped: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
});

afterAll(async () => {
  if (ctx) await ctx.close();
});

const itp = (...args: Parameters<typeof it>) =>
  pgAvailable ? it(...args) : it.skip(...args);

async function tableExists(
  schema: string,
  table: string,
): Promise<boolean> {
  const r = await ctx!.pool.query(
    `SELECT 1
       FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = $2`,
    [schema, table],
  );
  return r.rowCount === 1;
}

describe("Workshop migrations — down/up reversibility", () => {
  itp("058 workshop_module: up creates, down drops, up recreates", async () => {
    await ctx!.applyMigration("src/migrations/058_b1_workshop_module.sql");
    expect(await tableExists(ctx!.schema, "workshop_module")).toBe(true);

    await ctx!.applyMigration("src/migrations/058_b1_workshop_module.down.sql");
    expect(await tableExists(ctx!.schema, "workshop_module")).toBe(false);

    await ctx!.applyMigration("src/migrations/058_b1_workshop_module.sql");
    expect(await tableExists(ctx!.schema, "workshop_module")).toBe(true);
  });

  itp(
    "059 workshop_idempotency_record: up creates, down drops, up recreates",
    async () => {
      await ctx!.applyMigration(
        "src/migrations/059_b1_workshop_idempotency.sql",
      );
      expect(
        await tableExists(ctx!.schema, "workshop_idempotency_record"),
      ).toBe(true);

      await ctx!.applyMigration(
        "src/migrations/059_b1_workshop_idempotency.down.sql",
      );
      expect(
        await tableExists(ctx!.schema, "workshop_idempotency_record"),
      ).toBe(false);

      await ctx!.applyMigration(
        "src/migrations/059_b1_workshop_idempotency.sql",
      );
      expect(
        await tableExists(ctx!.schema, "workshop_idempotency_record"),
      ).toBe(true);
    },
  );

  itp(
    "060 workshop_module_version: up creates, down drops, up recreates",
    async () => {
      await ctx!.applyMigration(
        "src/migrations/060_b3_workshop_module_version.sql",
      );
      expect(
        await tableExists(ctx!.schema, "workshop_module_version"),
      ).toBe(true);

      await ctx!.applyMigration(
        "src/migrations/060_b3_workshop_module_version.down.sql",
      );
      expect(
        await tableExists(ctx!.schema, "workshop_module_version"),
      ).toBe(false);

      await ctx!.applyMigration(
        "src/migrations/060_b3_workshop_module_version.sql",
      );
      expect(
        await tableExists(ctx!.schema, "workshop_module_version"),
      ).toBe(true);
    },
  );
});
