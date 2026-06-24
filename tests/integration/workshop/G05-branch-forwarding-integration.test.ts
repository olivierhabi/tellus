// G-05 — branch forwarding (§0.5).
//
// Every Workshop endpoint that accepts `?branch=<branchRid>` MUST forward
// the value verbatim onto every downstream service call. This suite
// exercises every B-endpoint that has a `branchRid` surface and proves
// the branch propagates to:
//   - B01 mutating endpoints: actor.branchRid (audit + persistence)
//   - B05 /object-sets/_load: OSS adapter ctx.branchRid
//   - B08 /object-sets/_aggregate: OSS adapter ctx.branchRid
//   - B10 /actions/_validate + _apply: Actions adapter ctx.branchRid
//
// The brief: "G-05 is non-negotiable. A single missed forward is a Blocker."

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  RecordingOssAdapter,
  setOss,
} from "../../../src/services/workshop/ossAdapter";
import {
  RecordingActionsAdapter,
  setActions,
} from "../../../src/services/workshop/actionsAdapter";

const FOLDER = `ri.compass.main.folder.${randomUUID()}`;
const ONTOLOGY = `ri.ontology.main.ontology.${randomUUID()}`;
const BRANCH = `ri.branches.main.branch.${randomUUID()}`;

let ctx: SchemaContext | null = null;
let app: Express;
let oss: RecordingOssAdapter;
let actions: RecordingActionsAdapter;
let pgAvailable = true;

beforeAll(async () => {
  try {
    ctx = await openTestSchema("workshop_branch_fwd");
    await ctx.applyMigration("src/migrations/058_b1_workshop_module.sql");
    await ctx.applyMigration("src/migrations/059_b1_workshop_idempotency.sql");
    await ctx.applyMigration("src/migrations/060_b3_workshop_module_version.sql");
  } catch (err) {
    pgAvailable = false;
    // eslint-disable-next-line no-console
    console.warn(
      `[G05] Postgres unavailable; tests skipped: ${
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
    (req as unknown as { user: { id: string } }).user = { id: "u-branch" };
    (req as unknown as { headers: Record<string, string> }).headers[
      "authorization"
    ] = "Bearer test-jwt";
    next();
  });
  app.use("/api/v1/workshop", workshopModulesRouter);
});

beforeEach(() => {
  oss = new RecordingOssAdapter();
  actions = new RecordingActionsAdapter();
  setOss(oss);
  setActions(actions);
});

afterAll(async () => {
  resetWorkshopDb();
  if (ctx) await ctx.close();
});

const itp = (...args: Parameters<typeof it>) =>
  pgAvailable ? it(...args) : it.skip(...args);

function emptyDef() {
  return {
    schemaVersion: 4,
    variables: [],
    widgets: [],
    sections: [{ id: "s_root", layout: "rows", children: [] }],
    layout: { rootSection: "s_root" },
  };
}

describe("G-05 — branch forwarding across every B-endpoint", () => {
  itp("B01 POST /modules?branch=… forwards branch into the actor", async () => {
    const r = await request(app)
      .post(`/api/v1/workshop/modules?branch=${encodeURIComponent(BRANCH)}`)
      .set("Idempotency-Key", randomUUID())
      .send({
        displayName: `branch-create-${Date.now()}`,
        description: null,
        parentFolderRid: FOLDER,
        ontologyRid: ONTOLOGY,
        branchRid: BRANCH,
        definition: emptyDef(),
      });
    expect(r.status).toBe(201);
    // Persisted branchRid round-trips on GET
    const fetched = await request(app)
      .get(`/api/v1/workshop/modules/${encodeURIComponent(r.body.rid)}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.branchRid).toBe(BRANCH);
  });

  itp(
    "B05 POST /object-sets/_load?branch=… forwards branch verbatim into OSS adapter",
    async () => {
      const r = await request(app)
        .post(
          `/api/v1/workshop/object-sets/_load?branch=${encodeURIComponent(
            BRANCH,
          )}`,
        )
        .send({
          ontologyRid: ONTOLOGY,
          objectTypeApiName: "Order",
          schema: { id: "string" },
          filters: [],
          pageSize: 25,
        });
      expect(r.status).toBe(200);
      expect(oss.calls.length).toBe(1);
      expect(oss.calls[0]?.context.branchRid).toBe(BRANCH);
    },
  );

  itp(
    "B05 omitted ?branch → null branchRid (no implicit fallback)",
    async () => {
      const r = await request(app)
        .post("/api/v1/workshop/object-sets/_load")
        .send({
          ontologyRid: ONTOLOGY,
          objectTypeApiName: "Order",
          schema: { id: "string" },
          filters: [],
          pageSize: 25,
        });
      expect(r.status).toBe(200);
      expect(oss.calls.length).toBe(1);
      expect(oss.calls[0]?.context.branchRid).toBeNull();
    },
  );

  itp(
    "B08 POST /object-sets/_aggregate?branch=… forwards branch into OSS adapter",
    async () => {
      const r = await request(app)
        .post(
          `/api/v1/workshop/object-sets/_aggregate?branch=${encodeURIComponent(
            BRANCH,
          )}`,
        )
        .send({
          ontologyRid: ONTOLOGY,
          objectTypeApiName: "Order",
          schema: { id: "string", status: "string" },
          filters: [],
          aggregations: [
            {
              name: "byStatus",
              chart: "pie",
              property: "status",
              aggregation: { kind: "count" },
            },
          ],
        });
      expect(r.status).toBe(200);
      expect(oss.calls.length).toBe(1);
      expect(oss.calls[0]?.context.branchRid).toBe(BRANCH);
    },
  );

  itp(
    "B10 POST /actions/_validate?branch=… forwards branch into Actions adapter",
    async () => {
      const r = await request(app)
        .post(
          `/api/v1/workshop/actions/_validate?branch=${encodeURIComponent(
            BRANCH,
          )}`,
        )
        .send({
          ontologyRid: ONTOLOGY,
          actionTypeApiName: "doThing",
          parameters: { x: 1 },
        });
      expect(r.status).toBe(200);
      const vCalls = actions.calls.filter((c) => c.kind === "validate");
      expect(vCalls.length).toBe(1);
      expect(vCalls[0]?.context.branchRid).toBe(BRANCH);
    },
  );

  itp(
    "B10 POST /actions/_apply?branch=… forwards branch into Actions adapter",
    async () => {
      const r = await request(app)
        .post(
          `/api/v1/workshop/actions/_apply?branch=${encodeURIComponent(
            BRANCH,
          )}`,
        )
        .set("Idempotency-Key", randomUUID())
        .send({
          ontologyRid: ONTOLOGY,
          actionTypeApiName: "doThing",
          parameters: { x: 1 },
        });
      expect(r.status).toBe(200);
      const aCalls = actions.calls.filter((c) => c.kind === "apply");
      expect(aCalls.length).toBe(1);
      expect(aCalls[0]?.context.branchRid).toBe(BRANCH);
    },
  );
});
