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
const tag = `final06_${randomUUID()}`;
const otRid = `ri.ontology.main.object-type.${tag}`;
const onto = 'ri.ontology.main.ontology.default';

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  await pool.query(`DELETE FROM funnel_b9_state WHERE object_type_rid = $1`, [otRid]);
  await pool.end();
});

describe("FINAL.06 — funnel orchestrator end-to-end", () => {
  it("first run advances offset and lands IDLE", async () => {
    let bulkCount = 0;
    let hydratorCount = 0;
    const r = await orch.run({
      objectTypeRid: otRid, ontologyRid: onto, indexName: 'test-idx',
      loadChanges: async () => [
        { primaryKey: 'a', operation: 'UPSERT', version: 1, payload: { x: 1 } },
        { primaryKey: 'b', operation: 'UPSERT', version: 2 },
        { primaryKey: 'c', operation: 'DELETE', version: 3 },
      ],
      bulkFn: async (a) => { bulkCount += a.length; return { took: 1, errors: false, itemCount: a.length }; },
      applyFn: async () => { hydratorCount++; },
    });
    expect(r.phase).toBe('IDLE');
    expect(r.indexed).toBe(3);
    expect(r.advancedTo).toBe(3);
    expect(bulkCount).toBe(3);
    expect(hydratorCount).toBe(3);
  });
  it("subsequent run with no new changes is a no-op", async () => {
    const r = await orch.run({
      objectTypeRid: otRid, ontologyRid: onto, indexName: 'test-idx',
      loadChanges: async () => [],
      bulkFn: async (a) => ({ took: 0, errors: false, itemCount: a.length }),
      applyFn: async () => {},
    });
    expect(r.phase).toBe('IDLE');
    expect(r.indexed).toBe(0);
    expect(r.advancedTo).toBe(3); // unchanged
  });
  it("error in bulk flips to ERROR + records last_error", async () => {
    const r = await orch.run({
      objectTypeRid: otRid, ontologyRid: onto, indexName: 'test-idx',
      loadChanges: async () => [{ primaryKey: 'd', operation: 'UPSERT', version: 99 }],
      bulkFn: async () => { throw new Error('cluster yellow'); },
      applyFn: async () => {},
    });
    expect(r.phase).toBe('ERROR');
    expect(r.error).toContain('cluster yellow');
  });
  it("recovery run after error flips back to IDLE + clears error", async () => {
    const r = await orch.run({
      objectTypeRid: otRid, ontologyRid: onto, indexName: 'test-idx',
      loadChanges: async () => [],
      bulkFn: async () => ({ took: 0, errors: false, itemCount: 0 }),
      applyFn: async () => {},
    });
    expect(r.phase).toBe('IDLE');
    const { rows } = await pool.query<{ phase: string; last_error: string | null }>(`SELECT phase, last_error FROM funnel_b9_state WHERE object_type_rid = $1`, [otRid]);
    expect(rows[0].phase).toBe('IDLE');
    expect(rows[0].last_error).toBeNull();
  });
});
