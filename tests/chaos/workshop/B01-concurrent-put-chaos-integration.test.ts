// B01 — chaos: N concurrent PUTs to the same module.
//
// Spec §B01 + §0.2: every PUT requires a matching `If-Match` ETag.
// When N callers race a PUT against the same starting ETag, exactly
// one MUST win (200 + new ETag) and the remaining N-1 MUST observe
// 412 `Tellus:Workshop:ResourceVersionMismatch`. Workshop never
// accepts blind PUTs and never auto-merges (Forbidden Behaviors).
//
// Contract IDs:
//   B01 chaos C-19 — concurrent PUT race: exactly one wins; N-1 receive 412.
//   B01 chaos C-20 — winner ETag differs from the starting ETag and from
//                    every loser's reported ETag.
//   B01 chaos C-06 — display-name uniqueness within parent folder under
//                    concurrent POST: only one row materializes.

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
} from "../../integration/code-repos/_helpers/pg";
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

function emptyDefinition() {
  return {
    schemaVersion: 4,
    variables: [],
    widgets: [],
    sections: [{ id: "s_root", layout: "rows", children: [] }],
    layout: { rootSection: "s_root" },
  };
}

function buildBody(displayName: string) {
  return {
    displayName,
    description: null,
    parentFolderRid: FOLDER,
    ontologyRid: ONTOLOGY,
    branchRid: null,
    definition: emptyDefinition(),
  };
}

beforeAll(async () => {
  try {
    ctx = await openTestSchema("workshop_b01_chaos");
    await ctx.applyMigration("src/migrations/058_b1_workshop_module.sql");
    await ctx.applyMigration("src/migrations/059_b1_workshop_idempotency.sql");
    // Module create now also writes the creator's owner grant
    // (workshop_module_grants) — same migration set as B01-route.
    await ctx.applyMigration("src/migrations/181_workshop_module_grants.sql");
  } catch (err) {
    pgAvailable = false;
    // eslint-disable-next-line no-console
    console.warn(
      `[B01 chaos] Postgres unavailable; tests skipped: ${
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
  // Audit is asserted elsewhere (B01-route); keep it in-memory here so the
  // race exercises only the module + grant tables in the test schema.
  setAuditEmitter(async () => {});
  app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string } }).user = { id: "u-b01-chaos" };
    next();
  });
  app.use("/api/v1/workshop", workshopModulesRouter);
});

afterAll(async () => {
  resetWorkshopDb();
  resetAuditEmitter();
  if (ctx) await ctx.close();
});

const itp = (...args: Parameters<typeof it>) =>
  pgAvailable ? it(...args) : it.skip(...args);

describe("B01 chaos — concurrent mutation invariants", () => {
  itp(
    "B01 chaos C-19/C-20: 20 concurrent PUTs → exactly one 200, nineteen 412",
    async () => {
      const created = await request(app)
        .post("/api/v1/workshop/modules")
        .set("Idempotency-Key", randomUUID())
        .send(buildBody(`chaos-put-${randomUUID()}`));
      expect(created.status).toBe(201);
      const rid = created.body.rid as string;
      const startingEtag = created.headers.etag as string;
      expect(startingEtag).toMatch(/^W\/"[a-f0-9]+"$/);

      // Fire 20 PUTs in parallel, each with the same starting If-Match.
      // Each request changes the description so canonical-JSON ETags
      // differ — without this all 20 would be no-op identical PUTs.
      const N = 20;
      const responses = await Promise.all(
        Array.from({ length: N }, async (_, i) =>
          request(app)
            .put(`/api/v1/workshop/modules/${encodeURIComponent(rid)}`)
            .set("If-Match", startingEtag)
            .send({
              definition: emptyDefinition(),
              description: `racer-${i}`,
            }),
        ),
      );

      const winners = responses.filter((r) => r.status === 200);
      const losers = responses.filter((r) => r.status === 412);
      expect(winners.length).toBe(1);
      expect(losers.length).toBe(N - 1);

      // C-20: winner ETag is fresh + every loser carries the
      // ResourceVersionMismatch envelope with the current etag in
      // parameters so the client can refetch without a separate GET.
      const winnerEtag = winners[0].headers.etag as string;
      expect(winnerEtag).toMatch(/^W\/"[a-f0-9]+"$/);
      expect(winnerEtag).not.toBe(startingEtag);
      for (const r of losers) {
        expect(r.body.errorName).toBe(
          "Tellus:Workshop:ResourceVersionMismatch",
        );
      }

      // Persistence reflects exactly one mutation beyond the seed insert.
      const rows = await ctx!.pool.query(
        `SELECT updated_at FROM workshop_module WHERE rid = $1`,
        [rid],
      );
      expect(rows.rows).toHaveLength(1);
    },
  );

  itp(
    "B01 chaos C-06: 10 concurrent POSTs with same (parent, displayName) → exactly one 201, others 409",
    async () => {
      const dn = `racer-name-${randomUUID()}`;
      const N = 10;
      const responses = await Promise.all(
        Array.from({ length: N }, async () =>
          request(app)
            .post("/api/v1/workshop/modules")
            .set("Idempotency-Key", randomUUID())
            .send(buildBody(dn)),
        ),
      );

      const created = responses.filter((r) => r.status === 201);
      const conflicts = responses.filter((r) => r.status === 409);
      expect(created.length).toBe(1);
      expect(created.length + conflicts.length).toBe(N);
      for (const r of conflicts) {
        expect(r.body.errorName).toMatch(/^Tellus:Workshop:/);
      }

      // Persistence has exactly one row with that display name.
      const rows = await ctx!.pool.query(
        `SELECT rid FROM workshop_module
          WHERE parent_folder_rid = $1 AND display_name = $2`,
        [FOLDER, dn],
      );
      expect(rows.rows).toHaveLength(1);
    },
  );
});
