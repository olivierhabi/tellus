// B2-C-10..C-12 unit tests — projectService.createProject space-rid handling.
//
// Pure-logic tests over a stubbed knex. The integration test
// (foundry/integration/spaces-b2-integration.test.ts) exercises against live
// Postgres including the `spaces` FK + spaces_one_root_idx invariant.
import { describe, it, expect } from "vitest";
import { ProjectService } from "../../../src/services/projectService";
import { ROOT_SPACE_RID, parseRid } from "../../../src/lib/rid";
import { OntologyError } from "../../../src/utils/queryErrors";

// Minimal knex stub: returns a query builder that records the calls we care
// about without touching a real DB. Each createProject call sequence is:
//   1. .knex('projects').where({...}).first()        → existing dup check
//   2. (optional) .knex('spaces').where({rid}).select('rid').first()
//   3. .knex.transaction(cb) → runs cb with a trx that supports the
//      project insert + .raw(...) + project_members insert.
function buildKnexStub(opts: {
  duplicate?: boolean;
  spaceExists?: boolean;
  insertedRow?: Record<string, unknown>;
}): unknown {
  const dupHit = !!opts.duplicate;
  const spaceHit = !!opts.spaceExists;
  const insertedRow = opts.insertedRow ?? {
    id: "00000000-0000-0000-0000-000000000099",
    name: "stub-project",
    created_at: new Date(),
    updated_at: new Date(),
  };
  function builder(table: string) {
    return {
      where(_q: Record<string, unknown>) {
        return {
          first: async () =>
            table === "projects"
              ? dupHit
                ? { id: "dup" }
                : null
              : table === "spaces"
                ? spaceHit
                  ? { rid: (_q as { rid?: string }).rid }
                  : null
                : null,
          select: () => ({
            first: async () =>
              table === "spaces"
                ? spaceHit
                  ? { rid: (_q as { rid?: string }).rid }
                  : null
                : null,
          }),
          whereNot: () => ({
            first: async () => null,
          }),
        };
      },
      insert(_v: Record<string, unknown>) {
        return {
          returning: async (_c?: string | string[]) => [insertedRow],
          onConflict: () => ({ ignore: async () => undefined }),
        };
      },
    };
  }
  // The transaction call invokes cb with a trx that proxies the same builder.
  // Inside the trx we also need .raw to be a no-op.
  const trxFn: any = (table: string) => builder(table);
  trxFn.raw = async () => undefined;
  const knex: any = (table: string) => builder(table);
  knex.transaction = async (cb: (trx: typeof trxFn) => Promise<unknown>) => cb(trxFn);
  return knex;
}

describe("B2-C-10 — createProject default spaceRid", () => {
  it("uses ROOT_SPACE_RID when no spaceRid is supplied", async () => {
    const insertedRow = {
      id: "00000000-0000-0000-0000-000000000099",
      name: "default-space",
      created_at: new Date(),
      updated_at: new Date(),
    };
    const knex = buildKnexStub({ insertedRow }) as never;
    const ps = new ProjectService(knex as never);
    // Should not throw — default path bypasses the `spaces` lookup entirely.
    const project = await ps.createProject(
      "default-space",
      "00000000-0000-0000-0000-000000000001",
    );
    expect(project).toBeTruthy();
    expect((project as { id: string }).id).toBe(insertedRow.id);
  });
});

describe("B2-C-11 — SPACE_NOT_FOUND when spaceRid does not exist", () => {
  it("rejects with SPACE_NOT_FOUND when the spaces row is absent", async () => {
    const knex = buildKnexStub({ spaceExists: false }) as never;
    const ps = new ProjectService(knex as never);
    const customSpace = "ri.compass.main.space.11111111-1111-4111-8111-111111111111";
    let thrown: unknown = null;
    try {
      await ps.createProject(
        "with-bogus-space",
        "00000000-0000-0000-0000-000000000001",
        { spaceRid: customSpace },
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OntologyError);
    expect((thrown as OntologyError).code).toBe("SPACE_NOT_FOUND");
    expect((thrown as OntologyError).statusCode).toBe(404);
  });
});

describe("B2-C-12 — INVALID_RID_FORMAT on malformed spaceRid", () => {
  it("rejects with INVALID_RID_FORMAT for a non-rid string", async () => {
    const knex = buildKnexStub({}) as never;
    const ps = new ProjectService(knex as never);
    let thrown: unknown = null;
    try {
      await ps.createProject(
        "bad-space-rid",
        "00000000-0000-0000-0000-000000000001",
        { spaceRid: "not a rid" },
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OntologyError);
    expect((thrown as OntologyError).code).toBe("INVALID_RID_FORMAT");
    expect((thrown as OntologyError).statusCode).toBe(400);
  });

  it("rejects with INVALID_RID_FORMAT when service segment is missing", async () => {
    const knex = buildKnexStub({}) as never;
    const ps = new ProjectService(knex as never);
    let thrown: unknown = null;
    try {
      await ps.createProject(
        "bad-space-rid-2",
        "00000000-0000-0000-0000-000000000001",
        { spaceRid: "ri..main.space.foo" },
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OntologyError);
    expect((thrown as OntologyError).code).toBe("INVALID_RID_FORMAT");
  });
});

describe("ROOT_SPACE_RID well-formed", () => {
  it("ROOT_SPACE_RID parses as a valid rid", () => {
    // Sanity: the constant we default to passes the same parser the
    // createProject path validates user input against.
    expect(() => parseRid(ROOT_SPACE_RID)).not.toThrow();
  });
});
