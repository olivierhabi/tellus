// ---------------------------------------------------------------------------
// DiskStemma — a robust, hybrid StemmaAdapter with real disk workspace syncing.
//
// Dual-writes all commit structures and branch forks physically to the OS
// filesystem (backing code-server workspaces) whilst keeping PostgresStemma as
// the underlying transactional ledger.
//
// Features:
//   1. Multi-tenant Branch Isolation: Organized under `var/tellus/repositories/:rid/:branch`
//   2. Git Integration: Automatically initializes `git init`, configures local user details
//      and stages on each commit.
//   3. Fault-Tolerant Rehydration: Self-healing workspace directories that auto-reconstruct
//      the disk from Postgres on read if missing.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import type { Pool } from "pg";
import type {
  StemmaAdapter,
  StemmaCreateArgs,
  StemmaCreateOutcome,
  StemmaCommitFilesArgs,
  StemmaCommitFilesOutcome,
  StemmaListTreeArgs,
  StemmaListTreeOutcome,
  StemmaReadBlobArgs,
  StemmaReadBlobOutcome,
  StemmaCreateBranchArgs,
  StemmaCreateBranchOutcome,
  StemmaDeleteBranchArgs,
  StemmaDeleteBranchOutcome,
  StemmaListBranchesOutcome,
} from "./types";
import { PostgresStemma } from "./postgres";

/** Resolve the canonical directory root for workspace storage with seamless graceful fallbacks. */
export function getWorkspaceReposRoot(): string {
  if (process.env.TELLUS_REPOS_ROOT) {
    return process.env.TELLUS_REPOS_ROOT;
  }
  const defaultVarPath = "/var/tellus/repositories";
  try {
    mkdirSync(defaultVarPath, { recursive: true });
    return defaultVarPath;
  } catch (err) {
    // If permission or accessibility fails, fallback to local workspace project folder
    const projectVarPath = path.join(process.cwd(), "var/tellus/repositories");
    try {
      mkdirSync(projectVarPath, { recursive: true });
      return projectVarPath;
    } catch {
      // Emergency sandbox fallback
      const tmpPath = path.join("/tmp", "tellus", "repositories");
      mkdirSync(tmpPath, { recursive: true });
      return tmpPath;
    }
  }
}

export interface DiskStemmaDeps {
  readonly pool: Pool;
}

export class DiskStemma implements StemmaAdapter {
  private readonly dbStemma: PostgresStemma;
  private readonly reposRoot: string;

  constructor(deps: DiskStemmaDeps) {
    this.dbStemma = new PostgresStemma({ pool: deps.pool });
    this.reposRoot = getWorkspaceReposRoot();
    console.log(`[DiskStemma] Initialized at mount point: ${this.reposRoot}`);
  }

  /** Run any git command reliably in the context of a given directory path. */
  private runGitCmd(cmd: string, cwd: string): Promise<string> {
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

  /** Ensures workspace directory with a valid git repository is initialized. */
  private async ensureGitWorkspaceInitialized(repositoryRid: string, branch: string): Promise<string> {
    const branchPath = path.join(this.reposRoot, repositoryRid, branch);
    await fs.mkdir(branchPath, { recursive: true });
    
    // Check if git directory is configured, if not, perform a robust init
    const gitDir = path.join(branchPath, ".git");
    try {
      await fs.access(gitDir);
    } catch {
      try {
        await this.runGitCmd("init", branchPath);
        await this.runGitCmd('config user.name "Tellus Robot"', branchPath);
        await this.runGitCmd('config user.email "robot@tellus.io"', branchPath);
      } catch (err) {
        console.warn(`[DiskStemma] Custom git init warning for ${repositoryRid}/${branch}:`, err);
      }
    }
    return branchPath;
  }

  /** Automatically self-heals by backfilling missing physical directories from our autorative database ledger. */
  private async ensureDiskWorkspaceRehydrated(repositoryRid: string, branch: string): Promise<void> {
    const branchPath = path.join(this.reposRoot, repositoryRid, branch);
    try {
      await fs.access(branchPath);
      const contents = await fs.readdir(branchPath);
      // If folder exists but is empty (except optionally .git), trigger rehydration
      const nonGitContents = contents.filter(item => item !== ".git");
      if (nonGitContents.length > 0) return;
    } catch {
      // Rehydrate required as folder is missing
    }

    console.log(`[DiskStemma] Self-healing rehydration triggered for: ${repositoryRid}/${branch}...`);
    const listResult = await this.dbStemma.listTree({
      repositoryRid,
      branch,
      path: "",
      depth: 5,
    });

    if (listResult.kind === "ok") {
      const activePath = await this.ensureGitWorkspaceInitialized(repositoryRid, branch);
      for (const entry of listResult.entries) {
        if (entry.type === "blob") {
          const blobData = await this.dbStemma.readBlob({
            repositoryRid,
            branch,
            path: entry.path,
          });
          if (blobData.kind === "ok") {
            const filePath = path.join(activePath, entry.path);
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, blobData.content);
            if (entry.mode === "100755") {
              await fs.chmod(filePath, 0o755);
            } else {
              await fs.chmod(filePath, 0o644);
            }
          }
        }
      }
      try {
        await this.runGitCmd("add -A", activePath);
        await this.runGitCmd('commit -m "Refreshed and self-healed workspace from Postgres"', activePath);
      } catch {
        // commit failure during self-healing warning is ignored
      }
    }
  }

  async createRepository(args: StemmaCreateArgs): Promise<StemmaCreateOutcome> {
    // 1. Core database creation block
    const outcome = await this.dbStemma.createRepository(args);
    if (outcome.kind !== "ok") return outcome;

    // 2. Scaffold workspace files on local node disk
    try {
      await this.ensureGitWorkspaceInitialized(args.proposedRid, args.defaultBranchName);
    } catch (err) {
      console.error(`[DiskStemma] Failed to construct disk repository directories:`, err);
    }
    return outcome;
  }

  async tombstone(args: { repositoryRid: string }): Promise<void> {
    // 1. Delete workspace on disk
    try {
      const repoPath = path.join(this.reposRoot, args.repositoryRid);
      await fs.rm(repoPath, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[DiskStemma] Tombstone disk wipe issue for ${args.repositoryRid}:`, err);
    }

    // 2. Cascade metadata purge to DB
    await this.dbStemma.tombstone(args);
  }

  async commitFiles(args: StemmaCommitFilesArgs): Promise<StemmaCommitFilesOutcome> {
    // 1. Drive commit through database first for transaction consistency & Ref validation
    const outcome = await this.dbStemma.commitFiles(args);
    if (outcome.kind !== "ok") return outcome;

    // 2. Write to physical workspace on success
    try {
      const branchPath = await this.ensureGitWorkspaceInitialized(args.repositoryRid, args.branch);
      
      // Handle file additions/updates
      for (const file of args.files) {
        const filePath = path.join(branchPath, file.path);
        // Ensure folder tree is nested correctly
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, file.content);
        if (file.mode === "100755") {
          await fs.chmod(filePath, 0o755);
        } else {
          await fs.chmod(filePath, 0o644);
        }
      }

      // Handle deletes
      if (args.deletePaths && args.deletePaths.length > 0) {
        for (const deletePath of args.deletePaths) {
          const filePath = path.join(branchPath, deletePath);
          try {
            await fs.unlink(filePath);
          } catch {
            // Idempotent deletion tolerates non-existent paths
          }
        }
      }

      // Capture state in Git tracking
      try {
        await this.runGitCmd("add -A", branchPath);
        const escapedMsg = args.message.replace(/"/g, '\\"');
        await this.runGitCmd(`commit -m "${escapedMsg}"`, branchPath);
      } catch (err) {
        // Tolerates duplicate git commits with no index drifts
      }
    } catch (err) {
      console.error(`[DiskStemma] Dual-write commit to disk directories failed:`, err);
    }

    return outcome;
  }

  async createBranch(args: StemmaCreateBranchArgs): Promise<StemmaCreateBranchOutcome> {
    // 1. Commit/Fork through DB
    const outcome = await this.dbStemma.createBranch(args);
    if (outcome.kind !== "ok") return outcome;

    // 2. Migrate files to new branch path on disk
    try {
      await this.ensureDiskWorkspaceRehydrated(args.repositoryRid, args.fromBranch);
      const fromPath = path.join(this.reposRoot, args.repositoryRid, args.fromBranch);
      const toPath = path.join(this.reposRoot, args.repositoryRid, args.newBranch);

      await fs.cp(fromPath, toPath, { recursive: true });
      // Reset Git tracking inside new branch workspace
      await fs.rm(path.join(toPath, ".git"), { recursive: true, force: true }).catch(() => {});
      await this.ensureGitWorkspaceInitialized(args.repositoryRid, args.newBranch);
      const branchCwd = path.join(this.reposRoot, args.repositoryRid, args.newBranch);
      try {
        await this.runGitCmd("add -A", branchCwd);
        await this.runGitCmd(`commit -m "Branched from ${args.fromBranch}"`, branchCwd);
      } catch {
        // Ignore committing unstaged drifts
      }
    } catch (err) {
      console.error(`[DiskStemma] File copying to new fork failed:`, err);
    }

    return outcome;
  }

  async deleteBranch(args: StemmaDeleteBranchArgs): Promise<StemmaDeleteBranchOutcome> {
    const outcome = await this.dbStemma.deleteBranch(args);
    if (outcome.kind !== "ok") return outcome;

    try {
      const branchPath = path.join(this.reposRoot, args.repositoryRid, args.branch);
      await fs.rm(branchPath, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[DiskStemma] Disk cleanup for branch delete failed:`, err);
    }
    return outcome;
  }

  async listBranches(args: { repositoryRid: string }): Promise<StemmaListBranchesOutcome> {
    return this.dbStemma.listBranches(args);
  }

  async listTree(args: StemmaListTreeArgs): Promise<StemmaListTreeOutcome> {
    // Bring physical workspace back up to current sync state before listing
    await this.ensureDiskWorkspaceRehydrated(args.repositoryRid, args.branch).catch((err) => {
      console.warn(`[DiskStemma] Read self-heal missed for ${args.repositoryRid}/${args.branch}:`, err);
    });
    return this.dbStemma.listTree(args);
  }

  async readBlob(args: StemmaReadBlobArgs): Promise<StemmaReadBlobOutcome> {
    return this.dbStemma.readBlob(args);
  }

  // --- duck-typed rehydrate capabilities -----------------------------------
  async exists(rid: string): Promise<boolean> {
    return this.dbStemma.exists(rid);
  }

  async isTombstoned(rid: string): Promise<boolean> {
    return this.dbStemma.isTombstoned(rid);
  }
}
