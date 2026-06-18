// ---------------------------------------------------------------------------
// tests/integration/code-repos/migrations/052-b10-stemma-events-roundtrip-integration.test.ts
//
// B10 — DDL round-trip for migration 052_b10_stemma_events.sql.
// Mirrors the 050 round-trip test: apply UP, assert every table/CHECK/
// index/comment exists; apply DOWN, assert clean; re-apply UP to prove
// idempotent reversibility (DoD).
//
// Spec contracts touched:
//   B10-C-11  stemma_subscription registry — global + per-repo scope,
//             secret_encrypted, ACTIVE/SUSPENDED state, 5-failure cap.
//   B10-C-12  stemma_event append-only log — cursor-paginated.
//   B10-C-15  fan-out path uses (state, repository_rid) lookup index.
// ---------------------------------------------------------------------------

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "vitest";
import { openTestSchema, type SchemaContext } from "../_helpers/pg";

const VALID_RID =
  "ri.stemma-events.shared.event.test-aaaaaaaaaaaaaaaaaaaaaaaaa";
const VALID_REPO_RID =
  "ri.stemma.shared.repository.test-bbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const VALID_SUB_RID =
  "ri.stemma-events.shared.subscription.test-cccccccccccccccccccc";

describe("B10 — 052_b10_stemma_events up/down round-trip", () => {
  let ctx: SchemaContext;

  beforeAll(async () => {
    ctx = await openTestSchema("b10_ddl_roundtrip");
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  describe("after applying 052_b10_stemma_events.sql", () => {
    beforeAll(async () => {
      await ctx.applyMigration("src/migrations/052_b10_stemma_events.sql");
    });

    it("stemma_event table exists with rid PRIMARY KEY", async () => {
      const r = await ctx.query(`
        SELECT a.attname
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'stemma_event'::regclass AND i.indisprimary
      `);
      expect(r.rows.map((row) => (row as { attname: string }).attname)).toEqual([
        "rid",
      ]);
    });

    it("stemma_event.event_type CHECK accepts only the spec'd enum", async () => {
      // Allowed values land.
      for (const t of [
        "PUSH",
        "MERGE",
        "TAG",
        "PR_OPENED",
        "PR_MERGED",
        "PR_CLOSED",
        "BRANCH_CREATED",
        "BRANCH_DELETED",
      ]) {
        await ctx.query(
          `INSERT INTO stemma_event (rid, repository_rid, event_type) VALUES ($1, $2, $3)`,
          [`${VALID_RID}-${t.toLowerCase()}`, VALID_REPO_RID, t],
        );
      }
      // Disallowed value rejected.
      await expect(
        ctx.query(
          `INSERT INTO stemma_event (rid, repository_rid, event_type) VALUES ($1, $2, $3)`,
          [`${VALID_RID}-bogus`, VALID_REPO_RID, "BOGUS"],
        ),
      ).rejects.toThrow(/check constraint|stemma_event_event_type_check/i);
    });

    it("stemma_event.rid CHECK rejects malformed RIDs", async () => {
      await expect(
        ctx.query(
          `INSERT INTO stemma_event (rid, repository_rid, event_type) VALUES ($1, $2, 'PUSH')`,
          ["not-a-rid", VALID_REPO_RID],
        ),
      ).rejects.toThrow(/check constraint/i);
    });

    it("stemma_event SHA CHECKs reject non-40-hex values", async () => {
      await expect(
        ctx.query(
          `INSERT INTO stemma_event (rid, repository_rid, event_type, old_sha)
           VALUES ($1, $2, 'PUSH', $3)`,
          [`${VALID_RID}-shabad`, VALID_REPO_RID, "ZZZZ"],
        ),
      ).rejects.toThrow(/check constraint/i);
    });

    it("stemma_subscription table exists with required CHECKs", async () => {
      // event_types must be non-empty.
      await expect(
        ctx.query(
          `INSERT INTO stemma_subscription
             (rid, event_types, target_uri, secret_encrypted)
           VALUES ($1, ARRAY[]::text[], 'https://x', 'enc')`,
          [VALID_SUB_RID],
        ),
      ).rejects.toThrow(/check constraint|cardinality/i);

      // Valid insert lands.
      await ctx.query(
        `INSERT INTO stemma_subscription
           (rid, event_types, target_uri, secret_encrypted)
         VALUES ($1, ARRAY['PUSH','TAG'], 'https://example.test/hook', 'enc-stub')`,
        [`${VALID_SUB_RID}-1`],
      );
    });

    it("stemma_subscription.state CHECK rejects unknown values", async () => {
      await expect(
        ctx.query(
          `INSERT INTO stemma_subscription
             (rid, event_types, target_uri, secret_encrypted, state)
           VALUES ($1, ARRAY['PUSH'], 'https://x', 'enc', 'WAT')`,
          [`${VALID_SUB_RID}-bad-state`],
        ),
      ).rejects.toThrow(/check constraint/i);
    });

    it("indexes from migration are present", async () => {
      const r = await ctx.query(`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = $1
          AND tablename IN ('stemma_event','stemma_subscription')
        ORDER BY indexname
      `, [ctx.schema]);
      const names = r.rows.map((row) => (row as { indexname: string }).indexname);
      expect(names).toEqual(
        expect.arrayContaining([
          "stemma_event_repo_time_idx",
          "stemma_event_type_time_idx",
          "stemma_subscription_active_idx",
          "stemma_subscription_event_types_gin_idx",
        ]),
      );
    });

    it("partial index on subscription is filtered to ACTIVE only", async () => {
      const r = await ctx.query(`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = $1 AND indexname = 'stemma_subscription_active_idx'
      `, [ctx.schema]);
      expect((r.rows[0] as { indexdef: string }).indexdef).toMatch(
        /WHERE \(?state = 'ACTIVE'/i,
      );
    });
  });

  describe("after applying 052_b10_stemma_events.down.sql", () => {
    beforeAll(async () => {
      await ctx.applyMigration("src/migrations/052_b10_stemma_events.down.sql");
    });

    it("table stemma_event no longer exists", async () => {
      const r = await ctx.query(
        `SELECT to_regclass($1) AS x`,
        [`${ctx.schema}.stemma_event`],
      );
      expect((r.rows[0] as { x: string | null }).x).toBeNull();
    });

    it("table stemma_subscription no longer exists", async () => {
      const r = await ctx.query(
        `SELECT to_regclass($1) AS x`,
        [`${ctx.schema}.stemma_subscription`],
      );
      expect((r.rows[0] as { x: string | null }).x).toBeNull();
    });

    it("indexes from migration are gone", async () => {
      const r = await ctx.query(`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = $1
          AND indexname IN (
            'stemma_event_repo_time_idx','stemma_event_type_time_idx',
            'stemma_subscription_active_idx','stemma_subscription_event_types_gin_idx'
          )
      `, [ctx.schema]);
      expect(r.rowCount).toBe(0);
    });
  });

  describe("UP after DOWN succeeds (idempotent reversibility — DoD)", () => {
    it("re-applies the UP migration cleanly", async () => {
      await ctx.applyMigration("src/migrations/052_b10_stemma_events.sql");
      const r = await ctx.query(
        `SELECT to_regclass($1) AS x`,
        [`${ctx.schema}.stemma_event`],
      );
      expect((r.rows[0] as { x: string | null }).x).not.toBeNull();
    });
  });
});
