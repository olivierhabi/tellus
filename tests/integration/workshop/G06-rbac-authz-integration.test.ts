// G-06 — RBAC authz integration (DoD: every endpoint must enforce 403 on
// insufficient role).
//
// Spec §0.6: 403 on insufficient role; downstream services receive the same
// JWT (no service-account fan-out).
//
// Test strategy: mount the workshop router with a stub user that exposes a
// `roles` array. The `requireRole` middleware in
// `src/services/workshop/rbac.ts` soft-enforces: when `roles` is undefined
// (the existing test convention) it lets the request through; when `roles`
// is an array, it strictly checks. Both paths are exercised below.
//
// Contract IDs:
//   G-06 C-01 POST /modules without editor role → 403 Forbidden
//   G-06 C-02 PUT /modules/{rid} without editor role → 403 Forbidden
//   G-06 C-03 DELETE /modules/{rid} without editor role → 403 Forbidden
//   G-06 C-04 POST :publish without editor role → 403 Forbidden
//   G-06 C-05 POST :bootstrap without editor role → 403 Forbidden
//   G-06 C-06 viewer role CANNOT read draft (GET /modules/{rid} requires editor)
//   G-06 C-07 editor role implies viewer (an editor can read)
//   G-06 C-10 viewer → 403 on POST rollback
//   G-06 C-11 unauth → 401 on POST rollback
//   G-06 C-12 editor → 200 on POST rollback
//   G-06 C-13: per-module grant — viewer grant lets user read published
//   G-06 C-14: per-module grant — editor grant lets user write
//   G-06 C-15: per-module grant — no grant → 404 ModuleNotFound

import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

const FOLDER = `ri.compass.main.folder.${randomUUID()}`;
const ONTOLOGY = `ri.ontology.main.ontology.${randomUUID()}`;

let ctx: SchemaContext | null = null;
let pgAvailable = true;

function buildApp(roles: string[] | undefined): Express {
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string; roles?: string[] } }).user = {
      id: "u-rbac",
      ...(roles !== undefined ? { roles } : {}),
    };
    next();
  });
  app.use("/api/v1/workshop", workshopModulesRouter);
  return app;
}

function emptyDef() {
  return {
    schemaVersion: 4,
    variables: [],
    widgets: [],
    sections: [{ id: "s_root", layout: "rows", children: [] }],
    layout: { rootSection: "s_root" },
  };
}

beforeAll(async () => {
  try {
    ctx = await openTestSchema("workshop_rbac");
    await ctx.applyMigration("src/migrations/058_b1_workshop_module.sql");
    await ctx.applyMigration("src/migrations/059_b1_workshop_idempotency.sql");
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
      `[G06] Postgres unavailable; tests skipped: ${
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
});

afterAll(async () => {
  resetWorkshopDb();
  if (ctx) await ctx.close();
});

const itp = (...args: Parameters<typeof it>) =>
  pgAvailable ? it(...args) : it.skip(...args);

describe("G-06 — RBAC authz", () => {
  itp("C-01: POST /modules without editor role → 403 Forbidden", async () => {
    const app = buildApp(["workshop-viewer"]); // explicit viewer, no editor
    const r = await request(app)
      .post("/api/v1/workshop/modules")
      .set("Idempotency-Key", randomUUID())
      .send({
        displayName: `rbac-create-${Date.now()}`,
        description: null,
        parentFolderRid: FOLDER,
        ontologyRid: ONTOLOGY,
        branchRid: null,
        definition: emptyDef(),
      });
    expect(r.status).toBe(403);
    expect(r.body.errorName).toBe("Tellus:Workshop:Forbidden");
    expect(r.body.parameters?.requiredRole).toBe("editor");
  });

  itp("C-02: PUT /modules/{rid} without editor role → 403", async () => {
    // First create as editor to get a RID + ETag.
    const editor = buildApp(["workshop-editor"]);
    const created = await request(editor)
      .post("/api/v1/workshop/modules")
      .set("Idempotency-Key", randomUUID())
      .send({
        displayName: `rbac-put-${Date.now()}`,
        description: null,
        parentFolderRid: FOLDER,
        ontologyRid: ONTOLOGY,
        branchRid: null,
        definition: emptyDef(),
      });
    expect(created.status).toBe(201);
    const rid = created.body.rid as string;
    const etag = created.headers.etag as string;

    // Try to PUT as viewer.
    const viewer = buildApp(["workshop-viewer"]);
    const r = await request(viewer)
      .put(`/api/v1/workshop/modules/${encodeURIComponent(rid)}`)
      .set("If-Match", etag)
      .send({ definition: emptyDef() });
    expect(r.status).toBe(403);
    expect(r.body.errorName).toBe("Tellus:Workshop:Forbidden");
  });

  itp("C-03: DELETE /modules/{rid} without editor role → 403", async () => {
    const editor = buildApp(["workshop-editor"]);
    const created = await request(editor)
      .post("/api/v1/workshop/modules")
      .set("Idempotency-Key", randomUUID())
      .send({
        displayName: `rbac-del-${Date.now()}`,
        description: null,
        parentFolderRid: FOLDER,
        ontologyRid: ONTOLOGY,
        branchRid: null,
        definition: emptyDef(),
      });
    const rid = created.body.rid as string;
    const etag = created.headers.etag as string;

    const viewer = buildApp(["workshop-viewer"]);
    const r = await request(viewer)
      .delete(`/api/v1/workshop/modules/${encodeURIComponent(rid)}`)
      .set("If-Match", etag);
    expect(r.status).toBe(403);
    expect(r.body.errorName).toBe("Tellus:Workshop:Forbidden");
  });

  itp("C-04: POST :publish without editor role → 403", async () => {
    const editor = buildApp(["workshop-editor"]);
    const created = await request(editor)
      .post("/api/v1/workshop/modules")
      .set("Idempotency-Key", randomUUID())
      .send({
        displayName: `rbac-pub-${Date.now()}`,
        description: null,
        parentFolderRid: FOLDER,
        ontologyRid: ONTOLOGY,
        branchRid: null,
        definition: emptyDef(),
      });
    const rid = created.body.rid as string;

    const viewer = buildApp(["workshop-viewer"]);
    const r = await request(viewer)
      .post(
        `/api/v1/workshop/modules/${encodeURIComponent(rid)}/versions:publish`,
      )
      .set("Idempotency-Key", randomUUID())
      .send({ semver: "1.0.0" });
    expect(r.status).toBe(403);
    expect(r.body.errorName).toBe("Tellus:Workshop:Forbidden");
  });

  itp("C-05: POST :bootstrap without editor role → 403", async () => {
    const viewer = buildApp(["workshop-viewer"]);
    const r = await request(viewer)
      .post("/api/v1/workshop/modules:bootstrap")
      .set("Idempotency-Key", randomUUID())
      .send({
        parentFolderRid: FOLDER,
        ontologyRid: ONTOLOGY,
        displayName: `rbac-boot-${Date.now()}`,
      });
    expect(r.status).toBe(403);
    expect(r.body.errorName).toBe("Tellus:Workshop:Forbidden");
  });

  itp(
    // P1: GET /modules/:rid now requires editor (it returns the mutable draft).
    // Viewers must use GET /modules/:rid/published or resolve/latest.
    "C-06: viewer CANNOT read draft GET /modules/{rid} → 403",
    async () => {
      const editor = buildApp(["workshop-editor"]);
      const created = await request(editor)
        .post("/api/v1/workshop/modules")
        .set("Idempotency-Key", randomUUID())
        .send({
          displayName: `rbac-rw-${Date.now()}`,
          description: null,
          parentFolderRid: FOLDER,
          ontologyRid: ONTOLOGY,
          branchRid: null,
          definition: emptyDef(),
        });
      const rid = created.body.rid as string;

      const viewer = buildApp(["workshop-viewer"]);
      const fetched = await request(viewer).get(
        `/api/v1/workshop/modules/${encodeURIComponent(rid)}`,
      );
      expect(fetched.status).toBe(403);
      expect(fetched.body.errorName).toBe("Tellus:Workshop:Forbidden");
    },
  );

  itp("C-07: editor role implies viewer (editor can read draft)", async () => {
    const editor = buildApp(["workshop-editor"]);
    const created = await request(editor)
      .post("/api/v1/workshop/modules")
      .set("Idempotency-Key", randomUUID())
      .send({
        displayName: `rbac-implied-${Date.now()}`,
        description: null,
        parentFolderRid: FOLDER,
        ontologyRid: ONTOLOGY,
        branchRid: null,
        definition: emptyDef(),
      });
    const rid = created.body.rid as string;
    const r = await request(editor).get(
      `/api/v1/workshop/modules/${encodeURIComponent(rid)}`,
    );
    expect(r.status).toBe(200);
  });

  itp(
    "C-10: viewer → 403 on POST rollback",
    async () => {
      const editor = buildApp(["workshop-editor"]);
      const created = await request(editor)
        .post("/api/v1/workshop/modules")
        .set("Idempotency-Key", randomUUID())
        .send({
          displayName: `rbac-rollback-v-${Date.now()}`,
          description: null,
          parentFolderRid: FOLDER,
          ontologyRid: ONTOLOGY,
          branchRid: null,
          definition: emptyDef(),
        });
      const rid = created.body.rid as string;
      await request(editor)
        .post(`/api/v1/workshop/modules/${rid}/versions:publish`)
        .send({ semver: "1.0.0" });

      const viewer = buildApp(["workshop-viewer"]);
      const r = await request(viewer)
        .post(`/api/v1/workshop/modules/${rid}/actions/rollback`)
        .send({ semver: "1.0.0" });
      expect(r.status).toBe(403);
      expect(r.body.errorName).toBe("Tellus:Workshop:Forbidden");
    },
  );

  itp(
    "C-11: unauthenticated → 401 on POST rollback",
    async () => {
      // Build app WITHOUT a user stub — currentUser will throw UNAUTHORIZED.
      const noUserApp = express();
      noUserApp.use(express.json({ limit: "5mb" }));
      noUserApp.use("/api/v1/workshop", workshopModulesRouter);
      // Error handler to map AppError UNAUTHORIZED → 401.
      noUserApp.use(
        (
          err: unknown,
          _req: import("express").Request,
          res: import("express").Response,
          _next: import("express").NextFunction,
        ) => {
          const code = (err as { code?: string }).code;
          if (code === "UNAUTHORIZED") {
            res.status(401).json({ error: "UNAUTHORIZED" });
            return;
          }
          res.status(500).json({ error: "INTERNAL" });
        },
      );

      const r = await request(noUserApp)
        .post(`/api/v1/workshop/modules/ri.workshop.main.module.irrelevant/actions/rollback`)
        .send({ semver: "1.0.0" });
      expect(r.status).toBe(401);
    },
  );

  itp(
    "C-12: editor → 200 on POST rollback",
    async () => {
      const editor = buildApp(["workshop-editor"]);
      const created = await request(editor)
        .post("/api/v1/workshop/modules")
        .set("Idempotency-Key", randomUUID())
        .send({
          displayName: `rbac-rollback-e-${Date.now()}`,
          description: null,
          parentFolderRid: FOLDER,
          ontologyRid: ONTOLOGY,
          branchRid: null,
          definition: emptyDef(),
        });
      const rid = created.body.rid as string;
      await request(editor)
        .post(`/api/v1/workshop/modules/${rid}/versions:publish`)
        .send({ semver: "1.0.0" });
      await request(editor)
        .post(`/api/v1/workshop/modules/${rid}/versions:publish`)
        .send({ semver: "2.0.0" });

      const r = await request(editor)
        .post(`/api/v1/workshop/modules/${rid}/actions/rollback`)
        .send({ semver: "1.0.0" });
      expect(r.status).toBe(200);
    },
  );

  itp(
    "C-13: per-module viewer grant → can read published, not draft",
    async () => {
      // Create as superadmin (bypasses per-module auth).
      const admin = buildApp(["tellus-superadmin"]);
      const created = await request(admin)
        .post("/api/v1/workshop/modules")
        .set("Idempotency-Key", randomUUID())
        .send({
          displayName: `rbac-grant-v-${Date.now()}`,
          description: null,
          parentFolderRid: FOLDER,
          ontologyRid: ONTOLOGY,
          branchRid: null,
          definition: emptyDef(),
        });
      const rid = created.body.rid as string;
      await request(admin)
        .post(`/api/v1/workshop/modules/${rid}/versions:publish`)
        .send({ semver: "1.0.0" });

      // Grant viewer to user "u-viewer" (simulates grant added by admin).
      await request(admin)
        .post(`/api/v1/workshop/modules/${rid}/grants`)
        .send({
          principalType: "user",
          principalId: "u-viewer",
          role: "viewer",
        });

      // User "u-viewer" has no global roles — only per-module grant.
      const grantApp = express();
      grantApp.use(express.json({ limit: "5mb" }));
      grantApp.use((req, _res, next) => {
        (req as unknown as { user: { id: string; roles: string[] } }).user = {
          id: "u-viewer",
          roles: [],
        };
        next();
      });
      grantApp.use("/api/v1/workshop", workshopModulesRouter);

      // Read published → 200.
      const pub = await request(grantApp).get(
        `/api/v1/workshop/modules/${encodeURIComponent(rid)}/published`,
      );
      expect(pub.status).toBe(200);
      expect(pub.body.semver).toBe("1.0.0");

      // Resolve/latest → 200.
      const latest = await request(grantApp).get(
        `/api/v1/workshop/resolve/latest?rid=${encodeURIComponent(rid)}`,
      );
      expect(latest.status).toBe(200);

      // Draft read → 403.
      const draft = await request(grantApp).get(
        `/api/v1/workshop/modules/${encodeURIComponent(rid)}`,
      );
      expect(draft.status).toBe(403);
    },
  );

  itp(
    "C-14: per-module editor grant → user can do everything",
    async () => {
      const admin = buildApp(["tellus-superadmin"]);
      const created = await request(admin)
        .post("/api/v1/workshop/modules")
        .set("Idempotency-Key", randomUUID())
        .send({
          displayName: `rbac-grant-e-${Date.now()}`,
          description: null,
          parentFolderRid: FOLDER,
          ontologyRid: ONTOLOGY,
          branchRid: null,
          definition: emptyDef(),
        });
      const rid = created.body.rid as string;

      // Grant editor to user "u-editor".
      await request(admin)
        .post(`/api/v1/workshop/modules/${rid}/grants`)
        .send({
          principalType: "user",
          principalId: "u-editor",
          role: "editor",
        });

      const grantApp = express();
      grantApp.use(express.json({ limit: "5mb" }));
      grantApp.use((req, _res, next) => {
        (req as unknown as { user: { id: string; roles: string[] } }).user = {
          id: "u-editor",
          roles: [],
        };
        next();
      });
      grantApp.use("/api/v1/workshop", workshopModulesRouter);

      // Draft read → 200.
      const draft = await request(grantApp).get(
        `/api/v1/workshop/modules/${encodeURIComponent(rid)}`,
      );
      expect(draft.status).toBe(200);

      // Publish → 200.
      const pub = await request(grantApp)
        .post(`/api/v1/workshop/modules/${rid}/versions:publish`)
        .send({ semver: "1.0.0" });
      expect(pub.status).toBe(200);
    },
  );

  itp(
    "C-15: no grant + no global role → 404 ModuleNotFound",
    async () => {
      const admin = buildApp(["tellus-superadmin"]);
      const created = await request(admin)
        .post("/api/v1/workshop/modules")
        .set("Idempotency-Key", randomUUID())
        .send({
          displayName: `rbac-nogrant-${Date.now()}`,
          description: null,
          parentFolderRid: FOLDER,
          ontologyRid: ONTOLOGY,
          branchRid: null,
          definition: emptyDef(),
        });
      const rid = created.body.rid as string;

      // User with no roles, no grants.
      const noGrantApp = express();
      noGrantApp.use(express.json({ limit: "5mb" }));
      noGrantApp.use((req, _res, next) => {
        (req as unknown as { user: { id: string; roles: string[] } }).user = {
          id: "u-nobody",
          roles: [],
        };
        next();
      });
      noGrantApp.use("/api/v1/workshop", workshopModulesRouter);

      const draft = await request(noGrantApp).get(
        `/api/v1/workshop/modules/${encodeURIComponent(rid)}`,
      );
      expect(draft.status).toBe(404);
      expect(draft.body.errorName).toBe("Tellus:Workshop:ModuleNotFound");
    },
  );

  itp(
    "C-08: empty roles array → 403 (proves enforcement, not just no-op)",
    async () => {
      const empty = buildApp([]); // explicit empty
      const r = await request(empty)
        .post("/api/v1/workshop/modules")
        .set("Idempotency-Key", randomUUID())
        .send({
          displayName: `rbac-empty-${Date.now()}`,
          description: null,
          parentFolderRid: FOLDER,
          ontologyRid: ONTOLOGY,
          branchRid: null,
          definition: emptyDef(),
        });
      expect(r.status).toBe(403);
    },
  );

  itp(
    "C-09: undefined roles → soft-allow (test-bypass contract preserved)",
    async () => {
      const noRoles = buildApp(undefined); // existing test convention
      const r = await request(noRoles)
        .post("/api/v1/workshop/modules")
        .set("Idempotency-Key", randomUUID())
        .send({
          displayName: `rbac-noroles-${Date.now()}`,
          description: null,
          parentFolderRid: FOLDER,
          ontologyRid: ONTOLOGY,
          branchRid: null,
          definition: emptyDef(),
        });
      expect(r.status).toBe(201);
    },
  );
});
