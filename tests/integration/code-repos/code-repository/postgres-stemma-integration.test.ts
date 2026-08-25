// ---------------------------------------------------------------------------
// PostgresStemma — durable StemmaAdapter integration tests.
//
// Verifies the adapter that replaced the in-memory Stemma so committed code
// survives a backend restart (migration 086). The "restart" is simulated by
// constructing a SECOND PostgresStemma over the same pool and asserting the
// content is still there.
// ---------------------------------------------------------------------------

import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { openTestSchema, type TestSchema } from "../_helpers/pg";
import { PostgresStemma } from "../../../../src/services/codeRepository/adapters/postgres";

let schema: TestSchema;
const RID = "ri.stemma.main.repository.11111111-2222-4333-8444-555555555555";
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

describe("PostgresStemma — durable adapter", () => {
  it("creates a repo, commits files, and lists/reads them back", async () => {
    const stemma = new PostgresStemma({ pool: schema.pool });
    const created = await stemma.createRepository({
      proposedRid: RID,
      defaultBranchName: "main",
      principalSub: "tester",
    });
    expect(created.kind).toBe("ok");

    const tree0 = await stemma.listTree({ repositoryRid: RID, branch: "main", path: "", depth: 5 });
    expect(tree0.kind).toBe("ok");
    const parent = tree0.kind === "ok" ? tree0.branchHead : "";

    const commit = await stemma.commitFiles({
      repositoryRid: RID,
      branch: "main",
      parentSha: parent,
      message: "add fn",
      principalSub: "tester",
      files: [
        { path: "src/functions/add.ts", content: enc("export default (x:number)=>x+1;\n"), mode: "100644" },
        { path: "README.md", content: enc("# demo\n"), mode: "100644" },
      ],
    });
    expect(commit.kind).toBe("ok");
    if (commit.kind === "ok") expect(commit.fileCount).toBe(2);

    const blob = await stemma.readBlob({ repositoryRid: RID, branch: "main", path: "src/functions/add.ts" });
    expect(blob.kind).toBe("ok");
    if (blob.kind === "ok") {
      expect(new TextDecoder().decode(blob.content)).toContain("export default");
    }
  });

  it("CAS: a stale parentSha is rejected with stale-ref", async () => {
    const stemma = new PostgresStemma({ pool: schema.pool });
    const r = await stemma.commitFiles({
      repositoryRid: RID,
      branch: "main",
      parentSha: "0000000000000000000000000000000000000000", // wrong head
      message: "stale",
      principalSub: "tester",
      files: [{ path: "src/functions/x.ts", content: enc("export default 1;"), mode: "100644" }],
    });
    expect(r.kind).toBe("stale-ref");
  });

  it("persists across adapter instances (simulated restart)", async () => {
    // A brand-new PostgresStemma over the same pool == the same DB == a restart.
    const afterRestart = new PostgresStemma({ pool: schema.pool });
    expect(await afterRestart.exists(RID)).toBe(true);
    const tree = await afterRestart.listTree({ repositoryRid: RID, branch: "main", path: "src/functions", depth: 2 });
    expect(tree.kind).toBe("ok");
    if (tree.kind === "ok") {
      const files = tree.entries.filter((e) => e.type === "blob").map((e) => e.name);
      expect(files).toContain("add.ts");
    }
  });

  it("createBranch forks files + head; deleteBranch removes it", async () => {
    const stemma = new PostgresStemma({ pool: schema.pool });
    // fresh repo for branch ops
    const rid2 = "ri.stemma.main.repository.99999999-8888-4777-8666-555555555555";
    await stemma.createRepository({ proposedRid: rid2, defaultBranchName: "main", principalSub: "t" });
    const t0 = await stemma.listTree({ repositoryRid: rid2, branch: "main", path: "", depth: 5 });
    const parent = t0.kind === "ok" ? t0.branchHead : "";
    await stemma.commitFiles({
      repositoryRid: rid2, branch: "main", parentSha: parent, message: "seed", principalSub: "t",
      files: [{ path: "src/functions/a.ts", content: enc("export default 1;"), mode: "100644" }],
    });

    const cb = await stemma.createBranch({ repositoryRid: rid2, newBranch: "feature/x", fromBranch: "main" });
    expect(cb.kind).toBe("ok");
    // the new branch has the forked file
    const tree = await stemma.listTree({ repositoryRid: rid2, branch: "feature/x", path: "src/functions", depth: 2 });
    expect(tree.kind).toBe("ok");
    if (tree.kind === "ok") {
      expect(tree.entries.filter((e) => e.type === "blob").map((e) => e.name)).toContain("a.ts");
    }
    // duplicate name → branch-exists; unknown source → source-not-found
    expect((await stemma.createBranch({ repositoryRid: rid2, newBranch: "feature/x", fromBranch: "main" })).kind).toBe("branch-exists");
    expect((await stemma.createBranch({ repositoryRid: rid2, newBranch: "z", fromBranch: "nope" })).kind).toBe("source-not-found");

    // delete it back
    expect((await stemma.deleteBranch({ repositoryRid: rid2, branch: "feature/x" })).kind).toBe("ok");
    expect((await stemma.deleteBranch({ repositoryRid: rid2, branch: "feature/x" })).kind).toBe("not-found");
    const gone = await stemma.listTree({ repositoryRid: rid2, branch: "feature/x", path: "", depth: 5 });
    expect(gone.kind).toBe("branch-not-found");
  });

  it("tombstone makes reads return branch-not-found", async () => {
    const stemma = new PostgresStemma({ pool: schema.pool });
    await stemma.tombstone({ repositoryRid: RID });
    const tree = await stemma.listTree({ repositoryRid: RID, branch: "main", path: "", depth: 5 });
    expect(tree.kind).toBe("branch-not-found");
    expect(await stemma.exists(RID)).toBe(false);

    // GC guarantee: tombstone() must free the Stemma content rows, not just
    // flip the tombstoned flag. Branch rows are deleted (migration 086 FK
    // ON DELETE CASCADE removes the blobs), so neither branches nor blobs
    // linger. This is the delete->GC contract the DELETE /:rid route relies on.
    const br = await schema.pool.query(
      "SELECT count(*) AS n FROM coderepo_stemma_branch WHERE repository_rid = $1",
      [RID],
    );
    const bl = await schema.pool.query(
      "SELECT count(*) AS n FROM coderepo_stemma_blob WHERE repository_rid = $1",
      [RID],
    );
    expect(Number(br.rows[0].n)).toBe(0);
    expect(Number(bl.rows[0].n)).toBe(0);
  });
});
