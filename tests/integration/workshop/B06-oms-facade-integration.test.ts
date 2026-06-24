// B06 — OMS metadata facade with TTL cache.
//
// Spec §B06. Wire-level integration via supertest. Per D-02 the workshop
// facade reads from the same `object_type` and `action_type` tables used
// by the existing routes/services. The test seeds minimal fixture rows
// directly so we don't depend on JS-driven schema bootstrapping in the
// per-schema harness.
//
// Contract IDs:
//   B06 C-01 listObjectTypes returns rows for the given ontology
//   B06 C-02 getObjectType (by id and by api_name) returns shape
//   B06 C-03 unknown object type → 404 ObjectTypeNotFound
//   B06 C-04 listActionTypes returns rows
//   B06 C-05 unknown action type → 404 ActionTypeNotFound
//   B06 C-06 cache hits on second list call (no DB roundtrip)
//   B06 C-07 invalidateOntology drops all entries for that ontology

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
  invalidateOntology,
  omsCache,
} from "../../../src/services/workshop/omsFacade";

const ONTOLOGY_UUID = randomUUID();
const OTHER_ONTOLOGY_UUID = randomUUID();
const ONTOLOGY = `ri.ontology.main.ontology.${ONTOLOGY_UUID}`;
const OTHER_ONTOLOGY = `ri.ontology.main.ontology.${OTHER_ONTOLOGY_UUID}`;

let ctx: SchemaContext | null = null;
let app: Express;
let pgAvailable = true;

beforeAll(async () => {
  try {
    ctx = await openTestSchema("workshop_b06");
    // Minimal fixture DDL covering the columns omsFacade reads. Real DDL
    // lives in the monolith bootstrap; we mirror only what we need.
    // Mirror the production object_type / action_type schema (UUID
    // ontology_id, primary_key_property_id UUID, no `properties`
    // column on object_type — properties live in a separate table that
    // the workshop facade does not currently consume).
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
      CREATE TABLE action_type (
        action_type_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ontology_id    UUID NOT NULL,
        api_name       TEXT NOT NULL,
        display_name   TEXT NOT NULL,
        description    TEXT,
        parameters     JSONB,
        rules          JSONB,
        submission_criteria JSONB,
        is_enabled     BOOLEAN NOT NULL DEFAULT true,
        max_affected_objects INT NOT NULL DEFAULT 1000,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (ontology_id, api_name)
      );
    `);
  } catch (err) {
    pgAvailable = false;
    // eslint-disable-next-line no-console
    console.warn(
      `[B06] Postgres unavailable; tests will be skipped: ${
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
    (req as unknown as { user: { id: string } }).user = { id: "u-oms" };
    next();
  });
  app.use("/api/v1/workshop", workshopModulesRouter);
});

afterAll(async () => {
  resetWorkshopDb();
  if (ctx) await ctx.close();
});

beforeEach(async () => {
  omsCache.reset();
  if (ctx) {
    await ctx.pool.query("TRUNCATE TABLE object_type RESTART IDENTITY");
    await ctx.pool.query("TRUNCATE TABLE action_type RESTART IDENTITY");
    await ctx.pool.query(
      `INSERT INTO object_type (ontology_id, api_name, display_name, description)
       VALUES
         ($1::uuid, 'order', 'Order', 'an order'),
         ($1::uuid, 'customer', 'Customer', 'a customer'),
         ($2::uuid, 'noise', 'Noise', '')`,
      [ONTOLOGY_UUID, OTHER_ONTOLOGY_UUID],
    );
    await ctx.pool.query(
      `INSERT INTO action_type (ontology_id, api_name, display_name, description, parameters, rules)
       VALUES
         ($1::uuid, 'assignOrder', 'Assign Order', '',
          $2::jsonb, '[]'::jsonb)`,
      [
        ONTOLOGY_UUID,
        JSON.stringify([
          { apiName: "assignee", type: "user" },
          { apiName: "status", type: "string" },
        ]),
      ],
    );
  }
});

const itp = (...args: Parameters<typeof it>) =>
  pgAvailable ? it(...args) : it.skip(...args);

describe("B06 — OMS facade", () => {
  itp("B06 C-01: list object types for an ontology returns 2 rows", async () => {
    const r = await request(app)
      .get(
        `/api/v1/workshop/object-types?ontologyRid=${encodeURIComponent(
          ONTOLOGY,
        )}`,
      );
    expect(r.status).toBe(200);
    expect(r.body.objectTypes).toHaveLength(2);
    expect(r.body.objectTypes.map((o: { apiName: string }) => o.apiName).sort()).toEqual([
      "customer",
      "order",
    ]);
  });

  itp(
    "B06 C-02: get object type by api_name returns shape",
    async () => {
      const r = await request(app).get(
        `/api/v1/workshop/object-types/order?ontologyRid=${encodeURIComponent(
          ONTOLOGY,
        )}`,
      );
      expect(r.status).toBe(200);
      expect(r.body.apiName).toBe("order");
      expect(r.body.displayName).toBe("Order");
      expect(r.body.description).toBe("an order");
      expect(r.body.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      // Production schema does not store properties on object_type
      // (they live in object_property); the workshop facade currently
      // returns an empty list for properties — verified explicitly.
      expect(r.body.properties).toEqual([]);
    },
  );

  itp(
    "B06 C-03: unknown object type → 404 ObjectTypeNotFound envelope",
    async () => {
      const r = await request(app).get(
        `/api/v1/workshop/object-types/nope?ontologyRid=${encodeURIComponent(
          ONTOLOGY,
        )}`,
      );
      expect(r.status).toBe(404);
      expect(r.body.errorName).toBe("Tellus:Workshop:ObjectTypeNotFound");
      expect(r.body.parameters.ontologyRid).toBe(ONTOLOGY);
      expect(r.body.parameters.objectTypeId).toBe("nope");
    },
  );

  itp("B06 C-04: list action types returns the seeded one", async () => {
    const r = await request(app).get(
      `/api/v1/workshop/action-types?ontologyRid=${encodeURIComponent(
        ONTOLOGY,
      )}`,
    );
    expect(r.status).toBe(200);
    expect(r.body.actionTypes).toHaveLength(1);
    expect(r.body.actionTypes[0].apiName).toBe("assignOrder");
    expect(r.body.actionTypes[0].parameters).toHaveLength(2);
  });

  itp("B06 C-05: unknown action type → 404 ActionTypeNotFound", async () => {
    const r = await request(app).get(
      `/api/v1/workshop/action-types/nope?ontologyRid=${encodeURIComponent(
        ONTOLOGY,
      )}`,
    );
    expect(r.status).toBe(404);
    expect(r.body.errorName).toBe("Tellus:Workshop:ActionTypeNotFound");
  });

  itp(
    "B06 C-06: cache: second list call hits cache (hit count rises, miss flat)",
    async () => {
      const before = omsCache.stats();
      await request(app).get(
        `/api/v1/workshop/object-types?ontologyRid=${encodeURIComponent(
          ONTOLOGY,
        )}`,
      );
      const afterFirst = omsCache.stats();
      expect(afterFirst.misses).toBe(before.misses + 1);
      expect(afterFirst.hits).toBe(before.hits);

      await request(app).get(
        `/api/v1/workshop/object-types?ontologyRid=${encodeURIComponent(
          ONTOLOGY,
        )}`,
      );
      const afterSecond = omsCache.stats();
      expect(afterSecond.hits).toBe(afterFirst.hits + 1);
      expect(afterSecond.misses).toBe(afterFirst.misses);
    },
  );

  itp(
    "B06 C-07: invalidateOntology drops cache entries for that ontology only",
    async () => {
      // Warm caches for both ontologies.
      await request(app).get(
        `/api/v1/workshop/object-types?ontologyRid=${encodeURIComponent(
          ONTOLOGY,
        )}`,
      );
      await request(app).get(
        `/api/v1/workshop/object-types?ontologyRid=${encodeURIComponent(
          OTHER_ONTOLOGY,
        )}`,
      );
      const beforeStats = omsCache.stats();
      expect(beforeStats.size).toBeGreaterThanOrEqual(2);

      invalidateOntology(ONTOLOGY);

      const after = omsCache.stats();
      expect(after.size).toBeLessThan(beforeStats.size);

      // OTHER_ONTOLOGY entry survives — next read still hits cache.
      const beforeOther = omsCache.stats();
      await request(app).get(
        `/api/v1/workshop/object-types?ontologyRid=${encodeURIComponent(
          OTHER_ONTOLOGY,
        )}`,
      );
      const afterOther = omsCache.stats();
      expect(afterOther.hits).toBe(beforeOther.hits + 1);
    },
  );
});
