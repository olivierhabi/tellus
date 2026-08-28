import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  objectTypeCreateConflict,
  hasCompanionDatasourceBinding,
  resolveCompositeIssues,
  resolveDraftActionTypeId,
  orderWorkingChanges,
  stableOntologyValue,
  validateDraftObjectTypeId,
  type WorkingChange,
} from "../../../src/services/ontologyWorkingStateService";

function change(changeId: string, operation: WorkingChange["operation"], dependencies: string[] = []): WorkingChange {
  return {
    changeId,
    resourceKind: "objectType",
    resourceId: changeId,
    operation,
    dependencies,
    summary: changeId,
    baseSnapshot: null,
    baseRevision: "0",
    issues: [],
    acknowledged: false,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

describe("Ontology Manager working-state domain", () => {
  const objectCreate = (id = "object-1", dataset = "dataset-1"): WorkingChange => ({ ...change(`objectType:${id}:create`, "create"), resourceId: id,
    proposedValue: { objectTypeId: id, requiredDatasourceId: dataset }, issues: [{ key: `objectType:${id}:create:datasource`, severity: "error", code: "REQUIRED_FIELD_MISSING", message: "A backing datasource or explicit unbacked location is required.", resourceKind: "objectType", resourceId: id }] });
  const datasourceBind = (id = "object-1", dataset = "dataset-1"): WorkingChange => ({ ...change(`datasource:${id}:binding`, "bind"), resourceKind: "datasource", resourceId: id, proposedValue: { foundryDatasetId: dataset } });

  it("resolves the datasource requirement only from the matching composite binding", () => {
    const create = objectCreate(); const bind = datasourceBind();
    expect(hasCompanionDatasourceBinding(create, [bind, create])).toBe(true);
    expect(resolveCompositeIssues(create, create.issues, [bind, create])).toEqual([]);
    expect(hasCompanionDatasourceBinding(create, [datasourceBind("other-object")])).toBe(false);
    expect(hasCompanionDatasourceBinding(create, [datasourceBind("object-1", "other-dataset")])).toBe(false);
  });

  it("restores the datasource error when the dependent binding is removed", () => {
    const create = objectCreate();
    expect(resolveCompositeIssues(create, create.issues, [create])).toEqual(create.issues);
  });
  it("orders composite changes deterministically while honoring dependencies", () => {
    const ordered = orderWorkingChanges([
      change("delete-old", "delete", ["bind-datasource"]),
      change("bind-datasource", "bind", ["create-object"]),
      change("create-object", "create"),
    ]);
    expect(ordered.map((item) => item.changeId)).toEqual(["create-object", "bind-datasource", "delete-old"]);
  });

  it("rejects dependency cycles before any write is applied", () => {
    expect(() => orderWorkingChanges([
      change("a", "modify", ["b"]),
      change("b", "modify", ["a"]),
    ])).toThrow(/Dependency cycle/);
  });

  it("canonicalizes object keys for stable request and conflict hashes", () => {
    expect(stableOntologyValue({ b: 2, a: [1, { d: 4, c: 3 }] }))
      .toBe(stableOntologyValue({ a: [1, { c: 3, d: 4 }], b: 2 }));
  });

  it("scopes stable change ids by working state in persistence", () => {
    const migration = readFileSync(resolve(__dirname, "../../../src/migrations/175_ontology_manager_working_state.sql"), "utf8");
    expect(migration).toContain("PRIMARY KEY (working_state_id, change_id)");
    expect(migration).not.toContain("change_id TEXT PRIMARY KEY");
  });

  it("validates client-supplied draft object-type UUIDs", () => {
    expect(validateDraftObjectTypeId(undefined)).toBeNull();
    expect(validateDraftObjectTypeId("9ed8aefe-c62c-4aac-a05f-982ea6bc0dd7")).toBeNull();
    expect(validateDraftObjectTypeId("shared-route-id")).toMatch(/valid UUID/);
  });

  it("preserves a staged action-type UUID so its editor URL survives commit", () => {
    const draftRid = "6464fa0c-1bb5-429b-950b-8e04e1a1e387";
    expect(resolveDraftActionTypeId({
      resourceId: draftRid,
      proposedValue: { rid: draftRid },
    })).toBe(draftRid);
    // Legacy drafts used API names rather than UUIDs and must continue to
    // receive the database-generated identifier instead of failing a cast.
    expect(resolveDraftActionTypeId({
      resourceId: "createLegacyOrder",
      proposedValue: { apiName: "createLegacyOrder" },
    })).toBeNull();
  });

  it("maps object-type UUID and API-name races to precise domain conflicts", () => {
    expect(objectTypeCreateConflict(
      { code: "23505", constraint: "object_type_pkey" },
      { objectTypeId: "9ed8aefe-c62c-4aac-a05f-982ea6bc0dd7", apiName: "Order" },
    )).toEqual({
      code: "OBJECT_TYPE_ALREADY_EXISTS",
      message: "Object type ID '9ed8aefe-c62c-4aac-a05f-982ea6bc0dd7' is already in use.",
    });
    expect(objectTypeCreateConflict(
      { code: "23505", constraint: "object_type_ontology_id_api_name_key" },
      { objectTypeId: "9ed8aefe-c62c-4aac-a05f-982ea6bc0dd7", apiName: "Order" },
    )?.message).toContain("API name 'Order'");
    expect(objectTypeCreateConflict({ code: "23503" }, {})).toBeNull();
  });
});
