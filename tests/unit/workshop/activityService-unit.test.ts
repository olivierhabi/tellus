// =============================================================================
// Workshop home activity service — unit tests
//
// Covers the composite read that backs `GET /api/v1/workshop/modules:activity`:
//   - recents ∪ favorites, both wings represented in one row set
//   - trashed modules filtered at the SQL layer (self-healing for stale
//     recents rows)
//   - folder-path composition (ltree chain + project-root fallback)
//   - principal display-name resolution with raw-id fallback
//   - recency ordering, favorite-only rows sorting last (NULLS LAST), and
//     limit clamping
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryResult } from "pg";

import {
  composeModulePath,
  listModuleActivity,
} from "../../../src/services/workshop/activityService.js";
import {
  resetWorkshopDb,
  setWorkshopDb,
} from "../../../src/services/workshop/db.js";

const USER = "u-1";
const RID_A = "ri.workshop.main.module.11111111-1111-4111-8111-111111111111";
const RID_B = "ri.workshop.main.module.22222222-2222-4222-8222-222222222222";
const FOLDER_UUID = "99999999-9999-4999-8999-999999999999";
const FOLDER_RID = `ri.compass.main.folder.${FOLDER_UUID}`;

function activityQueryResult() {
  return {
    rows: [
      {
        rid: RID_A,
        display_name: "Sandboxed Orders",
        description: null,
        parent_folder_rid: FOLDER_RID,
        created_by: "u-elly",
        updated_by: "u-gone",
        created_at: "2026-07-01T10:00:00.000Z",
        updated_at: "2026-07-14T06:33:00.000Z",
        published_semver: "1.2.0",
        last_viewed_at: "2026-07-14T12:00:00.000Z",
        is_favorite: true,
      },
      {
        rid: RID_B,
        display_name: "Logistics",
        description: "favorite only",
        parent_folder_rid: FOLDER_RID,
        created_by: "u-unknown",
        updated_by: "u-unknown",
        created_at: "2026-07-02T10:00:00.000Z",
        updated_at: "2026-07-13T06:33:00.000Z",
        published_semver: null,
        last_viewed_at: null,
        is_favorite: true,
      },
    ],
  } as unknown as QueryResult;
}

function foldersQueryResult() {
  return {
    rows: [
      { id: FOLDER_UUID, project_name: "bihire", chain: "Hello world" },
    ],
  } as unknown as QueryResult;
}

const queryMock = vi.fn();

describe("workshop activityService", () => {
  beforeEach(() => {
    queryMock.mockReset();
    setWorkshopDb({
      query: queryMock,
      withTransaction: vi.fn(),
    });
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes("FROM workshop_module")) {
        return Promise.resolve(activityQueryResult());
      }
      if (sql.includes("FROM folders")) {
        return Promise.resolve(foldersQueryResult());
      }
      if (sql.includes("FROM projects")) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.reject(new Error(`unexpected SQL: ${sql}`));
    });
  });

  afterEach(() => resetWorkshopDb());

  it("scopes, trash-filters and bounds the composite SQL", async () => {
    await listModuleActivity(USER, { resolvePrincipals: async () => new Map() });

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("m.deleted_at IS NULL");
    expect(sql).toContain("user_recent_activity");
    expect(sql).toContain("user_favorite");
    expect(sql).toContain("DESC NULLS LAST");
    expect(params).toEqual([USER]);
  });

  it("composes enriched rows: paths, principals, recency, favorite flags", async () => {
    const { items } = await listModuleActivity(USER, {
      resolvePrincipals: async (ids) =>
        new Map(ids.filter((id) => id === "u-elly").map((id) => [id, "icyimpaye ellysa"])),
    });

    expect(items).toHaveLength(2);

    const recent = items[0]!;
    expect(recent).toMatchObject({
      rid: RID_A,
      displayName: "Sandboxed Orders",
      path: "/bihire/Hello world",
      createdBy: { id: "u-elly", displayName: "icyimpaye ellysa" },
      // No directory hit → raw id surfaced (FE renders it verbatim).
      lastEditedBy: { id: "u-gone", displayName: "u-gone" },
      publishedSemver: "1.2.0",
      lastViewedAt: "2026-07-14T12:00:00.000Z",
      isFavorite: true,
    });

    const favoriteOnly = items[1]!;
    expect(favoriteOnly.rid).toBe(RID_B);
    expect(favoriteOnly.lastViewedAt).toBeNull();
    expect(favoriteOnly.isFavorite).toBe(true);
  });

  it("resolves project-root parents through the projects fallback", async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes("FROM workshop_module")) {
        return Promise.resolve(activityQueryResult());
      }
      if (sql.includes("FROM folders")) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes("FROM projects")) {
        return Promise.resolve({
          rows: [{ id: FOLDER_UUID, name: "bihire" }],
        });
      }
      return Promise.reject(new Error(`unexpected SQL: ${sql}`));
    });

    const { items } = await listModuleActivity(USER, {
      resolvePrincipals: async () => new Map(),
    });
    expect(items[0]!.path).toBe("/bihire");
  });

  it("renders '—' when no parent container resolves", async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes("FROM workshop_module")) {
        return Promise.resolve(activityQueryResult());
      }
      return Promise.resolve({ rows: [] });
    });

    const { items } = await listModuleActivity(USER, {
      resolvePrincipals: async () => new Map(),
    });
    expect(items[0]!.path).toBe("—");
  });

  it("short-circuits on empty activity (no fan-out queries)", async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes("FROM workshop_module")) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.reject(new Error("no fan-out expected"));
    });

    const { items } = await listModuleActivity(USER, {
      resolvePrincipals: async () => {
        throw new Error("resolver must not run for empty activity");
      },
    });
    expect(items).toEqual([]);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("clamps limit to [1, 100]", async () => {
    await listModuleActivity(USER, { limit: 5000, resolvePrincipals: async () => new Map() });
    const [sql] = queryMock.mock.calls[0] as [string];
    expect(sql).toContain("LIMIT 100");
  });

  describe("composeModulePath", () => {
    it("joins project + folder chain", () => {
      expect(composeModulePath("bihire", "Hello world")).toBe(
        "/bihire/Hello world",
      );
    });
    it("project root only", () => {
      expect(composeModulePath("bihire", null)).toBe("/bihire");
    });
    it("unresolvable container", () => {
      expect(composeModulePath(null, null)).toBe("—");
    });
  });
});
