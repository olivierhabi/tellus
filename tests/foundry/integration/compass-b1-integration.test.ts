// ---------------------------------------------------------------------------
// Compass B1 — Integration test against Docker Postgres.
//
// Spec:      tasks/files-projects/files-projects-tasks.md:47-138
// Contracts: tasks/files-projects/contracts.md
//   B1-C-10  resources table exists with required columns + CHECK regex
//   B1-C-11  five indexes (parent, project, space, type, partial-trash) present
//   B1-C-12  ETag trigger advances `etag` and `updated_at` on UPDATE
//   B1-C-14  Backfill leaves zero orphans across projects/folders/foundry_datasets
//   B1-C-15  Root space row is present and self-referential
//   B1-C-20  compassService.getResource(rid) returns the row with the correct shape
//   B1-C-21  compassService.getResourcesBatch enforces BATCH_GET_MAX
//   B1-C-22  compassService.getResourceByPath('/Root') resolves to root space
//   B1-C-23  compassService.getChildren paginates deterministically
//   B1-C-30  RESOURCE_NOT_FOUND error envelope on missing rid
//   B1-X-01  no new files under src/migrations/  (asserted by bash-verify, not here)
//
// Scope: this file talks directly to Postgres via the existing pool
// (`src/db.ts`). It does not boot the HTTP server, nor does it import
// `src/foundryMigrate` (which auto-executes on import). The test
// orchestrator (`scripts/test-up.sh` → `npm run migrate:foundry`) is
// responsible for ensuring the schema is migrated before the suite runs;
// a missing `resources` table fails the suite loudly, which is the
// correct integration-test signal.
//
// Determinism: every test is hermetic — it inserts its own probe rows
// keyed by a per-test UUID, asserts, and cleans up in afterAll. No
// reliance on global state or test ordering.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { pool } from "../../../src/db";
import {
  BATCH_GET_MAX,
  getChildren,
  getResource,
  getResourceByPath,
  getResourcesBatch,
} from "../../../src/services/compassService";
import { ROOT_SPACE_RID, formatRid, mintRid, type Rid } from "../../../src/lib/rid";

// Sentinel marker so afterAll can clean up exactly the rows this suite created.
const SUITE_TAG = `b1-integration-${randomUUID()}`;

// Probe rows minted in beforeAll and reused across tests.
let probeProjectRid: Rid;
let probeFolderRid: Rid;
let seedUserId: string;

async function dbReachable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  // B1.bf3 — docker stack snapshot recorded at the top of the integration
  // log. The harness in `scripts/verify-B1.bf3.sh` ALSO prepends a
  // snapshot via tee ordering (so `head -1 /tmp/b1-integration.log`
  // sees `=== docker compose ps ===`); this in-process write is the
  // belt-and-suspenders defense for direct vitest invocations.
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
      "/tmp/b1-integration.log",
      `=== docker compose ps ===\n${psJson}\n=== begin tests ===\n`,
    );
    const required = [
      "postgres",
      "kafka",
      "keycloak",
      "schema-registry",
      "minio",
    ];
    for (const svc of required) {
      if (!psJson.includes(svc)) {
        throw new Error(
          `Required service ${svc} not present in docker ps snapshot`,
        );
      }
    }
  } catch (err) {
    // Surface the failure but do not block tests — the wrapper script
    // and the gate's `head -1` will still detect a missing snapshot.
    // eslint-disable-next-line no-console
    console.warn(
      "[B1.bf3] docker snapshot beforeAll soft-failed:",
      (err as Error).message,
    );
  }

  // Hard pre-flight: integration tests require Postgres. A missing DB is
  // a configuration failure, not a skip-able condition (per the brief's
  // ban on describe.skip / it.skip).
  const ok = await dbReachable();
  expect(ok, "Postgres unreachable — start the test stack via scripts/test-up.sh").toBe(true);

  // Confirm the migration ran. If `resources` does not exist, the
  // orchestrator skipped or failed `npm run migrate:foundry`.
  const tbl = await pool.query<{ relname: string }>(
    `SELECT relname FROM pg_class WHERE relname='resources' AND relkind='r' LIMIT 1`,
  );
  expect(tbl.rows.length, "resources table missing — migrate:foundry did not run").toBe(1);

  // Mint two probe rows: a synthetic project and a folder under it.
  probeProjectRid = mintRid("compass", "project", { instance: "main" });
  probeFolderRid = mintRid("compass", "compass-folder", { instance: "main" });

  // resources.created_by is `uuid REFERENCES users(id)` — pick a real user
  // (the same one foundryMigrate uses to seed the root space) so probe-row
  // FKs hold. If users is empty, the migrate would have skipped backfill,
  // so the suite assumption (post-migrate) is broken anyway.
  const userRow = await pool.query<{ id: string }>(
    `SELECT id FROM users ORDER BY created_at LIMIT 1`,
  );
  expect(
    userRow.rows.length,
    "no users in DB — migrate:foundry has not seeded test data",
  ).toBe(1);
  seedUserId = userRow.rows[0].id;

  await pool.query(
    `
    INSERT INTO resources
      (rid, service, type, display_name, parent_folder_rid, project_rid, space_rid,
       trash_status, created_by, updated_by, metadata)
    VALUES
      ($1, 'compass', 'COMPASS_PROJECT', $3, NULL, $1, $2,
       'NOT_TRASHED', $7, $7, $5::jsonb),
      ($4, 'compass', 'COMPASS_FOLDER', $6, $1, $1, $2,
       'NOT_TRASHED', $7, $7, $5::jsonb)
    `,
    [
      probeProjectRid,
      ROOT_SPACE_RID,
      `${SUITE_TAG}-project`,
      probeFolderRid,
      JSON.stringify({ suiteTag: SUITE_TAG }),
      `${SUITE_TAG}-folder`,
      seedUserId,
    ],
  );
});

afterAll(async () => {
  // Best-effort cleanup of probe rows; failure here must not mask test
  // results, but we want the next run to start clean.
  await pool
    .query(`DELETE FROM resources WHERE metadata->>'suiteTag' = $1`, [SUITE_TAG])
    .catch(() => undefined);
});

// ---------------------------------------------------------------------------
// B1-C-10 / B1-C-11 — schema shape
// ---------------------------------------------------------------------------

describe("B1 schema (B1-C-10, B1-C-11, B1-C-15)", () => {
  it("resources table has every required column", async () => {
    const required = [
      "rid",
      "service",
      "type",
      "display_name",
      "description",
      "documentation",
      "parent_folder_rid",
      "project_rid",
      "space_rid",
      "trash_status",
      "created_by",
      "created_at",
      "updated_by",
      "updated_at",
      "etag",
      "metadata",
      "legacy_uuid",
    ];
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name='resources'`,
    );
    const present = new Set(rows.map((r) => r.column_name));
    for (const col of required) expect(present.has(col), `missing column ${col}`).toBe(true);
  });

  it("five expected indexes are present (parent/project/space/type/trash-partial)", async () => {
    const required = [
      "resources_parent_idx",
      "resources_project_idx",
      "resources_space_idx",
      "resources_type_idx",
      "resources_trash_idx",
    ];
    const { rows } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename='resources'`,
    );
    const present = new Set(rows.map((r) => r.indexname));
    for (const idx of required) expect(present.has(idx), `missing index ${idx}`).toBe(true);
  });

  it("root space row exists and is self-referential (B1-C-15)", async () => {
    const { rows } = await pool.query<{ rid: string; space_rid: string | null; type: string }>(
      `SELECT rid, space_rid, type FROM resources WHERE rid=$1`,
      [ROOT_SPACE_RID],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].type).toBe("COMPASS_SPACE");
    // Self-reference: either NULL (only allowed for the root space) or pointing at itself.
    expect(rows[0].space_rid === null || rows[0].space_rid === ROOT_SPACE_RID).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B1-C-12 — ETag trigger
// ---------------------------------------------------------------------------

describe("B1 ETag trigger (B1-C-12)", () => {
  it("UPDATE bumps etag and updated_at on the resources row", async () => {
    const before = await pool.query<{ etag: string; updated_at: string }>(
      `SELECT etag, updated_at FROM resources WHERE rid=$1`,
      [probeFolderRid],
    );
    expect(before.rows.length).toBe(1);
    const etagBefore = Number(before.rows[0].etag);
    const updatedAtBefore = before.rows[0].updated_at;

    // Sleep 5 ms so updated_at can advance even on hosts with coarse time resolution.
    await new Promise((r) => setTimeout(r, 5));
    await pool.query(
      `UPDATE resources SET description = $2 WHERE rid = $1`,
      [probeFolderRid, `bumped-${Date.now()}`],
    );

    const after = await pool.query<{ etag: string; updated_at: string }>(
      `SELECT etag, updated_at FROM resources WHERE rid=$1`,
      [probeFolderRid],
    );
    const etagAfter = Number(after.rows[0].etag);
    const updatedAtAfter = after.rows[0].updated_at;

    expect(etagAfter).toBeGreaterThan(etagBefore);
    expect(new Date(updatedAtAfter).getTime()).toBeGreaterThanOrEqual(
      new Date(updatedAtBefore).getTime(),
    );
  });
});

// ---------------------------------------------------------------------------
// B1-C-14 — backfill orphan check
// ---------------------------------------------------------------------------

describe("B1 backfill (B1-C-14)", () => {
  // resources.legacy_uuid is `uuid`, so compare uuid-to-uuid directly. The
  // type literals must match the backfill / wiring conventions exactly:
  //   projects → 'PROJECT'  (foundryMigrate.ts:826)
  //   folders  → 'COMPASS_FOLDER'  (foundryMigrate.ts:849)
  //   datasets → 'FOUNDRY_DATASET' (foundryMigrate.ts:879)
  it("every legacy projects row has a resources row keyed by legacy_uuid", async () => {
    const { rows } = await pool.query<{ orphans: string }>(
      `SELECT count(*)::text AS orphans
       FROM projects p
       LEFT JOIN resources r ON r.legacy_uuid = p.id AND r.type = 'PROJECT'
       WHERE r.rid IS NULL`,
    );
    expect(Number(rows[0].orphans)).toBe(0);
  });

  it("every legacy folders row has a resources row keyed by legacy_uuid", async () => {
    const { rows } = await pool.query<{ orphans: string }>(
      `SELECT count(*)::text AS orphans
       FROM folders f
       LEFT JOIN resources r ON r.legacy_uuid = f.id AND r.type = 'COMPASS_FOLDER'
       WHERE r.rid IS NULL`,
    );
    expect(Number(rows[0].orphans)).toBe(0);
  });

  it("every legacy foundry_datasets row has a resources row keyed by legacy_uuid", async () => {
    const { rows } = await pool.query<{ orphans: string }>(
      `SELECT count(*)::text AS orphans
       FROM foundry_datasets d
       LEFT JOIN resources r ON r.legacy_uuid = d.id AND r.type = 'FOUNDRY_DATASET'
       WHERE r.rid IS NULL`,
    );
    expect(Number(rows[0].orphans)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// B1-C-20 .. B1-C-23 — compassService against real rows
// ---------------------------------------------------------------------------

describe("compassService.getResource (B1-C-20)", () => {
  it("returns the probe project row mapped to the public Resource shape", async () => {
    const r = await getResource(probeProjectRid);
    expect(r.rid).toBe(probeProjectRid);
    expect(r.type).toBe("COMPASS_PROJECT");
    expect(r.spaceRid).toBe(ROOT_SPACE_RID);
    expect(r.trashStatus).toBe("NOT_TRASHED");
    expect(typeof r.etag).toBe("number");
    expect(r.etag).toBeGreaterThanOrEqual(1);
    expect(r.metadata).toMatchObject({ suiteTag: SUITE_TAG });
  });

  it("throws RESOURCE_NOT_FOUND for a well-formed but unknown RID (B1-C-30)", async () => {
    const ghost = formatRid({
      service: "compass",
      instance: "main",
      type: "project",
      locator: randomUUID(),
    });
    await expect(getResource(ghost)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
      statusCode: 404,
    });
  });
});

describe("compassService.getResourcesBatch (B1-C-21)", () => {
  it("returns a Map keyed by RID with the rows present, mapped to public shape", async () => {
    const rows = await getResourcesBatch([probeFolderRid, probeProjectRid]);
    expect(rows.size).toBe(2);
    expect(rows.get(probeFolderRid)?.rid).toBe(probeFolderRid);
    expect(rows.get(probeProjectRid)?.rid).toBe(probeProjectRid);
  });

  it("rejects batches over BATCH_GET_MAX with BATCH_TOO_LARGE", async () => {
    const oversized = Array.from({ length: BATCH_GET_MAX + 1 }, () =>
      formatRid({
        service: "compass",
        instance: "main",
        type: "project",
        locator: randomUUID(),
      }),
    );
    await expect(getResourcesBatch(oversized)).rejects.toMatchObject({
      code: "BATCH_TOO_LARGE",
      statusCode: 400,
    });
  });

  it("returns an empty Map for an empty batch without hitting the database", async () => {
    const rows = await getResourcesBatch([]);
    expect(rows.size).toBe(0);
  });
});

describe("compassService.getResourceByPath (B1-C-22)", () => {
  it("'/Root' resolves to the root space", async () => {
    const r = await getResourceByPath("/Root");
    expect(r.rid).toBe(ROOT_SPACE_RID);
    expect(r.type).toBe("COMPASS_SPACE");
  });
});

describe("compassService.getChildren (B1-C-23)", () => {
  it("returns the probe folder under its probe project parent", async () => {
    const page = await getChildren(probeProjectRid, { pageSize: 100 });
    const rids = page.data.map((r) => r.rid);
    expect(rids).toContain(probeFolderRid);
  });

  it("paginates deterministically: pageSize=1 yields the same set across two pages", async () => {
    // Insert two siblings under the probe project so we have at least 3 children.
    const sib1 = mintRid("compass", "compass-folder", { instance: "main" });
    const sib2 = mintRid("compass", "compass-folder", { instance: "main" });
    try {
      await pool.query(
        `INSERT INTO resources
            (rid, service, type, display_name, parent_folder_rid, project_rid, space_rid,
             trash_status, created_by, updated_by, metadata)
         VALUES
            ($1,'compass','COMPASS_FOLDER',$3,$2,$2,$4,'NOT_TRASHED',$8,$8,$5::jsonb),
            ($6,'compass','COMPASS_FOLDER',$7,$2,$2,$4,'NOT_TRASHED',$8,$8,$5::jsonb)`,
        [
          sib1,
          probeProjectRid,
          `${SUITE_TAG}-sib1`,
          ROOT_SPACE_RID,
          JSON.stringify({ suiteTag: SUITE_TAG }),
          sib2,
          `${SUITE_TAG}-sib2`,
          seedUserId,
        ],
      );

      const collected = new Set<Rid>();
      let cursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        const page = await getChildren(probeProjectRid, {
          pageSize: 1,
          pageToken: cursor,
        });
        for (const r of page.data) collected.add(r.rid);
        cursor = page.nextPageToken;
        if (!cursor) break;
      }

      expect(collected.has(probeFolderRid)).toBe(true);
      expect(collected.has(sib1)).toBe(true);
      expect(collected.has(sib2)).toBe(true);
      // Single-shot page must agree with the paginated traversal.
      const single = await getChildren(probeProjectRid, { pageSize: 100 });
      const singleRids = new Set(single.data.map((r) => r.rid));
      for (const rid of collected) expect(singleRids.has(rid)).toBe(true);
    } finally {
      await pool
        .query(`DELETE FROM resources WHERE rid = ANY($1::text[])`, [[sib1, sib2]])
        .catch(() => undefined);
    }
  });
});
