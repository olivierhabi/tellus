// =============================================================================
// B10 — Actions wire-level integration via supertest + Postgres harness.
//
// The idempotency path requires DB. Validate path is DB-free.
//
// Spec §B10:
//   - /actions/_apply requires Idempotency-Key (G-03)
//   - same key + same body → cached response (200 from cache)
//   - same key + different body → 409 IdempotencyKeyReused
//   - StaleObjectError → 409 ActionStaleObject
//   - branch flows verbatim
// =============================================================================

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
import workshopModulesRouter from "../../../src/routes/workshopModules";
import {
  RecordingActionsAdapter,
  setActions,
  StaleObjectError,
} from "../../../src/services/workshop/actionsAdapter";

let ctx: SchemaContext | null = null;
let app: Express;
let pgAvailable = true;

beforeAll(async () => {
  try {
    ctx = await openTestSchema("workshop_b10");
    // Apply the idempotency table only — actions/_apply needs it.
    await ctx.exec(`
      CREATE TABLE workshop_idempotency_record (
        idempotency_key TEXT NOT NULL,
        user_id         TEXT NOT NULL,
        route           TEXT NOT NULL,
        body_sha256     BYTEA NOT NULL,
        response_status INT NOT NULL,
        response_body   JSONB NOT NULL,
        response_etag   TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
        PRIMARY KEY (idempotency_key, user_id, route)
      );
    `);
  } catch (err) {
    pgAvailable = false;
    // eslint-disable-next-line no-console
    console.warn(
      `[B10] Postgres unavailable; tests will be skipped: ${
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
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
  });
  app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string; token: string } }).user = {
      id: "u-b10",
      token: "jwt-b10",
    };
    next();
  });
  app.use("/api/v1/workshop", workshopModulesRouter);
});

afterAll(async () => {
  resetWorkshopDb();
  if (ctx) await ctx.close();
});

beforeEach(async () => {
  setActions(new RecordingActionsAdapter());
  if (ctx) {
    await ctx.pool.query("TRUNCATE TABLE workshop_idempotency_record");
  }
});

const itp = (...args: Parameters<typeof it>) =>
  pgAvailable ? it(...args) : it.skip(...args);

describe("B10 — actions/_validate (no DB)", () => {
  itp("B10 wire: returns adapter's validation result", async () => {
    setActions(
      new RecordingActionsAdapter(() => ({
        valid: false,
        errors: [{ path: "$.assignee", code: "REQUIRED", message: "missing" }],
      })),
    );
    const r = await request(app)
      .post("/api/v1/workshop/actions/_validate")
      .send({
        ontologyRid: "o1",
        actionTypeApiName: "assignOrder",
        parameters: { status: "assigned" },
      });
    expect(r.status).toBe(200);
    expect(r.body.valid).toBe(false);
    expect(r.body.errors).toHaveLength(1);
    expect(r.body.errors[0].code).toBe("REQUIRED");
  });

  itp("B10 wire: branch flows verbatim", async () => {
    const recording = new RecordingActionsAdapter();
    setActions(recording);
    await request(app)
      .post(
        "/api/v1/workshop/actions/_validate?branch=ri.branch.b1",
      )
      .send({
        ontologyRid: "o1",
        actionTypeApiName: "assignOrder",
        parameters: {},
      });
    expect(recording.calls[0]!.context.branchRid).toBe("ri.branch.b1");
    expect(recording.calls[0]!.context.jwt).toBe("jwt-b10");
  });
});

describe("B10 — actions/_apply (idempotency + stale object)", () => {
  itp("B10 wire: missing Idempotency-Key → IdempotencyKeyRequired 400", async () => {
    const r = await request(app)
      .post("/api/v1/workshop/actions/_apply")
      .send({
        ontologyRid: "o1",
        actionTypeApiName: "assignOrder",
        parameters: { assignee: "alice" },
      });
    expect(r.status).toBe(400);
    expect(r.body.errorName).toBe("Tellus:Workshop:IdempotencyKeyRequired");
  });

  itp("B10 wire: malformed Idempotency-Key → IdempotencyKeyMalformed 400", async () => {
    const r = await request(app)
      .post("/api/v1/workshop/actions/_apply")
      .set("Idempotency-Key", "not-a-uuid")
      .send({
        ontologyRid: "o1",
        actionTypeApiName: "assignOrder",
        parameters: { assignee: "alice" },
      });
    expect(r.status).toBe(400);
    expect(r.body.errorName).toBe("Tellus:Workshop:IdempotencyKeyMalformed");
  });

  itp("B10 wire: same key + same body → cached replay (adapter invoked once)", async () => {
    const recording = new RecordingActionsAdapter(undefined, () => ({
      validation: { valid: true, errors: [] },
      edits: {
        modifiedObjects: [{ objectTypeApiName: "Order", primaryKey: "80060" }],
        modifiedProperties: ["assignee", "status"],
        createdObjects: [],
        deletedObjects: [],
      },
    }));
    setActions(recording);
    const key = randomUUID();
    const body = {
      ontologyRid: "o1",
      actionTypeApiName: "assignOrder",
      parameters: { assignee: "alice", status: "assigned" },
    };
    const r1 = await request(app)
      .post("/api/v1/workshop/actions/_apply")
      .set("Idempotency-Key", key)
      .send(body);
    expect(r1.status).toBe(200);
    expect(r1.body.edits.modifiedProperties).toEqual(["assignee", "status"]);
    const r2 = await request(app)
      .post("/api/v1/workshop/actions/_apply")
      .set("Idempotency-Key", key)
      .send(body);
    expect(r2.status).toBe(200);
    expect(r2.body).toEqual(r1.body);
    expect(recording.calls.filter((c) => c.kind === "apply")).toHaveLength(1);
  });

  itp("B10 wire: same key + different body → IdempotencyKeyReused 409", async () => {
    const key = randomUUID();
    const body1 = {
      ontologyRid: "o1",
      actionTypeApiName: "assignOrder",
      parameters: { assignee: "alice" },
    };
    const body2 = {
      ontologyRid: "o1",
      actionTypeApiName: "assignOrder",
      parameters: { assignee: "bob" },
    };
    const r1 = await request(app)
      .post("/api/v1/workshop/actions/_apply")
      .set("Idempotency-Key", key)
      .send(body1);
    expect(r1.status).toBe(200);
    const r2 = await request(app)
      .post("/api/v1/workshop/actions/_apply")
      .set("Idempotency-Key", key)
      .send(body2);
    expect(r2.status).toBe(409);
    expect(r2.body.errorName).toBe("Tellus:Workshop:IdempotencyKeyReused");
  });

  itp("B10 wire: StaleObjectError → ActionStaleObject 409", async () => {
    setActions(
      new RecordingActionsAdapter(undefined, () => {
        throw new StaleObjectError("Order", "o-99", "v3", "v4");
      }),
    );
    const r = await request(app)
      .post("/api/v1/workshop/actions/_apply")
      .set("Idempotency-Key", randomUUID())
      .send({
        ontologyRid: "o1",
        actionTypeApiName: "assignOrder",
        parameters: { assignee: "x" },
      });
    expect(r.status).toBe(409);
    expect(r.body.errorName).toBe("Tellus:Workshop:ActionStaleObject");
    expect(r.body.parameters.objectTypeApiName).toBe("Order");
    expect(r.body.parameters.primaryKey).toBe("o-99");
  });

  itp("B10 wire: branch flows verbatim into apply", async () => {
    const recording = new RecordingActionsAdapter();
    setActions(recording);
    await request(app)
      .post("/api/v1/workshop/actions/_apply?branch=ri.branch.feat.x")
      .set("Idempotency-Key", randomUUID())
      .send({
        ontologyRid: "o1",
        actionTypeApiName: "assignOrder",
        parameters: { assignee: "alice" },
      });
    const apply = recording.calls.find((c) => c.kind === "apply");
    expect(apply).toBeDefined();
    expect(apply!.context.branchRid).toBe("ri.branch.feat.x");
    expect(apply!.context.jwt).toBe("jwt-b10");
  });
});
