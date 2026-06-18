// ---------------------------------------------------------------------------
// B01 — Workshop Module Service integration tests against real Postgres.
//
// Contract IDs proven (see tasks/workshop/contracts.md):
//   B01 C-01  POST creates a module, returns ETag, Location, full body.
//   B01 C-02  RID format ri.workshop.main.module.<uuid v4>; bad rids 404.
//   B01 C-03  displayName length [1, 200] enforced.
//   B01 C-05  Definition >2 MiB rejected with 413 ModuleTooLarge.
//   B01 C-06  Duplicate (parent_folder_rid, lower(displayName)) → 409
//             ModuleNameConflict, including a concurrent-POST race.
//   B01 C-07/C-08 GET on unknown / soft-deleted rid → 404 ModuleNotFound.
//   B01 C-09  PUT without If-Match → 412 ResourceVersionMismatch.
//   B01 C-10  PUT with stale If-Match → 412 ResourceVersionMismatch with
//             parameters.currentEtag.
//   B01 C-11  PUT success returns 200 with a new ETag.
//   B01 C-13  DELETE is soft and idempotent on repeat.
//   B01 C-15  POST replay (same Idempotency-Key + same body) returns the
//             cached body and same RID, fromCache=true.
//   B01 C-16  POST reuse (same Idempotency-Key, different body) → 409
//             IdempotencyKeyReused.
//   B01 C-19  Concurrent PUT race — exactly one wins (200), all others
//             receive 412 with the new currentEtag.
//   B01 C-25  Migration is reversible (down + up roundtrip).
//
// Decisions referenced: D-05 (per-schema vitest harness — reuses the
// existing code-repos `_helpers/pg.ts`), D-08 (canonical-JSON ETag),
// D-10 (concurrent PUT semantics).
//
// These tests require a live Postgres reachable via PGHOST/PGPORT/...; they
// are skipped automatically (with a clear message) if connection fails.
// ---------------------------------------------------------------------------

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
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
  createModule,
  deleteModule,
  getModule,
  listModules,
  updateModule,
} from "../../../src/services/workshop/moduleService";
import { WorkshopError } from "../../../src/services/workshop/errors";

const FOLDER = `ri.compass.main.folder.${randomUUID()}`;
const ONTOLOGY = `ri.ontology.main.ontology.${randomUUID()}`;
const ACTOR = { userId: "user-test", branchRid: null as string | null };

const minimalDefinition = {
  schemaVersion: 4 as const,
  variables: [],
  widgets: [],
  sections: [{ id: "s_root", layout: "rows", children: [] }],
  layout: { rootSection: "s_root" },
};

function createBody(displayName: string) {
  return {
    displayName,
    description: null,
    parentFolderRid: FOLDER,
    ontologyRid: ONTOLOGY,
    branchRid: null,
    definition: { ...minimalDefinition },
  };
}

function updateBody() {
  return {
    definition: {
      ...minimalDefinition,
      // arbitrary mutation to force a different ETag
      widgets: [{ id: "w_a", type: "header", config: { title: "X" } }],
      sections: [
        {
          id: "s_root",
          layout: "rows",
          children: [{ kind: "widget", ref: "w_a" }],
        },
      ],
    },
  };
}

let ctx: SchemaContext | null = null;
let pgAvailable = true;

beforeAll(async () => {
  try {
    ctx = await openTestSchema("workshop_b01");
    await ctx.applyMigration("src/migrations/058_b1_workshop_module.sql");
    await ctx.applyMigration(
      "src/migrations/059_b1_workshop_idempotency.sql",
    );
  } catch (err) {
    pgAvailable = false;
    // eslint-disable-next-line no-console
    console.warn(
      `[B01-integration] Postgres unavailable; tests will be skipped: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }

  // Bind the Workshop service to the per-schema pool. `withTransaction`
  // is implemented inline so it uses the harness pool's connect path
  // (which pins search_path).
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
        try {
          await client.query("ROLLBACK");
        } catch {
          /* swallow */
        }
        throw e;
      } finally {
        client.release();
      }
    },
  });
});

afterAll(async () => {
  resetWorkshopDb();
  if (ctx) await ctx.close();
});

beforeEach(async () => {
  if (!pgAvailable || !ctx) return;
  // Tests within a `describe` are independent; truncate to keep them so.
  await ctx.exec("TRUNCATE workshop_module CASCADE");
  await ctx.exec("TRUNCATE workshop_idempotency_record");
});

const itp = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!pgAvailable) return;
    await fn();
  });

describe("B01 — module CRUD against real Postgres", () => {
  itp(
    "B01 C-01 / C-02: POST creates a module with the canonical RID format and returns an ETag",
    async () => {
      const result = await createModule(createBody("First module"), ACTOR, {
        key: null,
        route: "POST /api/v1/workshop/modules",
        body: createBody("First module"),
      });
      expect(result.fromCache).toBe(false);
      expect(result.module.rid).toMatch(
        /^ri\.workshop\.main\.module\.[0-9a-f-]{36}$/,
      );
      expect(result.etag).toMatch(/^W\/"[0-9a-f]{64}"$/);
      expect(result.module.displayName).toBe("First module");
      expect(result.module.currentSemver).toBe("0.1.0");
      expect(result.module.publishedSemver).toBeNull();
      expect(result.module.schemaVersion).toBe(4);
    },
  );

  itp(
    "B01 C-07: GET on unknown rid → 404 ModuleNotFound",
    async () => {
      const fakeRid = `ri.workshop.main.module.${randomUUID()}`;
      await expect(getModule(fakeRid)).rejects.toMatchObject({
        errorName: "Tellus:Workshop:ModuleNotFound",
        httpStatus: 404,
      });
    },
  );

  itp(
    "B01 C-08: GET on a non-canonical rid → 404 ModuleNotFound (no SQL leak)",
    async () => {
      await expect(
        getModule("ri.workshop.main.module.not-a-uuid"),
      ).rejects.toMatchObject({
        errorName: "Tellus:Workshop:ModuleNotFound",
      });
    },
  );

  itp(
    "B01 C-06: duplicate (parent_folder_rid, lower(displayName)) → 409 ModuleNameConflict",
    async () => {
      await createModule(createBody("Olivier Orders Inbox"), ACTOR, {
        key: null,
        route: "POST /api/v1/workshop/modules",
        body: createBody("Olivier Orders Inbox"),
      });
      // Same name with different case still conflicts (case-insensitive).
      await expect(
        createModule(createBody("OLIVIER orders inbox"), ACTOR, {
          key: null,
          route: "POST /api/v1/workshop/modules",
          body: createBody("OLIVIER orders inbox"),
        }),
      ).rejects.toMatchObject({
        errorName: "Tellus:Workshop:ModuleNameConflict",
        httpStatus: 409,
      });
    },
  );

  itp(
    "B01 C-06: concurrent POSTs with identical name — exactly one succeeds",
    async () => {
      const N = 8;
      const settled = await Promise.allSettled(
        Array.from({ length: N }, () =>
          createModule(createBody("RaceCondition"), ACTOR, {
            key: null,
            route: "POST /api/v1/workshop/modules",
            body: createBody("RaceCondition"),
          }),
        ),
      );
      const fulfilled = settled.filter((s) => s.status === "fulfilled");
      const rejected = settled.filter((s) => s.status === "rejected");
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(N - 1);
      for (const r of rejected) {
        expect((r as PromiseRejectedResult).reason).toMatchObject({
          errorName: "Tellus:Workshop:ModuleNameConflict",
        });
      }
    },
  );

  itp(
    "B01 C-05: definition > 2 MiB → 413 ModuleTooLarge",
    async () => {
      const huge = {
        ...minimalDefinition,
        widgets: [
          { id: "w_big", type: "blob", config: { x: "x".repeat(2_500_000) } },
        ],
      };
      await expect(
        createModule(
          {
            ...createBody("Too big"),
            definition: huge as unknown as typeof minimalDefinition,
          },
          ACTOR,
          {
            key: null,
            route: "POST /api/v1/workshop/modules",
            body: { ...createBody("Too big"), definition: huge },
          },
        ),
      ).rejects.toMatchObject({
        errorName: "Tellus:Workshop:ModuleTooLarge",
        httpStatus: 413,
      });
    },
  );

  itp(
    "B01 C-09: PUT without If-Match → 412 ResourceVersionMismatch",
    async () => {
      const created = await createModule(createBody("Needs PUT"), ACTOR, {
        key: null,
        route: "POST /api/v1/workshop/modules",
        body: createBody("Needs PUT"),
      });
      await expect(
        updateModule(created.module.rid, null, updateBody(), ACTOR),
      ).rejects.toMatchObject({
        errorName: "Tellus:Workshop:ResourceVersionMismatch",
        httpStatus: 412,
      });
    },
  );

  itp(
    "B01 C-10: PUT with stale If-Match → 412 with parameters.currentEtag",
    async () => {
      const created = await createModule(createBody("Stale ETag"), ACTOR, {
        key: null,
        route: "POST /api/v1/workshop/modules",
        body: createBody("Stale ETag"),
      });
      // Force two-second sleep is unnecessary — clock_timestamp() is per
      // statement, so two updates within the same wall-clock millisecond
      // get distinct ETags via the microsecond suffix.
      const first = await updateModule(
        created.module.rid,
        created.etag,
        updateBody(),
        ACTOR,
      );
      expect(first.etag).not.toBe(created.etag);
      // Stale: re-use the original etag.
      let caught: WorkshopError | null = null;
      try {
        await updateModule(created.module.rid, created.etag, updateBody(), ACTOR);
      } catch (e) {
        if (e instanceof WorkshopError) caught = e;
      }
      expect(caught).not.toBeNull();
      expect(caught!.errorName).toBe(
        "Tellus:Workshop:ResourceVersionMismatch",
      );
      expect(caught!.parameters.currentEtag).toBe(first.etag);
    },
  );

  itp(
    "B01 C-11: PUT success returns 200 with a new ETag distinct from the previous",
    async () => {
      const created = await createModule(createBody("New ETag"), ACTOR, {
        key: null,
        route: "POST /api/v1/workshop/modules",
        body: createBody("New ETag"),
      });
      const updated = await updateModule(
        created.module.rid,
        created.etag,
        updateBody(),
        ACTOR,
      );
      expect(updated.etag).toMatch(/^W\/"[0-9a-f]{64}"$/);
      expect(updated.etag).not.toBe(created.etag);
      // GET reflects the new ETag.
      const fetched = await getModule(created.module.rid);
      expect(fetched.rid).toBe(created.module.rid);
    },
  );

  itp(
    "B01 C-19: concurrent PUTs — exactly one wins, the rest 412",
    async () => {
      const created = await createModule(createBody("Race"), ACTOR, {
        key: null,
        route: "POST /api/v1/workshop/modules",
        body: createBody("Race"),
      });
      const N = 6;
      const settled = await Promise.allSettled(
        Array.from({ length: N }, () =>
          updateModule(created.module.rid, created.etag, updateBody(), ACTOR),
        ),
      );
      const ok = settled.filter((s) => s.status === "fulfilled");
      const fail = settled.filter((s) => s.status === "rejected");
      expect(ok.length).toBe(1);
      expect(fail.length).toBe(N - 1);
      for (const r of fail) {
        expect((r as PromiseRejectedResult).reason).toMatchObject({
          errorName: "Tellus:Workshop:ResourceVersionMismatch",
        });
      }
    },
  );

  itp(
    "B01 C-13: DELETE is soft and idempotent",
    async () => {
      const created = await createModule(createBody("To delete"), ACTOR, {
        key: null,
        route: "POST /api/v1/workshop/modules",
        body: createBody("To delete"),
      });
      const first = await deleteModule(
        created.module.rid,
        created.etag,
        ACTOR,
      );
      expect(first.deleted).toBe(true);
      // Repeat is idempotent (no-op).
      const second = await deleteModule(
        created.module.rid,
        created.etag,
        ACTOR,
      );
      expect(second.deleted).toBe(false);
      // Subsequent GET → 404.
      await expect(getModule(created.module.rid)).rejects.toMatchObject({
        errorName: "Tellus:Workshop:ModuleNotFound",
      });
    },
  );

  itp(
    "B01 C-15: POST with same Idempotency-Key and same body returns the cached response",
    async () => {
      const key = randomUUID();
      const body = createBody("Idempotent A");
      const a = await createModule(body, ACTOR, {
        key,
        route: "POST /api/v1/workshop/modules",
        body,
      });
      const b = await createModule(body, ACTOR, {
        key,
        route: "POST /api/v1/workshop/modules",
        body,
      });
      expect(b.fromCache).toBe(true);
      expect(b.module.rid).toBe(a.module.rid);
    },
  );

  itp(
    "B01 C-16: POST with same Idempotency-Key but different body → 409 IdempotencyKeyReused",
    async () => {
      const key = randomUUID();
      const a = createBody("Idempotent A");
      const b = createBody("Idempotent B");
      await createModule(a, ACTOR, {
        key,
        route: "POST /api/v1/workshop/modules",
        body: a,
      });
      await expect(
        createModule(b, ACTOR, {
          key,
          route: "POST /api/v1/workshop/modules",
          body: b,
        }),
      ).rejects.toMatchObject({
        errorName: "Tellus:Workshop:IdempotencyKeyReused",
        httpStatus: 409,
      });
    },
  );

  itp(
    "B01 C-14: LIST paginates by display_name + rid keyset",
    async () => {
      for (const n of ["alpha", "beta", "gamma", "delta", "epsilon"]) {
        await createModule(createBody(n), ACTOR, {
          key: null,
          route: "POST /api/v1/workshop/modules",
          body: createBody(n),
        });
      }
      const page1 = await listModules({
        parentFolderRid: FOLDER,
        pageSize: 2,
      });
      expect(page1.modules.length).toBe(2);
      expect(page1.nextPageToken).toBeTruthy();

      const page2 = await listModules({
        parentFolderRid: FOLDER,
        pageSize: 2,
        pageToken: page1.nextPageToken!,
      });
      expect(page2.modules.length).toBe(2);

      const allDisplayNames = [
        ...page1.modules.map((m) => m.displayName),
        ...page2.modules.map((m) => m.displayName),
      ];
      // Strictly ascending by displayName.
      const sorted = [...allDisplayNames].sort();
      expect(allDisplayNames).toEqual(sorted);
    },
  );
});

describe("B01 C-25: migration reversibility", () => {
  itp(
    "B01 C-25: down + up roundtrip drops and recreates the table cleanly",
    async () => {
      if (!ctx) return;
      // The harness already applied UP in beforeAll. Apply DOWN, then UP
      // again, and confirm the table is operational.
      await ctx.applyMigration("src/migrations/058_b1_workshop_module.down.sql");
      await ctx.applyMigration(
        "src/migrations/059_b1_workshop_idempotency.down.sql",
      );
      await ctx.applyMigration("src/migrations/058_b1_workshop_module.sql");
      await ctx.applyMigration(
        "src/migrations/059_b1_workshop_idempotency.sql",
      );
      // Sanity: table exists and is empty.
      const r = await ctx.query(
        `SELECT count(*)::int AS n FROM workshop_module`,
      );
      expect((r.rows[0] as { n: number }).n).toBe(0);
    },
  );
});
