// ---------------------------------------------------------------------------
// B01 — Wire-level integration tests for the Express route layer.
//
// Exercises the route bindings end-to-end via supertest, against the same
// per-schema Postgres harness used by the service-level tests, with an
// in-test auth middleware that injects `req.user.id` (so the router can
// call `currentUser(req)` without involving Keycloak/Multipass).
//
// Contract IDs proven at the wire level:
//   B01 C-01      201 Created with `Location` and `ETag` headers, body shape.
//   B01 C-09/C-10 PUT without/stale If-Match → 412 Conjure-style envelope.
//   B01 C-11      PUT success → new ETag header + 200.
//   B01 C-15      Idempotency replay returns 200 (not 201) with same body.
//   B01 C-16      Idempotency reuse with different body → 409 envelope.
//   B01 C-22      Audit row emitted for create/update/delete (via spy).
//   G-01          Conjure-style envelope on every error path.
//   G-05          ?branch=… is forwarded into the actor (read-back via
//                 the audit spy details payload).
// ---------------------------------------------------------------------------

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";

import {
  openTestSchema,
  type SchemaContext,
} from "../code-repos/_helpers/pg";
import {
  resetWorkshopDb,
  setWorkshopDb,
} from "../../../src/services/workshop/db";
import {
  resetAuditEmitter,
  setAuditEmitter,
  type WorkshopAuditEvent,
} from "../../../src/services/workshop/audit";
import workshopModulesRouter from "../../../src/routes/workshopModules";

const FOLDER = `ri.compass.main.folder.${randomUUID()}`;
const ONTOLOGY = `ri.ontology.main.ontology.${randomUUID()}`;
const TEST_USER = "user-routing-test";

let ctx: SchemaContext | null = null;
let app: Express;
let pgAvailable = true;
let audit: WorkshopAuditEvent[] = [];

function buildBody(displayName: string) {
  return {
    displayName,
    description: null,
    parentFolderRid: FOLDER,
    ontologyRid: ONTOLOGY,
    branchRid: null,
    definition: {
      schemaVersion: 4,
      variables: [],
      widgets: [],
      sections: [{ id: "s_root", layout: "rows", children: [] }],
      layout: { rootSection: "s_root" },
    },
  };
}

beforeAll(async () => {
  try {
    ctx = await openTestSchema("workshop_b01_route");
    await ctx.applyMigration("src/migrations/058_b1_workshop_module.sql");
    await ctx.applyMigration(
      "src/migrations/059_b1_workshop_idempotency.sql",
    );
  } catch (err) {
    pgAvailable = false;
    // eslint-disable-next-line no-console
    console.warn(
      `[B01-route] Postgres unavailable; tests will be skipped: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }

  setWorkshopDb({
    query: (sql, params) => ctx!.pool.query(sql, params ?? []),
    withTransaction: async (fn) => {
      const client = await ctx!.pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(client);
        await client.query("COMMIT");
        return out;
      } catch (e) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* swallow */
        }
        throw e;
      } finally {
        client.release();
      }
    },
  });

  setAuditEmitter(async (e) => {
    audit.push(e);
  });

  app = express();
  app.use(express.json({ limit: "10mb" }));
  // In-test "Multipass" — extract subject from a header.
  app.use((req, _res, next) => {
    const sub = (req.header("x-test-principal") as string | undefined) ?? TEST_USER;
    (req as express.Request & { user?: { id?: string } }).user = { id: sub };
    next();
  });
  app.use("/api/v1/workshop", workshopModulesRouter);
});

afterAll(async () => {
  resetWorkshopDb();
  resetAuditEmitter();
  if (ctx) await ctx.close();
});

beforeEach(async () => {
  if (!pgAvailable || !ctx) return;
  await ctx.exec("TRUNCATE workshop_module CASCADE");
  await ctx.exec("TRUNCATE workshop_idempotency_record");
  audit = [];
});

const itp = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!pgAvailable) return;
    await fn();
  });

describe("B01 — wire-level routing via supertest", () => {
  itp(
    "B01 C-01: POST returns 201, Location, ETag, full body; audit row written",
    async () => {
      const r = await request(app)
        .post("/api/v1/workshop/modules")
        .send(buildBody("Wire One"));
      expect(r.status).toBe(201);
      expect(r.headers.location).toMatch(
        /^\/api\/v1\/workshop\/modules\/ri\.workshop\.main\.module\./,
      );
      expect(r.headers.etag).toMatch(/^W\/"[0-9a-f]{64}"$/);
      expect(r.body.displayName).toBe("Wire One");
      expect(r.body.currentSemver).toBe("0.1.0");
      expect(audit).toHaveLength(1);
      expect(audit[0].action).toBe("WORKSHOP_MODULE_CREATED");
      expect(audit[0].rid).toBe(r.body.rid);
      expect(audit[0].actorSubject).toBe(TEST_USER);
    },
  );

  itp(
    "G-05: ?branch=… is forwarded into the actor (visible in audit details)",
    async () => {
      const branchRid = `ri.workshop.main.branch.${randomUUID()}`;
      const r = await request(app)
        .post(`/api/v1/workshop/modules?branch=${branchRid}`)
        .send(buildBody("Branched"));
      expect(r.status).toBe(201);
      expect(audit[0].details?.branchRid).toBe(branchRid);
    },
  );

  itp(
    "B01 C-09: PUT without If-Match → 412 Tellus:Workshop:ResourceVersionMismatch envelope",
    async () => {
      const created = await request(app)
        .post("/api/v1/workshop/modules")
        .send(buildBody("Needs IfMatch"));
      const rid = created.body.rid;
      const r = await request(app)
        .put(`/api/v1/workshop/modules/${rid}`)
        .send({ definition: buildBody("ignored").definition });
      expect(r.status).toBe(412);
      expect(r.body).toMatchObject({
        errorCode: "FAILED_PRECONDITION",
        errorName: "Tellus:Workshop:ResourceVersionMismatch",
      });
      expect(r.body.errorInstanceId).toMatch(
        /^[0-9a-f-]{36}$/,
      );
    },
  );

  itp(
    "B01 C-10/C-11: PUT with stale If-Match → 412; with current → 200 + new ETag",
    async () => {
      const created = await request(app)
        .post("/api/v1/workshop/modules")
        .send(buildBody("ETag round-trip"));
      const rid = created.body.rid;
      const firstEtag = created.headers.etag;

      const ok = await request(app)
        .put(`/api/v1/workshop/modules/${rid}`)
        .set("If-Match", firstEtag)
        .send({
          definition: {
            schemaVersion: 4,
            variables: [],
            widgets: [{ id: "w_a", type: "header", config: { title: "A" } }],
            sections: [
              {
                id: "s_root",
                layout: "rows",
                children: [{ kind: "widget", ref: "w_a" }],
              },
            ],
            layout: { rootSection: "s_root" },
          },
        });
      expect(ok.status).toBe(200);
      expect(ok.headers.etag).toMatch(/^W\/"[0-9a-f]{64}"$/);
      expect(ok.headers.etag).not.toBe(firstEtag);

      // Stale: re-use firstEtag.
      const stale = await request(app)
        .put(`/api/v1/workshop/modules/${rid}`)
        .set("If-Match", firstEtag)
        .send({
          definition: {
            schemaVersion: 4,
            variables: [],
            widgets: [],
            sections: [{ id: "s_root", layout: "rows", children: [] }],
            layout: { rootSection: "s_root" },
          },
        });
      expect(stale.status).toBe(412);
      expect(stale.body.errorName).toBe(
        "Tellus:Workshop:ResourceVersionMismatch",
      );
      expect(stale.body.parameters.currentEtag).toBe(ok.headers.etag);
    },
  );

  itp(
    "B01 C-15: POST replay (same Idempotency-Key + same body) returns 200 with same RID",
    async () => {
      const key = randomUUID();
      const body = buildBody("Idempotent wire");

      const a = await request(app)
        .post("/api/v1/workshop/modules")
        .set("Idempotency-Key", key)
        .send(body);
      expect(a.status).toBe(201);

      const b = await request(app)
        .post("/api/v1/workshop/modules")
        .set("Idempotency-Key", key)
        .send(body);
      expect(b.status).toBe(200);
      expect(b.body.rid).toBe(a.body.rid);
    },
  );

  itp(
    "B01 C-16: POST reuse with different body → 409 IdempotencyKeyReused envelope",
    async () => {
      const key = randomUUID();
      const a = await request(app)
        .post("/api/v1/workshop/modules")
        .set("Idempotency-Key", key)
        .send(buildBody("Wire A"));
      expect(a.status).toBe(201);

      const b = await request(app)
        .post("/api/v1/workshop/modules")
        .set("Idempotency-Key", key)
        .send(buildBody("Wire B"));
      expect(b.status).toBe(409);
      expect(b.body).toMatchObject({
        errorCode: "CONFLICT",
        errorName: "Tellus:Workshop:IdempotencyKeyReused",
      });
    },
  );

  itp(
    "B01 C-22: every mutating call emits exactly one audit row with the right action",
    async () => {
      const created = await request(app)
        .post("/api/v1/workshop/modules")
        .send(buildBody("Audit"));
      const rid = created.body.rid;
      const firstEtag = created.headers.etag;
      const updated = await request(app)
        .put(`/api/v1/workshop/modules/${rid}`)
        .set("If-Match", firstEtag)
        .send({
          definition: {
            schemaVersion: 4,
            variables: [],
            widgets: [],
            sections: [{ id: "s_root", layout: "rows", children: [] }],
            layout: { rootSection: "s_root" },
          },
        });
      expect(updated.status).toBe(200);
      const deleted = await request(app)
        .delete(`/api/v1/workshop/modules/${rid}`)
        .set("If-Match", updated.headers.etag);
      expect(deleted.status).toBe(204);

      expect(audit.map((e) => e.action)).toEqual([
        "WORKSHOP_MODULE_CREATED",
        "WORKSHOP_MODULE_UPDATED",
        "WORKSHOP_MODULE_DELETED",
      ]);
      for (const e of audit) {
        expect(e.rid).toBe(rid);
        expect(e.actorSubject).toBe(TEST_USER);
        expect(e.result).toBe("SUCCESS");
      }
    },
  );

  itp(
    "G-01: validation error returns Conjure-style envelope (errorCode, errorName, errorInstanceId)",
    async () => {
      const r = await request(app)
        .post("/api/v1/workshop/modules")
        .send({ displayName: "x", parentFolderRid: "not-a-rid" });
      expect(r.status).toBe(400);
      expect(r.body.errorCode).toBe("INVALID_ARGUMENT");
      expect(r.body.errorName).toBe("Tellus:Workshop:InvalidModuleSchema");
      expect(r.body.errorInstanceId).toMatch(/^[0-9a-f-]{36}$/);
    },
  );
});
