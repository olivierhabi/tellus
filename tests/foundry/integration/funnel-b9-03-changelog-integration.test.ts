import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { B9Changelog, Change } from "../../../src/services/funnel/b9Changelog";

const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
const phase = new B9Changelog(pool);
const tag = `b9-03-${randomUUID()}`;
const otRid = `ri.ontology.main.object-type.${tag}`;
const onto = 'ri.ontology.main.ontology.default';

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  await pool.query(`DELETE FROM funnel_b9_state WHERE object_type_rid = $1`, [otRid]);
  await pool.end();
});

describe("B9.03 — changelog phase", () => {
  it("first run loads from offset 0", async () => {
    const seenSince: number[] = [];
    const r = await phase.run({
      objectTypeRid: otRid, ontologyRid: onto,
      loadChanges: async (since) => {
        seenSince.push(since);
        const out: Change[] = [
          { primaryKey: 'a', operation: 'UPSERT', version: 5, payload: { x: 1 } },
          { primaryKey: 'b', operation: 'UPSERT', version: 7 },
        ];
        return out;
      },
    });
    expect(seenSince).toEqual([0]);
    expect(r.changes.length).toBe(2);
    expect(r.advancedTo).toBe(7);
  });

  it("second run advances last_offset", async () => {
    const seenSince: number[] = [];
    const r = await phase.run({
      objectTypeRid: otRid, ontologyRid: onto,
      loadChanges: async (since) => {
        seenSince.push(since);
        return [{ primaryKey: 'c', operation: 'DELETE', version: 12 }];
      },
    });
    expect(seenSince).toEqual([7]);
    expect(r.advancedTo).toBe(12);
  });

  it("empty change set leaves last_offset unchanged", async () => {
    const r = await phase.run({
      objectTypeRid: otRid, ontologyRid: onto,
      loadChanges: async () => [],
    });
    expect(r.changes).toEqual([]);
    expect(r.advancedTo).toBe(12);
  });
});
