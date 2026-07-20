// ---------------------------------------------------------------------------
// buildOntologySdk — requested-types instrumentation + import-scoping diff.
//
// The backend enforces Resource imports *fail-silently*: only imported object
// types are loaded into the snapshot, so Objects.search on a non-imported type
// returns an empty ObjectSet (no error). To turn that silent empty into an
// actionable UX, the SDK records every type the function queried via
// Objects.search/Objects.get (NOT Objects.types — that lists loaded types,
// not a request). The invoke route diffs that set against the repo's imports
// and returns `unimportedAccessedTypes`. These tests guard both halves:
//   1. getRequestedTypes() captures search + get args (deduped, ordered).
//   2. A non-imported type still returns an empty ObjectSet (fail-silent
//      preserved — the function keeps running, the UX layer surfaces the gap).
//   3. The route's diff logic (replicated inline) yields exactly the
//      non-imported subset.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  buildOntologySdk,
  type OntologyObject,
  type OntologySnapshot,
} from "../../../src/services/functions/ontologyRuntime";

function makeSnapshot(types: Record<string, Record<string, OntologyObject>>): OntologySnapshot {
  const byType = new Map<string, Map<string, OntologyObject>>();
  let objectCount = 0;
  for (const [apiName, byPk] of Object.entries(types)) {
    const bucket = new Map<string, OntologyObject>();
    for (const [pk, obj] of Object.entries(byPk)) {
      bucket.set(pk, { $apiName: apiName, $primaryKey: pk, $title: pk, ...obj });
      objectCount += 1;
    }
    byType.set(apiName, bucket);
  }
  return { byType, ontologyId: "ont-1", objectCount, objectTypes: Object.keys(types) };
}

describe("buildOntologySdk — requestedTypes instrumentation", () => {
  it("records types queried via Objects.search and Objects.get (deduped, insertion-ordered)", () => {
    const snap = makeSnapshot({
      A: { a1: { name: "Alpha 1" } },
      B: { b1: { name: "Bravo 1" } },
    });
    const { sdk, getRequestedTypes } = buildOntologySdk(snap);

    sdk.Objects.search("A");
    sdk.Objects.search("C"); // not in snapshot
    sdk.Objects.get("D", "x"); // not in snapshot
    sdk.Objects.search("A"); // duplicate — collapses

    expect(getRequestedTypes()).toEqual(["A", "C", "D"]);
  });

  it("Objects.search on a non-imported/non-existent type returns an empty ObjectSet (fail-silent preserved)", () => {
    const snap = makeSnapshot({ A: { a1: { name: "Alpha 1" } } });
    const { sdk } = buildOntologySdk(snap);

    const set = sdk.Objects.search("NonImported");
    expect(set.count()).toBe(0);
    expect(set.all()).toEqual([]);
    expect(set.isEmpty()).toBe(true);
  });

  it("Objects.get on a non-imported type returns undefined (no throw)", () => {
    const snap = makeSnapshot({ A: { a1: { name: "Alpha 1" } } });
    const { sdk } = buildOntologySdk(snap);

    expect(sdk.Objects.get("NonImported", "whatever")).toBeUndefined();
  });

  it("Objects.types() is NOT recorded as a request (it lists loaded types, not a query)", () => {
    const snap = makeSnapshot({ A: { a1: {} }, B: { b1: {} } });
    const { sdk, getRequestedTypes } = buildOntologySdk(snap);

    sdk.Objects.types();

    expect(getRequestedTypes()).toEqual([]);
  });

  it("the invoke-route diff (replicated) yields the non-imported subset", () => {
    // Replicates the exact computation in
    // src/services/codeRepository/admin/routes.ts (POST /:rid/functions/invoke):
    //   const importedSet = new Set(importedTypes);
    //   const unimportedAccessedTypes = (result.requestedTypes ?? [])
    //     .filter((t) => !importedSet.has(t));
    const snap = makeSnapshot({
      A: { a1: {} },
      B: { b1: {} },
    });
    const { sdk, getRequestedTypes } = buildOntologySdk(snap);

    sdk.Objects.search("A"); // imported
    sdk.Objects.search("C"); // NOT imported
    sdk.Objects.get("D", "x"); // NOT imported
    const requestedTypes = getRequestedTypes();

    const importedTypes = ["A", "B"]; // what the repo imported
    const importedSet = new Set(importedTypes);
    const unimportedAccessedTypes = requestedTypes.filter(
      (t) => !importedSet.has(t),
    );

    expect(unimportedAccessedTypes).toEqual(["C", "D"]);
  });

  it("no queries → empty requestedTypes → empty diff", () => {
    const snap = makeSnapshot({ A: { a1: {} } });
    const { getRequestedTypes } = buildOntologySdk(snap);
    expect(getRequestedTypes()).toEqual([]);
  });

  // ---- Fix B: objectTypeDescriptors keyed off DECLARED imports, not rows ---
  // Mirrors the orderInsights regression: a code repository imports
  // `OlivierOrderJune` (code_repository_resource_imports, kind='object_type')
  // but Postgres `object_instances` has ZERO rows for it. The function does
  // `import { OlivierOrderJune } from "@ontology/sdk"` then reads
  // `OlivierOrderJune.apiName`. The descriptor MUST resolve (it is a TYPE
  // descriptor, not data) or `.apiName` throws
  // `Cannot read properties of undefined (reading 'apiName')`.
  it("an imported type with ZERO rows still resolves a descriptor (no undefined.apiName)", () => {
    const snap: OntologySnapshot = {
      byType: new Map(),
      ontologyId: "ont-1",
      objectCount: 0,
      objectTypes: [],
      importedTypes: ["OlivierOrderJune"],
    };
    const { sdk } = buildOntologySdk(snap);

    expect(sdk.objectTypeDescriptors.OlivierOrderJune).toEqual({
      apiName: "OlivierOrderJune",
    });
    // Objects.search on the zero-rows type returns an empty ObjectSet, not a
    // throw — the function returns a well-defined empty result.
    const set = sdk.Objects.search("OlivierOrderJune");
    expect(set.count()).toBe(0);
    expect(set.all()).toEqual([]);
  });

  it("declared imports and rows coexist: imported type with rows keeps data, imported type without rows keeps descriptor", () => {
    // Repo imports ["OlivierOrder", "OlivierOrderJune"]; only OlivierOrder has rows.
    const byType = new Map<string, Map<string, OntologyObject>>();
    const bucket = new Map<string, OntologyObject>();
    bucket.set("ord-1", {
      $apiName: "OlivierOrder",
      $primaryKey: "ord-1",
      $title: "ord-1",
      total: 100,
    });
    byType.set("OlivierOrder", bucket);
    const snap: OntologySnapshot = {
      byType,
      ontologyId: "ont-1",
      objectCount: 1,
      objectTypes: ["OlivierOrder"],
      importedTypes: ["OlivierOrder", "OlivierOrderJune"],
    };
    const { sdk } = buildOntologySdk(snap);

    // Both imported types resolve descriptors (one has rows, one doesn't).
    expect(sdk.objectTypeDescriptors.OlivierOrder).toEqual({
      apiName: "OlivierOrder",
    });
    expect(sdk.objectTypeDescriptors.OlivierOrderJune).toEqual({
      apiName: "OlivierOrderJune",
    });
    // Type WITH rows returns its data (unchanged pre-fix behaviour).
    expect(sdk.Objects.search("OlivierOrder").count()).toBe(1);
    expect(sdk.Objects.get("OlivierOrder", "ord-1")?.$primaryKey).toBe("ord-1");
    // Type WITHOUT rows returns empty, no throw.
    expect(sdk.Objects.search("OlivierOrderJune").count()).toBe(0);
  });

  it("fallback: no importedTypes set → descriptors from objectTypes (pre-fix behaviour, no regression)", () => {
    // makeSnapshot does not set importedTypes → buildOntologySdk falls back
    // to snapshot.objectTypes (the loaded rows), preserving old behaviour for
    // callers that load without an import filter.
    const snap = makeSnapshot({ A: { a1: {} }, B: { b1: {} } });
    const { sdk } = buildOntologySdk(snap);

    expect(sdk.objectTypeDescriptors.A).toEqual({ apiName: "A" });
    expect(sdk.objectTypeDescriptors.B).toEqual({ apiName: "B" });
  });
});
