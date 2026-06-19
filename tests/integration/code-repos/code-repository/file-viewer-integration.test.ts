// ---------------------------------------------------------------------------
// B2-C-10 / B2-C-11 — file-viewer route integration tests.
//
// Real Postgres (schema-isolated) + in-memory Stemma adapter.
//
// Spec contracts proven:
//   B2-C-10  GET /:rid/branches/:branch/tree happy + ETag + If-None-Match
//   B2-C-11  GET /:rid/branches/:branch/files happy + size cap + binary
//   §1.3     §1.3 envelope on every error path (errorCode/errorName/etc.)
//   G-C-09   IDOR-as-404 for unknown rid / unknown branch
//   G-C-13   path / depth / branch validation grammars
//   G-C-51   audit row emitted per read
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { openTestSchema, type TestSchema } from "../_helpers/pg";
import {
  InMemoryCompass,
  InMemoryStemma,
  InMemoryTemplate,
} from "../../../../src/services/codeRepository/adapters/inMemory";
import { createCodeRepositoryApp } from "../../../../src/services/codeRepository/admin/app";

import type { Express } from "express";

const MIGS = [
  "050_stemma_ddl.sql",
  "051_code_repos_audit.sql",
  "053_b2_code_repository.sql",
];
let schema: TestSchema;
let app: Express;
let compass: InMemoryCompass;
let stemma: InMemoryStemma;
let template: InMemoryTemplate;

beforeAll(async () => {
  schema = await openTestSchema("b2_file_viewer");
  for (const f of MIGS) {
    const sql = readFileSync(
      path.resolve(process.cwd(), `src/migrations/${f}`),
      "utf8",
    );
    await schema.pool.query(sql);
  }
});

afterAll(async () => {
  await schema.close();
});

const FOLDER_RID =
  "ri.compass.main.folder.0123abcd-ef01-4345-8789-abcdef012345";

let idemCounter = 0;
function nextIdem(): string {
  idemCounter += 1;
  const hex = (n: number) => n.toString(16).padStart(8, "0");
  return `${hex(idemCounter)}-aaaa-4bbb-8ccc-dddddddddddd`;
}

function withAuth(req: request.Test): request.Test {
  return req.set("X-Tellus-Test-Principal", "alice");
}

beforeEach(() => {
  compass = new InMemoryCompass();
  stemma = new InMemoryStemma();
  // Wire stemma into the template so scaffoldAndPush actually materializes
  // the B3 manifest's file list (the fix that replaced DEFAULT_SCAFFOLD).
  // Without this the legacy fake-commit fallback fires and the tree
  // would be empty.
  template = new InMemoryTemplate({ stemma });
  app = createCodeRepositoryApp({
    pool: schema.pool,
    compass,
    stemma,
    template,
  });
});

async function createRepo(displayName: string): Promise<string> {
  const r = await withAuth(
    request(app)
      .post("/api/v1/code-repositories")
      .set("Idempotency-Key", nextIdem())
      .send({
        displayName,
        parentFolderRid: FOLDER_RID,
        templateId: "typescript-functions",
        templateVersion: "2.4.0",
        defaultBranch: "main",
      }),
  );
  if (r.status !== 201) {
    throw new Error(`createRepository failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return r.body.rid as string;
}

// ---------------------------------------------------------------------------
// GET /tree — happy path + ETag (B2-C-10)
// ---------------------------------------------------------------------------

describe("B2-C-10 GET /:rid/branches/:branch/tree", () => {
  it("returns the seeded tree at root depth=1 (v2 typescript-functions scaffold)", async () => {
    const rid = await createRepo("Happy");
    const r = await withAuth(
      request(app).get(
        `/api/v1/code-repositories/${encodeURIComponent(rid)}/branches/main/tree`,
      ),
    );
    expect(r.status).toBe(200);
    expect(r.body.branch).toBe("main");
    expect(r.body.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.body.truncated).toBe(false);
    const paths = (r.body.entries as Array<{ path: string }>).map((e) => e.path);
    // v2 scaffold root: gradle wrapper metadata, repoSettings,
    // and the `typescript-functions/` language subproject directory.
    expect(paths).toContain("templateConfig.json");
    expect(paths).toContain("repoSettings.json");
    expect(paths).toContain("typescript-functions");
    // `src/` no longer lives at root in v2 — it's inside the subproject.
    expect(paths).not.toContain("src");
    expect(paths).not.toContain("typescript-functions/package.json");
    expect(r.headers.etag).toMatch(/^"[0-9a-f]{40}"$/);
  });

  it("depth=2 reaches one level into the typescript-functions/ subproject", async () => {
    const rid = await createRepo("Depth2");
    const r = await withAuth(
      request(app).get(
        `/api/v1/code-repositories/${encodeURIComponent(rid)}/branches/main/tree?depth=2`,
      ),
    );
    expect(r.status).toBe(200);
    const paths = (r.body.entries as Array<{ path: string }>).map((e) => e.path);
    expect(paths).toContain("typescript-functions/package.json");
    expect(paths).toContain("typescript-functions/src");
    expect(paths).toContain("typescript-functions/test");
    expect(paths).toContain("gradle/wrapper");
    // depth=2 stops short of the leaf function file (depth=3).
    expect(paths).not.toContain("typescript-functions/src/functions/helloWorld.ts");
  });

  it("path query scopes to a subtree", async () => {
    const rid = await createRepo("Sub");
    const r = await withAuth(
      request(app).get(
        `/api/v1/code-repositories/${encodeURIComponent(rid)}/branches/main/tree?path=typescript-functions`,
      ),
    );
    expect(r.status).toBe(200);
    const paths = (r.body.entries as Array<{ path: string }>).map((e) => e.path);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p.startsWith("typescript-functions")).toBe(true);
    }
  });

  it("If-None-Match returns 304 when ETag matches", async () => {
    const rid = await createRepo("Etag");
    const first = await withAuth(
      request(app).get(
        `/api/v1/code-repositories/${encodeURIComponent(rid)}/branches/main/tree`,
      ),
    );
    expect(first.status).toBe(200);
    const etag = first.headers.etag as string;
    const second = await withAuth(
      request(app)
        .get(
          `/api/v1/code-repositories/${encodeURIComponent(rid)}/branches/main/tree`,
        )
        .set("If-None-Match", etag),
    );
    expect(second.status).toBe(304);
  });

  it("rejects path traversal (..) with 400 InvalidPath", async () => {
    const rid = await createRepo("Trav");
    const r = await withAuth(
      request(app).get(
        `/api/v1/code-repositories/${encodeURIComponent(rid)}/branches/main/tree?path=src/../etc`,
      ),
    );
    expect(r.status).toBe(400);
    expect(r.body.errorName).toBe("CodeRepos:InvalidPath");
    expect(r.body.parameters?.reason).toBe("traversal");
  });

  it("rejects depth=0 with 400 InvalidDepth", async () => {
    const rid = await createRepo("Depth0");
    const r = await withAuth(
      request(app).get(
        `/api/v1/code-repositories/${encodeURIComponent(rid)}/branches/main/tree?depth=0`,
      ),
    );
    expect(r.status).toBe(400);
    expect(r.body.errorName).toBe("CodeRepos:InvalidDepth");
  });

  it("rejects depth=99 with 400 InvalidDepth", async () => {
    const rid = await createRepo("Depth99");
    const r = await withAuth(
      request(app).get(
        `/api/v1/code-repositories/${encodeURIComponent(rid)}/branches/main/tree?depth=99`,
      ),
    );
    expect(r.status).toBe(400);
    expect(r.body.errorName).toBe("CodeRepos:InvalidDepth");
  });

  it("returns 404 RepositoryNotFound for unknown rid (G-C-09 IDOR-as-404)", async () => {
    const fakeRid =
      "ri.stemma.main.repository.99999999-9999-4999-8999-999999999999";
    const r = await withAuth(
      request(app).get(
        `/api/v1/code-repositories/${encodeURIComponent(fakeRid)}/branches/main/tree`,
      ),
    );
    expect(r.status).toBe(404);
    expect(r.body.errorName).toBe("CodeRepos:RepositoryNotFound");
  });

  it("returns 404 BranchNotFound for unknown branch", async () => {
    const rid = await createRepo("MissingBranch");
    const r = await withAuth(
      request(app).get(
        `/api/v1/code-repositories/${encodeURIComponent(rid)}/branches/release/tree`,
      ),
    );
    expect(r.status).toBe(404);
    expect(r.body.errorName).toBe("CodeRepos:BranchNotFound");
  });

  it("emits one audit row per successful read (G-C-51)", async () => {
    const rid = await createRepo("Audit");
    const before = await schema.pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM code_repos_audit_events
        WHERE category = 'code_repository' AND action = 'readTree'`,
    );
    await withAuth(
      request(app).get(
        `/api/v1/code-repositories/${encodeURIComponent(rid)}/branches/main/tree`,
      ),
    );
    const after = await schema.pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM code_repos_audit_events
        WHERE category = 'code_repository' AND action = 'readTree'`,
    );
    expect(after.rows[0].c - before.rows[0].c).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// GET /files — happy path + size cap + binary (B2-C-11)
// ---------------------------------------------------------------------------

describe("B2-C-11 GET /:rid/branches/:branch/files", () => {
  it("returns typescript-functions/package.json as utf-8", async () => {
    const rid = await createRepo("PkgJson");
    const r = await withAuth(
      request(app).get(
        `/api/v1/code-repositories/${encodeURIComponent(rid)}/branches/main/files?path=typescript-functions/package.json`,
      ),
    );
    expect(r.status).toBe(200);
    expect(r.body.encoding).toBe("utf-8");
    expect(r.body.isBinary).toBe(false);
    expect(r.body.truncated).toBe(false);
    expect(r.body.mimeType).toBe("application/json");
    // v2 scaffold's package.json interpolates `{{packageName}}` (slugified
    // from the displayName "PkgJson" → "pkgjson") in the `name` field.
    expect(r.body.content).toMatch(/"name":\s*"pkgjson"/);
    // OSDK v2 deps must be present (Wave 22 contract).
    expect(r.body.content).toMatch(/@osdk\/functions/);
    expect(r.body.content).toMatch(/@osdk\/client/);
    expect(r.body.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.headers.etag).toMatch(/^"[0-9a-f]{40}"$/);
  });

  it("returns 304 on If-None-Match match", async () => {
    const rid = await createRepo("Etag2");
    const a = await withAuth(
      request(app).get(
        `/api/v1/code-repositories/${encodeURIComponent(rid)}/branches/main/files?path=templateConfig.json`,
      ),
    );
    expect(a.status).toBe(200);
    const b = await withAuth(
      request(app)
        .get(
          `/api/v1/code-repositories/${encodeURIComponent(rid)}/branches/main/files?path=templateConfig.json`,
        )
        .set("If-None-Match", a.headers.etag),
    );
    expect(b.status).toBe(304);
  });

  it("returns 200 + truncated:true and empty body when size > 5 MiB", async () => {
    const rid = await createRepo("Big");
    // Re-seed the branch with one ~6 MiB blob.
    const big = Buffer.alloc(6 * 1024 * 1024 + 1, 0x41); // 'A'
    stemma.seedBranch(rid, "main", {
      headCommitSha: "0000000000000000000000000000000000000099",
      files: [
        { path: "BIG.txt", content: new Uint8Array(big) },
        { path: "OK.txt", content: "ok" },
      ],
    });
    const r = await withAuth(
      request(app).get(
        `/api/v1/code-repositories/${encodeURIComponent(rid)}/branches/main/files?path=BIG.txt`,
      ),
    );
    expect(r.status).toBe(200);
    expect(r.body.truncated).toBe(true);
    expect(r.body.content).toBe("");
    expect(r.body.size).toBe(big.byteLength);
  });

  it("returns 200 + base64 + isBinary:true for an image", async () => {
    const rid = await createRepo("Img");
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
    ]);
    stemma.seedBranch(rid, "main", {
      headCommitSha: "0000000000000000000000000000000000000098",
      files: [{ path: "logo.png", content: png }],
    });
    const r = await withAuth(
      request(app).get(
        `/api/v1/code-repositories/${encodeURIComponent(rid)}/branches/main/files?path=logo.png`,
      ),
    );
    expect(r.status).toBe(200);
    expect(r.body.isBinary).toBe(true);
    expect(r.body.encoding).toBe("base64");
    expect(r.body.mimeType).toBe("image/png");
    expect(Buffer.from(r.body.content, "base64").equals(Buffer.from(png))).toBe(
      true,
    );
  });

  it("returns 404 InvalidPathType when caller asks for a directory", async () => {
    const rid = await createRepo("Dir");
    const r = await withAuth(
      request(app).get(
        `/api/v1/code-repositories/${encodeURIComponent(rid)}/branches/main/files?path=typescript-functions`,
      ),
    );
    expect(r.status).toBe(404);
    expect(r.body.errorName).toBe("CodeRepos:InvalidPathType");
  });

  it("returns 404 FileNotFound for unknown path", async () => {
    const rid = await createRepo("Missing");
    const r = await withAuth(
      request(app).get(
        `/api/v1/code-repositories/${encodeURIComponent(rid)}/branches/main/files?path=nope.ts`,
      ),
    );
    expect(r.status).toBe(404);
    expect(r.body.errorName).toBe("CodeRepos:FileNotFound");
  });

  it("returns 400 InvalidPath when path is missing", async () => {
    const rid = await createRepo("NoPath");
    const r = await withAuth(
      request(app).get(
        `/api/v1/code-repositories/${encodeURIComponent(rid)}/branches/main/files`,
      ),
    );
    expect(r.status).toBe(400);
    expect(r.body.errorName).toBe("CodeRepos:InvalidPath");
  });

  it("returns 400 InvalidPath on null-byte injection", async () => {
    const rid = await createRepo("Nul");
    const r = await withAuth(
      request(app).get(
        `/api/v1/code-repositories/${encodeURIComponent(rid)}/branches/main/files?path=src/index%00.ts`,
      ),
    );
    expect(r.status).toBe(400);
    expect(r.body.errorName).toBe("CodeRepos:InvalidPath");
    expect(r.body.parameters?.reason).toBe("null-byte");
  });

  it("emits one audit row per successful file read (G-C-51)", async () => {
    const rid = await createRepo("AuditFile");
    const before = await schema.pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM code_repos_audit_events
        WHERE category = 'code_repository' AND action = 'readFile'`,
    );
    const r = await withAuth(
      request(app).get(
        `/api/v1/code-repositories/${encodeURIComponent(rid)}/branches/main/files?path=templateConfig.json`,
      ),
    );
    expect(r.status).toBe(200);
    const after = await schema.pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM code_repos_audit_events
        WHERE category = 'code_repository' AND action = 'readFile'`,
    );
    expect(after.rows[0].c - before.rows[0].c).toBe(1);
  });

  it("401 Unauthenticated when no test-principal header", async () => {
    const rid = await createRepo("Unauth");
    const r = await request(app).get(
      `/api/v1/code-repositories/${encodeURIComponent(rid)}/branches/main/files?path=templateConfig.json`,
    );
    expect(r.status).toBe(401);
  });
});
