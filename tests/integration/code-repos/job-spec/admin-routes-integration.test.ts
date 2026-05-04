// B7 — JobSpec admin routes integration tests.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import request from "supertest";
import type { Express } from "express";
import { openTestSchema, type SchemaContext } from "../_helpers/pg.js";
import { createJobSpecApp } from "../../../../src/services/jobSpec/admin/app.js";

const REPO_A = "ri.stemma.main.repository.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REPO_B = "ri.stemma.main.repository.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DS_X = "ri.foundry.main.dataset.11111111-1111-4111-8111-111111111111";
const DS_Y = "ri.foundry.main.dataset.22222222-2222-4222-8222-222222222222";
const DS_Z = "ri.foundry.main.dataset.33333333-3333-4333-8333-333333333333";

let ctx: SchemaContext;
let app: Express;

const authed = (a: Express) => ({
  get: (p: string) => request(a).get(p).set("X-Tellus-Test-Principal", "alice").set("X-Tellus-Test-Roles", "editor"),
  post: (p: string) => request(a).post(p).set("X-Tellus-Test-Principal", "alice").set("X-Tellus-Test-Roles", "editor").set("Idempotency-Key", randomUUID()),
});

beforeAll(async () => {
  ctx = await openTestSchema("jobspec_routes");
  await ctx.applyMigrationSql(readFileSync(resolve("src/migrations/051_code_repos_audit.sql"), "utf8"));
  await ctx.applyMigrationSql(readFileSync(resolve("src/migrations/057_b7_jobspec.sql"), "utf8"));
  app = createJobSpecApp({ pool: ctx.pool });
});

afterAll(async () => {
  await ctx.close();
});

describe("B7 JobSpec — health", () => {
  it("/health 200", async () => {
    const r = await request(app).get("/health");
    expect(r.status).toBe(200);
  });
});

describe("B7 JobSpec — POST .../job-specs (acceptance §1)", () => {
  it("publishes 2 JobSpec rows for a transforms-python repo with 2 @transforms", async () => {
    const r = await authed(app)
      .post(`/repositories/${REPO_A}/branches/main/job-specs`)
      .send({
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        jobSpecs: [
          { outputDatasetRid: DS_X, sourcePath: "src/x.py", entryPoint: "x:f", inputs: [], parameters: {}, computeProfile: "default" },
          { outputDatasetRid: DS_Y, sourcePath: "src/y.py", entryPoint: "y:g", inputs: [], parameters: {}, computeProfile: "default" },
        ],
      });
    expect(r.status).toBe(200);
    expect(r.body.published).toHaveLength(2);
    expect(r.body.rejected).toHaveLength(0);
  });

  it("re-publishing same outputs from same repo is idempotent (resource_version increments)", async () => {
    // First publish baseline.
    const r1 = await authed(app).post(`/repositories/${REPO_A}/branches/dev/job-specs`).send({
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      jobSpecs: [{ outputDatasetRid: DS_Z, sourcePath: "src/z.py", entryPoint: "z:h", inputs: [], parameters: {}, computeProfile: "default" }],
    });
    expect(r1.status).toBe(200);
    const v1 = r1.body.published[0].resourceVersion;

    // Re-publish same output from same repo.
    const r2 = await authed(app).post(`/repositories/${REPO_A}/branches/dev/job-specs`).send({
      commitSha: "fedcba9876543210fedcba9876543210fedcba98",
      jobSpecs: [{ outputDatasetRid: DS_Z, sourcePath: "src/z.py", entryPoint: "z:h", inputs: [], parameters: {}, computeProfile: "default" }],
    });
    expect(r2.status).toBe(200);
    expect(r2.body.published[0].resourceVersion).toBeGreaterThan(v1);
  });

  it("orphan replacement: previously-owned outputs not in new batch are deleted", async () => {
    // Publish 2 outputs.
    await authed(app).post(`/repositories/${REPO_A}/branches/orphan-test/job-specs`).send({
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      jobSpecs: [
        { outputDatasetRid: DS_X, sourcePath: "x.py", entryPoint: "x:f", inputs: [], parameters: {}, computeProfile: "default" },
        { outputDatasetRid: DS_Y, sourcePath: "y.py", entryPoint: "y:g", inputs: [], parameters: {}, computeProfile: "default" },
      ],
    });
    // Re-publish only DS_X. DS_Y should be deleted as orphan.
    const r = await authed(app).post(`/repositories/${REPO_A}/branches/orphan-test/job-specs`).send({
      commitSha: "fedcba9876543210fedcba9876543210fedcba98",
      jobSpecs: [
        { outputDatasetRid: DS_X, sourcePath: "x.py", entryPoint: "x:f", inputs: [], parameters: {}, computeProfile: "default" },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.deletedOrphans).toContain(DS_Y);
    // Verify in DB.
    const left = await ctx.query<{ output_dataset_rid: string }>(
      `SELECT output_dataset_rid FROM job_spec WHERE repository_rid = $1 AND branch = $2`,
      [REPO_A, "orphan-test"],
    );
    expect(left.rows).toHaveLength(1);
    expect(left.rows[0].output_dataset_rid).toBe(DS_X);
  });
});

describe("B7 JobSpec — cross-repo collision (acceptance §2)", () => {
  it("two repos race for same output: exactly one wins", async () => {
    const branch = "race";
    const dataset = "ri.foundry.main.dataset.99999999-9999-4999-8999-999999999999";
    const body = (repo: string) => ({
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      jobSpecs: [
        { outputDatasetRid: dataset, sourcePath: "race.py", entryPoint: "race:f", inputs: [], parameters: {}, computeProfile: "default" },
      ],
    });
    // Repo A wins by going first.
    const ra = await authed(app).post(`/repositories/${REPO_A}/branches/${branch}/job-specs`).send(body(REPO_A));
    expect(ra.status).toBe(200);
    expect(ra.body.published).toHaveLength(1);

    // Repo B attempts same → rejected with OutputAlreadyOwned.
    const rb = await authed(app).post(`/repositories/${REPO_B}/branches/${branch}/job-specs`).send(body(REPO_B));
    expect(rb.status).toBe(409);
    expect(rb.body.errorName).toBe("JobSpec:OutputAlreadyOwned");
    expect(rb.body.parameters.rejected).toHaveLength(1);
    expect(rb.body.parameters.rejected[0].ownedBy).toBe(REPO_A);
  });
});

describe("B7 JobSpec — validation errors", () => {
  it("400 InvalidEntryPoint on malformed entry point", async () => {
    const r = await authed(app).post(`/repositories/${REPO_A}/branches/main/job-specs`).send({
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      jobSpecs: [
        { outputDatasetRid: DS_X, sourcePath: "x.py", entryPoint: "9bad:start", inputs: [], parameters: {}, computeProfile: "default" },
      ],
    });
    expect(r.status).toBe(400);
    expect(r.body.errorName).toBe("JobSpec:InvalidEntryPoint");
  });

  it("400 CircularDependency on self-loop", async () => {
    const r = await authed(app).post(`/repositories/${REPO_A}/branches/main/job-specs`).send({
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      jobSpecs: [
        { outputDatasetRid: DS_X, sourcePath: "x.py", entryPoint: "x:f", inputs: [{ datasetRid: DS_X, branch: "main", view: "snapshot" }], parameters: {}, computeProfile: "default" },
      ],
    });
    expect(r.status).toBe(400);
    expect(r.body.errorName).toBe("JobSpec:CircularDependency");
  });

  it("400 InvalidArgument on duplicate output in batch", async () => {
    const r = await authed(app).post(`/repositories/${REPO_A}/branches/main/job-specs`).send({
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      jobSpecs: [
        { outputDatasetRid: DS_X, sourcePath: "x.py", entryPoint: "x:f", inputs: [], parameters: {}, computeProfile: "default" },
        { outputDatasetRid: DS_X, sourcePath: "y.py", entryPoint: "y:g", inputs: [], parameters: {}, computeProfile: "default" },
      ],
    });
    expect(r.status).toBe(400);
    expect(r.body.parameters.reason).toBe("duplicate-outputDatasetRid-in-batch");
  });

  it("400 InvalidArgument on bad commit_sha", async () => {
    const r = await authed(app).post(`/repositories/${REPO_A}/branches/main/job-specs`).send({
      commitSha: "ZZZZ",
      jobSpecs: [
        { outputDatasetRid: DS_X, sourcePath: "x.py", entryPoint: "x:f", inputs: [], parameters: {}, computeProfile: "default" },
      ],
    });
    expect(r.status).toBe(400);
  });

  it("400 InvalidArgument on invalid repository RID", async () => {
    const r = await authed(app).post(`/repositories/not-a-rid/branches/main/job-specs`).send({
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      jobSpecs: [{ outputDatasetRid: DS_X, sourcePath: "x.py", entryPoint: "x:f", inputs: [], parameters: {}, computeProfile: "default" }],
    });
    expect(r.status).toBe(400);
  });
});

describe("B7 JobSpec — GET /job-specs", () => {
  it("returns the JobSpec when present", async () => {
    const r = await authed(app).get(`/job-specs?outputDatasetRid=${DS_X}&branch=main`);
    expect(r.status).toBe(200);
    expect(r.body.outputDatasetRid).toBe(DS_X);
    expect(r.body.branch).toBe("main");
  });

  it("404 DatasetNotFound when no JobSpec exists", async () => {
    const r = await authed(app).get(`/job-specs?outputDatasetRid=ri.foundry.main.dataset.00000000-0000-4000-8000-000000000000&branch=main`);
    expect(r.status).toBe(404);
    expect(r.body.errorName).toBe("JobSpec:DatasetNotFound");
  });
});

describe("B7 JobSpec — GET /repositories/:rid/branches/:branch/job-specs", () => {
  it("returns all JobSpecs for the (repo, branch)", async () => {
    const r = await authed(app).get(`/repositories/${REPO_A}/branches/main/job-specs`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.jobSpecs)).toBe(true);
    expect(r.body.jobSpecs.length).toBeGreaterThanOrEqual(2);
    for (const j of r.body.jobSpecs) expect(j.repositoryRid).toBe(REPO_A);
  });

  it("returns empty array when repo has no JobSpecs on that branch", async () => {
    const r = await authed(app).get(`/repositories/${REPO_B}/branches/never-published/job-specs`);
    expect(r.status).toBe(200);
    expect(r.body.jobSpecs).toEqual([]);
  });
});

describe("B7 JobSpec — DDL", () => {
  it("rejects commit_sha not matching hex regex", async () => {
    let captured: unknown = null;
    try {
      await ctx.query(`INSERT INTO job_spec (output_dataset_rid, branch, repository_rid, commit_sha, source_path, entry_point, inputs)
        VALUES ('${DS_X}', 'x', '${REPO_A}', 'NOT-HEX', 'x.py', 'x:f', '[]'::jsonb)`);
    } catch (e) { captured = e; }
    expect((captured as { code?: string })?.code).toBe("23514");
  });

  it("PRIMARY KEY rejects duplicate (output_dataset_rid, branch)", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    await ctx.query(`INSERT INTO job_spec (output_dataset_rid, branch, repository_rid, commit_sha, source_path, entry_point, inputs)
      VALUES ('${DS_Z}', 'pk-test', '${REPO_A}', '${sha}', 'z.py', 'z:h', '[]'::jsonb)`);
    let captured: unknown = null;
    try {
      await ctx.query(`INSERT INTO job_spec (output_dataset_rid, branch, repository_rid, commit_sha, source_path, entry_point, inputs)
        VALUES ('${DS_Z}', 'pk-test', '${REPO_B}', '${sha}', 'z.py', 'z:h', '[]'::jsonb)`);
    } catch (e) { captured = e; }
    expect((captured as { code?: string })?.code).toBe("23505");
  });

  it("allows same output on different branches", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    await ctx.query(`INSERT INTO job_spec (output_dataset_rid, branch, repository_rid, commit_sha, source_path, entry_point, inputs)
      VALUES ('${DS_Z}', 'branch-a', '${REPO_A}', '${sha}', 'z.py', 'z:h', '[]'::jsonb)`);
    await ctx.query(`INSERT INTO job_spec (output_dataset_rid, branch, repository_rid, commit_sha, source_path, entry_point, inputs)
      VALUES ('${DS_Z}', 'branch-b', '${REPO_B}', '${sha}', 'z.py', 'z:h', '[]'::jsonb)`);
    const r = await ctx.query<{ count: string }>(`SELECT COUNT(*)::text as count FROM job_spec WHERE output_dataset_rid = '${DS_Z}'`);
    expect(parseInt(r.rows[0].count, 10)).toBeGreaterThanOrEqual(2);
  });
});
