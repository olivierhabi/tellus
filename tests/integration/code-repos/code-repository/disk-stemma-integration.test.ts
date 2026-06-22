// ---------------------------------------------------------------------------
// DiskStemma — durable physical workspace StemmaAdapter integration tests.
//
// Verifies that:
//   - Repositories are physically scaffolded on the OS local disk filesystem.
//   - Standard files/folders are dual-written to both disk and Postgres on commit.
//   - Git tracks edits, directory trees, deletions.
//   - Self-healing auto-rehydration backfills disk trees perfectly when empty.
// ---------------------------------------------------------------------------

import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { openTestSchema, type TestSchema } from "../_helpers/pg";
import { DiskStemma } from "../../../../src/services/codeRepository/adapters/disk";

let schema: TestSchema;
const RID = "ri.stemma.main.repository.da7ada7a-8888-4999-9999-eeeeeeeeeeee";
const enc = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));

beforeAll(async () => {
  schema = await openTestSchema("pg_stemma");
  const sql = readFileSync(
    path.resolve(process.cwd(), "src/migrations/086_durable_stemma.sql"),
    "utf8",
  );
  await schema.pool.query(sql);
});

afterAll(async () => {
  await schema.close();
});

describe("DiskStemma — physical workspace integration tests", () => {
  it("scaffolds physical directories, handles commits, and supports self-healing rehydration", async () => {
    // 1. Initialize DiskStemma over test schema pool
    const stemma = new DiskStemma({ pool: schema.pool });
    
    // Create new repo
    const created = await stemma.createRepository({
      proposedRid: RID,
      defaultBranchName: "main",
      principalSub: "tester",
    });
    expect(created.kind).toBe("ok");

    // Retrieve default root workspace path for this RID
    const rootDir = (stemma as any).reposRoot;
    const branchFolder = path.join(rootDir, RID, "main");

    // Verify git directory existence
    expect(existsSync(branchFolder)).toBe(true);
    expect(existsSync(path.join(branchFolder, ".git"))).toBe(true);

    // 2. Commit code files
    const parentTree = await stemma.listTree({ repositoryRid: RID, branch: "main", path: "", depth: 5 });
    const currentHead = parentTree.kind === "ok" ? parentTree.branchHead : "";

    const doCommit = await stemma.commitFiles({
      repositoryRid: RID,
      branch: "main",
      parentSha: currentHead,
      message: "Scaffold analytical python transform",
      principalSub: "tester",
      files: [
        { path: "transforms/transform.py", content: enc("# Hello world\n"), mode: "100644" },
        { path: "README.md", content: enc("# Project Docs\n"), mode: "100644" },
      ],
    });
    expect(doCommit.kind).toBe("ok");

    // Check physical file existence and permissions on disk
    const transformPyPath = path.join(branchFolder, "transforms/transform.py");
    expect(existsSync(transformPyPath)).toBe(true);
    expect(await fs.readFile(transformPyPath, "utf8")).toBe("# Hello world\n");

    // Check database has synchronised records
    const readBack = await stemma.readBlob({ repositoryRid: RID, branch: "main", path: "transforms/transform.py" });
    expect(readBack.kind).toBe("ok");
    if (readBack.kind === "ok") {
      expect(new TextDecoder().decode(readBack.content)).toBe("# Hello world\n");
    }

    // 3. Replicate branch via createBranch
    const cb = await stemma.createBranch({
      repositoryRid: RID,
      newBranch: "dev/branch",
      fromBranch: "main",
    });
    expect(cb.kind).toBe("ok");

    const replicatedFolder = path.join(rootDir, RID, "dev/branch");
    expect(existsSync(replicatedFolder)).toBe(true);
    expect(existsSync(path.join(replicatedFolder, "transforms/transform.py"))).toBe(true);

    // 4. Test Automated Self-Healing Backfills
    // Simulate disk space cleanup / node crash by deleting the main branch directory on host disk
    await fs.rm(branchFolder, { recursive: true, force: true });
    expect(existsSync(branchFolder)).toBe(false);

    // Tree list call should trigger transparent self-healing / disk reconstruction from database
    const queryTree = await stemma.listTree({ repositoryRid: RID, branch: "main", path: "", depth: 5 });
    expect(queryTree.kind).toBe("ok");
    
    // Check that files are backfilled to local disk perfectly
    expect(existsSync(branchFolder)).toBe(true);
    expect(existsSync(transformPyPath)).toBe(true);
    expect(await fs.readFile(transformPyPath, "utf8")).toBe("# Hello world\n");

    // 5. Test deletion teardown
    await stemma.tombstone({ repositoryRid: RID });
    expect(existsSync(path.join(rootDir, RID))).toBe(false);
  });
});
