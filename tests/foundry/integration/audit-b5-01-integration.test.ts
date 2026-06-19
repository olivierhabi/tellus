import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { AuditWriter } from "../../../src/services/audit";

const pool = new Pool({
  host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus", password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});
const w = new AuditWriter(pool);

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => { await pool.end(); });

describe("B5.01 — audit writer", () => {
  it("writes an event and returns row id", async () => {
    const eventId = randomUUID();
    const id = await w.write({ eventId, operationId: "compass:view-resource", decision: "ALLOW" });
    expect(id).toBeTruthy();
    const r = await pool.query(`SELECT * FROM audit_log WHERE event_id = $1`, [eventId]);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].decision).toBe("ALLOW");
    await pool.query(`DELETE FROM audit_log WHERE event_id = $1`, [eventId]);
  });

  it("is idempotent on event_id", async () => {
    const eventId = randomUUID();
    await w.write({ eventId, operationId: "compass:view-resource", decision: "DENY", reason: "X" });
    await w.write({ eventId, operationId: "compass:view-resource", decision: "DENY", reason: "X" });
    const r = await pool.query(`SELECT count(*)::int AS c FROM audit_log WHERE event_id = $1`, [eventId]);
    expect(r.rows[0].c).toBe(1);
    await pool.query(`DELETE FROM audit_log WHERE event_id = $1`, [eventId]);
  });

  it("rejects bad decision via CHECK constraint", async () => {
    await expect(
      pool.query(
        `INSERT INTO audit_log (event_id, operation_id, decision) VALUES ($1, 'x', 'BOGUS')`,
        [randomUUID()],
      ),
    ).rejects.toThrow();
  });
});
