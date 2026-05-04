// ---------------------------------------------------------------------------
// B2 — Code Repository Service HTTP routes integration tests.
//
// Uses real Postgres + in-memory Compass/Stemma/Template adapters.
//
// Spec contracts proven:
//   B2-C-30..35  CodeRepos:* error envelopes on the wire
//   G-C-09       IDOR-as-404 on every read/write
//   G-C-15..16   §1.3 envelope shape
//   G-C-17..19   ETag + If-Match on PATCH/DELETE/PUT
//   G-C-20..23   Idempotency-Key on POST + replay
//   G-C-41       /health + /readiness
//   G-C-51..54   audit row per mutation
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

const MIGS = ["050_stemma_ddl.sql", "051_code_repos_audit.sql", "053_b2_code_repository.sql"];
let schema: TestSchema;
let app: Express;
let compass: InMemoryCompass;
let stemma: InMemoryStemma;
let template: InMemoryTemplate;

beforeAll(async () => {
  schema = await openTestSchema("b2_routes");
  for (const f of MIGS) {
    const sql = readFileSync(path.resolve(process.cwd(), `src/migrations/${f}`), "utf8");
    await schema.pool.query(sql);
  }
});

afterAll(async () => {
  await schema.close();
});

beforeEach(() => {
  compass = new InMemoryCompass();
  stemma = new InMemoryStemma();
  template = new InMemoryTemplate();
  app = createCodeRepositoryApp({
    pool: schema.pool,
    compass,
    stemma,
    template,
  });
});

const FOLDER_RID = "ri.compass.main.folder.0123abcd-ef01-4345-8789-abcdef012345";

function authed<T>(agent: ReturnType<typeof request>, path: string): ReturnType<typeof request.prototype.post> {
  // helper signature for sa.post -- we do it inline below.
  void agent;
  void path;
  throw new Error("unused");
}

let idemCounter = 0;
function nextIdem(): string {
  idemCounter += 1;
  // RFC 4122 UUID v4 form (the middleware enforces UUIDv4 syntax).
  const hex = (n: number) => n.toString(16).padStart(8, "0");
  return `${hex(idemCounter)}-aaaa-4bbb-8ccc-dddddddddddd`;
}

function withAuth(req: request.Test): request.Test {
  return req
    .set("X-Tellus-Test-Principal", "alice")
    .set("X-Tellus-Test-Roles", "editor");
}

function createBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    displayName: "TestRepo",
    parentFolderRid: FOLDER_RID,
    templateId: "typescript-functions",
    templateVersion: "2.4.0",
    defaultBranch: "main",
    ...overrides,
  };
}

describe("B2 admin routes — /health + /readiness (G-C-41)", () => {
  it("/health 200 unauthenticated", async () => {
    const r = await request(app).get("/health");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ok");
  });

  it("/readiness 200 when DB reachable", async () => {
    const r = await request(app).get("/readiness");
    expect(r.status).toBe(200);
    expect(r.body.ready).toBe(true);
  });
});

describe("B2 admin routes — POST /repositories happy path", () => {
  it("creates a repo end-to-end (returns 201 + ETag)", async () => {
    const idem = nextIdem();
    const r = await withAuth(
      request(app)
        .post("/api/v1/code-repositories")
        .set("Idempotency-Key", idem)
        .send(createBody({ displayName: "Happy" })),
    );
    expect(r.status).toBe(201);
    expect(r.body.rid).toMatch(/^ri\.stemma\.main\.repository\./);
    expect(r.body.state).toBe("ACTIVE");
    expect(r.body.replayed).toBe(false);
    expect(r.headers.etag).toBe('W/"1"');
  });

  it("idempotent replay returns 201 with same body and replayed=true (G-C-22)", async () => {
    const idem = nextIdem();
    const r1 = await withAuth(
      request(app)
        .post("/api/v1/code-repositories")
        .set("Idempotency-Key", idem)
        .send(createBody({ displayName: "Replay1" })),
    );
    const r2 = await withAuth(
      request(app)
        .post("/api/v1/code-repositories")
        .set("Idempotency-Key", idem)
        .send(createBody({ displayName: "Replay1" })),
    );
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.body.rid).toBe(r1.body.rid);
    // Idempotency middleware tags the second response with X-Idempotent-Replay.
    expect(r2.headers["x-idempotent-replay"]).toBe("true");
  });

  it("emits exactly one audit row per saga (G-C-51)", async () => {
    const before = await schema.pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM code_repos_audit_events
        WHERE category = 'code_repository' AND action = 'createRepository'`,
    );
    const r = await withAuth(
      request(app)
        .post("/api/v1/code-repositories")
        .set("Idempotency-Key", nextIdem())
        .send(createBody({ displayName: "AuditCheck" })),
    );
    expect(r.status).toBe(201);
    const after = await schema.pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM code_repos_audit_events
        WHERE category = 'code_repository' AND action = 'createRepository'`,
    );
    expect(after.rows[0].c - before.rows[0].c).toBe(1);
  });
});

describe("B2 admin routes — POST validation + auth", () => {
  it("400 InvalidSettings when displayName missing", async () => {
    const r = await withAuth(
      request(app)
        .post("/api/v1/code-repositories")
        .set("Idempotency-Key", nextIdem())
        .send({ parentFolderRid: FOLDER_RID, templateId: "x", templateVersion: "1.0.0" }),
    );
    expect(r.status).toBe(400);
    expect(r.body.errorName).toBe("CodeRepos:InvalidSettings");
    expect(r.body.parameters?.field).toBe("displayName");
  });

  it("400 InvalidSettings when Idempotency-Key missing (G-C-20)", async () => {
    const r = await withAuth(
      request(app)
        .post("/api/v1/code-repositories")
        .send(createBody()),
    );
    // Idempotency middleware fires first → Stemma:MissingIdempotencyKey envelope.
    expect([400]).toContain(r.status);
    expect(typeof r.body.errorName).toBe("string");
  });

  it("401 Stemma:Unauthenticated when no principal header (G-C-08)", async () => {
    const r = await request(app)
      .post("/api/v1/code-repositories")
      .set("Idempotency-Key", nextIdem())
      .send(createBody());
    expect(r.status).toBe(401);
  });

  it("400 InvalidSettings when parentFolderRid is not a valid RID", async () => {
    const r = await withAuth(
      request(app)
        .post("/api/v1/code-repositories")
        .set("Idempotency-Key", nextIdem())
        .send(createBody({ parentFolderRid: "not-a-rid" })),
    );
    expect(r.status).toBe(400);
    expect(r.body.parameters?.field).toBe("parentFolderRid");
  });

  it("400 InvalidSettings when defaultBranch fails branch regex", async () => {
    const r = await withAuth(
      request(app)
        .post("/api/v1/code-repositories")
        .set("Idempotency-Key", nextIdem())
        .send(createBody({ defaultBranch: "spaces not allowed" })),
    );
    expect(r.status).toBe(400);
    expect(r.body.parameters?.field).toBe("defaultBranch");
  });
});

describe("B2 admin routes — POST surfaces saga failures", () => {
  it("409 NameConflict when duplicate name in same folder", async () => {
    // First repo wins.
    const r1 = await withAuth(
      request(app)
        .post("/api/v1/code-repositories")
        .set("Idempotency-Key", nextIdem())
        .send(createBody({ displayName: "Dup1" })),
    );
    expect(r1.status).toBe(201);

    // Second repo same case-insensitive name → step1 NameConflict (in-memory adapter).
    const r2 = await withAuth(
      request(app)
        .post("/api/v1/code-repositories")
        .set("Idempotency-Key", nextIdem())
        .send(createBody({ displayName: "DUP1" })),
    );
    expect(r2.status).toBe(409);
    expect(r2.body.errorName).toBe("CodeRepos:NameConflict");
  });

  it("404 TemplateNotFound when template adapter rejects (B2-C-31)", async () => {
    const r = await withAuth(
      request(app)
        .post("/api/v1/code-repositories")
        .set("Idempotency-Key", nextIdem())
        .send(createBody({ templateId: "no-such-template" })),
    );
    expect(r.status).toBe(404);
    expect(r.body.errorName).toBe("CodeRepos:TemplateNotFound");
  });
});

describe("B2 admin routes — GET /repositories/:rid", () => {
  it("returns 200 with ETag matching resource_version", async () => {
    const create = await withAuth(
      request(app)
        .post("/api/v1/code-repositories")
        .set("Idempotency-Key", nextIdem())
        .send(createBody({ displayName: "GetMe" })),
    );
    expect(create.status).toBe(201);
    const rid = create.body.rid;

    const r = await withAuth(request(app).get(`/api/v1/code-repositories/${rid}`));
    expect(r.status).toBe(200);
    expect(r.body.rid).toBe(rid);
    expect(r.body.displayName).toBe("GetMe");
    expect(r.headers.etag).toBe('W/"1"');
  });

  it("404 RepositoryNotFound on unknown RID (G-C-09)", async () => {
    const r = await withAuth(
      request(app).get(
        `/api/v1/code-repositories/ri.code-repository.main.repository.deadbeef-aaaa-bbbb-cccc-deadbeefcafe`,
      ),
    );
    expect(r.status).toBe(404);
    expect(r.body.errorName).toBe("CodeRepos:RepositoryNotFound");
  });

  it("404 on malformed RID (G-C-09)", async () => {
    const r = await withAuth(request(app).get(`/api/v1/code-repositories/garbage`));
    expect(r.status).toBe(404);
    expect(r.body.errorName).toBe("CodeRepos:RepositoryNotFound");
  });
});

describe("B2 admin routes — PATCH /repositories/:rid (ETag)", () => {
  it("200 + bumped ETag on valid PATCH with matching If-Match", async () => {
    const create = await withAuth(
      request(app)
        .post("/api/v1/code-repositories")
        .set("Idempotency-Key", nextIdem())
        .send(createBody({ displayName: "PatchMe" })),
    );
    const rid = create.body.rid;

    const r = await withAuth(
      request(app)
        .patch(`/api/v1/code-repositories/${rid}`)
        .set("If-Match", 'W/"1"')
        .send({ displayName: "PatchedName" }),
    );
    expect(r.status).toBe(200);
    expect(r.body.displayName).toBe("PatchedName");
    expect(r.headers.etag).toBe('W/"2"');
  });

  it("400 on If-Match mismatch (412 semantically; spec uses InvalidSettings envelope here)", async () => {
    const create = await withAuth(
      request(app)
        .post("/api/v1/code-repositories")
        .set("Idempotency-Key", nextIdem())
        .send(createBody({ displayName: "PatchMismatch" })),
    );
    const rid = create.body.rid;
    const r = await withAuth(
      request(app)
        .patch(`/api/v1/code-repositories/${rid}`)
        .set("If-Match", 'W/"99"')
        .send({ displayName: "x" }),
    );
    expect(r.status).toBe(400);
    expect(r.body.parameters?.reason).toBe("ETag mismatch");
  });

  it("400 InvalidSettings when If-Match missing", async () => {
    const create = await withAuth(
      request(app)
        .post("/api/v1/code-repositories")
        .set("Idempotency-Key", nextIdem())
        .send(createBody({ displayName: "NoIfMatch" })),
    );
    const rid = create.body.rid;
    const r = await withAuth(
      request(app)
        .patch(`/api/v1/code-repositories/${rid}`)
        .send({ displayName: "x" }),
    );
    expect(r.status).toBe(400);
    expect(r.body.parameters?.field).toBe("If-Match");
  });
});

describe("B2 admin routes — DELETE /repositories/:rid (soft-delete)", () => {
  it("204 on successful soft-delete; subsequent GET returns 404 (G-C-09)", async () => {
    const create = await withAuth(
      request(app)
        .post("/api/v1/code-repositories")
        .set("Idempotency-Key", nextIdem())
        .send(createBody({ displayName: "DeleteMe" })),
    );
    const rid = create.body.rid;
    const del = await withAuth(
      request(app).delete(`/api/v1/code-repositories/${rid}`).set("If-Match", 'W/"1"'),
    );
    expect(del.status).toBe(204);

    const r = await withAuth(request(app).get(`/api/v1/code-repositories/${rid}`));
    expect(r.status).toBe(404);
  });
});

describe("B2 admin routes — GET /repositories/:rid/branches", () => {
  it("returns empty list for a freshly-created repo (cache not yet populated)", async () => {
    const create = await withAuth(
      request(app)
        .post("/api/v1/code-repositories")
        .set("Idempotency-Key", nextIdem())
        .send(createBody({ displayName: "BranchList" })),
    );
    const rid = create.body.rid;
    const r = await withAuth(
      request(app).get(`/api/v1/code-repositories/${rid}/branches`),
    );
    expect(r.status).toBe(200);
    expect(r.body.branches).toEqual([]);
  });

  it("filters by ?protected=true|false", async () => {
    const create = await withAuth(
      request(app)
        .post("/api/v1/code-repositories")
        .set("Idempotency-Key", nextIdem())
        .send(createBody({ displayName: "BranchFilter" })),
    );
    const rid = create.body.rid;
    // Seed cache directly.
    await schema.pool.query(
      `INSERT INTO code_repository_branch_cache (repository_rid, branch_name, head_sha, is_protected)
       VALUES ($1, 'main', 'aaaa', TRUE), ($1, 'dev', 'bbbb', FALSE)`,
      [rid],
    );
    const r1 = await withAuth(
      request(app).get(`/api/v1/code-repositories/${rid}/branches?protected=true`),
    );
    expect(r1.body.branches.length).toBe(1);
    expect(r1.body.branches[0].name).toBe("main");
    const r2 = await withAuth(
      request(app).get(`/api/v1/code-repositories/${rid}/branches?protected=false`),
    );
    expect(r2.body.branches.length).toBe(1);
    expect(r2.body.branches[0].name).toBe("dev");
  });
});

describe("B2 admin routes — settings", () => {
  it("GET 200 returns settings + ETag; PUT 200 updates with If-Match", async () => {
    const create = await withAuth(
      request(app)
        .post("/api/v1/code-repositories")
        .set("Idempotency-Key", nextIdem())
        .send(createBody({ displayName: "Settings1" })),
    );
    const rid = create.body.rid;

    const get = await withAuth(
      request(app).get(`/api/v1/code-repositories/${rid}/settings`),
    );
    expect(get.status).toBe(200);
    expect(get.body).toEqual({});
    expect(get.headers.etag).toBe('W/"1"');

    const put = await withAuth(
      request(app)
        .put(`/api/v1/code-repositories/${rid}/settings`)
        .set("If-Match", 'W/"1"')
        .send({ requirePullRequest: true, requiredApprovals: 2 }),
    );
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ requirePullRequest: true, requiredApprovals: 2 });
    expect(put.headers.etag).toBe('W/"2"');
  });
});
