import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { FunnelOrchestrator } from "../../../src/services/funnel/b9FunnelOrchestrator";

const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
const orch = new FunnelOrchestrator(pool);
const tag = `b9-07-${randomUUID()}`;
const otRid = `ri.ontology.main.object-type.${tag}`;
const onto = 'ri.ontology.main.ontology.default';

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  await pool.query(`DELETE FROM funnel_b9_state WHERE object_type_rid = $1`, [otRid]);
  await pool.end();
});

describe("B9.07 — funnel orchestrator", () => {
  it("runs all 4 phases and flips back to IDLE", async () => {
    const r = await orch.run({
      objectTypeRid: otRid, ontologyRid: onto, indexName: 'test-objects',
      loadChanges: async () => [
        { primaryKey: 'a', operation: 'UPSERT', version: 1, payload: { x: 1 } },
        { primaryKey: 'b', operation: 'UPSERT', version: 2 },
      ],
      bulkFn: async (a) => ({ took: 1, errors: false, itemCount: a.length }),
      applyFn: async () => {},
    });
    expect(r.phase).toBe('IDLE');
    expect(r.indexed).toBe(2);
    expect(r.hydrated.upserts).toBe(2);
    expect(r.advancedTo).toBe(2);
  });

  it("on bulk failure → phase=ERROR, last_error captured", async () => {
    const r = await orch.run({
      objectTypeRid: otRid, ontologyRid: onto, indexName: 'test-objects',
      loadChanges: async () => [{ primaryKey: 'a', operation: 'UPSERT', version: 5 }],
      bulkFn: async () => { throw new Error('bulk failed!'); },
      applyFn: async () => {},
    });
    expect(r.phase).toBe('ERROR');
    expect(r.error).toContain('bulk failed!');
    const { rows } = await pool.query<{ phase: string; last_error: string }>(`SELECT phase, last_error FROM funnel_b9_state WHERE object_type_rid = $1`, [otRid]);
    expect(rows[0].phase).toBe('ERROR');
    expect(rows[0].last_error).toContain('bulk failed!');
  });

  it("subsequent successful run clears error", async () => {
    const r = await orch.run({
      objectTypeRid: otRid, ontologyRid: onto, indexName: 'test-objects',
      loadChanges: async () => [],
      bulkFn: async (a) => ({ took: 0, errors: false, itemCount: a.length }),
      applyFn: async () => {},
    });
    expect(r.phase).toBe('IDLE');
    const { rows } = await pool.query<{ phase: string; last_error: string | null }>(`SELECT phase, last_error FROM funnel_b9_state WHERE object_type_rid = $1`, [otRid]);
    expect(rows[0].phase).toBe('IDLE');
    expect(rows[0].last_error).toBeNull();
  });
});
