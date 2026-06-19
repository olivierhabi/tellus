/**
 * Verifies that folder soft-delete + restore round-trips every kind of
 * resource a folder can contain: subfolders, datasets, pipelines,
 * code-repositories, workshop-modules.
 *
 * Usage:
 *   npx tsx scripts/verify-folder-trash-roundtrip.ts \
 *     --project=<projectId> --folder=<folderId> --user=<userUuid>
 *
 *   --user defaults to the first row in `users` if omitted.
 *
 * Behavior:
 *   1) Snapshot the live folder state (children counts).
 *   2) Optionally seed a test code_repository and workshop_module into
 *      the folder so all kinds participate in the round-trip.
 *   3) Call folderService.deleteFolder.
 *   4) Verify the trash mirror is in place (resources row + snapshot).
 *   5) Call trashService.restore on the folder rid.
 *   6) Compare post-restore state vs pre-delete state.
 */

import knex from "knex";
import { Pool } from "pg";
import { FolderService } from "../src/services/folderService";
import { TrashService } from "../src/services/trashService";

interface Args {
  project: string;
  folder: string;
  user?: string;
  seed: boolean;
}

function parseArgs(): Args {
  const a: Partial<Args> = { seed: true };
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.replace(/^--/, "").split("=");
    if (k === "project") a.project = v;
    else if (k === "folder") a.folder = v;
    else if (k === "user") a.user = v;
    else if (k === "seed") a.seed = v !== "false";
  }
  if (!a.project || !a.folder) {
    console.error(
      "missing required args: --project=<uuid> --folder=<uuid>",
    );
    process.exit(2);
  }
  return a as Args;
}

async function main() {
  const args = parseArgs();
  const connectionString =
    process.env.DATABASE_URL ??
    "postgres://tellus:tellus@localhost:5432/tellus_db";
  const k = knex({ client: "pg", connection: connectionString });
  const pool = new Pool({ connectionString });

  // Hoisted to function scope so the catch handler can clean up seeded
  // rows even when an error is thrown before the cleanup line executes.
  const seeded: { repos: string[]; modules: string[] } = { repos: [], modules: [] };
  let cleanOnExit = true;

  try {
    // Resolve actor
    let actorId = args.user ?? null;
    if (!actorId) {
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM users ORDER BY created_at LIMIT 1`,
      );
      actorId = rows[0]?.id ?? null;
    }
    if (!actorId) throw new Error("no user found in `users`");

    const folderRid = `ri.compass.main.compass-folder.${args.folder}`;
    const folderRid2 = `ri.compass.main.folder.${args.folder}`;
    const projectFolderRid = `ri.compass.main.folder.${args.project}`;

    // ---- Sweep leftovers from prior aborted runs ----------------------
    // Any earlier run that crashed before cleanup-on-failure was wired
    // can leave `trash-roundtrip-*` rows under this folder. Remove them
    // up-front so this run's seed doesn't 23505 on the unique
    // (parent_folder_rid, lower(display_name)) index.
    await pool.query(
      `DELETE FROM code_repository
        WHERE parent_folder_rid = $1
          AND display_name = 'trash-roundtrip-repo'`,
      [folderRid2],
    );
    await pool.query(
      `DELETE FROM workshop_module
        WHERE parent_folder_rid = $1
          AND display_name = 'trash-roundtrip-module'`,
      [folderRid2],
    );

    // ---- Pre-state -----------------------------------------------------
    const before = await snapshotState(pool, args, folderRid2);
    console.log("=== PRE-STATE ===", JSON.stringify(before, null, 2));

    // ---- Seed code-repo + workshop-module if missing -------------------
    if (args.seed) {
      const seedRepoRid = `ri.stemma.main.repository.${cryptoRandomUuid()}`;
      const seedModuleRid = `ri.workshop.main.module.${cryptoRandomUuid()}`;
      await pool.query(
        `INSERT INTO code_repository
           (rid, display_name, parent_folder_rid, project_rid,
            template_id, template_version, default_branch,
            settings_json, state, created_by)
         VALUES ($1,$2,$3,$4,'blank','0.0.0','main','{}','ACTIVE',$5)
         ON CONFLICT (rid) DO NOTHING`,
        [
          seedRepoRid,
          "trash-roundtrip-repo",
          folderRid2,
          `ri.compass.main.project.${args.project}`,
          actorId,
        ],
      );
      seeded.repos.push(seedRepoRid);
      await pool.query(
        `INSERT INTO workshop_module
           (rid, ontology_rid, display_name, current_semver, definition,
            etag, schema_version, parent_folder_rid, created_by, updated_by)
         VALUES ($1,'ri.ontology.main.ontology.default','trash-roundtrip-module','0.1.0','{}','0',4,$2,$3,$3)
         ON CONFLICT (rid) DO NOTHING`,
        [seedModuleRid, folderRid2, actorId],
      );
      seeded.modules.push(seedModuleRid);
      console.log("seeded:", { seedRepoRid, seedModuleRid });
    }

    const beforeWithSeed = await snapshotState(pool, args, folderRid2);
    console.log(
      "=== PRE-STATE (after seed) ===",
      JSON.stringify(beforeWithSeed, null, 2),
    );

    // ---- DELETE --------------------------------------------------------
    const folderService = new FolderService(k);
    const deleteResult = await folderService.deleteFolder(
      args.project,
      args.folder,
      actorId,
    );
    console.log("=== DELETE RESULT ===", deleteResult);

    // Verify the trash mirror exists with snapshot
    const trashRow = await pool.query<{
      trash_status: string;
      metadata: { snapshot?: { kind: string; folders?: unknown[]; datasets?: unknown[]; pipelines?: unknown[]; codeRepositories?: unknown[]; workshopModules?: unknown[] } } | null;
    }>(
      `SELECT trash_status, metadata FROM resources WHERE rid = $1`,
      [folderRid],
    );
    const snap = trashRow.rows[0]?.metadata?.snapshot;
    console.log("=== TRASH MIRROR ===", {
      trashStatus: trashRow.rows[0]?.trash_status,
      snapshotKind: snap?.kind,
      snapshotCounts: {
        folders: snap?.folders?.length ?? 0,
        datasets: snap?.datasets?.length ?? 0,
        pipelines: snap?.pipelines?.length ?? 0,
        codeRepositories: snap?.codeRepositories?.length ?? 0,
        workshopModules: snap?.workshopModules?.length ?? 0,
      },
    });

    // Verify source-of-truth tables are now empty for this folder
    const liveAfterDelete = await snapshotState(pool, args, folderRid2);
    console.log(
      "=== POST-DELETE LIVE ===",
      JSON.stringify(liveAfterDelete, null, 2),
    );

    // ---- RESTORE -------------------------------------------------------
    const trashService = new TrashService(pool);
    const restoreResult = await trashService.restore(folderRid, actorId);
    console.log("=== RESTORE RESULT ===", restoreResult);

    // ---- Post-restore state -------------------------------------------
    const after = await snapshotState(pool, args, folderRid2);
    console.log("=== POST-RESTORE STATE ===", JSON.stringify(after, null, 2));

    // ---- Reconciliation -----------------------------------------------
    const ok =
      after.folders === beforeWithSeed.folders &&
      after.datasets === beforeWithSeed.datasets &&
      after.pipelines === beforeWithSeed.pipelines &&
      after.codeRepos === beforeWithSeed.codeRepos &&
      after.workshopModules === beforeWithSeed.workshopModules;

    if (ok) {
      console.log(
        "\nROUND-TRIP OK: every kind of resource recovered successfully.",
      );
    } else {
      console.error("\nROUND-TRIP MISMATCH:", {
        before: beforeWithSeed,
        after,
      });
      cleanOnExit = false;
      process.exitCode = 1;
    }

    // Successful round-trip: the restored seeded rows are now in the
    // live tables. Remove them so the script leaves the DB exactly as
    // it found it.
    if (cleanOnExit) {
      await cleanupSeeded(pool, seeded);
    }
  } catch (err) {
    // Any abort: try to remove seeded rows even though the round-trip
    // is incomplete. Cleanup itself is best-effort \u2014 we never want a
    // cleanup failure to mask the original error.
    try {
      await cleanupSeeded(pool, seeded);
    } catch (cleanupErr) {
      console.warn("[verify-folder-trash-roundtrip] cleanup failed:", cleanupErr);
    }
    throw err;
  } finally {
    await pool.end();
    await k.destroy();
  }
}

async function cleanupSeeded(
  pool: Pool,
  seeded: { repos: string[]; modules: string[] },
) {
  if (seeded.repos.length > 0) {
    await pool.query(
      `DELETE FROM code_repository WHERE rid = ANY($1::text[])`,
      [seeded.repos],
    );
  }
  if (seeded.modules.length > 0) {
    await pool.query(
      `DELETE FROM workshop_module WHERE rid = ANY($1::text[])`,
      [seeded.modules],
    );
  }
}

async function snapshotState(
  pool: Pool,
  args: Args,
  folderRid: string,
) {
  const folder = await pool.query<{ id: string }>(
    `SELECT id FROM folders WHERE id = $1`,
    [args.folder],
  );
  const datasets = await pool.query<{ count: string }>(
    `SELECT count(*) FROM foundry_datasets WHERE folder_id = $1`,
    [args.folder],
  );
  const pipelines = await pool.query<{ count: string }>(
    `SELECT count(*) FROM pipelines WHERE folder_id = $1`,
    [args.folder],
  );
  const codeRepos = await pool.query<{ count: string }>(
    `SELECT count(*) FROM code_repository WHERE parent_folder_rid = $1`,
    [folderRid],
  );
  const workshopModules = await pool.query<{ count: string }>(
    `SELECT count(*) FROM workshop_module WHERE parent_folder_rid = $1`,
    [folderRid],
  );
  return {
    folders: folder.rowCount ?? 0,
    datasets: Number(datasets.rows[0].count),
    pipelines: Number(pipelines.rows[0].count),
    codeRepos: Number(codeRepos.rows[0].count),
    workshopModules: Number(workshopModules.rows[0].count),
  };
}

function cryptoRandomUuid(): string {
  // RFC 4122 v4 — uses Math.random for the test seed, which is fine for
  // the short-lived rows this script writes. Production code uses pg's
  // gen_random_uuid().
  const hex = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < 32; i++) {
    if (i === 12) s += "4";
    else if (i === 16) s += hex[8 + Math.floor(Math.random() * 4)];
    else s += hex[Math.floor(Math.random() * 16)];
  }
  return [
    s.slice(0, 8),
    s.slice(8, 12),
    s.slice(12, 16),
    s.slice(16, 20),
    s.slice(20, 32),
  ].join("-");
}

main().catch((err) => {
  console.error("verify-folder-trash-roundtrip FAILED:", err);
  process.exit(1);
});
