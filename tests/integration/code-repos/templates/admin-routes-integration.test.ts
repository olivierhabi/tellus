// B3 — Templates admin routes integration tests.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import request from "supertest";
import type { Express } from "express";
import { openTestSchema, type SchemaContext } from "../_helpers/pg.js";
import { createTemplatesApp } from "../../../../src/services/templates/admin/app.js";

const REPO_RID = "ri.code-repos.main.repository.0123abcd-ef01-4234-8567-89abcdef0123";

let ctx: SchemaContext;
let app: Express;

function loadMigration(name: string): string {
  return readFileSync(resolve("src/migrations", name), "utf8");
}

const authed = (a: Express) => ({
  get: (p: string) => request(a).get(p).set("X-Tellus-Test-Principal", "alice").set("X-Tellus-Test-Roles", "editor"),
  post: (p: string) => request(a).post(p).set("X-Tellus-Test-Principal", "alice").set("X-Tellus-Test-Roles", "editor"),
});

beforeAll(async () => {
  ctx = await openTestSchema("templates_routes");
  await ctx.applyMigrationSql(loadMigration("051_code_repos_audit.sql"));
  await ctx.applyMigrationSql(loadMigration("056_b3_templates.sql"));
  app = createTemplatesApp({ pool: ctx.pool });
});

afterAll(async () => {
  await ctx.close();
});

describe("B3 Templates — health", () => {
  it("/health 200 unauthenticated", async () => {
    const r = await request(app).get("/health");
    expect(r.status).toBe(200);
  });
  it("/readiness 200 when DB reachable", async () => {
    const r = await request(app).get("/readiness");
    expect(r.status).toBe(200);
  });
});

describe("B3 Templates — GET /templates", () => {
  it("returns the 5 v1 templates", async () => {
    const r = await authed(app).get("/templates");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.templates)).toBe(true);
    const ids = r.body.templates.map((t: { templateId: string }) => t.templateId);
    expect(ids).toContain("typescript-functions");
    expect(ids).toContain("python-functions");
    expect(ids).toContain("transforms-python");
    expect(ids).toContain("transforms-java");
    expect(ids).toContain("transforms-sql");
    expect(r.body.templates.length).toBe(5);
  });

  it("?category=functions filters to functions templates only", async () => {
    const r = await authed(app).get("/templates?category=functions");
    expect(r.status).toBe(200);
    for (const t of r.body.templates) expect(t.category).toBe("functions");
    expect(r.body.templates.length).toBe(2);
  });

  it("?category=transforms filters to transforms templates only", async () => {
    const r = await authed(app).get("/templates?category=transforms");
    expect(r.status).toBe(200);
    for (const t of r.body.templates) expect(t.category).toBe("transforms");
    expect(r.body.templates.length).toBe(3);
  });

  // SKIPPED: under CODE_REPOS_TEST_AUTH=1 a missing principal header is
  // defaulted to cypress-admin (principal.ts), so this returns 200 not 401.
  it.skip("401 when no principal header", async () => {
    const r = await request(app).get("/templates");
    expect(r.status).toBe(401);
    expect(r.body.errorName).toBe("Stemma:Unauthenticated");
  });
});

describe("B3 Templates — GET /templates/:id/versions/:v", () => {
  it("returns the typescript-functions@2.4.0 manifest with files", async () => {
    const r = await authed(app).get("/templates/typescript-functions/versions/2.4.0");
    expect(r.status).toBe(200);
    expect(r.body.templateId).toBe("typescript-functions");
    expect(r.body.version).toBe("2.4.0");
    expect(Array.isArray(r.body.files)).toBe(true);
    // v2 typescript-functions@2.4.0 scaffold: 17 non-binary files. The
    // ≈22-file Foundry shape additionally ships `gradle-wrapper.jar` and
    // the two `gradlew*` shell scripts (binary by mode-bit) which are
    // omitted from the in-process catalog per manifest.ts comment.
    // README.md was also dropped (Wave 22, 2026-05-10) — user-facing
    // repos don't ship a stub README.
    expect(r.body.files.length).toBe(17);
    const paths = r.body.files.map((f: { path: string }) => f.path);
    // v2 puts language sources under the `typescript-functions/` subproject
    // (the V2 discriminator) rather than at root.
    expect(paths).toContain("typescript-functions/package.json");
    expect(paths).toContain("typescript-functions/src/functions/helloWorld.ts");
    expect(paths).toContain("templateConfig.json");
    expect(paths).not.toContain("package.json");
    expect(paths).not.toContain("src/index.ts");
  });

  it("404 Templates:NotFound on unknown templateId", async () => {
    const r = await authed(app).get("/templates/no-such/versions/1.0.0");
    expect(r.status).toBe(404);
    expect(r.body.errorName).toBe("Templates:NotFound");
  });

  it("404 on unknown version of known template", async () => {
    const r = await authed(app).get("/templates/typescript-functions/versions/9.9.9");
    expect(r.status).toBe(404);
  });
});

describe("B3 Templates — POST /scaffold (B3 acceptance §1)", () => {
  it("scaffolds typescript-functions deterministically", async () => {
    const body = {
      templateId: "typescript-functions",
      version: "2.4.0",
      repositoryRid: REPO_RID,
      repoDisplayName: "Demo Repo",
      parameters: { packageName: "demo-repo" },
    };
    const r1 = await authed(app).post("/scaffold").set("Idempotency-Key", "00000000-0000-4000-8000-000000000001").send(body);
    expect(r1.status).toBe(201);
    expect(r1.body.commitSha).toMatch(/^[0-9a-f]{40}$/);
    // v2 scaffold file count — see comment on the manifest assertion above.
    expect(r1.body.fileCount).toBe(17);
    const r2 = await authed(app).post("/scaffold").set("Idempotency-Key", "00000000-0000-4000-8000-000000000002").send(body);
    expect(r2.status).toBe(201);
    expect(r2.body.commitSha).toBe(r1.body.commitSha);
  });

  it("400 Templates:InvalidArgument on missing templateId", async () => {
    const r = await authed(app).post("/scaffold").set("Idempotency-Key", "00000000-0000-4000-8000-000000000003").send({ version: "2.4.0" });
    expect(r.status).toBe(400);
    expect(r.body.errorName).toBe("Templates:InvalidArgument");
  });

  it("404 Templates:NotFound on unknown template", async () => {
    const r = await authed(app).post("/scaffold").set("Idempotency-Key", "00000000-0000-4000-8000-000000000004").send({
      templateId: "no-such",
      version: "1.0.0",
      repositoryRid: REPO_RID,
      repoDisplayName: "x",
      parameters: {},
    });
    expect(r.status).toBe(404);
  });

  it("400 Templates:ParameterValidationFailed on regex mismatch", async () => {
    const r = await authed(app).post("/scaffold").set("Idempotency-Key", "00000000-0000-4000-8000-000000000005").send({
      templateId: "typescript-functions",
      version: "2.4.0",
      repositoryRid: REPO_RID,
      repoDisplayName: "x",
      parameters: { packageName: "INVALID UPPERCASE" },
    });
    expect(r.status).toBe(400);
    expect(r.body.errorName).toBe("Templates:ParameterValidationFailed");
    expect(r.body.parameters.reason).toBe("regex-mismatch");
  });

  it("400 missing Idempotency-Key", async () => {
    const r = await authed(app).post("/scaffold").send({
      templateId: "typescript-functions",
      version: "2.4.0",
      repositoryRid: REPO_RID,
      repoDisplayName: "x",
      parameters: {},
    });
    expect(r.status).toBe(400);
    expect(r.body.errorName).toBe("Stemma:MissingIdempotencyKey");
  });

  it("idempotent replay: same key returns prior body with X-Idempotent-Replay", async () => {
    const body = {
      templateId: "typescript-functions",
      version: "2.4.0",
      repositoryRid: REPO_RID,
      repoDisplayName: "Replay Repo",
      parameters: { packageName: "replay-repo" },
    };
    const r1 = await authed(app).post("/scaffold").set("Idempotency-Key", "00000000-0000-4000-8000-000000000099").send(body);
    expect(r1.status).toBe(201);
    const sha1 = r1.body.commitSha;
    const r2 = await authed(app).post("/scaffold").set("Idempotency-Key", "00000000-0000-4000-8000-000000000099").send(body);
    expect(r2.status).toBe(201);
    expect(r2.headers["x-idempotent-replay"]).toBe("true");
    expect(r2.body.commitSha).toBe(sha1);
  });
});

describe("B3 Templates — DDL", () => {
  it("templates_index table exists with expected columns", async () => {
    const r = await ctx.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'templates_index'
      ORDER BY ordinal_position
    `);
    const names = r.rows.map((row) => row.column_name);
    expect(names).toContain("template_id");
    expect(names).toContain("version");
    expect(names).toContain("is_deprecated");
    expect(names).toContain("deprecated_at");
  });

  it("rejects language not in ('typescript','python','java','sql')", async () => {
    let captured: unknown = null;
    try {
      await ctx.query(`INSERT INTO templates_index
        (template_id, version, display_name, language, category, file_count, total_bytes)
        VALUES ('x', '1.0.0', 'X', 'rust', 'functions', 1, 100)`);
    } catch (e) {
      captured = e;
    }
    expect((captured as { code?: string })?.code).toBe("23514");
  });

  it("rejects category not in ('functions','transforms')", async () => {
    let captured: unknown = null;
    try {
      await ctx.query(`INSERT INTO templates_index
        (template_id, version, display_name, language, category, file_count, total_bytes)
        VALUES ('x', '1.0.0', 'X', 'typescript', 'bogus', 1, 100)`);
    } catch (e) {
      captured = e;
    }
    expect((captured as { code?: string })?.code).toBe("23514");
  });

  it("dep_chk: is_deprecated=FALSE forbids deprecated_at", async () => {
    let captured: unknown = null;
    try {
      await ctx.query(`INSERT INTO templates_index
        (template_id, version, display_name, language, category, file_count, total_bytes, is_deprecated, deprecated_at)
        VALUES ('y', '1.0.0', 'Y', 'typescript', 'functions', 1, 100, FALSE, NOW())`);
    } catch (e) {
      captured = e;
    }
    expect((captured as { code?: string })?.code).toBe("23514");
  });

  it("dep_chk: is_deprecated=TRUE requires deprecated_at", async () => {
    let captured: unknown = null;
    try {
      await ctx.query(`INSERT INTO templates_index
        (template_id, version, display_name, language, category, file_count, total_bytes, is_deprecated)
        VALUES ('z', '1.0.0', 'Z', 'typescript', 'functions', 1, 100, TRUE)`);
    } catch (e) {
      captured = e;
    }
    expect((captured as { code?: string })?.code).toBe("23514");
  });
});
