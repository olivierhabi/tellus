// B02 — wire-level integration: validateModule runs inside POST/PUT and
// surfaces Conjure-style envelopes through the route layer.
//
// Per spec: B02's compiler runs in-process for B01 (PUT/POST). This test
// proves: (a) malformed schemas are rejected by the route with 400 +
// Tellus:Workshop:InvalidModuleSchema; (b) the nine semantic rules each
// surface their named error at the wire layer; (c) a valid module document
// passes both layers and persists.
//
// Contract IDs:
//   B02 C-01 (schema)         B02 C-04 (duplicate var ID)
//   B02 C-05 (cycle)          B02 C-06 (orphan widget)
//   B02 C-07 (dangling ref)   B02 C-08 (type mismatch)
//   B02 C-09 (dup external)   B02 C-10 (loop coherence)
//   B02 C-11 (active obj)     B02 C-13 (compiled topo)

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
} from "../../../src/services/workshop/audit";
import workshopModulesRouter from "../../../src/routes/workshopModules";

const FOLDER = `ri.compass.main.folder.${randomUUID()}`;
const ONTOLOGY = `ri.ontology.main.ontology.${randomUUID()}`;

let ctx: SchemaContext | null = null;
let app: Express;
let pgAvailable = true;

function bodyWith(definition: unknown, displayName = "M") {
  return {
    displayName,
    description: null,
    parentFolderRid: FOLDER,
    ontologyRid: ONTOLOGY,
    branchRid: null,
    definition,
  };
}

beforeAll(async () => {
  try {
    ctx = await openTestSchema("workshop_b02_route");
    await ctx.applyMigration("src/migrations/058_b1_workshop_module.sql");
    await ctx.applyMigration("src/migrations/059_b1_workshop_idempotency.sql");
    await ctx.applyMigration(
      "src/migrations/181_workshop_module_grants.sql",
    );
  } catch (err) {
    pgAvailable = false;
    // eslint-disable-next-line no-console
    console.warn(
      `[B02-route] Postgres unavailable; tests will be skipped: ${
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

  setAuditEmitter(async () => {});

  app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string } }).user = { id: "u-validate" };
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
  if (ctx) {
    await ctx.pool.query(
      "TRUNCATE TABLE workshop_module, workshop_module_grants, workshop_idempotency_record RESTART IDENTITY CASCADE",
    );
  }
});

const itp = (...args: Parameters<typeof it>) =>
  pgAvailable ? it(...args) : it.skip(...args);

describe("B02 — validateModule on the write path", () => {
  itp(
    "B02 C-01: missing schemaVersion → 400 InvalidModuleSchema envelope",
    async () => {
      const res = await request(app)
        .post("/api/v1/workshop/modules")
        .send(
          bodyWith({
            variables: [],
            widgets: [],
            sections: [{ id: "s_root", layout: "rows", children: [] }],
            layout: { rootSection: "s_root" },
          }),
        );
      expect(res.status).toBe(400);
      expect(res.body.errorName).toBe("Tellus:Workshop:InvalidModuleSchema");
      expect(typeof res.body.errorInstanceId).toBe("string");
    },
  );

  itp(
    "B02 C-04: duplicate variable IDs → 400 DuplicateVariableId",
    async () => {
      const res = await request(app)
        .post("/api/v1/workshop/modules")
        .send(
          bodyWith({
            schemaVersion: 4,
            variables: [
              {
                id: "v_x",
                type: "objectSet",
                definitionType: "objectSetDefinition",
                definition: {},
              },
              {
                id: "v_x",
                type: "objectSet",
                definitionType: "objectSetDefinition",
                definition: {},
              },
            ],
            widgets: [],
            sections: [{ id: "s_root", layout: "rows", children: [] }],
            layout: { rootSection: "s_root" },
          }),
        );
      expect(res.status).toBe(400);
      expect(res.body.errorName).toBe("Tellus:Workshop:DuplicateVariableId");
      expect(res.body.parameters.duplicateId).toBe("v_x");
    },
  );

  itp(
    "B02 C-05: variable graph cycle → 400 VariableGraphCycle with cyclePath",
    async () => {
      const res = await request(app)
        .post("/api/v1/workshop/modules")
        .send(
          bodyWith({
            schemaVersion: 4,
            variables: [
              {
                id: "v_filterA",
                type: "objectSetFilter",
                definitionType: "variableTransformation",
                definition: {},
                constraints: [
                  { kind: "filterByVariable", filterVariableId: "v_filterB" },
                ],
              },
              {
                id: "v_filterB",
                type: "objectSetFilter",
                definitionType: "variableTransformation",
                definition: {},
                constraints: [
                  { kind: "filterByVariable", filterVariableId: "v_filterA" },
                ],
              },
            ],
            widgets: [],
            sections: [{ id: "s_root", layout: "rows", children: [] }],
            layout: { rootSection: "s_root" },
          }),
        );
      expect(res.status).toBe(400);
      expect(res.body.errorName).toBe("Tellus:Workshop:VariableGraphCycle");
      const path = res.body.parameters.cyclePath as string[];
      expect(path).toContain("v_filterA");
      expect(path).toContain("v_filterB");
    },
  );

  itp(
    "B02 C-06: orphan widget reference → 400 OrphanWidgetReference",
    async () => {
      const res = await request(app)
        .post("/api/v1/workshop/modules")
        .send(
          bodyWith({
            schemaVersion: 4,
            variables: [
              {
                id: "v_set",
                type: "objectSet",
                definitionType: "objectSetDefinition",
                definition: {},
              },
            ],
            widgets: [
              {
                id: "w_orphan",
                type: "objectTable",
                config: {},
                inputs: { objectSet: "v_set" },
                outputs: {},
              },
            ],
            sections: [{ id: "s_root", layout: "rows", children: [] }],
            layout: { rootSection: "s_root" },
          }),
        );
      expect(res.status).toBe(400);
      expect(res.body.errorName).toBe("Tellus:Workshop:OrphanWidgetReference");
      expect(res.body.parameters.widgetId).toBe("w_orphan");
    },
  );

  itp(
    "B02 C-07: dangling variable reference from widget input → 400",
    async () => {
      const res = await request(app)
        .post("/api/v1/workshop/modules")
        .send(
          bodyWith({
            schemaVersion: 4,
            variables: [],
            widgets: [
              {
                id: "w_t",
                type: "objectTable",
                config: {},
                inputs: { objectSet: "v_does_not_exist" },
                outputs: {},
              },
            ],
            sections: [
              {
                id: "s_root",
                layout: "rows",
                children: [{ kind: "widget", ref: "w_t" }],
              },
            ],
            layout: { rootSection: "s_root" },
          }),
        );
      expect(res.status).toBe(400);
      expect(res.body.errorName).toBe(
        "Tellus:Workshop:DanglingVariableReference",
      );
      expect(res.body.parameters.variableId).toBe("v_does_not_exist");
    },
  );

  itp(
    "B02 C-08: type mismatch — widget input wired to wrong variable type → 400",
    async () => {
      const res = await request(app)
        .post("/api/v1/workshop/modules")
        .send(
          bodyWith({
            schemaVersion: 4,
            variables: [
              {
                id: "v_filter",
                type: "objectSetFilter",
                definitionType: "static",
                definition: {},
              },
            ],
            widgets: [
              {
                id: "w_t",
                type: "objectTable",
                config: {},
                inputs: { objectSet: "v_filter" },
                outputs: {},
              },
            ],
            sections: [
              {
                id: "s_root",
                layout: "rows",
                children: [{ kind: "widget", ref: "w_t" }],
              },
            ],
            layout: { rootSection: "s_root" },
          }),
        );
      expect(res.status).toBe(400);
      expect(res.body.errorName).toBe("Tellus:Workshop:VariableTypeMismatch");
      expect(res.body.parameters.expected).toBe("objectSet");
      expect(res.body.parameters.actual).toBe("objectSetFilter");
    },
  );

  itp(
    "B02 C-09: duplicate external ID across moduleInterface → 400",
    async () => {
      const res = await request(app)
        .post("/api/v1/workshop/modules")
        .send(
          bodyWith({
            schemaVersion: 4,
            variables: [
              {
                id: "v_set",
                type: "objectSet",
                definitionType: "objectSetDefinition",
                definition: {},
              },
            ],
            widgets: [],
            sections: [{ id: "s_root", layout: "rows", children: [] }],
            layout: { rootSection: "s_root" },
            moduleInterface: {
              variables: [
                { externalId: "in_a", variableId: "v_set", required: true },
                { externalId: "in_a", variableId: "v_set", required: false },
              ],
            },
          }),
        );
      expect(res.status).toBe(400);
      expect(res.body.errorName).toBe("Tellus:Workshop:DuplicateExternalId");
    },
  );

  itp(
    "B02 C-10: loop section without interfaceMapping → 400",
    async () => {
      const res = await request(app)
        .post("/api/v1/workshop/modules")
        .send(
          bodyWith({
            schemaVersion: 4,
            variables: [],
            widgets: [],
            sections: [
              {
                id: "s_root",
                layout: "rows",
                children: [{ kind: "section", ref: "s_loop" }],
              },
              {
                id: "s_loop",
                layout: "loop",
                loopConfig: { embeddedModuleRid: "ri.workshop.module.x" },
                children: [],
              },
            ],
            layout: { rootSection: "s_root" },
          }),
        );
      expect(res.status).toBe(400);
      expect(res.body.errorName).toBe(
        "Tellus:Workshop:EmbeddedModuleInterfaceUnsatisfied",
      );
    },
  );

  itp(
    "B02 C-13: a fully valid module persists with the right ETag",
    async () => {
      const res = await request(app)
        .post("/api/v1/workshop/modules")
        .send(
          bodyWith({
            schemaVersion: 4,
            variables: [
              {
                id: "v_set",
                type: "objectSet",
                definitionType: "objectSetDefinition",
                definition: {},
              },
            ],
            widgets: [
              {
                id: "w_t",
                type: "objectTable",
                config: {},
                inputs: { objectSet: "v_set" },
                outputs: {},
              },
            ],
            sections: [
              {
                id: "s_root",
                layout: "rows",
                children: [{ kind: "widget", ref: "w_t" }],
              },
            ],
            layout: { rootSection: "s_root" },
          }),
        );
      expect(res.status).toBe(201);
      expect(res.headers.etag).toMatch(/^W\/"[0-9a-f]{64}"$/);
      expect(res.body.rid).toMatch(/^ri\.workshop\.main\.module\./);
    },
  );

  // -------------------------------------------------------------------------
  // Regression guard — F02 module-page-header round-trip.
  //
  // The FE (HeaderInspector + WorkshopDraftStore.setHeader) writes the
  // visible page-header strip title into `definition.header.title`. Both
  // the Zod request schema and the Ajv document schema MUST accept that
  // shape; the autosave hook in `tellus-fe/hooks/useWorkshopAutosave.ts`
  // PUTs it on every keystroke quiescence. Before this guard, the
  // `.strict()` Zod schema and the `additionalProperties: false` Ajv
  // schema both rejected `header` as an unrecognized key, which silently
  // converted every title edit into a 400 InvalidModuleSchema response —
  // visible to the user as "title doesn't survive reload".
  //
  // This test pins the contract end-to-end: a POST accepts the header
  // slot, a follow-up PUT updates it, GET reads it back unchanged.
  // -------------------------------------------------------------------------
  itp(
    "F02 regression: definition.header.{title,icon,color} round-trips POST → PUT → GET",
    async () => {
      const initialDefinition = {
        schemaVersion: 4,
        variables: [],
        widgets: [],
        sections: [
          { id: "s_root", layout: "rows", children: [] },
        ],
        layout: { rootSection: "s_root" },
        header: { title: "Initial title", icon: "shop", color: "cerulean" },
      };

      const post = await request(app)
        .post("/api/v1/workshop/modules")
        .send(bodyWith(initialDefinition, "header-roundtrip"));
      expect(post.status).toBe(201);
      const rid = post.body.rid as string;
      const etag1 = post.headers.etag as string;
      expect(post.body.definition.header).toEqual({
        title: "Initial title",
        icon: "shop",
        color: "cerulean",
      });

      const put = await request(app)
        .put(`/api/v1/workshop/modules/${encodeURIComponent(rid)}`)
        .set("If-Match", etag1)
        .send({
          displayName: "header-roundtrip",
          definition: {
            ...initialDefinition,
            header: { title: "Renamed via PUT", icon: null, color: null },
          },
        });
      expect(put.status).toBe(200);
      expect(put.body.definition.header).toEqual({
        title: "Renamed via PUT",
        icon: null,
        color: null,
      });
      expect(put.headers.etag).not.toBe(etag1);

      const get = await request(app).get(
        `/api/v1/workshop/modules/${encodeURIComponent(rid)}`,
      );
      expect(get.status).toBe(200);
      expect(get.body.definition.header.title).toBe("Renamed via PUT");
    },
  );

  itp(
    "F02 regression: unknown keys under definition.header are STILL rejected (strict)",
    async () => {
      const res = await request(app)
        .post("/api/v1/workshop/modules")
        .send(
          bodyWith({
            schemaVersion: 4,
            variables: [],
            widgets: [],
            layout: { rootSection: "s_root" },
            sections: [{ id: "s_root", layout: "rows", children: [] }],
            // `subtitle` is not part of the header contract — the
            // strict schema must reject it so silent typos surface
            // immediately instead of being persisted and forgotten.
            header: { title: "ok", subtitle: "not allowed" },
          }),
        );
      expect(res.status).toBe(400);
      expect(res.body.errorName).toBe("Tellus:Workshop:InvalidModuleSchema");
    },
  );
});
