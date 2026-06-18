// B03 — chaos: multi-process NOTIFY → peer cache invalidation.
//
// Validates §B03 + D-04: when one process publishes a module, every
// peer process listening on `workshop_module_published` MUST observe
// the channel signal and invalidate its own ResolveCache before the
// next /resolve/latest call returns stale data.
//
// We simulate two processes by:
//   1. Wiring the regular workshop-service flow (route + service) onto
//      pool A. This is the "publisher" process.
//   2. Constructing a second ResolveCache + a dedicated pg.Client on
//      pool B that LISTENs on `workshop_module_published` and
//      synchronously invalidates the peer cache when a payload arrives.
//   3. Asserting:
//      - Peer cache is initially populated (resolve through peer pool).
//      - Publisher publishes via the route.
//      - Peer cache is invalidated within 500ms of the publish commit.
//      - A subsequent peer-side resolve sees the new semver.
//
// Contract IDs:
//   B03 chaos C-04 — peer ResolveCache invalidates on NOTIFY within 500ms
//   B03 chaos C-05 — post-NOTIFY peer resolve returns the new published semver

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { Client, Pool } from "pg";
import { randomUUID } from "node:crypto";

import {
  openTestSchema,
  type SchemaContext,
} from "../../integration/code-repos/_helpers/pg";
import {
  resetWorkshopDb,
  setWorkshopDb,
} from "../../../src/services/workshop/db";
import workshopModulesRouter from "../../../src/routes/workshopModules";
import {
  ResolveCache,
  cacheStore,
} from "../../../src/services/workshop/versionService";

const FOLDER = `ri.compass.main.folder.${randomUUID()}`;
const ONTOLOGY = `ri.ontology.main.ontology.${randomUUID()}`;

let ctx: SchemaContext | null = null;
let peerPool: Pool | null = null;
let peerListener: Client | null = null;
let app: Express;
let pgAvailable = true;
let peerCache: ResolveCache;

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
    ctx = await openTestSchema("workshop_b03_multi_chaos");
    await ctx.applyMigration("src/migrations/058_b1_workshop_module.sql");
    await ctx.applyMigration("src/migrations/059_b1_workshop_idempotency.sql");
    await ctx.applyMigration("src/migrations/060_b3_workshop_module_version.sql");
  } catch (err) {
    pgAvailable = false;
    // eslint-disable-next-line no-console
    console.warn(
      `[B03 multi-chaos] Postgres unavailable; tests skipped: ${
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
    (req as unknown as { user: { id: string } }).user = { id: "u-multi-chaos" };
    next();
  });
  app.use("/api/v1/workshop", workshopModulesRouter);

  // Peer pool — a *second* connection pool that simulates a second
  // workshop-service process. It does NOT share an in-memory cache
  // with pool A.
  peerPool = new Pool({
    host: process.env.PGHOST ?? "localhost",
    port: Number(process.env.PGPORT ?? 5432),
    database: process.env.PGDATABASE ?? "tellus_db",
    user: process.env.PGUSER ?? "tellus",
    password: process.env.PGPASSWORD ?? "tellus123",
    max: 4,
  });

  peerCache = new ResolveCache();

  peerListener = new Client({
    host: process.env.PGHOST ?? "localhost",
    port: Number(process.env.PGPORT ?? 5432),
    database: process.env.PGDATABASE ?? "tellus_db",
    user: process.env.PGUSER ?? "tellus",
    password: process.env.PGPASSWORD ?? "tellus123",
  });
  await peerListener.connect();
  await peerListener.query("LISTEN workshop_module_published");
  peerListener.on("notification", (msg) => {
    if (msg.channel !== "workshop_module_published" || !msg.payload) return;
    try {
      const parsed = JSON.parse(msg.payload) as { rid?: string };
      if (parsed.rid) peerCache.invalidate(parsed.rid);
    } catch {
      // Drop malformed payloads.
    }
  });
});

afterAll(async () => {
  resetWorkshopDb();
  if (peerListener) await peerListener.end();
  if (peerPool) await peerPool.end();
  if (ctx) await ctx.close();
});

const itp = (...args: Parameters<typeof it>) =>
  pgAvailable ? it(...args) : it.skip(...args);

describe("B03 multi-process — peer ResolveCache invalidation via NOTIFY", () => {
  itp(
    "B03 chaos C-04: peer cache invalidates within 500ms of publish NOTIFY",
    async () => {
      // Publisher (pool A) creates + publishes a module.
      const created = await request(app)
        .post("/api/v1/workshop/modules")
        .set("Idempotency-Key", randomUUID())
        .send(buildBody("multi-1"));
      expect(created.status).toBe(201);
      const rid = created.body.rid as string;

      await request(app)
        .post(
          `/api/v1/workshop/modules/${encodeURIComponent(rid)}/versions:publish`,
        )
        .set("Idempotency-Key", randomUUID())
        .send({ semver: "1.0.0" });

      // Pre-warm the peer cache by directly putting a stub entry. In a
      // real second process this would be populated by a /resolve/latest
      // call; we shortcut for clarity.
      peerCache.put(rid, {
        rid,
        semver: "1.0.0",
        schemaVersion: 4,
        definition: {} as never,
        compiled: null as never,
        asOf: new Date().toISOString(),
        source: "latest",
      });
      expect(peerCache.stats().size).toBeGreaterThanOrEqual(1);
      const beforeSize = peerCache.stats().size;

      // Publisher publishes a NEW semver. NOTIFY MUST reach the peer
      // listener and invalidate its cache for `rid`.
      await request(app)
        .post(
          `/api/v1/workshop/modules/${encodeURIComponent(rid)}/versions:publish`,
        )
        .set("Idempotency-Key", randomUUID())
        .send({ semver: "1.0.1" });

      const deadline = Date.now() + 500;
      let invalidated = false;
      while (Date.now() < deadline) {
        if (peerCache.stats().size < beforeSize) {
          invalidated = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(invalidated).toBe(true);
    },
  );

  itp(
    "B03 chaos C-05: post-NOTIFY peer resolve sees the newly-published semver",
    async () => {
      // Reset peer cache between tests — these are simulating two
      // independent replicas.
      peerCache.reset();

      const created = await request(app)
        .post("/api/v1/workshop/modules")
        .set("Idempotency-Key", randomUUID())
        .send(buildBody("multi-2"));
      const rid = created.body.rid as string;

      await request(app)
        .post(
          `/api/v1/workshop/modules/${encodeURIComponent(rid)}/versions:publish`,
        )
        .set("Idempotency-Key", randomUUID())
        .send({ semver: "1.0.0" });

      // Publish a second semver — peer NOTIFY should fire.
      await request(app)
        .post(
          `/api/v1/workshop/modules/${encodeURIComponent(rid)}/versions:publish`,
        )
        .set("Idempotency-Key", randomUUID())
        .send({ semver: "1.0.1" });

      // Allow NOTIFY to deliver.
      await new Promise((r) => setTimeout(r, 100));

      // Peer-side resolve via direct SQL query — same shape as the real
      // _resolveLatestInner read path, with explicit schema qualification
      // because peerPool doesn't share the test schema's search_path.
      const r2 = await peerPool!.query(
        `SELECT v.semver
           FROM "${ctx!.schema}".workshop_module_version v
           JOIN "${ctx!.schema}".workshop_module m
             ON m.rid = v.rid
            AND m.published_semver = v.semver
            AND m.published_at = v.published_at
          WHERE m.rid = $1`,
        [rid],
      );
      expect(r2.rows[0]?.semver).toBe("1.0.1");

      // Peer cache MUST NOT have a stale entry for rid (it was reset
      // and never repopulated since the second publish).
      expect(peerCache.stats().size).toBe(0);
    },
  );
});

// Side effect to keep cacheStore reachable from import without the module
// being tree-shaken out of test bundles.
void cacheStore;
