// B03 — versioning + publish + resolve.
//
// Integration tests against real Postgres (testcontainers absent — D-05 —
// per-schema harness). Wire-level via supertest where the route surface
// matters (publish, resolve), service-level for invariants that belong
// below the wire (cache TTL, audit).
//
// Contract IDs:
//   B03 C-01 publish creates version row, returns ETag, audits PUBLISHED
//   B03 C-02 republish same (rid, semver) is idempotent
//   B03 C-03 rollback to older semver → 200 + audits ROLLED_BACK
//   B03 C-04 GET version returns the persisted definition + compiled
//   B03 C-05 GET /resolve/latest → published version
//   B03 C-06 GET /resolve/latest is cache-fast (cache hit on second call)
//   B03 C-07 publish invalidates resolve cache
//   B03 C-08 GET /resolve/dev returns the head independent of publish
//   B03 C-09 idempotency replay returns same body
//   B03 C-10 idempotency conflict → 409
//   B03 C-11 invalid semver → 400
//   B03 C-12 not-published → 404 ModuleNotPublished

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
import { cacheStore } from "../../../src/services/workshop/versionService";

const FOLDER = `ri.compass.main.folder.${randomUUID()}`;
const ONTOLOGY = `ri.ontology.main.ontology.${randomUUID()}`;

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
    ctx = await openTestSchema("workshop_b03");
    await ctx.applyMigration("src/migrations/058_b1_workshop_module.sql");
    await ctx.applyMigration(
      "src/migrations/059_b1_workshop_idempotency.sql",
    );
    await ctx.applyMigration(
      "src/migrations/060_b3_workshop_module_version.sql",
    );
    await ctx.applyMigration(
      "src/migrations/180_b3_workshop_version_unique_semver.sql",
    );
    await ctx.applyMigration(
      "src/migrations/181_workshop_module_grants.sql",
    );
  } catch (err) {
    pgAvailable = false;
    // eslint-disable-next-line no-console
    console.warn(
      `[B03] Postgres unavailable; tests will be skipped: ${
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
    audit.push(e);
  });

  app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string } }).user = { id: "u-publish" };
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
  audit = [];
  cacheStore.reset();
  if (ctx) {
    await ctx.pool.query(
      "TRUNCATE TABLE workshop_module, workshop_module_version, workshop_module_grants, workshop_idempotency_record RESTART IDENTITY CASCADE",
    );
  }
});

const itp = (...args: Parameters<typeof it>) =>
  pgAvailable ? it(...args) : it.skip(...args);

async function createOne(displayName = "Pub"): Promise<string> {
  const r = await request(app)
    .post("/api/v1/workshop/modules")
    .send(buildBody(displayName));
  expect(r.status).toBe(201);
  return r.body.rid;
}

describe("B03 — publish + resolve", () => {
  itp(
    "B03 C-01: publish creates version row, returns ETag + body, audits PUBLISHED",
    async () => {
      const rid = await createOne();
      audit = []; // reset; we only care about publish audit.
      const r = await request(app)
        .post(`/api/v1/workshop/modules/${rid}/versions:publish`)
        .send({ semver: "1.0.0" });
      expect(r.status).toBe(200);
      expect(r.headers.etag).toMatch(/^W\/"[0-9a-f]{64}"$/);
      expect(r.body).toMatchObject({
        rid,
        semver: "1.0.0",
        schemaVersion: 4,
        publishedBy: "u-publish",
      });
      expect(audit.map((e) => e.action)).toContain(
        "WORKSHOP_MODULE_PUBLISHED",
      );

      const dbRow = await ctx!.pool.query(
        `SELECT rid, semver, published_by FROM workshop_module_version WHERE rid = $1`,
        [rid],
      );
      expect(dbRow.rows.length).toBe(1);
      expect(dbRow.rows[0].semver).toBe("1.0.0");
    },
  );

  itp(
    "B03 C-02: republish same (rid, semver) is idempotent (both 200)",
    async () => {
      const rid = await createOne();
      const a = await request(app)
        .post(`/api/v1/workshop/modules/${rid}/versions:publish`)
        .send({ semver: "1.0.0" });
      const b = await request(app)
        .post(`/api/v1/workshop/modules/${rid}/versions:publish`)
        .send({ semver: "1.0.0" });
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      // Two version rows is acceptable per the spec's rollback-timeline
      // rule. Or one if dedup; assert >= 1.
      const versions = await ctx!.pool.query(
        `SELECT count(*)::int AS n FROM workshop_module_version WHERE rid = $1`,
        [rid],
      );
      expect(versions.rows[0].n).toBeGreaterThanOrEqual(1);
    },
  );

  itp(
    "B03 C-02a: list versions returns real semvers newest-first and deduplicates republished tags",
    async () => {
      const rid = await createOne();
      await request(app)
        .post(`/api/v1/workshop/modules/${rid}/versions:publish`)
        .send({ semver: "1.0.0" });
      await request(app)
        .post(`/api/v1/workshop/modules/${rid}/versions:publish`)
        .send({ semver: "1.1.0" });
      await request(app)
        .post(`/api/v1/workshop/modules/${rid}/versions:publish`)
        .send({ semver: "1.0.0" });

      const result = await request(app).get(
        `/api/v1/workshop/modules/${rid}/versions`,
      );

      expect(result.status).toBe(200);
      expect(result.body.versions).toHaveLength(2);
      expect(
        result.body.versions.map(
          (version: { semver: string }) => version.semver,
        ),
      ).toEqual(["1.1.0", "1.0.0"]);
      expect(result.body.versions[0]).toMatchObject({
        rid,
        semver: "1.1.0",
        schemaVersion: 4,
        publishedBy: "u-publish",
      });
    },
  );

  itp(
    "B03 C-03: rollback to older semver → 200 + WORKSHOP_MODULE_ROLLED_BACK",
    async () => {
      const rid = await createOne();
      // Publish 1.0.0 then 1.1.0.
      await request(app)
        .post(`/api/v1/workshop/modules/${rid}/versions:publish`)
        .send({ semver: "1.0.0" });
      await request(app)
        .post(`/api/v1/workshop/modules/${rid}/versions:publish`)
        .send({ semver: "1.1.0" });
      audit = [];
      const r = await request(app)
        .post(`/api/v1/workshop/modules/${rid}/actions/rollback`)
        .send({ semver: "1.0.0" });
      expect(r.status).toBe(200);
      expect(audit.map((e) => e.action)).toContain(
        "WORKSHOP_MODULE_ROLLED_BACK",
      );
      // workshop_module.published_semver flips back to 1.0.0.
      const head = await ctx!.pool.query(
        `SELECT published_semver FROM workshop_module WHERE rid = $1`,
        [rid],
      );
      expect(head.rows[0].published_semver).toBe("1.0.0");
    },
  );

  itp(
    "B03 C-03a: rollback restores the original definition (content-level correctness)",
    async () => {
      const rid = await createOne("RollbackContent");
      // Publish 1.0.0 with the default empty definition (A).
      await request(app)
        .post(`/api/v1/workshop/modules/${rid}/versions:publish`)
        .send({ semver: "1.0.0" });

      // Snapshot definition A from the version row.
      const v10 = await request(app).get(
        `/api/v1/workshop/modules/${rid}/versions/1.0.0`,
      );
      expect(v10.status).toBe(200);
      const defA = v10.body.definition;

      // Edit the mutable head to definition B (add a widget).
      const headModule = await request(app).get(
        `/api/v1/workshop/modules/${rid}`,
      );
      const defB = {
        ...defA,
        widgets: [
          {
            id: "w_changed",
            type: "text",
            config: { text: "B" },
          },
        ],
        sections: [
          {
            id: "s_root",
            layout: "rows",
            children: [{ kind: "widget", ref: "w_changed" }],
          },
        ],
      };
      const putR = await request(app)
        .put(`/api/v1/workshop/modules/${rid}`)
        .set("If-Match", headModule.headers.etag)
        .send({ definition: defB });
      expect(putR.status).toBe(200);

      // Publish 1.1.0 (snapshots B).
      await request(app)
        .post(`/api/v1/workshop/modules/${rid}/versions:publish`)
        .send({ semver: "1.1.0" });

      // Rollback to 1.0.0.
      const rb = await request(app)
        .post(`/api/v1/workshop/modules/${rid}/actions/rollback`)
        .send({ semver: "1.0.0" });
      expect(rb.status).toBe(200);

      // Resolve latest => definition deep-equals A.
      const latest = await request(app).get(
        `/api/v1/workshop/resolve/latest?rid=${encodeURIComponent(rid)}`,
      );
      expect(latest.status).toBe(200);
      expect(latest.body.definition).toEqual(defA);

      // Mutable head still equals B.
      const dev = await request(app).get(
        `/api/v1/workshop/resolve/dev?rid=${encodeURIComponent(rid)}`,
      );
      expect(dev.status).toBe(200);
      expect(dev.body.definition).toEqual(defB);

      // Version 1.0.0 snapshot is still retrievable and matches A.
      const v10after = await request(app).get(
        `/api/v1/workshop/modules/${rid}/versions/1.0.0`,
      );
      expect(v10after.status).toBe(200);
      expect(v10after.body.definition).toEqual(defA);

      // Only one row per (rid, semver) — the unique index.
      const count = await ctx!.pool.query(
        `SELECT count(*)::int AS n FROM workshop_module_version
          WHERE rid = $1 AND semver = '1.0.0'`,
        [rid],
      );
      expect(count.rows[0].n).toBe(1);
    },
  );

  itp(
    "B03 C-03b: re-publishing same semver with different content → 409 SemverTagImmutable",
    async () => {
      const rid = await createOne();
      await request(app)
        .post(`/api/v1/workshop/modules/${rid}/versions:publish`)
        .send({ semver: "1.0.0" });

      // Edit the mutable head.
      const headModule = await request(app).get(
        `/api/v1/workshop/modules/${rid}`,
      );
      const defB = {
        ...headModule.body.definition,
        widgets: [{ id: "w_test_b", type: "text", config: { text: "B" } }],
        sections: [
          {
            id: "s_root",
            layout: "rows",
            children: [{ kind: "widget", ref: "w_test_b" }],
          },
        ],
      };
      await request(app)
        .put(`/api/v1/workshop/modules/${rid}`)
        .set("If-Match", headModule.headers.etag)
        .send({ definition: defB });

      // Try to publish 1.0.0 with different content → 409.
      const r = await request(app)
        .post(`/api/v1/workshop/modules/${rid}/versions:publish`)
        .send({ semver: "1.0.0" });
      expect(r.status).toBe(409);
      expect(r.body.errorName).toBe("Tellus:Workshop:SemverTagImmutable");
    },
  );

  itp("B03 C-04: GET version returns persisted definition", async () => {
    const rid = await createOne();
    await request(app)
      .post(`/api/v1/workshop/modules/${rid}/versions:publish`)
      .send({ semver: "1.0.0" });
    const r = await request(app).get(
      `/api/v1/workshop/modules/${rid}/versions/1.0.0`,
    );
    expect(r.status).toBe(200);
    expect(r.body.semver).toBe("1.0.0");
    expect(r.body.definition.schemaVersion).toBe(4);
    expect(r.headers.etag).toMatch(/^W\/"[0-9a-f]{64}"$/);
  });

  itp(
    "B03 C-05: GET /resolve/latest → the published version",
    async () => {
      const rid = await createOne();
      await request(app)
        .post(`/api/v1/workshop/modules/${rid}/versions:publish`)
        .send({ semver: "2.5.0" });
      const r = await request(app).get(
        `/api/v1/workshop/resolve/latest?rid=${encodeURIComponent(rid)}`,
      );
      expect(r.status).toBe(200);
      expect(r.body.semver).toBe("2.5.0");
      expect(r.body.source).toBe("latest");
    },
  );

  itp(
    "B03 C-06/C-07: resolve cache hits on second call; publish invalidates",
    async () => {
      const rid = await createOne();
      await request(app)
        .post(`/api/v1/workshop/modules/${rid}/versions:publish`)
        .send({ semver: "1.0.0" });

      const before = cacheStore.stats();
      await request(app).get(
        `/api/v1/workshop/resolve/latest?rid=${encodeURIComponent(rid)}`,
      );
      const afterMiss = cacheStore.stats();
      expect(afterMiss.misses).toBeGreaterThan(before.misses);

      await request(app).get(
        `/api/v1/workshop/resolve/latest?rid=${encodeURIComponent(rid)}`,
      );
      const afterHit = cacheStore.stats();
      expect(afterHit.hits).toBeGreaterThan(afterMiss.hits);

      // Publishing 1.1.0 invalidates rid in cache; next read goes back to
      // the DB and reflects 1.1.0.
      await request(app)
        .post(`/api/v1/workshop/modules/${rid}/versions:publish`)
        .send({ semver: "1.1.0" });
      const afterPub = cacheStore.stats();
      expect(afterPub.size).toBe(0); // invalidate cleared the entry
      const r = await request(app).get(
        `/api/v1/workshop/resolve/latest?rid=${encodeURIComponent(rid)}`,
      );
      expect(r.body.semver).toBe("1.1.0");
    },
  );

  itp(
    "B03 C-08: GET /resolve/dev returns the head independent of publish",
    async () => {
      const rid = await createOne();
      const r = await request(app).get(
        `/api/v1/workshop/resolve/dev?rid=${encodeURIComponent(rid)}`,
      );
      expect(r.status).toBe(200);
      expect(r.body.source).toBe("dev");
      expect(r.body.semver).toBeNull();
    },
  );

  itp(
    "B03 C-09: idempotency replay (same key + same body) returns the same response",
    async () => {
      const rid = await createOne();
      const key = randomUUID();
      const a = await request(app)
        .post(`/api/v1/workshop/modules/${rid}/versions:publish`)
        .set("Idempotency-Key", key)
        .send({ semver: "1.0.0" });
      const b = await request(app)
        .post(`/api/v1/workshop/modules/${rid}/versions:publish`)
        .set("Idempotency-Key", key)
        .send({ semver: "1.0.0" });
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(b.body.publishedAt).toBe(a.body.publishedAt);
      // Only one version row was actually inserted because the second
      // call short-circuited from the idempotency cache.
      const n = await ctx!.pool.query(
        `SELECT count(*)::int AS n FROM workshop_module_version WHERE rid = $1`,
        [rid],
      );
      expect(n.rows[0].n).toBe(1);
    },
  );

  itp(
    "B03 C-10: idempotency conflict (same key + different body) → 409",
    async () => {
      const rid = await createOne();
      const key = randomUUID();
      const a = await request(app)
        .post(`/api/v1/workshop/modules/${rid}/versions:publish`)
        .set("Idempotency-Key", key)
        .send({ semver: "1.0.0" });
      const b = await request(app)
        .post(`/api/v1/workshop/modules/${rid}/versions:publish`)
        .set("Idempotency-Key", key)
        .send({ semver: "2.0.0" });
      expect(a.status).toBe(200);
      expect(b.status).toBe(409);
      expect(b.body.errorName).toBe("Tellus:Workshop:IdempotencyKeyReused");
    },
  );

  itp("B03 C-11: invalid semver → 400 InvalidSemver", async () => {
    const rid = await createOne();
    const r = await request(app)
      .post(`/api/v1/workshop/modules/${rid}/versions:publish`)
      .send({ semver: "not-a-version" });
    expect(r.status).toBe(400);
    expect(r.body.errorName).toBe("Tellus:Workshop:InvalidSemver");
  });

  itp(
    "B03 C-12: resolve/latest on unpublished module → 404 ModuleNotPublished",
    async () => {
      const rid = await createOne("never published");
      const r = await request(app).get(
        `/api/v1/workshop/resolve/latest?rid=${encodeURIComponent(rid)}`,
      );
      expect(r.status).toBe(404);
      expect(r.body.errorName).toBe("Tellus:Workshop:ModuleNotPublished");
    },
  );
});
