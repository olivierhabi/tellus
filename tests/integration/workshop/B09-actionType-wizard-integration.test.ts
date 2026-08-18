// =============================================================================
// B09 — Action Type Wizard wire-level integration.
//
// Uses real Postgres (per-schema harness) with action_type + idempotency
// table fixtures. Asserts:
//   - 201 + ETag + DB row + correct parameters JSON
//   - duplicate (ontology, apiName) → 409 ActionTypeApiNameConflict
//   - missing Idempotency-Key → 400 IdempotencyKeyRequired
//   - same key replay → cached 201 with same body
//   - same key + different body → 409 IdempotencyKeyReused
//   - audit row emitted via spy
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
  resetAuditEmitter,
  setAuditEmitter,
  type WorkshopAuditEvent,
} from "../../../src/services/workshop/audit";

let ctx: SchemaContext | null = null;
let app: Express;
let pgAvailable = true;
const ONTOLOGY = `ri.ontology.main.ontology.${randomUUID()}`;
const auditLog: WorkshopAuditEvent[] = [];

beforeAll(async () => {
  try {
    ctx = await openTestSchema("workshop_b09");
    await ctx.exec(`
      CREATE TABLE action_type (
        action_type_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ontology_id    TEXT NOT NULL,
        api_name       TEXT NOT NULL,
        display_name   TEXT NOT NULL,
        description    TEXT,
        parameters     JSONB,
        rules          JSONB,
        submission_criteria JSONB,
        is_enabled     BOOLEAN NOT NULL DEFAULT true,
        max_affected_objects INT NOT NULL DEFAULT 1000,
        -- Migration 124 made these NOT NULL; the wizard INSERT always writes
        -- the resolved v1 triple, so the scratch table must carry them.
        semantics_version SMALLINT NOT NULL,
        execution_mode TEXT NOT NULL,
        delete_policy TEXT NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (ontology_id, api_name)
      );
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
      `[B09] Postgres unavailable; tests will be skipped: ${
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
  setAuditEmitter(async (e) => {
    auditLog.push(e);
  });
  app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string; token: string } }).user = {
      id: "u-b09",
      token: "jwt-b09",
    };
    next();
  });
  app.use("/api/v1/workshop", workshopModulesRouter);
});

afterAll(async () => {
  resetAuditEmitter();
  resetWorkshopDb();
  if (ctx) await ctx.close();
});

beforeEach(async () => {
  auditLog.length = 0;
  if (ctx) {
    await ctx.pool.query("TRUNCATE TABLE action_type RESTART IDENTITY");
    await ctx.pool.query("TRUNCATE TABLE workshop_idempotency_record");
  }
});

const itp = (...args: Parameters<typeof it>) =>
  pgAvailable ? it(...args) : it.skip(...args);

const baseBody = () => ({
  ontologyRid: ONTOLOGY,
  apiName: "olivierAssignOrder",
  displayName: "Olivier Assign Order",
  description: "",
  parameters: [
    { apiName: "assignee", binding: { kind: "user" }, type: "user", required: true },
    {
      apiName: "status",
      binding: { kind: "static", value: "assigned" },
      type: "string",
      required: true,
    },
  ],
  submissionCriteria: { kind: "user", target: "self" },
  isEnabled: true,
  maxAffectedObjects: 1000,
});

describe("B09 — POST /action-types", () => {
  itp("creates action type, returns 201 + ETag + audit row", async () => {
    const r = await request(app)
      .post("/api/v1/workshop/action-types")
      .set("Idempotency-Key", randomUUID())
      .send(baseBody());
    expect(r.status).toBe(201);
    expect(r.headers["etag"]).toMatch(/^W\//);
    expect(r.body.apiName).toBe("olivierAssignOrder");
    expect(r.body.parameters).toHaveLength(2);
    expect(r.body.submissionCriteria).toEqual({ kind: "user", target: "self" });
    // DB
    const rows = await ctx!.pool.query(
      `SELECT api_name, display_name, parameters FROM action_type WHERE ontology_id = $1`,
      [ONTOLOGY],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]!.api_name).toBe("olivierAssignOrder");
    expect(rows.rows[0]!.parameters).toHaveLength(2);
    // Audit
    expect(auditLog).toHaveLength(1);
    expect(auditLog[0]!.action).toBe("WORKSHOP_ACTION_TYPE_CREATED");
  });

  itp("rejects duplicate (ontology, apiName) → 409 ActionTypeApiNameConflict", async () => {
    await request(app)
      .post("/api/v1/workshop/action-types")
      .set("Idempotency-Key", randomUUID())
      .send(baseBody());
    const r = await request(app)
      .post("/api/v1/workshop/action-types")
      .set("Idempotency-Key", randomUUID())
      .send(baseBody());
    expect(r.status).toBe(409);
    expect(r.body.errorName).toBe("Tellus:Workshop:ActionTypeApiNameConflict");
  });

  itp("missing Idempotency-Key → IdempotencyKeyRequired 400", async () => {
    const r = await request(app)
      .post("/api/v1/workshop/action-types")
      .send(baseBody());
    expect(r.status).toBe(400);
    expect(r.body.errorName).toBe("Tellus:Workshop:IdempotencyKeyRequired");
  });

  itp("same key + same body → cached 201", async () => {
    const key = randomUUID();
    const body = baseBody();
    const r1 = await request(app)
      .post("/api/v1/workshop/action-types")
      .set("Idempotency-Key", key)
      .send(body);
    expect(r1.status).toBe(201);
    const r2 = await request(app)
      .post("/api/v1/workshop/action-types")
      .set("Idempotency-Key", key)
      .send(body);
    expect(r2.status).toBe(201);
    expect(r2.body).toEqual(r1.body);
    // DB still has exactly one row (cached replay didn't insert again)
    const rows = await ctx!.pool.query(
      `SELECT count(*)::int AS c FROM action_type WHERE ontology_id = $1`,
      [ONTOLOGY],
    );
    expect(rows.rows[0]!.c).toBe(1);
  });

  itp("same key + different body → IdempotencyKeyReused 409", async () => {
    const key = randomUUID();
    const r1 = await request(app)
      .post("/api/v1/workshop/action-types")
      .set("Idempotency-Key", key)
      .send(baseBody());
    expect(r1.status).toBe(201);
    const r2 = await request(app)
      .post("/api/v1/workshop/action-types")
      .set("Idempotency-Key", key)
      .send({ ...baseBody(), apiName: "differentApi" });
    expect(r2.status).toBe(409);
    expect(r2.body.errorName).toBe("Tellus:Workshop:IdempotencyKeyReused");
  });
});
