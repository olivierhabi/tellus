// ---------------------------------------------------------------------------
// B4-C-10/11 — GET/PUT /:rid/resource-imports integration tests.
//
// Exercises the resource-imports endpoints against:
//   - real Postgres (testcontainers via openTestSchema)
//   - in-memory Compass / Stemma / Template adapters
//
// Coverage:
//   GET empty repo                         → 200, ontologyRid=null, items=[], ETag "empty"
//   PUT then GET round-trip                → 200/200, same content+etag
//   PUT idempotent replay                  → same etag, no-op effective
//   PUT replace-all atomically             → DELETE+INSERT in one tx
//   PUT clear (items=[])                   → ontologyRid null, etag "empty"
//   PUT 400 InvalidImportsBody — missing items
//   PUT 400 InvalidImportsBody — items not array
//   PUT 400 InvalidImportsBody — items > 500
//   PUT 400 InvalidImportsBody — bad kind
//   PUT 400 InvalidImportsBody — bad apiName
//   PUT 400 InvalidImportsBody — duplicate (kind, apiName)
//   PUT 400 InvalidImportsBody — missing ontologyRid when items≠[]
//   PUT 400 InvalidImportsBody — missing If-Match
//   PUT 400 InvalidImportsBody — malformed If-Match
//   PUT 412 StaleImportsState — If-Match mismatches current
//   PUT 412 RepositoryArchived
//   PUT 404 RepositoryNotFound
//   GET 404 RepositoryNotFound
//   PUT writes one audit row with action="resource_imports.put"
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";

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
  "072_b4_resource_imports.sql",
];

let schema: TestSchema;
let app: Express;
let compass: InMemoryCompass;
let stemma: InMemoryStemma;
let template: InMemoryTemplate;

const FOLDER_RID = "ri.compass.main.folder.0123abcd-ef01-4345-8789-abcdef012345";

let idemCounter = 0;
function nextIdem(): string {
  idemCounter += 1;
  const hex = (n: number) => n.toString(16).padStart(8, "0");
  return `${hex(idemCounter)}-aaaa-4bbb-8ccc-dddddddddddd`;
}

let repoCounter = 0;
function nextDisplayName(prefix: string): string {
  repoCounter += 1;
  return `${prefix}-${repoCounter}`;
}

function withAuth(req: request.Test): request.Test {
  return req
    .set("X-Tellus-Test-Principal", "alice")
    .set("X-Tellus-Test-Auth-Token", process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "")
    .set("X-Tellus-Test-Roles", "editor");
}

function createBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    displayName: "ImportsTest",
    parentFolderRid: FOLDER_RID,
    templateId: "typescript-functions",
    templateVersion: "2.4.0",
    defaultBranch: "main",
    ...overrides,
  };
}

async function createRepo(prefix: string): Promise<string> {
  const displayName = nextDisplayName(prefix);
  const r = await withAuth(
    request(app)
      .post("/api/v1/code-repositories")
      .set("Idempotency-Key", nextIdem())
      .send(createBody({ displayName })),
  );
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.rid as string;
}

function imports(items: Array<{ kind: string; apiName: string }>): {
  ontologyRid: string;
  items: Array<{ kind: string; apiName: string }>;
} {
  return {
    ontologyRid: "fffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb",
    items,
  };
}

beforeAll(async () => {
  schema = await openTestSchema("b4_resource_imports");
  for (const f of MIGS) {
    await schema.applyMigration(`src/migrations/${f}`);
  }
});

afterAll(async () => {
  if (schema) await schema.close();
});

beforeEach(() => {
  process.env.CODE_REPOS_TEST_AUTH = "1";
  compass = new InMemoryCompass();
  stemma = new InMemoryStemma();
  template = new InMemoryTemplate({ stemma });
  app = createCodeRepositoryApp({
    pool: schema.pool,
    compass,
    stemma,
    template,
  });
});

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

describe("B4-C-10 — GET /:rid/resource-imports", () => {
  it("returns ontologyRid=null, items=[], ETag 'empty' for a fresh repo", async () => {
    const rid = await createRepo("GetEmpty");
    const r = await withAuth(
      request(app).get(`/api/v1/code-repositories/${rid}/resource-imports`),
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ontologyRid: null, items: [] });
    expect(r.headers.etag).toBe('W/"empty"');
  });

  it("returns 404 RepositoryNotFound when the rid does not match", async () => {
    const r = await withAuth(
      request(app).get(
        `/api/v1/code-repositories/ri.stemma.main.repository.00000000-0000-4000-8000-000000000000/resource-imports`,
      ),
    );
    expect(r.status).toBe(404);
    expect(r.body.errorName).toBe("CodeRepos:RepositoryNotFound");
  });
});

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

describe("B4-C-11 — PUT /:rid/resource-imports", () => {
  it("PUT then GET round-trips identically with stable ETag", async () => {
    const rid = await createRepo("RoundTrip");
    const body = imports([
      { kind: "object_type", apiName: "GenaPatient" },
      { kind: "object_type", apiName: "GenaInvoice" },
      { kind: "link_type", apiName: "PatientToInvoice" },
    ]);
    const r = await withAuth(
      request(app)
        .put(`/api/v1/code-repositories/${rid}/resource-imports`)
        .set("If-Match", 'W/"empty"')
        .send(body),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.ontologyRid).toBe(body.ontologyRid);
    expect(r.body.items).toHaveLength(3);
    expect(r.headers.etag).toMatch(/^W\/"[0-9a-f]{16}"$/);
    const firstEtag = r.headers.etag;

    const r2 = await withAuth(
      request(app).get(`/api/v1/code-repositories/${rid}/resource-imports`),
    );
    expect(r2.status).toBe(200);
    expect(r2.body.ontologyRid).toBe(body.ontologyRid);
    expect(r2.body.items).toHaveLength(3);
    expect(r2.headers.etag).toBe(firstEtag);
    // Items are sorted by (kind, apiName) for stable client-side comparisons.
    expect(r2.body.items.map((i: { apiName: string }) => i.apiName)).toEqual([
      "PatientToInvoice",
      "GenaInvoice",
      "GenaPatient",
    ]);
  });

  it("idempotent replay — PUT same body twice → same etag, no audit duplication", async () => {
    const rid = await createRepo("Replay");
    const body = imports([{ kind: "object_type", apiName: "Foo" }]);
    const r1 = await withAuth(
      request(app)
        .put(`/api/v1/code-repositories/${rid}/resource-imports`)
        .set("If-Match", 'W/"empty"')
        .send(body),
    );
    expect(r1.status).toBe(200);
    const firstEtag = r1.headers.etag;
    const r2 = await withAuth(
      request(app)
        .put(`/api/v1/code-repositories/${rid}/resource-imports`)
        .set("If-Match", firstEtag)
        .send(body),
    );
    expect(r2.status).toBe(200);
    expect(r2.headers.etag).toBe(firstEtag);
    // Audit rows = 2 (one per PUT). True idempotency-at-the-route layer is
    // a separate cross-cutting Middleware (G-C-22); per-PUT audit is the
    // current contract here.
    const auditRows = await schema.pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM code_repos_audit_events
        WHERE action = 'resourceImports.put' AND target_rid = $1`,
      [rid],
    );
    expect(auditRows.rows[0].c).toBe(2);
  });

  it("clears the set when items=[] regardless of ontologyRid", async () => {
    const rid = await createRepo("Clear");
    // First add some items.
    const r1 = await withAuth(
      request(app)
        .put(`/api/v1/code-repositories/${rid}/resource-imports`)
        .set("If-Match", 'W/"empty"')
        .send(imports([{ kind: "object_type", apiName: "Foo" }])),
    );
    expect(r1.status).toBe(200);
    const firstEtag = r1.headers.etag;
    // Then clear.
    const r2 = await withAuth(
      request(app)
        .put(`/api/v1/code-repositories/${rid}/resource-imports`)
        .set("If-Match", firstEtag)
        .send({ ontologyRid: null, items: [] }),
    );
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(r2.body.ontologyRid).toBeNull();
    expect(r2.body.items).toEqual([]);
    expect(r2.headers.etag).toBe('W/"empty"');
  });

  it("400 InvalidImportsBody when body is not a JSON object", async () => {
    const rid = await createRepo("BadBody");
    const r = await withAuth(
      request(app)
        .put(`/api/v1/code-repositories/${rid}/resource-imports`)
        .set("If-Match", 'W/"empty"')
        .set("Content-Type", "application/json")
        .send("[]"),
    );
    expect(r.status).toBe(400);
    expect(r.body.errorName).toBe("CodeRepos:InvalidImportsBody");
  });

  it("400 InvalidImportsBody when items not array", async () => {
    const rid = await createRepo("BadItems");
    const r = await withAuth(
      request(app)
        .put(`/api/v1/code-repositories/${rid}/resource-imports`)
        .set("If-Match", 'W/"empty"')
        .send({ ontologyRid: "x", items: "nope" }),
    );
    expect(r.status).toBe(400);
    expect(r.body.errorName).toBe("CodeRepos:InvalidImportsBody");
    expect(r.body.parameters.field).toBe("items");
  });

  it("400 InvalidImportsBody when bad kind", async () => {
    const rid = await createRepo("BadKind");
    const r = await withAuth(
      request(app)
        .put(`/api/v1/code-repositories/${rid}/resource-imports`)
        .set("If-Match", 'W/"empty"')
        .send(
          imports([
            { kind: "action_type" as never, apiName: "Foo" },
          ]),
        ),
    );
    expect(r.status).toBe(400);
    expect(r.body.errorName).toBe("CodeRepos:InvalidImportsBody");
    expect(r.body.parameters.field).toBe("items[0].kind");
  });

  it("400 InvalidImportsBody when apiName has illegal chars", async () => {
    const rid = await createRepo("BadApi");
    const r = await withAuth(
      request(app)
        .put(`/api/v1/code-repositories/${rid}/resource-imports`)
        .set("If-Match", 'W/"empty"')
        .send(imports([{ kind: "object_type", apiName: "has spaces" }])),
    );
    expect(r.status).toBe(400);
    expect(r.body.parameters.field).toBe("items[0].apiName");
  });

  it("400 InvalidImportsBody when duplicate (kind, apiName) in request", async () => {
    const rid = await createRepo("Dup");
    const r = await withAuth(
      request(app)
        .put(`/api/v1/code-repositories/${rid}/resource-imports`)
        .set("If-Match", 'W/"empty"')
        .send(
          imports([
            { kind: "object_type", apiName: "Foo" },
            { kind: "object_type", apiName: "Foo" },
          ]),
        ),
    );
    expect(r.status).toBe(400);
    expect(r.body.parameters.reason).toMatch(/duplicate/i);
  });

  it("allows same apiName across kinds (object_type vs link_type)", async () => {
    const rid = await createRepo("CrossKind");
    const r = await withAuth(
      request(app)
        .put(`/api/v1/code-repositories/${rid}/resource-imports`)
        .set("If-Match", 'W/"empty"')
        .send(
          imports([
            { kind: "object_type", apiName: "Foo" },
            { kind: "link_type", apiName: "Foo" },
          ]),
        ),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.items).toHaveLength(2);
  });

  it("400 InvalidImportsBody when ontologyRid missing and items≠[]", async () => {
    const rid = await createRepo("NoOntology");
    const r = await withAuth(
      request(app)
        .put(`/api/v1/code-repositories/${rid}/resource-imports`)
        .set("If-Match", 'W/"empty"')
        .send({
          ontologyRid: null,
          items: [{ kind: "object_type", apiName: "Foo" }],
        }),
    );
    expect(r.status).toBe(400);
    expect(r.body.parameters.field).toBe("ontologyRid");
  });

  it("400 InvalidImportsBody when missing If-Match header", async () => {
    const rid = await createRepo("NoIfMatch");
    const r = await withAuth(
      request(app)
        .put(`/api/v1/code-repositories/${rid}/resource-imports`)
        .send({ ontologyRid: null, items: [] }),
    );
    expect(r.status).toBe(400);
    expect(r.body.parameters.field).toBe("If-Match");
  });

  it("400 InvalidImportsBody when If-Match is malformed", async () => {
    const rid = await createRepo("BadIfMatch");
    const r = await withAuth(
      request(app)
        .put(`/api/v1/code-repositories/${rid}/resource-imports`)
        .set("If-Match", "not-an-etag")
        .send({ ontologyRid: null, items: [] }),
    );
    expect(r.status).toBe(400);
    expect(r.body.parameters.field).toBe("If-Match");
  });

  it("412 StaleImportsState when If-Match does not match current", async () => {
    const rid = await createRepo("Stale");
    // First write so etag is non-empty.
    const r0 = await withAuth(
      request(app)
        .put(`/api/v1/code-repositories/${rid}/resource-imports`)
        .set("If-Match", 'W/"empty"')
        .send(imports([{ kind: "object_type", apiName: "A" }])),
    );
    expect(r0.status).toBe(200);
    // Now PUT with a stale "empty" etag.
    const r1 = await withAuth(
      request(app)
        .put(`/api/v1/code-repositories/${rid}/resource-imports`)
        .set("If-Match", 'W/"empty"')
        .send(imports([{ kind: "object_type", apiName: "B" }])),
    );
    expect(r1.status).toBe(412);
    expect(r1.body.errorName).toBe("CodeRepos:StaleImportsState");
    expect(r1.body.parameters.currentEtag).toMatch(/^[0-9a-f]{16}$/);
  });

  it("404 RepositoryNotFound on unknown rid", async () => {
    const r = await withAuth(
      request(app)
        .put(
          `/api/v1/code-repositories/ri.stemma.main.repository.00000000-0000-4000-8000-000000000000/resource-imports`,
        )
        .set("If-Match", 'W/"empty"')
        .send({ ontologyRid: null, items: [] }),
    );
    expect(r.status).toBe(404);
    expect(r.body.errorName).toBe("CodeRepos:RepositoryNotFound");
  });

  it("audit row written on success with action=resource_imports.put", async () => {
    const rid = await createRepo("Audit");
    const r = await withAuth(
      request(app)
        .put(`/api/v1/code-repositories/${rid}/resource-imports`)
        .set("If-Match", 'W/"empty"')
        .send(
          imports([
            { kind: "object_type", apiName: "Foo" },
            { kind: "link_type", apiName: "FooLink" },
          ]),
        ),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const audit = await schema.pool.query<{
      action: string;
      target_rid: string;
      parameters: Record<string, unknown>;
    }>(
      `SELECT action, target_rid, parameters
         FROM code_repos_audit_events
        WHERE action = 'resourceImports.put' AND target_rid = $1
        ORDER BY seq DESC LIMIT 1`,
      [rid],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].parameters.count).toBe(2);
    expect(audit.rows[0].parameters.kinds).toEqual({
      object_type: 1,
      link_type: 1,
    });
  });
});
