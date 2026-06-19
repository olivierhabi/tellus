// B4.03 — Markings DDL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus",
  password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});

let userId: string;
const markingId = `b4-test-${randomUUID()}`;
const resourceRid = `ri.compass.main.dataset.${randomUUID()}`;

beforeAll(async () => {
  await pool.query("SELECT 1");
  const u = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'b4-marking') RETURNING id`,
    [`b4-marking-${randomUUID()}@tellus.local`],
  );
  userId = u.rows[0].id;
  await pool.query(
    `INSERT INTO markings (id, display_name) VALUES ($1, 'B4 test marking')`,
    [markingId],
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM resource_markings WHERE marking_id = $1`, [markingId]);
  await pool.query(`DELETE FROM user_markings WHERE marking_id = $1`, [markingId]);
  await pool.query(`DELETE FROM markings WHERE id = $1`, [markingId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await pool.end();
});

describe("B4.03 — markings tables", () => {
  it("attach marking to resource as DIRECT", async () => {
    await pool.query(
      `INSERT INTO resource_markings (resource_rid, marking_id, source) VALUES ($1, $2, 'DIRECT')`,
      [resourceRid, markingId],
    );
    const { rows } = await pool.query(
      `SELECT * FROM resource_markings WHERE resource_rid = $1 AND marking_id = $2`,
      [resourceRid, markingId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe('DIRECT');
  });

  it("attach marking to user", async () => {
    await pool.query(
      `INSERT INTO user_markings (user_id, marking_id) VALUES ($1, $2)`,
      [userId, markingId],
    );
    const { rows } = await pool.query(
      `SELECT * FROM user_markings WHERE user_id = $1 AND marking_id = $2`,
      [userId, markingId],
    );
    expect(rows.length).toBe(1);
  });

  it("CHECK constraint rejects source='INVALID'", async () => {
    await expect(
      pool.query(
        `INSERT INTO resource_markings (resource_rid, marking_id, source) VALUES ($1, $2, 'INVALID')`,
        [resourceRid + '-bad', markingId],
      ),
    ).rejects.toThrow();
  });
});
