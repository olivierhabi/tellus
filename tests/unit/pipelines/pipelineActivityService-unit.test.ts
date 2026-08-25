// =============================================================================
// Pipeline home activity service — unit tests
//
// Covers the composite read that backs `GET /api/v1/pipelines:activity`:
//   - recents ∪ favorites scoping (SQL asserts caller + resource_type +
//     archived-trash filter)
//   - read-side dedupe of racy user_recent_activity writes (GROUP BY)
//   - project-name join → row path
//   - creator display-name resolution with raw-id fallback
//   - empty short-circuit (no principal lookups when no rows)
//   - limit clamping
// =============================================================================

import { describe, expect, it, vi } from "vitest";
import type { QueryResult } from "pg";

import {
  listPipelineActivity,
  MAX_PIPELINE_ACTIVITY_LIMIT,
} from "../../../src/services/pipelines/pipelineActivityService.js";

const USER = "u-1";
const PIPELINE_A = "11111111-1111-4111-8111-111111111111";
const PIPELINE_B = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function activityQueryResult() {
  return {
    rows: [
      {
        id: PIPELINE_A,
        name: "Orders enrichment",
        description: null,
        project_id: PROJECT_ID,
        project_name: "[Olivier] Orders",
        pipeline_type: "batch",
        status: "active",
        created_by: "u-olly",
        created_at: "2026-07-01T10:00:00.000Z",
        updated_at: "2026-07-14T06:33:00.000Z",
        last_viewed_at: "2026-07-14T12:00:00.000Z",
        is_favorite: true,
      },
      {
        id: PIPELINE_B,
        name: "Events stream",
        description: "favorite only",
        project_id: PROJECT_ID,
        project_name: null,
        pipeline_type: "streaming",
        status: "draft",
        created_by: null,
        created_at: "2026-07-02T10:00:00.000Z",
        updated_at: "2026-07-13T06:33:00.000Z",
        last_viewed_at: null,
        is_favorite: true,
      },
    ],
  } as unknown as QueryResult;
}

describe("pipelines pipelineActivityService", () => {
  it("scopes the SQL to the caller, pipeline resource_type, and non-archived rows", async () => {
    const queryMock = vi.fn().mockResolvedValue(activityQueryResult());
    await listPipelineActivity(USER, {
      db: { query: queryMock },
      resolvePrincipals: async () => new Map(),
    });

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("FROM pipelines p");
    expect(sql).toContain("p.status <> 'archived'");
    expect(sql).toContain("resource_type = 'pipeline'");
    expect(sql).toContain("GROUP BY resource_id");
    expect(sql).toContain("LEFT JOIN projects pr ON pr.id = p.project_id");
    expect(sql).toContain("ORDER BY ra.last_viewed_at DESC NULLS LAST");
    expect(params).toEqual([USER]);
  });

  it("maps rows into home-table items with path and principal names", async () => {
    const queryMock = vi.fn().mockResolvedValue(activityQueryResult());
    const result = await listPipelineActivity(USER, {
      db: { query: queryMock },
      resolvePrincipals: async (ids) => {
        expect(ids).toEqual(["u-olly"]);
        return new Map([["u-olly", "Olivier HABIMANA"]]);
      },
    });

    expect(result.items).toHaveLength(2);
    const [a, b] = result.items;
    expect(a).toMatchObject({
      id: PIPELINE_A,
      name: "Orders enrichment",
      projectId: PROJECT_ID,
      projectName: "[Olivier] Orders",
      path: "/[Olivier] Orders",
      pipelineType: "batch",
      status: "active",
      createdBy: { id: "u-olly", displayName: "Olivier HABIMANA" },
      lastViewedAt: "2026-07-14T12:00:00.000Z",
      isFavorite: true,
    });
    // Favorite-only row: no view timestamp, unresolved project → "—",
    // null creator stays null (no phantom principal).
    expect(b).toMatchObject({
      id: PIPELINE_B,
      path: "—",
      createdBy: null,
      lastViewedAt: null,
      isFavorite: true,
    });
  });

  it("falls back to the raw id when a principal cannot be resolved", async () => {
    const queryMock = vi.fn().mockResolvedValue(activityQueryResult());
    const result = await listPipelineActivity(USER, {
      db: { query: queryMock },
      resolvePrincipals: async () => new Map(),
    });
    expect(result.items[0].createdBy).toEqual({
      id: "u-olly",
      displayName: "u-olly",
    });
  });

  it("short-circuits without principal lookups when nothing matches", async () => {
    const queryMock = vi
      .fn()
      .mockResolvedValue({ rows: [] } as unknown as QueryResult);
    const resolvePrincipals = vi.fn();
    const result = await listPipelineActivity(USER, {
      db: { query: queryMock },
      resolvePrincipals,
    });
    expect(result.items).toEqual([]);
    expect(resolvePrincipals).not.toHaveBeenCalled();
  });

  it("clamps the limit to the service maximum", async () => {
    const queryMock = vi.fn().mockResolvedValue(activityQueryResult());
    await listPipelineActivity(USER, {
      limit: 10_000,
      db: { query: queryMock },
      resolvePrincipals: async () => new Map(),
    });
    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(`LIMIT ${MAX_PIPELINE_ACTIVITY_LIMIT}`);
  });
});
