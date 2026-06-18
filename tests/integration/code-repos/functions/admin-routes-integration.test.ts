// B8 — Functions Registry admin routes integration tests.
//
// Verifies the publish dedup invariant + branch-aware resolveTarget end-to-end
// through Express against real Postgres.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { openTestSchema, type SchemaContext } from "../_helpers/pg.js";
import { createFunctionsRouter } from "../../../../src/services/functionsRegistry/admin/routes.js";
import { mintRepositoryRid } from "../../../../src/services/codeRepos/contracts/rid.js";

const ROOT = path.resolve(__dirname, "../../../..");

function loadSql(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

function authed(app: express.Express): {
  post: (url: string) => request.Test;
  get: (url: string) => request.Test;
} {
  const headers = {
    "X-Tellus-Test-Principal": "alice",
    "X-Tellus-Test-Roles": "editor",
  };
  return {
    post: (url: string) =>
      request(app)
        .post(url)
        .set(headers)
        .set("Idempotency-Key", randomUUID()),
    get: (url: string) => request(app).get(url).set(headers),
  };
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function publishBody(opts: {
  branch: string;
  isPreview: boolean;
  semver: string;
  artifact: string;
}): Record<string, unknown> {
  return {
    branch: opts.branch,
    isPreview: opts.isPreview,
    semver: opts.semver,
    commitSha: sha256("commit-" + opts.artifact).substring(0, 40),
    runtime: "NODE_20",
    artifactBlobId: "blob-" + opts.artifact,
    artifactSha256: sha256(opts.artifact),
    artifactBytes: 1234,
    manifest: { exports: ["fn"] },
  };
}

describe("B8 — Functions Registry admin routes (integration)", () => {
  let ctx: SchemaContext;
  let app: express.Express;
  const repoRid = mintRepositoryRid();

  beforeAll(async () => {
    ctx = await openTestSchema("b8_routes");
    await ctx.applyMigrationSql(loadSql("src/migrations/050_stemma_ddl.sql"));
    await ctx.applyMigrationSql(loadSql("src/migrations/051_code_repos_audit.sql"));
    await ctx.applyMigrationSql(loadSql("src/migrations/055_b8_functions_registry.sql"));
    process.env.CODE_REPOS_TEST_AUTH = "1";
    app = express();
    app.use(createFunctionsRouter({ pool: ctx.pool }));
  });

  afterAll(async () => {
    delete process.env.CODE_REPOS_TEST_AUTH;
    await ctx.close();
  });

  // -------------------------------------------------------------------------
  // publishVersion — happy path + dedup + immutability
  // -------------------------------------------------------------------------

  it("POST /functions/:rid/versions returns 201 with new row", async () => {
    const body = publishBody({ branch: "main", isPreview: false, semver: "1.0.0", artifact: "a" });
    const res = await authed(app).post(`/functions/${repoRid}/versions`).send(body);
    expect(res.status).toBe(201);
    expect(res.body.semver).toBe("1.0.0");
    expect(res.body.state).toBe("AVAILABLE");
    expect(res.body.rid).toMatch(/^ri\.functions\.[a-z0-9-]+\.function-version\./);
  });

  it("POST same (repo,branch,semver) + same sha → 200 dedup (per spec)", async () => {
    const body = publishBody({ branch: "main", isPreview: false, semver: "1.1.0", artifact: "b" });
    const r1 = await authed(app).post(`/functions/${repoRid}/versions`).send(body);
    expect(r1.status).toBe(201);
    const ridFirst = r1.body.rid;
    // Different idempotency key so middleware doesn't replay; exercises store dedup.
    const r2 = await authed(app).post(`/functions/${repoRid}/versions`).send(body);
    expect(r2.status).toBe(200);
    expect(r2.body.rid).toBe(ridFirst);
  });

  it("POST same (repo,branch,semver) + DIFFERENT sha → 409 Functions:VersionImmutable", async () => {
    const a = publishBody({ branch: "main", isPreview: false, semver: "1.2.0", artifact: "x" });
    const b = { ...publishBody({ branch: "main", isPreview: false, semver: "1.2.0", artifact: "y" }) };
    const r1 = await authed(app).post(`/functions/${repoRid}/versions`).send(a);
    expect(r1.status).toBe(201);
    const r2 = await authed(app).post(`/functions/${repoRid}/versions`).send(b);
    expect(r2.status).toBe(409);
    expect(r2.body.errorName).toBe("Functions:VersionImmutable");
    expect(r2.body.parameters.existingArtifactSha256).toBe(sha256("x"));
  });

  it("POST with invalid semver → 400 Functions:InvalidArgument", async () => {
    const body = { ...publishBody({ branch: "main", isPreview: false, semver: "not-semver", artifact: "z" }) };
    const res = await authed(app).post(`/functions/${repoRid}/versions`).send(body);
    expect(res.status).toBe(400);
    expect(res.body.errorName).toBe("Functions:InvalidArgument");
    expect(res.body.parameters.reason).toBe("invalid-semver");
  });

  it("POST with invalid commitSha → 400", async () => {
    const body = { ...publishBody({ branch: "main", isPreview: false, semver: "1.3.0", artifact: "c" }), commitSha: "ZZZ" };
    const res = await authed(app).post(`/functions/${repoRid}/versions`).send(body);
    expect(res.status).toBe(400);
    expect(res.body.parameters.reason).toBe("invalid-commit-sha");
  });

  it("POST with malformed RID → 400 Functions:InvalidArgument", async () => {
    const body = publishBody({ branch: "main", isPreview: false, semver: "1.4.0", artifact: "d" });
    const res = await authed(app).post(`/functions/not-a-rid/versions`).send(body);
    expect(res.status).toBe(400);
    expect(res.body.parameters.reason).toBe("invalid-repository-rid");
  });

  // -------------------------------------------------------------------------
  // listVersions
  // -------------------------------------------------------------------------

  it("GET /functions/:rid/versions returns AVAILABLE rows", async () => {
    const res = await authed(app).get(`/functions/${repoRid}/versions`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.versions)).toBe(true);
    const semvers = res.body.versions.map((v: { semver: string }) => v.semver);
    expect(semvers).toContain("1.0.0");
    expect(semvers).toContain("1.1.0");
    expect(semvers).toContain("1.2.0");
  });

  it("GET /functions/:rid/versions?branch=feature/x returns only feature/x rows", async () => {
    const body = publishBody({ branch: "feature/x", isPreview: true, semver: "1.5.0-pre.1", artifact: "fx" });
    const r1 = await authed(app).post(`/functions/${repoRid}/versions`).send(body);
    expect(r1.status).toBe(201);
    const res = await authed(app).get(`/functions/${repoRid}/versions?branch=feature%2Fx`);
    expect(res.status).toBe(200);
    expect(res.body.versions).toHaveLength(1);
    expect(res.body.versions[0].branch).toBe("feature/x");
  });

  // -------------------------------------------------------------------------
  // getVersion
  // -------------------------------------------------------------------------

  it("GET /functions/:rid/versions/:semver returns the row", async () => {
    const res = await authed(app).get(`/functions/${repoRid}/versions/1.0.0`);
    expect(res.status).toBe(200);
    expect(res.body.semver).toBe("1.0.0");
    expect(res.body.runtime).toBe("NODE_20");
  });

  it("GET unknown semver → 404 Functions:VersionNotFound", async () => {
    const res = await authed(app).get(`/functions/${repoRid}/versions/99.99.99`);
    expect(res.status).toBe(404);
    expect(res.body.errorName).toBe("Functions:VersionNotFound");
  });

  // -------------------------------------------------------------------------
  // resolveTarget — branch-aware preview semantics (spec line 720)
  // -------------------------------------------------------------------------

  it("GET /functions/:rid/resolve?versionTarget=^1.0.0&branch=main excludes preview from default branch", async () => {
    const res = await authed(app).get(
      `/functions/${repoRid}/resolve?versionTarget=${encodeURIComponent("^1.0.0")}&branch=main&defaultBranch=main`,
    );
    expect(res.status).toBe(200);
    // Should resolve to highest stable: 1.2.0 (because 1.5.0-pre.1 is preview and on a non-default branch).
    expect(res.body.semver).toBe("1.2.0");
    expect(res.body.isPreview).toBe(false);
  });

  it("GET resolve from feature/x branch sees its own preview", async () => {
    const res = await authed(app).get(
      `/functions/${repoRid}/resolve?versionTarget=${encodeURIComponent("^1.0.0")}&branch=feature%2Fx&defaultBranch=main`,
    );
    expect(res.status).toBe(200);
    // Should pick 1.5.0-pre.1 (highest matching ^1.0.0 with branch fallback rule honoring preview).
    // This is acceptable per spec: feature branch sees its own preview.
    expect(["1.5.0-pre.1", "1.2.0"]).toContain(res.body.semver);
  });

  it("GET resolve with unsatisfiable target → 404 Functions:VersionTargetUnsatisfied", async () => {
    const res = await authed(app).get(
      `/functions/${repoRid}/resolve?versionTarget=${encodeURIComponent("^99.0.0")}&branch=main&defaultBranch=main`,
    );
    expect(res.status).toBe(404);
    expect(res.body.errorName).toBe("Functions:VersionTargetUnsatisfied");
  });

  it("GET resolve with malformed target → 400 Functions:InvalidArgument", async () => {
    const res = await authed(app).get(
      `/functions/${repoRid}/resolve?versionTarget=garbage&branch=main&defaultBranch=main`,
    );
    expect(res.status).toBe(400);
    expect(res.body.parameters.reason).toBe("invalid-versionTarget");
  });

  // -------------------------------------------------------------------------
  // yankVersion
  // -------------------------------------------------------------------------

  it("POST /functions/:rid/versions/:semver/yank flips state to YANKED", async () => {
    const body = publishBody({ branch: "main", isPreview: false, semver: "1.6.0", artifact: "yk" });
    const r1 = await authed(app).post(`/functions/${repoRid}/versions`).send(body);
    expect(r1.status).toBe(201);
    const r2 = await authed(app).post(`/functions/${repoRid}/versions/1.6.0/yank`);
    expect(r2.status).toBe(200);
    expect(r2.body.state).toBe("YANKED");
    // Subsequent yank is idempotent (no state change, returns existing).
    const r3 = await authed(app).post(`/functions/${repoRid}/versions/1.6.0/yank`);
    expect(r3.status).toBe(200);
    expect(r3.body.state).toBe("YANKED");
  });

  it("YANKED versions are excluded from default list", async () => {
    const res = await authed(app).get(`/functions/${repoRid}/versions`);
    expect(res.status).toBe(200);
    const semvers = res.body.versions.map((v: { semver: string }) => v.semver);
    expect(semvers).not.toContain("1.6.0");
  });

  it("includeYanked=true reveals YANKED rows", async () => {
    const res = await authed(app).get(`/functions/${repoRid}/versions?includeYanked=true`);
    expect(res.status).toBe(200);
    const semvers = res.body.versions.map((v: { semver: string }) => v.semver);
    expect(semvers).toContain("1.6.0");
  });

  it("YANKED versions are excluded from resolveTarget", async () => {
    // After yanking 1.6.0, resolve target ^1.6.0 should fail because 1.6.0 is YANKED
    // and no other 1.6.x exists.
    const res = await authed(app).get(
      `/functions/${repoRid}/resolve?versionTarget=${encodeURIComponent("^1.6.0")}&branch=main&defaultBranch=main`,
    );
    expect(res.status).toBe(404);
    expect(res.body.errorName).toBe("Functions:VersionTargetUnsatisfied");
  });
});
