// B04 — bootstrap integration tests.
//
// Spec §B04: POST /api/v1/workshop/modules:bootstrap creates a fresh
// module from Ontology Manager, optionally seeded with an Object Set
// variable. Idempotency-Key is REQUIRED (G-03 + Forbidden Behaviors).
//
// Contract IDs:
//   B04 C-01 happy path returns 201 + RID + ETag
//   B04 C-02 missing Idempotency-Key → 400 IdempotencyKeyRequired
//   B04 C-03 idempotency replay returns same RID
//   B04 C-04 idempotency conflict (same key + different body) → 409
//   B04 C-05 unknown seed object type → 404 ObjectTypeNotFound
//   B04 C-06 audit row written exactly once per bootstrap
//   B04 C-07 seeded module includes an Object Set variable when seed supplied

import {
  afterAll,
  beforeAll,
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

const ONTOLOGY_UUID = randomUUID();
const ONTOLOGY = `ri.ontology.main.ontology.${ONTOLOGY_UUID}`;
const FOLDER = `ri.compass.main.folder.${randomUUID()}`;

let ctx: SchemaContext | null = null;
let app: Express;
let pgAvailable = true;

beforeAll(async () => {
  try {
    ctx = await openTestSchema("workshop_b04");
    await ctx.applyMigration("src/migrations/058_b1_workshop_module.sql");
    await ctx.applyMigration("src/migrations/059_b1_workshop_idempotency.sql");
    // Object type fixture (B04 calls B06 for the seed lookup).
    await ctx.exec(`
      CREATE TABLE object_type (
        object_type_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ontology_id             UUID NOT NULL,
        api_name                TEXT NOT NULL,
        display_name            TEXT NOT NULL,
        description             TEXT,
        primary_key_property_id UUID,
        status                  TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (ontology_id, api_name)
      );
      INSERT INTO object_type (ontology_id, api_name, display_name)
        VALUES ($$${ONTOLOGY_UUID}$$::uuid, 'order', 'Order');
    `);
  } catch (err) {
    pgAvailable = false;
    // eslint-disable-next-line no-console
    console.warn(
      `[B04] Postgres unavailable; tests will be skipped: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }

  setWorkshopDb({
    query: (sql, params) => ctx!.pool.query(sql, params ?? []),
    withTransaction: async (fn) => {
      const c = await ctx!.pool.connect();
      try {
        await c.query("BEGIN");
        const out = await fn(c);
        await c.query("COMMIT");
        return out;
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    },
  });

  app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string } }).user = { id: "u-b04" };
    next();
  });
  app.use("/api/v1/workshop", workshopModulesRouter);
});

afterAll(async () => {
  resetWorkshopDb();
  if (ctx) await ctx.close();
});

const itp = (...args: Parameters<typeof it>) =>
  pgAvailable ? it(...args) : it.skip(...args);

function uniqueName(prefix: string): string {
  return `${prefix} ${Date.now()} ${Math.floor(Math.random() * 9999)}`;
}

describe("B04 — bootstrap", () => {
  itp("B04 C-01: happy path returns 201 + RID + ETag", async () => {
    const r = await request(app)
      .post("/api/v1/workshop/modules:bootstrap")
      .set("Idempotency-Key", randomUUID())
      .send({
        parentFolderRid: FOLDER,
        ontologyRid: ONTOLOGY,
        displayName: uniqueName("b04-happy"),
      });
    expect(r.status).toBe(201);
    expect(r.body.rid).toMatch(/^ri\.workshop\.main\.module\./);
    expect(r.headers.etag).toMatch(/^W\/"[a-f0-9]+"$/);
  });

  itp(
    "B04 C-02: missing Idempotency-Key → 400 IdempotencyKeyRequired",
    async () => {
      const r = await request(app)
        .post("/api/v1/workshop/modules:bootstrap")
        .send({
          parentFolderRid: FOLDER,
          ontologyRid: ONTOLOGY,
          displayName: uniqueName("b04-no-key"),
        });
      expect(r.status).toBe(400);
      expect(r.body.errorName).toBe("Tellus:Workshop:IdempotencyKeyRequired");
    },
  );

  itp("B04 C-03: idempotency replay returns same RID", async () => {
    const key = randomUUID();
    const dn = uniqueName("b04-replay");
    const body = {
      parentFolderRid: FOLDER,
      ontologyRid: ONTOLOGY,
      displayName: dn,
    };
    const a = await request(app)
      .post("/api/v1/workshop/modules:bootstrap")
      .set("Idempotency-Key", key)
      .send(body);
    expect(a.status).toBe(201);
    const b = await request(app)
      .post("/api/v1/workshop/modules:bootstrap")
      .set("Idempotency-Key", key)
      .send(body);
    expect([200, 201]).toContain(b.status);
    expect(b.body.rid).toBe(a.body.rid);
  });

  itp(
    "B04 C-04: same Idempotency-Key + different body → 409 IdempotencyKeyReused",
    async () => {
      const key = randomUUID();
      const a = await request(app)
        .post("/api/v1/workshop/modules:bootstrap")
        .set("Idempotency-Key", key)
        .send({
          parentFolderRid: FOLDER,
          ontologyRid: ONTOLOGY,
          displayName: uniqueName("b04-conflict-a"),
        });
      expect(a.status).toBe(201);
      const b = await request(app)
        .post("/api/v1/workshop/modules:bootstrap")
        .set("Idempotency-Key", key)
        .send({
          parentFolderRid: FOLDER,
          ontologyRid: ONTOLOGY,
          displayName: uniqueName("b04-conflict-b"),
        });
      expect(b.status).toBe(409);
      expect(b.body.errorName).toBe("Tellus:Workshop:IdempotencyKeyReused");
    },
  );

  itp(
    "B04 C-05: unknown seed object type → 404 ObjectTypeNotFound",
    async () => {
      const r = await request(app)
        .post("/api/v1/workshop/modules:bootstrap")
        .set("Idempotency-Key", randomUUID())
        .send({
          parentFolderRid: FOLDER,
          ontologyRid: ONTOLOGY,
          displayName: uniqueName("b04-unknown-seed"),
          seedObjectTypeApiName: "no-such-type",
        });
      expect(r.status).toBe(404);
      expect(r.body.errorName).toBe("Tellus:Workshop:ObjectTypeNotFound");
    },
  );

  itp(
    "B04 C-07: seeded module includes an Object Set variable when seed supplied",
    async () => {
      const r = await request(app)
        .post("/api/v1/workshop/modules:bootstrap")
        .set("Idempotency-Key", randomUUID())
        .send({
          parentFolderRid: FOLDER,
          ontologyRid: ONTOLOGY,
          displayName: uniqueName("b04-seeded"),
          seedObjectTypeApiName: "order",
        });
      expect(r.status).toBe(201);
      // Read back via GET to confirm definition contains the seeded
      // Object Set variable.
      const fetched = await request(app)
        .get(`/api/v1/workshop/modules/${encodeURIComponent(r.body.rid)}`);
      expect(fetched.status).toBe(200);
      const variables = fetched.body.definition.variables as Array<{
        type?: string;
        definitionType?: string;
        definition?: { objectTypeApiName?: string };
        objectTypeApiName?: string;
      }>;
      expect(variables.length).toBeGreaterThan(0);
      expect(
        variables.some(
          (v) =>
            v.type === "objectSet" &&
            (v.definition?.objectTypeApiName === "order" ||
              v.objectTypeApiName === "order"),
        ),
      ).toBe(true);
    },
  );
});
