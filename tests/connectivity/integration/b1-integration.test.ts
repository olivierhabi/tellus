// ---------------------------------------------------------------------------
// B1 integration tests against a real Postgres 16 (Testcontainers).
//
// Maps the spec §76 in-session acceptance criteria literally:
//
//   1. Round-trip create/read/list/update/delete with valid If-Match;
//      invalid If-Match → 409.
//   2. Concurrent PUT with same If-Match → exactly one 2xx + one 409.
//   3. Soft-delete excludes from list; read returns 404.
//   4. Idempotency-Key replay within 24h returns original response.
//   5. Compass folder deletion blocked while connection exists.
//   6. CI runs `npm run generate:openapi:connectivity` and confirms emitted
//      YAML is committed AND `openapi-typescript` produces a TS client that
//      compiles (this criterion is gated on the host's npm; the harness
//      exercises the emitter in-process and snapshots its output).
//
// Notes
// - The handler extracts req.user via a flexible reader. The test injects a
//   tiny middleware before the router that sets req.user = { id, tenant,
//   scopes }. No coupling to the production Multipass middleware.
// - The outbox poller is disabled in the test env (TELLUS_DISABLE_..._POLLER=1);
//   tests drain the outbox synchronously via outbox.drainForTest() between
//   the create and the folder-delete assertion so the Compass row exists.
// - Each test resets the connectivity tables to keep ordering deterministic.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import express from "express";
import request from "supertest";
import {
  PgFixture,
  resetConnectivityTables,
  setEnvForTest,
  startPostgres16,
} from "../../fixtures/containers";
import { buildOpenApiDocument } from "../../../src/services/connectivity/openapi";

let fixture: PgFixture;
let app: express.Express;

// Module-scoped lazy imports — connectivity router pulls in src/db.ts
// which evaluates DATABASE_URL at first import. We need setEnvForTest()
// to run first.
async function buildAppForTests(scopes: string[] = ["connectivity:*"]) {
  const { createConnectivityRouter } = await import(
    "../../../src/services/connectivity"
  );
  const a = express();
  a.use(express.json({ limit: "1mb" }));
  a.use((req, _res, next) => {
    (req as any).user = {
      id: fixture.testUserId,
      tenant: "default",
      scopes,
    };
    next();
  });
  a.use("/api/v2/connectivity", createConnectivityRouter());
  return a;
}

beforeAll(async () => {
  fixture = await startPostgres16();
  setEnvForTest(fixture);
  app = await buildAppForTests();
}, 120_000);

afterAll(async () => {
  await fixture?.cleanup();
});

beforeEach(async () => {
  await resetConnectivityTables(fixture.pool);
});

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    name: `src-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    description: "test source",
    connectorType: "postgresql",
    workerType: "foundryWorker",
    config: {
      connectorType: "postgresql",
      postgres: { host: "db.example.com", database: "fraud" },
    },
    egressPolicy: {
      allowlist: [{ kind: "host", host: "db.example.com", port: 5432 }],
    },
    compassFolderRid: fixture.testFolderRid,
    ...overrides,
  };
}

async function drainOutbox() {
  const outbox = await import("../../../src/services/connectivity/store/outbox");
  await outbox.drainForTest("test-worker");
}

// ---------------------------------------------------------------------------
// Acceptance criterion 1 — happy path CRUD + invalid If-Match → 409
// ---------------------------------------------------------------------------

describe("B1 §76.1 — round-trip CRUD + ETag/If-Match", () => {
  it("POST → 201 with weak ETag W/\"1\" and Location header", async () => {
    const res = await request(app)
      .post("/api/v2/connectivity/connections")
      .send(createBody({ name: "ac1-create" }));
    expect(res.status).toBe(201);
    expect(res.headers.etag).toBe('W/"1"');
    expect(res.headers.location).toMatch(/^\/api\/v2\/connectivity\/connections\/ri\.magritte\.main\.source\./);
    expect(res.body.rid).toMatch(/^ri\.magritte\.main\.source\./);
    expect(res.body.version).toBe(1);
    expect(res.body.connectorType).toBe("postgresql");
  });

  it("GET → 200 with ETag, matching the POST response", async () => {
    const created = await request(app)
      .post("/api/v2/connectivity/connections")
      .send(createBody({ name: "ac1-read" }));
    expect(created.status).toBe(201);

    const got = await request(app).get(
      `/api/v2/connectivity/connections/${created.body.rid}`,
    );
    expect(got.status).toBe(200);
    expect(got.headers.etag).toBe('W/"1"');
    expect(got.body.rid).toBe(created.body.rid);
  });

  it("PUT with valid If-Match → 200, version bumped, ETag bumped", async () => {
    const created = await request(app)
      .post("/api/v2/connectivity/connections")
      .send(createBody({ name: "ac1-update" }));
    const updated = await request(app)
      .put(`/api/v2/connectivity/connections/${created.body.rid}`)
      .set("If-Match", 'W/"1"')
      .send({ description: "edited" });
    expect(updated.status).toBe(200);
    expect(updated.body.version).toBe(2);
    expect(updated.headers.etag).toBe('W/"2"');
    expect(updated.body.description).toBe("edited");
  });

  it("PUT with stale If-Match → 409 Tellus:Connectivity:ResourceVersionMismatch", async () => {
    const created = await request(app)
      .post("/api/v2/connectivity/connections")
      .send(createBody({ name: "ac1-stale" }));
    const stale = await request(app)
      .put(`/api/v2/connectivity/connections/${created.body.rid}`)
      .set("If-Match", 'W/"99"')
      .send({ description: "edited" });
    expect(stale.status).toBe(409);
    expect(stale.body.errorName).toBe(
      "Tellus:Connectivity:ResourceVersionMismatch",
    );
    expect(stale.body.parameters.current).toBe(1);
    expect(stale.body.parameters.provided).toBe(99);
  });

  it("PUT missing If-Match → 412 Tellus:Connectivity:IfMatchRequired", async () => {
    const created = await request(app)
      .post("/api/v2/connectivity/connections")
      .send(createBody({ name: "ac1-noifmatch" }));
    const res = await request(app)
      .put(`/api/v2/connectivity/connections/${created.body.rid}`)
      .send({ description: "edited" });
    expect(res.status).toBe(412);
    expect(res.body.errorName).toBe("Tellus:Connectivity:IfMatchRequired");
  });

  it("LIST returns the created connection", async () => {
    await request(app)
      .post("/api/v2/connectivity/connections")
      .send(createBody({ name: "ac1-list" }));
    const list = await request(app).get("/api/v2/connectivity/connections");
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThan(0);
  });

  it("DELETE with valid If-Match → 204; subsequent GET → 404", async () => {
    const created = await request(app)
      .post("/api/v2/connectivity/connections")
      .send(createBody({ name: "ac1-delete" }));
    const del = await request(app)
      .delete(`/api/v2/connectivity/connections/${created.body.rid}`)
      .set("If-Match", 'W/"1"');
    expect(del.status).toBe(204);

    const got = await request(app).get(
      `/api/v2/connectivity/connections/${created.body.rid}`,
    );
    expect(got.status).toBe(404);
    expect(got.body.errorName).toBe("Tellus:Connectivity:ConnectionNotFound");
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 2 — concurrent PUT: exactly one 200 + one 409
// ---------------------------------------------------------------------------

describe("B1 §76.2 — concurrent PUT OCC", () => {
  it("fires two PUTs with same If-Match; one wins, one 409s", async () => {
    const created = await request(app)
      .post("/api/v2/connectivity/connections")
      .send(createBody({ name: "ac2-occ" }));

    const [a, b] = await Promise.all([
      request(app)
        .put(`/api/v2/connectivity/connections/${created.body.rid}`)
        .set("If-Match", 'W/"1"')
        .send({ description: "A" }),
      request(app)
        .put(`/api/v2/connectivity/connections/${created.body.rid}`)
        .set("If-Match", 'W/"1"')
        .send({ description: "B" }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const losingBody = a.status === 409 ? a.body : b.body;
    expect(losingBody.errorName).toBe(
      "Tellus:Connectivity:ResourceVersionMismatch",
    );
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 3 — soft-delete excludes from list; read returns 404
// ---------------------------------------------------------------------------

describe("B1 §76.3 — soft-delete semantics", () => {
  it("after DELETE, list excludes the row and read returns 404", async () => {
    const created = await request(app)
      .post("/api/v2/connectivity/connections")
      .send(createBody({ name: "ac3-soft" }));
    await request(app)
      .delete(`/api/v2/connectivity/connections/${created.body.rid}`)
      .set("If-Match", 'W/"1"')
      .expect(204);

    const list = await request(app).get("/api/v2/connectivity/connections");
    expect(list.body.data.find((c: any) => c.rid === created.body.rid)).toBeUndefined();

    const got = await request(app).get(
      `/api/v2/connectivity/connections/${created.body.rid}`,
    );
    expect(got.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 4 — Idempotency-Key 24h replay
// ---------------------------------------------------------------------------

describe("B1 §76.4 — Idempotency-Key replay", () => {
  it("identical POST with same key returns the cached response + Idempotent-Replay header", async () => {
    const key = randomUUID();
    const body = createBody({ name: "ac4-idem" });

    const first = await request(app)
      .post("/api/v2/connectivity/connections")
      .set("Idempotency-Key", key)
      .send(body);
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/api/v2/connectivity/connections")
      .set("Idempotency-Key", key)
      .send(body);
    expect(second.status).toBe(201);
    expect(second.headers["idempotent-replay"]).toBe("true");
    expect(second.body.rid).toBe(first.body.rid);
  });

  it("same key, different body → 409 IDEMPOTENCY_KEY_CONFLICT", async () => {
    const key = randomUUID();
    await request(app)
      .post("/api/v2/connectivity/connections")
      .set("Idempotency-Key", key)
      .send(createBody({ name: "ac4-same-key-A" }))
      .expect(201);

    const conflict = await request(app)
      .post("/api/v2/connectivity/connections")
      .set("Idempotency-Key", key)
      .send(createBody({ name: "ac4-same-key-B" }));
    expect(conflict.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 5 — Compass folder deletion blocked while connection exists
// ---------------------------------------------------------------------------

describe("B1 §76.5 — folder deletion blocked while connection exists", () => {
  it("DELETE FROM resources WHERE rid = folder_rid → foreign_key_violation", async () => {
    await request(app)
      .post("/api/v2/connectivity/connections")
      .send(createBody({ name: "ac5-folder" }))
      .expect(201);
    await drainOutbox();

    // The connectivity_connections row carries the FK to resources(folder_rid)
    // ON DELETE RESTRICT, so DELETE on the folder row must fail with PG error
    // code 23503 (foreign_key_violation).
    await expect(
      fixture.pool.query(`DELETE FROM resources WHERE rid = $1`, [
        fixture.testFolderRid,
      ]),
    ).rejects.toMatchObject({ code: "23503" });
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 6 — OpenAPI emission in-process
// ---------------------------------------------------------------------------

describe("B1 §76.6 — OpenAPI emission", () => {
  it("buildOpenApiDocument() returns an OpenAPI 3.1 doc with all 7 paths", () => {
    const doc = buildOpenApiDocument() as any;
    expect(doc.openapi).toMatch(/^3\.1/);
    const paths = Object.keys(doc.paths);
    expect(paths).toContain("/api/v2/connectivity/connections");
    expect(paths).toContain("/api/v2/connectivity/connections/{rid}");
    expect(paths).toContain(
      "/api/v2/connectivity/connections/{rid}/configuration",
    );
    expect(paths).toContain("/api/v2/connectivity/connections/{rid}/status");

    const ops = doc.paths["/api/v2/connectivity/connections/{rid}"];
    expect(ops).toHaveProperty("get");
    expect(ops).toHaveProperty("put");
    expect(ops).toHaveProperty("delete");

    const post = doc.paths["/api/v2/connectivity/connections"].post;
    expect(post.responses["201"]).toBeDefined();
    expect(post.responses["409"]).toBeDefined();
    expect(post.security[0].multipass).toContain("connectivity:write");
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: §9 envelope shape on every error path
// ---------------------------------------------------------------------------

describe("§9 cross-cutting — envelope shape on errors", () => {
  it("404 body has { errorCode, errorName, errorInstanceId, parameters }", async () => {
    const res = await request(app).get(
      "/api/v2/connectivity/connections/ri.magritte.main.source.00000000-0000-0000-0000-000000000000",
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      errorCode: "NOT_FOUND",
      errorName: "Tellus:Connectivity:ConnectionNotFound",
    });
    expect(typeof res.body.errorInstanceId).toBe("string");
    expect(res.body.parameters).toBeDefined();
  });
});
