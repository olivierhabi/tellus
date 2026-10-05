// ---------------------------------------------------------------------------
// dataset-registration-integration — atomic foundry_datasets writer
// (incident 3ec397d5), against real PostgreSQL (lane DB).
//
// Covers:
//   • N parallel registerDataset calls, same (project, folder, name):
//     exactly 1 row; 1 created + N-1 adopted. Never a duplicate.
//   • refuse-on-conflict callers (uploads, clone): 1 success + N-1 typed
//     409 DATASET_NAME_ALREADY_EXISTS. Still exactly 1 row.
//   • retry after partial failure: same-node re-registration adopts the
//     winner (no "already in use"); genuine cross-node collision 409s.
//   • live binding -> update-in-place; ghost binding -> atomic insert.
//   • migration 190: unique index present with NULLS NOT DISTINCT, and the
//     pre-check DO block refuses a dirty database (scratch-DB proof).
// ---------------------------------------------------------------------------

// LANE import must be first: its side effect pins the lane identity into
// process.env before any service module reads it.
import { LANE } from "../../laneEnv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import type { Knex } from "knex";

import { registerDataset } from "../../../src/services/datasets/datasetRegistration";
import {
  RUN,
  createOutputNode,
  createProjectTree,
  destroyProjectTree,
  seedUserId,
  type DeployFixtures,
} from "./fixtures";

void LANE;

let knex: Knex;
let fx: DeployFixtures;

const PATCH = {
  file_path: "projects/x/pipeline-outputs/y/race_2026-01-01.csv",
  row_count: 10,
  row_count_exact: 10,
  column_count: 2,
  file_size_bytes: 100,
  mime_type: "text/csv",
  format: "csv",
  original_filename: "race.csv",
  status: "ready",
};

beforeAll(async () => {
  const foundryDb = (await import("../../../src/config/foundryDb")).default;
  knex = foundryDb as unknown as Knex;
  const ownerId = await seedUserId(knex);
  fx = await createProjectTree(knex, ownerId, "reg");
});

afterAll(async () => {
  await destroyProjectTree(knex, fx);
});

describe("atomic dataset registration", () => {
  it("N parallel writers produce exactly 1 row (1 created + N-1 adopted)", async () => {
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        registerDataset(knex, {
          projectId: fx.projectId,
          folderId: fx.folderId,
          name: `race-${RUN}`,
          patch: { ...PATCH },
          actor: `racer-${i}`,
        }),
      ),
    );
    const rows = await knex("foundry_datasets").where({
      project_id: fx.projectId,
      folder_id: fx.folderId,
      name: `race-${RUN}`,
    });
    expect(rows).toHaveLength(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.filter((r) => r.adopted)).toHaveLength(N - 1);
    const ids = new Set(results.map((r) => r.datasetId));
    expect(ids.size).toBe(1);
    expect(ids.has(rows[0].id)).toBe(true);
  });

  it("refuse-on-conflict callers get typed 409s, still exactly 1 row", async () => {
    const N = 6;
    const settled = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        registerDataset(knex, {
          projectId: fx.projectId,
          folderId: fx.folderId,
          name: `refuse-${RUN}`,
          patch: { ...PATCH },
          adoptIf: async () => false,
          actor: `refuser-${i}`,
        }),
      ),
    );
    const ok = settled.filter((s) => s.status === "fulfilled");
    const failed = settled.filter((s) => s.status === "rejected") as Array<{
      status: "rejected";
      reason: unknown;
    }>;
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(N - 1);
    for (const f of failed) {
      expect((f.reason as { code?: string }).code).toBe(
        "DATASET_NAME_ALREADY_EXISTS",
      );
      expect((f.reason as { statusCode?: number }).statusCode).toBe(409);
    }
    const rows = await knex("foundry_datasets").where({
      project_id: fx.projectId,
      folder_id: fx.folderId,
      name: `refuse-${RUN}`,
    });
    expect(rows).toHaveLength(1);
  });

  it("retry with the same node adopts the winner (no already-in-use)", async () => {
    const nodeA = await createOutputNode(knex, fx.pipelineId, `retry-${RUN}`);
    const first = await registerDataset(knex, {
      projectId: fx.projectId,
      folderId: fx.folderId,
      name: `retry-${RUN}`,
      patch: { ...PATCH },
      bindNode: {
        pipelineId: fx.pipelineId,
        nodeId: nodeA,
        config: (id) => ({ outputDatasetId: id }),
      },
      actor: "retry-attempt-1",
    });
    expect(first.created).toBe(true);
    // Second attempt (retry after a mid-deploy failure): no live-binding
    // shortcut, straight at the atomic path — must adopt, not 409.
    const second = await registerDataset(knex, {
      projectId: fx.projectId,
      folderId: fx.folderId,
      name: `retry-${RUN}`,
      patch: { ...PATCH, row_count: 11 },
      bindNode: {
        pipelineId: fx.pipelineId,
        nodeId: nodeA,
        config: (id) => ({ outputDatasetId: id }),
      },
      actor: "retry-attempt-2",
    });
    expect(second.datasetId).toBe(first.datasetId);
    expect(second.adopted).toBe(true);
    const rows = await knex("foundry_datasets").where({
      project_id: fx.projectId,
      folder_id: fx.folderId,
      name: `retry-${RUN}`,
    });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].row_count)).toBe(11);
  });

  it("genuine cross-node collision refuses with 409", async () => {
    const nodeA = await createOutputNode(knex, fx.pipelineId, `collide-a-${RUN}`);
    const nodeB = await createOutputNode(knex, fx.pipelineId, `collide-b-${RUN}`);
    await registerDataset(knex, {
      projectId: fx.projectId,
      folderId: fx.folderId,
      name: `collide-${RUN}`,
      patch: { ...PATCH },
      bindNode: {
        pipelineId: fx.pipelineId,
        nodeId: nodeA,
        config: (id) => ({ outputDatasetId: id }),
      },
      actor: "collide-owner",
    });
    await expect(
      registerDataset(knex, {
        projectId: fx.projectId,
        folderId: fx.folderId,
        name: `collide-${RUN}`,
        patch: { ...PATCH },
        bindNode: {
          pipelineId: fx.pipelineId,
          nodeId: nodeB,
          config: (id) => ({ outputDatasetId: id }),
        },
        actor: "collide-intruder",
      }),
    ).rejects.toMatchObject({
      code: "DATASET_NAME_ALREADY_EXISTS",
      statusCode: 409,
    });
    const rows = await knex("foundry_datasets").where({
      project_id: fx.projectId,
      folder_id: fx.folderId,
      name: `collide-${RUN}`,
    });
    expect(rows).toHaveLength(1);
  });

  it("live binding updates in place; ghost binding inserts", async () => {
    const live = await registerDataset(knex, {
      projectId: fx.projectId,
      folderId: fx.folderId,
      name: `bound-${RUN}`,
      patch: { ...PATCH },
      actor: "bound-create",
    });
    const updated = await registerDataset(knex, {
      projectId: fx.projectId,
      folderId: fx.folderId,
      name: `bound-${RUN}`,
      patch: { ...PATCH, row_count: 99 },
      resolveBoundId: async () => live.datasetId,
      actor: "bound-update",
    });
    expect(updated.datasetId).toBe(live.datasetId);
    expect(updated.created).toBe(false);
    expect(updated.adopted).toBe(false);

    const ghost = await registerDataset(knex, {
      projectId: fx.projectId,
      folderId: fx.folderId,
      name: `ghost-${RUN}`,
      patch: { ...PATCH },
      resolveBoundId: async () => "00000000-0000-4000-8000-ffffffffffff",
      actor: "ghost-create",
    });
    expect(ghost.created).toBe(true);
  });
});

describe("migration 190 (dataset name uniqueness)", () => {
  it("unique index exists with NULLS NOT DISTINCT", async () => {
    const res = await knex.raw(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'foundry_datasets'
          AND indexname = 'uq_foundry_datasets_project_folder_name'`,
    );
    const rows = (res?.rows ?? res ?? []) as Array<{ indexdef: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain("NULLS NOT DISTINCT");
  });

  it("pre-check query finds zero duplicate groups on the lane DB", async () => {
    const res = await knex("foundry_datasets")
      .select("project_id", "folder_id", "name")
      .count("* as n")
      .groupBy("project_id", "folder_id", "name")
      .havingRaw("count(*) > 1");
    const rows = (res?.rows ?? res ?? []) as unknown[];
    expect(rows).toHaveLength(0);
  });

  it("pre-check blocks a dirty database and passes once clean (scratch DB)", async () => {
    const scratchDb = `fencing_scratch_${RUN}`.replaceAll("-", "_");
    const admin = new pg.Client({
      host: "localhost",
      port: 5432,
      user: "tellus",
      password: process.env.PGPASSWORD,
      database: "postgres",
    });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${scratchDb}"`);
    try {
      const scratch = new pg.Client({
        host: "localhost",
        port: 5432,
        user: "tellus",
        password: process.env.PGPASSWORD,
        database: scratchDb,
      });
      await scratch.connect();
      try {
        await scratch.query(
          `CREATE TABLE foundry_datasets (
             id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
             project_id uuid, folder_id uuid, name text)`,
        );
        const pid = "11111111-1111-4111-8111-111111111111";
        await scratch.query(
          `INSERT INTO foundry_datasets (project_id, folder_id, name)
           VALUES ($1, NULL, 'dup'), ($1, NULL, 'dup')`,
          [pid],
        );
        const migration = readFileSync(
          path.resolve(
            __dirname,
            "../../../src/migrations/190_dataset_name_uniqueness.sql",
          ),
          "utf8",
        );
        await expect(scratch.query(migration)).rejects.toMatchObject({
          code: "P0001",
        });
        await scratch.query(
          `DELETE FROM foundry_datasets WHERE project_id = $1`,
          [pid],
        );
        await scratch.query(migration);
        const idx = await scratch.query(
          `SELECT 1 FROM pg_indexes WHERE indexname = 'uq_foundry_datasets_project_folder_name'`,
        );
        expect(idx.rows).toHaveLength(1);
      } finally {
        await scratch.end();
      }
    } finally {
      await admin.query(`DROP DATABASE "${scratchDb}"`);
      await admin.end();
    }
  }, 120_000);
});
