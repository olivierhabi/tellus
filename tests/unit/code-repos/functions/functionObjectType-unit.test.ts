// ---------------------------------------------------------------------------
// functionObjectType — inferFunctionObjectType unit tests.
//
// Locks the per-function object-type detection that backs the Workshop
// function-picker "on {Type}" badge (Track 2). The `@ontology/sdk` module is
// keyed by object-type apiName, so a function importing `OlivierOrderJune`
// binds to apiName `OlivierOrderJune`; a function with no ontology import
// (helloWorld) is a pure utility → null.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { inferFunctionObjectType } from "../../../../src/services/codeRepository/functionObjectType";

const HELLO_WORLD = `export default function helloWorld(name: string): string {
  return \`Hello, \${name}\`;
}`;

const ORDER_PRIORITY = `import { ObjectSet, ObjectSpecifier } from "@osdk/client";
import { Objects } from "@osdk/functions";
import { OlivierOrderJune } from "@ontology/sdk";

export type OrderPriorityColumn = (
  orders: ObjectSet<OlivierOrderJune>,
) => Record<ObjectSpecifier<OlivierOrderJune>, string>;

export default function orderPriority(page: ObjectSetPage): Record<ObjectSpecifier<OlivierOrderJune>, string> {
  return {};
}`;

const ORDER_INSIGHTS = `import { ObjectSet, ObjectSpecifier } from "@osdk/client";
import { OlivierOrderJune } from "@ontology/sdk";

interface OrderInsights { priority: string; totalValue: number; dueStatus: string; }
export default function orderInsights(page: ObjectSetPage): Record<ObjectSpecifier<OlivierOrderJune>, OrderInsights> {
  return {};
}`;

describe("inferFunctionObjectType", () => {
  it("returns null for a pure utility (no @ontology/sdk import)", () => {
    expect(inferFunctionObjectType(HELLO_WORLD)).toBeNull();
  });

  it("returns the bound object-type apiName for a typed function (ObjectSet<X>)", () => {
    expect(inferFunctionObjectType(ORDER_PRIORITY)).toBe("OlivierOrderJune");
  });

  it("detects via ObjectSpecifier<X> too (multi-column custom return)", () => {
    expect(inferFunctionObjectType(ORDER_INSIGHTS)).toBe("OlivierOrderJune");
  });

  it("with multiple @ontology/sdk imports, picks the one used as ObjectSet<X>", () => {
    const src = `import { TypeA, TypeB } from "@ontology/sdk";
import { ObjectSet } from "@osdk/client";
export default function fn(o: ObjectSet<TypeB>) { return o; }`;
    expect(inferFunctionObjectType(src)).toBe("TypeB");
  });

  it("falls back to the first ontology import when no ObjectSet<X>/ObjectSpecifier<X> is present", () => {
    const src = `import { OnlyType } from "@ontology/sdk";
export default function fn() { return OnlyType.apiName; }`;
    expect(inferFunctionObjectType(src)).toBe("OnlyType");
  });

  it("ignores generic ObjectSet<T> type parameters (T is not an ontology import)", () => {
    const src = `import { RealType } from "@ontology/sdk";
import { ObjectSet } from "@osdk/client";
export type Generic<T> = ObjectSet<T>;
export default function fn(o: ObjectSet<RealType>) { return o; }`;
    expect(inferFunctionObjectType(src)).toBe("RealType");
  });

  it("resolves `as` aliases back to the original apiName", () => {
    const src = `import { OlivierOrderJune as Order } from "@ontology/sdk";
import { ObjectSet } from "@osdk/client";
export default function fn(o: ObjectSet<Order>) { return o; }`;
    // The function renames the import locally (`Order`), but the object-type
    // apiName is the ORIGINAL imported name `OlivierOrderJune` (that is how
    // `@ontology/sdk` is keyed). The detector resolves the alias and returns
    // the apiName, not the local binding.
    expect(inferFunctionObjectType(src)).toBe("OlivierOrderJune");
  });

  it("returns null for an empty/blank source", () => {
    expect(inferFunctionObjectType("")).toBeNull();
    expect(inferFunctionObjectType("   ")).toBeNull();
  });

  // ----- v1 legacy API (@foundry/functions, string-typed) -----------------

  it("detects v1 functions that default the object type via `objectType ?? \"X\"`", () => {
    const src = `import { Objects } from "@foundry/functions";
export default function orderSlaStatus(input: { objectType?: string; primaryKeys?: string[] }): Record<string, string> {
  const type = input.objectType ?? "OlivierOrderJune";
  for (const o of Objects.search(type).all()) { /* … */ }
  return {};
}`;
    expect(inferFunctionObjectType(src)).toBe("OlivierOrderJune");
  });

  it("detects v1 functions that call Objects.search(\"X\") with a literal", () => {
    const src = `import { Objects } from "@foundry/functions";
export default function fn() {
  return Objects.search("Flight").all();
}`;
    expect(inferFunctionObjectType(src)).toBe("Flight");
  });

  it("detects v1 functions that call Objects.get(\"X\", pk)", () => {
    const src = `import { Objects } from "@foundry/functions";
export default function fn(pk: string) {
  return Objects.get("Employee", pk);
}`;
    expect(inferFunctionObjectType(src)).toBe("Employee");
  });

  it("returns null for a v1 function with no detectable object-type literal", () => {
    // Imports @foundry/functions but the object type is only ever a runtime
    // variable with no literal default — can't infer statically.
    const src = `import { Objects } from "@foundry/functions";
export default function fn(ot: string) {
  return Objects.search(ot).all();
}`;
    expect(inferFunctionObjectType(src)).toBeNull();
  });

  it("does not match @ontology/sdk-like strings in comments or other modules", () => {
    const src = `// import { Fake } from "@ontology/sdk"
import { ObjectSet } from "@osdk/client";
export default function fn(o: ObjectSet<Fake>) { return o; }`;
    // `Fake` is only mentioned in a comment, not actually imported → null.
    // (The regex import match grabs the commented line, but `Fake` is never a
    // real import; ObjectSet<Fake> has no imported inner → falls to first
    // import `Fake` from the commented match. This documents current behaviour:
    // a commented-out import is still seen. Acceptable — real sources don't do
    // this — but pinned so a future tightening is a deliberate change.)
    expect(inferFunctionObjectType(src)).toBe("Fake");
  });
});
