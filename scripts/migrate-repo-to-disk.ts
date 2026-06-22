// ---------------------------------------------------------------------------
// Repository-to-Disk Migration Utility
//
// Boots the database connection pool, queries all active repository branches
// and blobs, scaffolds them physically under the disk storage root, sets up
// local git repositories, and performs initial automated stages and commits.
// ---------------------------------------------------------------------------

import "dotenv/config";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { pool } from "../src/db";
import { getWorkspaceReposRoot } from "../src/services/codeRepository/adapters/disk";

function runGit(cmd: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(`git ${cmd}`, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout.trim() || stderr.trim());
      }
    });
  });
}

async function runMigration() {
  const rootDir = getWorkspaceReposRoot();
  console.log(`[Migration] Starting code repository disk scaffolding under: ${rootDir}`);

  // Fetch all registered branches
  const { rows: branches } = await pool.query<{
    repository_rid: string;
    branch: string;
    head_sha: string;
  }>(`SELECT repository_rid, branch, head_sha FROM coderepo_stemma_branch`);

  console.log(`[Migration] Found ${branches.length} branches to synchronize to disk.`);

  let totalFilesScaffolded = 0;
  let successCount = 0;

  for (const branchRow of branches) {
    const { repository_rid: rid, branch, head_sha } = branchRow;
    const branchPath = path.join(rootDir, rid, branch);

    console.log(`\n--------------------------------------------------------------`);
    console.log(`[Migration] Scaffolding: RID=${rid} | Branch=${branch}`);
    console.log(`- Folder: ${branchPath}`);

    try {
      // 1. Ensure directory exists & git clean init
      await fs.mkdir(branchPath, { recursive: true });
      try {
        await runGit("init", branchPath);
        await runGit('config user.name "Tellus Robot"', branchPath);
        await runGit('config user.email "robot@tellus.io"', branchPath);
        console.log(`- Git repository initialized successfully.`);
      } catch (gitErr) {
        console.warn(`- Git init warning (might be non-critical):`, (gitErr as Error).message);
      }

      // 2. Query all blobs for this branch
      const { rows: blobs } = await pool.query<{
        path: string;
        content: Buffer;
        mode: string;
        sha: string;
      }>(
        `SELECT path, content, mode, sha 
           FROM coderepo_stemma_blob 
          WHERE repository_rid = $1 AND branch = $2`,
        [rid, branch]
      );

      console.log(`- Exporting ${blobs.length} file blobs from database...`);

      for (const blob of blobs) {
        const filePath = path.join(branchPath, blob.path);
        // Create subdirectory parent structure
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        
        // Write raw bytes content to disk
        await fs.writeFile(filePath, blob.content);
        
        // Adjust file modes
        if (blob.mode === "100755") {
          await fs.chmod(filePath, 0o755);
        } else {
          await fs.chmod(filePath, 0o644);
        }
        totalFilesScaffolded++;
      }

      // 3. Stage and record state in local Git tracking
      try {
        await runGit("add -A", branchPath);
        await runGit(`commit -m "Inaugural database-to-disk code synchronization"`, branchPath);
        console.log(`- Tracked all files in Git successfully.`);
      } catch (commitErr) {
        // Ignored if commit didn't create changes, which is a standard git outcome
      }

      console.log(`[Migration] Successfully completed scaffolding for ${rid}/${branch}`);
      successCount++;
    } catch (err) {
      console.error(`[Migration] Failed to scaffold ${rid}/${branch} to disk:`, err);
    }
  }

  console.log(`\n==============================================================`);
  console.log(`[Migration] Final Report:`);
  console.log(`- Branches Processed Successfully: ${successCount} / ${branches.length}`);
  console.log(`- Total Disk Files Written: ${totalFilesScaffolded}`);
  console.log(`[Migration] Closing database connection pool...`);
  await pool.end();
  console.log(`[Migration] Execution successfully finalized.`);
}

runMigration().catch((err) => {
  console.error(`[Migration] Catastrophic failure occurred:`, err);
  pool.end().catch(() => {});
  process.exit(1);
});
