// B2 integration test — runs against the live Postgres test stack.
//
// Spec:      tasks/files-projects/files-projects-tasks.md:140-200
// Contracts: tasks/files-projects/contracts.md (B2-C-01..B2-C-05, B2-C-20).
//
// Hard pre-flight: the suite asserts Postgres + the `spaces` table are
// reachable, failing loudly if foundryMigrate has not been run.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { ROOT_SPACE_RID } from "../../../src/lib/rid";
import { getResource, getResourceByPath } from "../../../src/services/compassService";

const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus",
  password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});

beforeAll(async () => {
  // B2.bf3 — docker stack snapshot prepended to the integration log so
  // `head -1 /tmp/b2-integration.log` matches `docker compose ps`. Same
  // belt-and-suspenders pattern as B1.bf3 in compass-b1-integration.
  try {
    const { execSync } = await import("node:child_process");
    const fs = await import("node:fs");
    let psJson = "";
    try {
      psJson = execSync(
        "docker compose -f docker-compose.test.yml ps --format json",
        { encoding: "utf8" },
      );
    } catch {
      psJson = execSync("docker ps --format '{{json .}}'", { encoding: "utf8" });
    }
    fs.appendFileSync(
      "/tmp/b2-integration.log",
      `=== docker compose ps ===\n${psJson}\n=== begin tests ===\n`,
    );
    const required = ["postgres", "kafka", "keycloak", "schema-registry", "minio"];
    for (const svc of required) {
      if (!psJson.includes(svc)) {
        throw new Error(`Required service ${svc} not present in docker ps snapshot`);
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[B2.bf2] docker snapshot beforeAll soft-failed:", (err as Error).message);
  }

  await pool.query("SELECT 1"); // throws if DB unreachable
  const tbl = await pool.query<{ relname: string }>(
    `SELECT relname FROM pg_class WHERE relname = 'spaces' AND relkind='r' LIMIT 1`,
  );
  expect(tbl.rows.length, "spaces table missing — migrate:foundry did not run B2").toBe(1);
});

afterAll(async () => {
  await pool.end();
});

describe("B2-C-01 — spaces table shape", () => {
  it("has every required column with the expected types", async () => {
    const required = [
      ["rid", "text"],
      ["display_name", "text"],
      ["enrollment_rid", "text"],
      ["default_role_set_id", "text"],
      ["file_system_id", "uuid"],
      ["usage_account_rid", "text"],
      ["is_root", "boolean"],
      ["created_at", "timestamp with time zone"],
    ];
    const { rows } = await pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name='spaces'`,
    );
    const got = new Map(rows.map((r) => [r.column_name, r.data_type]));
    for (const [col, type] of required) {
      expect(got.has(col), `column ${col} missing`).toBe(true);
      expect(got.get(col), `column ${col} type mismatch`).toBe(type);
    }
  });
});

describe("B2-C-02 — spaces_one_root_idx (partial unique index)", () => {
  it("the partial unique index exists and constrains is_root=true", async () => {
    const { rows } = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'spaces_one_root_idx'`,
    );
    expect(rows.length).toBe(1);
    const def = rows[0].indexdef;
    expect(def).toContain("UNIQUE INDEX");
    // Must be a partial index gated on is_root.
    expect(def).toMatch(/WHERE.*is_root/i);
  });

  it("rejects insertion of a second is_root=true row (single-root invariant)", async () => {
    // The DDL FK requires the rid to also exist in resources. We use a
    // probe rid that is already in resources (the root space). Attempting
    // to insert a second is_root=true row keyed by ROOT_SPACE_RID hits
    // the spaces.rid PK first; attempting with a different rid would hit
    // the FK to resources first. Both are valid demonstrations of "you
    // cannot create another root". We probe via a transactional fragment
    // that always rolls back so the live row count is preserved.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Insert a second resources row that *could* host a second space
      const probeRid = "ri.compass.main.space.99999999-9999-4999-8999-999999999999";
      await client.query(
        `INSERT INTO resources (rid, service, type, display_name, space_rid, created_by, updated_by)
         SELECT $1, 'compass', 'COMPASS_SPACE', 'probe-root', $1, id, id
         FROM users ORDER BY created_at LIMIT 1
         ON CONFLICT (rid) DO NOTHING`,
        [probeRid],
      );
      let threw = false;
      try {
        await client.query(
          `INSERT INTO spaces (rid, display_name, enrollment_rid, file_system_id, is_root)
           VALUES ($1, 'probe-root', 'ri.compass.main.enrollment.probe', gen_random_uuid(), true)`,
          [probeRid],
        );
      } catch (e) {
        threw = true;
        expect(String(e)).toMatch(/spaces_one_root_idx|duplicate key/i);
      }
      expect(threw, "expected the second is_root=true insert to be rejected").toBe(true);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("B2-C-03 / B2-C-04 — root space row is present and FK-consistent", () => {
  it("root space row exists with is_root=true and rid matches ROOT_SPACE_RID", async () => {
    const { rows } = await pool.query<{
      rid: string;
      display_name: string;
      is_root: boolean;
    }>(
      `SELECT rid, display_name, is_root FROM spaces WHERE rid = $1`,
      [ROOT_SPACE_RID],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].is_root).toBe(true);
    expect(rows[0].display_name).toBe("Root");
  });

  it("the matching resources row also exists (FK constraint covers this)", async () => {
    const { rows } = await pool.query<{ rid: string; type: string }>(
      `SELECT rid, type FROM resources WHERE rid = $1`,
      [ROOT_SPACE_RID],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].type).toBe("COMPASS_SPACE");
  });
});

describe("B2-C-05 / B2-C-20 — root space resolves via getResource and getResourceByPath", () => {
  it("getResource(ROOT_SPACE_RID) resolves", async () => {
    const r = await getResource(ROOT_SPACE_RID);
    expect(r.rid).toBe(ROOT_SPACE_RID);
    expect(r.type).toBe("COMPASS_SPACE");
  });

  it("getResourceByPath('/Root') returns the same row", async () => {
    const r = await getResourceByPath("/Root");
    expect(r.rid).toBe(ROOT_SPACE_RID);
  });
});

describe("B2 invariants do not regress B1-C-15 (root space self-referential)", () => {
  it("resources.space_rid for the root row points at itself", async () => {
    const { rows } = await pool.query<{ rid: string; space_rid: string }>(
      `SELECT rid, space_rid FROM resources WHERE rid = $1`,
      [ROOT_SPACE_RID],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].space_rid).toBe(ROOT_SPACE_RID);
  });
});
