// ---------------------------------------------------------------------------
// Unit tests for buildTrashedQuery.
//
// Pinned contract preventing the wrong-rid regression that silently
// emptied the project-level Trash page in production. Each test
// documents the production defect it would catch.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import { buildTrashedQuery } from "../../../src/services/trashedQuery";

const PROJECT_ID = "36271681-65d7-4c55-a6d0-20137f8212dc";
const PROJECT_RID = `ri.compass.main.project.${PROJECT_ID}`;
const FOLDER_RID = "ri.compass.main.compass-folder.7df7ab97-35cc-446a-83dd-757164ee4819";

describe("buildTrashedQuery — project-level branch (no parentRid)", () => {
  it("scopes to the project by EITHER project_rid OR rid (covers root resource row)", () => {
    const { sql, params } = buildTrashedQuery({ projectId: PROJECT_ID, pageSize: 50 });
    expect(sql).toMatch(/\(r\.project_rid = \$1 OR r\.rid = \$1\)/);
    expect(params[0]).toBe(PROJECT_RID);
  });

  it("does NOT add a parent_folder_rid predicate (the regression that emptied the page)", () => {
    const { sql } = buildTrashedQuery({ projectId: PROJECT_ID, pageSize: 50 });
    expect(sql).not.toMatch(/parent_folder_rid =/);
  });

  it("does NOT inject ri.compass.main.folder.<projectId> anywhere (the wrong-rid bug)", () => {
    const { sql, params } = buildTrashedQuery({ projectId: PROJECT_ID, pageSize: 50 });
    const wrongRid = `ri.compass.main.folder.${PROJECT_ID}`;
    expect(sql).not.toContain(wrongRid);
    expect(params).not.toContain(wrongRid);
  });

  it("filters out NOT_TRASHED rows", () => {
    const { sql } = buildTrashedQuery({ projectId: PROJECT_ID, pageSize: 50 });
    expect(sql).toMatch(/r\.trash_status <> 'NOT_TRASHED'/);
  });

  it("orders by trashed_at DESC NULLS LAST, then rid DESC for stable pagination", () => {
    const { sql } = buildTrashedQuery({ projectId: PROJECT_ID, pageSize: 50 });
    expect(sql).toMatch(/ORDER BY r\.trashed_at DESC NULLS LAST, r\.rid DESC/);
  });

  it("binds pageSize as the last positional parameter", () => {
    const { params } = buildTrashedQuery({ projectId: PROJECT_ID, pageSize: 25 });
    expect(params).toEqual([PROJECT_RID, 25]);
  });

  it("LIMIT clause references the trailing $N", () => {
    const { sql, params } = buildTrashedQuery({ projectId: PROJECT_ID, pageSize: 50 });
    expect(sql).toMatch(new RegExp(`LIMIT \\$${params.length}\\s*$`));
  });

  it("treats null and undefined parentRid identically (project-wide branch)", () => {
    const a = buildTrashedQuery({ projectId: PROJECT_ID, pageSize: 50, parentRid: null });
    const b = buildTrashedQuery({ projectId: PROJECT_ID, pageSize: 50, parentRid: undefined });
    expect(a.sql).toBe(b.sql);
    expect(a.params).toEqual(b.params);
  });
});

describe("buildTrashedQuery — folder-scoped branch (parentRid set)", () => {
  it("adds parent_folder_rid predicate bound to the supplied rid", () => {
    const { sql, params } = buildTrashedQuery({
      projectId: PROJECT_ID,
      parentRid: FOLDER_RID,
      pageSize: 50,
    });
    expect(sql).toMatch(/AND r\.parent_folder_rid = \$2/);
    expect(params).toEqual([PROJECT_RID, FOLDER_RID, 50]);
  });

  it("preserves the project envelope so the folder rid alone cannot leak rows from other projects", () => {
    const { sql } = buildTrashedQuery({
      projectId: PROJECT_ID,
      parentRid: FOLDER_RID,
      pageSize: 50,
    });
    expect(sql).toMatch(/\(r\.project_rid = \$1 OR r\.rid = \$1\)/);
  });

  it("LIMIT references trailing $3 when both project + parent + pageSize are bound", () => {
    const { sql, params } = buildTrashedQuery({
      projectId: PROJECT_ID,
      parentRid: FOLDER_RID,
      pageSize: 50,
    });
    expect(params.length).toBe(3);
    expect(sql).toMatch(/LIMIT \$3\s*$/);
  });

  it("empty-string parentRid degrades to project-wide (does not inject empty predicate)", () => {
    const { sql, params } = buildTrashedQuery({
      projectId: PROJECT_ID,
      parentRid: "",
      pageSize: 50,
    });
    expect(sql).not.toMatch(/parent_folder_rid =/);
    expect(params).toEqual([PROJECT_RID, 50]);
  });
});

describe("buildTrashedQuery — schema surface", () => {
  it("selects every column the route handler maps to the response", () => {
    const { sql } = buildTrashedQuery({ projectId: PROJECT_ID, pageSize: 50 });
    for (const col of [
      "r.rid",
      "r.display_name",
      "r.type",
      "r.trash_status",
      "r.trashed_at",
      "r.trashed_by",
      "r.retention_until",
      "r.parent_folder_rid",
      "r.created_at",
      "r.updated_at",
      "u.email AS trashed_by_email",
    ]) {
      expect(sql).toContain(col);
    }
  });

  it("LEFT JOINs users for the trashed_by_email enrichment (so deleted users do not drop rows)", () => {
    const { sql } = buildTrashedQuery({ projectId: PROJECT_ID, pageSize: 50 });
    expect(sql).toMatch(/LEFT JOIN users u ON u\.id = r\.trashed_by/);
  });
});
