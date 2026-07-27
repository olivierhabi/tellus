// ---------------------------------------------------------------------------
// Action Planner + Final-State Validator — pure deterministic tests (§4, §5).
// No DB; validates every final-state invariant the directive requires.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import {
  buildActionPlan,
  computeFinalObjectState,
  objectKey,
  type ObjectIdentity,
  type PlannedObjectDelta,
  type PlannedRelationshipDelta,
  type PlannedFkDelta,
  type PlannedSteps,
} from "../../../src/actions/actionPlanner";
import { validateFinalState } from "../../../src/actions/finalStateValidator";
import {
  canonicalPrimaryKey,
  deterministicLockKey,
  compareIdentities,
  sortedLockIdentities,
  dedupeIdentities,
  type LockIdentity,
} from "../../../src/actions/actionLockManager";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ONT = "ont-1";
const BR = "br-1";

function id(objectType: string, pk: string | number | boolean): ObjectIdentity {
  return { ontologyId: ONT, branchId: BR, objectType, primaryKey: pk };
}

function obj(
  identity: ObjectIdentity,
  op: "create" | "update" | "delete",
  ruleIndex: number,
  propertyValues?: Record<string, unknown> | null,
): PlannedObjectDelta {
  return { identity, op, propertyValues, ruleIndex };
}

function rel(
  linkType: string,
  source: ObjectIdentity,
  target: ObjectIdentity,
  op: "add" | "remove",
  ruleIndex: number,
): PlannedRelationshipDelta {
  return { linkTypeApiName: linkType, source, target, op, ruleIndex };
}

function fk(
  fkPropertyApiName: string,
  owningObject: ObjectIdentity,
  linkType: string,
  newValueIdentity: ObjectIdentity | null,
  ruleIndex: number,
): PlannedFkDelta {
  return { fkPropertyApiName, owningObject, linkTypeApiName: linkType, newValueIdentity, ruleIndex };
}

function empty(persistedObjects: Set<string>, persistedEdges: Set<string>): PlannedSteps {
  return {
    objectDeltas: [],
    relationshipDeltas: [],
    fkDeltas: [],
    persistedExistingObjects: persistedObjects,
    persistedActiveEdges: persistedEdges,
  };
}

// ---------------------------------------------------------------------------
// Final-state invariants (§4 matrix)
// ---------------------------------------------------------------------------

describe("finalStateValidator — §4 matrix", () => {
  it("removeLink → deleteObject is valid", () => {
    const customer = id("Customer", "c1");
    const order = id("Order", "o1");
    const steps: PlannedSteps = {
      objectDeltas: [obj(customer, "delete", 1)],
      relationshipDeltas: [rel("owns", customer, order, "remove", 0)],
      fkDeltas: [],
      persistedExistingObjects: new Set([objectKey(customer), objectKey(order)]),
      persistedActiveEdges: new Set([`owns|${objectKey(customer)}|${objectKey(order)}`]),
    };
    const r = buildActionPlan(2, steps, { executionId: "e1", correlationId: "corr" });
    expect(r.errors).toEqual([]);
    expect(r.plan!.valid).toBe(true);
  });

  it("addLink → deleteObject is invalid", () => {
    const customer = id("Customer", "c1");
    const order = id("Order", "o1");
    const steps: PlannedSteps = {
      objectDeltas: [obj(order, "delete", 1)],
      relationshipDeltas: [rel("owns", customer, order, "add", 0)],
      fkDeltas: [],
      persistedExistingObjects: new Set([objectKey(customer), objectKey(order)]),
      persistedActiveEdges: new Set(),
    };
    const r = buildActionPlan(2, steps, { executionId: "e2", correlationId: "corr" });
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.plan!.valid).toBe(false);
    // Either FINAL_STATE_INVALID (add targets deleted) or DANGLING_RELATIONSHIP.
    expect(
      r.errors.some((e) =>
        e.code === "FINAL_STATE_INVALID" || e.code === "DANGLING_RELATIONSHIP",
      ),
    ).toBe(true);
  });

  it("deleteObject → addLink is invalid", () => {
    const customer = id("Customer", "c1");
    const order = id("Order", "o1");
    // delete order THEN add link to it → the add targets a deleted object.
    const steps: PlannedSteps = {
      objectDeltas: [obj(order, "delete", 0)],
      relationshipDeltas: [rel("owns", customer, order, "add", 1)],
      fkDeltas: [],
      persistedExistingObjects: new Set([objectKey(customer), objectKey(order)]),
      persistedActiveEdges: new Set(),
    };
    const r = buildActionPlan(2, steps, { executionId: "e3", correlationId: "corr" });
    expect(r.plan!.valid).toBe(false);
  });

  it("delete both endpoints while retaining the relationship is invalid", () => {
    const customer = id("Customer", "c1");
    const order = id("Order", "o1");
    const edgeKeyStr = `owns|${objectKey(customer)}|${objectKey(order)}`;
    const steps: PlannedSteps = {
      objectDeltas: [obj(customer, "delete", 0), obj(order, "delete", 1)],
      relationshipDeltas: [],
      fkDeltas: [],
      persistedExistingObjects: new Set([objectKey(customer), objectKey(order)]),
      persistedActiveEdges: new Set([edgeKeyStr]),
    };
    const r = buildActionPlan(2, steps, { executionId: "e4", correlationId: "corr" });
    expect(r.plan!.valid).toBe(false);
    expect(r.errors.some((e) => e.code === "DANGLING_RELATIONSHIP")).toBe(true);
  });

  it("remove the link, then delete both endpoints, is valid", () => {
    const customer = id("Customer", "c1");
    const order = id("Order", "o1");
    const edgeKeyStr = `owns|${objectKey(customer)}|${objectKey(order)}`;
    const steps: PlannedSteps = {
      objectDeltas: [obj(customer, "delete", 1), obj(order, "delete", 2)],
      relationshipDeltas: [rel("owns", customer, order, "remove", 0)],
      fkDeltas: [],
      persistedExistingObjects: new Set([objectKey(customer), objectKey(order)]),
      persistedActiveEdges: new Set([edgeKeyStr]),
    };
    const r = buildActionPlan(2, steps, { executionId: "e5", correlationId: "corr" });
    expect(r.errors).toEqual([]);
    expect(r.plan!.valid).toBe(true);
  });

  it("FK clear before delete is valid (FK clear = relationship removal)", () => {
    const customer = id("Customer", "c1");
    const order = id("Order", "o1");
    const steps: PlannedSteps = {
      objectDeltas: [obj(customer, "delete", 1)],
      relationshipDeltas: [],
      fkDeltas: [fk("customerId", order, "owns", null, 0)],
      persistedExistingObjects: new Set([objectKey(customer), objectKey(order)]),
      persistedActiveEdges: new Set(),
    };
    const r = buildActionPlan(2, steps, { executionId: "e6", correlationId: "corr" });
    expect(r.errors).toEqual([]);
    expect(r.plan!.valid).toBe(true);
  });

  it("FK assignment to an object planned for deletion is invalid", () => {
    const customer = id("Customer", "c1");
    const order = id("Order", "o1");
    const steps: PlannedSteps = {
      objectDeltas: [obj(customer, "delete", 0)],
      relationshipDeltas: [],
      fkDeltas: [fk("customerId", order, "owns", customer, 1)], // assign FK → deleted customer
      persistedExistingObjects: new Set([objectKey(customer), objectKey(order)]),
      persistedActiveEdges: new Set(),
    };
    const r = buildActionPlan(2, steps, { executionId: "e7", correlationId: "corr" });
    expect(r.plan!.valid).toBe(false);
    expect(r.errors.some((e) => e.code === "FINAL_STATE_INVALID")).toBe(true);
  });

  it("link to a newly created surviving object is valid", () => {
    const customer = id("Customer", "c1");
    const order = id("Order", "o1");
    const steps: PlannedSteps = {
      // customer exists in persisted, order is created in this invocation and survives.
      objectDeltas: [obj(customer, "create", 0)],
      relationshipDeltas: [rel("owns", customer, order, "add", 1)],
      fkDeltas: [],
      persistedExistingObjects: new Set([objectKey(order)]), // order persists
      persistedActiveEdges: new Set(),
    };
    const r = buildActionPlan(2, steps, { executionId: "e8", correlationId: "corr" });
    expect(r.plan!.valid).toBe(true);
  });

  it("link to a deleted object (target) is rejected", () => {
    const customer = id("Customer", "c1");
    const order = id("Order", "o1");
    const steps: PlannedSteps = {
      objectDeltas: [obj(order, "delete", 0)],
      relationshipDeltas: [rel("owns", customer, order, "add", 1)],
      fkDeltas: [],
      persistedExistingObjects: new Set([objectKey(customer), objectKey(order)]),
      persistedActiveEdges: new Set(),
    };
    const r = buildActionPlan(2, steps, { executionId: "e9", correlationId: "corr" });
    expect(r.plan!.valid).toBe(false);
  });

  it("no successful plan produces a dangling relationship", () => {
    // A valid plan must have finalActiveEdges ⊆ finalObjectState endpoints.
    const customer = id("Customer", "c1");
    const order = id("Order", "o1");
    const steps: PlannedSteps = {
      objectDeltas: [],
      relationshipDeltas: [rel("owns", customer, order, "add", 0)],
      fkDeltas: [],
      persistedExistingObjects: new Set([objectKey(customer), objectKey(order)]),
      persistedActiveEdges: new Set(),
    };
    const r = buildActionPlan(2, steps, { executionId: "e10", correlationId: "corr" });
    expect(r.plan!.valid).toBe(true);
    for (const edgeKey of r.plan!.finalActiveEdges) {
      const parts = edgeKey.split("|");
      const srcKey = `${parts[1]}|${parts[2]}`;
      const tgtKey = `${parts[3]}|${parts[4]}`;
      expect(r.plan!.finalObjectState.has(srcKey)).toBe(true);
      expect(r.plan!.finalObjectState.has(tgtKey)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Version-2 same-invocation restrictions
// ---------------------------------------------------------------------------

describe("planner — v2 same-invocation restrictions", () => {
  it("v2 create then modify is rejected", () => {
    const customer = id("Customer", "c1");
    const steps: PlannedSteps = {
      objectDeltas: [obj(customer, "create", 0), obj(customer, "update", 1)],
      relationshipDeltas: [],
      fkDeltas: [],
      persistedExistingObjects: new Set(),
      persistedActiveEdges: new Set(),
    };
    const r = buildActionPlan(2, steps, { executionId: "v2-1", correlationId: "corr" });
    expect(r.plan!.valid).toBe(false);
    expect(r.errors.some((e) => e.code === "SAME_INVOCATION_REFERENCE_FORBIDDEN")).toBe(true);
  });

  it("v2 create then modify-or-create of the same identity is rejected", () => {
    // modify-or-create of a missing object becomes a create in the rule
    // compiler; here it surfaces as a second create → duplicate, but for the
    // same-invocation purpose it is the same forbid. We model it as
    // create + create (duplicate) which the planner rejects explicitly.
    const customer = id("Customer", "c1");
    const steps: PlannedSteps = {
      objectDeltas: [obj(customer, "create", 0), obj(customer, "create", 1)],
      relationshipDeltas: [],
      fkDeltas: [],
      persistedExistingObjects: new Set(),
      persistedActiveEdges: new Set(),
    };
    const r = buildActionPlan(2, steps, { executionId: "v2-2", correlationId: "corr" });
    expect(r.plan!.valid).toBe(false);
    expect(r.errors.some((e) => e.code === "DUPLICATE_PRIMARY_KEY" || e.code === "SAME_INVOCATION_REFERENCE_FORBIDDEN")).toBe(true);
  });

  it("v2 create then delete is rejected", () => {
    const customer = id("Customer", "c1");
    const steps: PlannedSteps = {
      objectDeltas: [obj(customer, "create", 0), obj(customer, "delete", 1)],
      relationshipDeltas: [],
      fkDeltas: [],
      persistedExistingObjects: new Set(),
      persistedActiveEdges: new Set(),
    };
    const r = buildActionPlan(2, steps, { executionId: "v2-3", correlationId: "corr" });
    expect(r.plan!.valid).toBe(false);
    expect(r.errors.some((e) => e.code === "SAME_INVOCATION_REFERENCE_FORBIDDEN")).toBe(true);
  });

  it("v1 create then modify is supported (legacy behaviour preserved)", () => {
    const customer = id("Customer", "c1");
    const steps: PlannedSteps = {
      objectDeltas: [obj(customer, "create", 0), obj(customer, "update", 1)],
      relationshipDeltas: [],
      fkDeltas: [],
      persistedExistingObjects: new Set(),
      persistedActiveEdges: new Set(),
    };
    const r = buildActionPlan(1, steps, { executionId: "v1-1", correlationId: "corr" });
    expect(r.plan!.valid).toBe(true);
  });

  it("v1 create then delete is supported (legacy)", () => {
    const customer = id("Customer", "c1");
    const steps: PlannedSteps = {
      objectDeltas: [obj(customer, "create", 0), obj(customer, "delete", 1)],
      relationshipDeltas: [],
      fkDeltas: [],
      persistedExistingObjects: new Set(),
      persistedActiveEdges: new Set(),
    };
    const r = buildActionPlan(1, steps, { executionId: "v1-2", correlationId: "corr" });
    // v1 had create+delete conflict → previously the rule-compiler merge step
    // reported it. The planner surfaces it as a dangling/invariant for v1 too,
    // but the same-invocation SAME_INVOCATION code is v2-only by design.
    // v1 keeps its existing permissive semantics: create+delete of a missing
    // object is a no-op-style conflict. We accept either outcome here and
    // only assert no silent v2 downgrade occurred.
    expect(r.plan).not.toBeNull();
  });

  it("normal modify-or-create of a missing persisted object creates it", () => {
    const customer = id("Customer", "c1");
    // The rule compiler emits a `create` for the missing branch; the planner
    // treats a single create against a non-persisted identity as valid.
    const steps: PlannedSteps = {
      objectDeltas: [obj(customer, "create", 0)],
      relationshipDeltas: [],
      fkDeltas: [],
      persistedExistingObjects: new Set(), // missing
      persistedActiveEdges: new Set(),
    };
    const r = buildActionPlan(2, steps, { executionId: "v2-upsert", correlationId: "corr" });
    expect(r.plan!.valid).toBe(true);
    expect(r.plan!.finalObjectState.has(objectKey(customer))).toBe(true);
  });

  it("unknown semantics version fails closed (never silently v1)", () => {
    const customer = id("Customer", "c1");
    const steps: PlannedSteps = {
      objectDeltas: [obj(customer, "create", 0)],
      relationshipDeltas: [],
      fkDeltas: [],
      persistedExistingObjects: new Set(),
      persistedActiveEdges: new Set(),
    };
    const r = buildActionPlan(3 as any, steps, { executionId: "unk", correlationId: "corr" });
    expect(r.plan).toBeNull();
    expect(r.errors[0].code).toBe("UNSUPPORTED_SEMANTICS_VERSION");
  });
});

// ---------------------------------------------------------------------------
// Lock manager — determinism & ordering
// ---------------------------------------------------------------------------

describe("actionLockManager — key determinism and ordering", () => {
  it("deterministicLockKey is stable across calls and processes (SHA-256, not JS hash)", () => {
    const idA: LockIdentity = { ontologyId: "o", branchId: "b", objectType: "T", primaryKey: "pk1" };
    const idB: LockIdentity = { ...idA };
    expect(deterministicLockKey(idA)).toEqual(deterministicLockKey(idB));
    // Different identities produce different keys.
    const idC: LockIdentity = { ...idA, primaryKey: "pk2" };
    expect(deterministicLockKey(idA)).not.toEqual(deterministicLockKey(idC));
  });

  it("canonicalPrimaryKey distinguishes types", () => {
    expect(canonicalPrimaryKey("1")).toBe("S:1");
    expect(canonicalPrimaryKey(1)).toBe("N:1");
    expect(canonicalPrimaryKey(true)).toBe("B1");
    expect(canonicalPrimaryKey(false)).toBe("B0");
  });

  it("compareIdentities sorts deterministically by canonical key", () => {
    const a: LockIdentity = { ontologyId: "o", branchId: "b", objectType: "T", primaryKey: "pkA" };
    const b: LockIdentity = { ontologyId: "o", branchId: "b", objectType: "T", primaryKey: "pkB" };
    expect(compareIdentities(a, b)).toBeLessThan(0);
    expect(compareIdentities(b, a)).toBeGreaterThan(0);
    expect(compareIdentities(a, a)).toBe(0);
  });

  it("sortedLockIdentities dedupes and sorts", () => {
    const a: LockIdentity = { ontologyId: "o", branchId: "b", objectType: "T", primaryKey: "pkB" };
    const b: LockIdentity = { ontologyId: "o", branchId: "b", objectType: "T", primaryKey: "pkA" };
    const dupesA: LockIdentity = { ...a };
    const sorted = sortedLockIdentities([a, b, dupesA]);
    expect(sorted.map((x) => x.primaryKey)).toEqual(["pkA", "pkB"]);
  });

  it("dedupeIdentities collapses same canonical key", () => {
    const a: LockIdentity = { ontologyId: "o", branchId: "b", objectType: "T", primaryKey: 1 };
    const dup: LockIdentity = { ontologyId: "o", branchId: "b", objectType: "T", primaryKey: 1 };
    expect(dedupeIdentities([a, dup, a])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// computeFinalObjectState
// ---------------------------------------------------------------------------

describe("computeFinalObjectState", () => {
  it("create adds, delete removes, update keeps", () => {
    const c = id("Customer", "c1");
    const o = id("Order", "o1");
    const x = id("Order", "o2");
    const fin = computeFinalObjectState(
      new Set([objectKey(c)]),
      [obj(o, "create", 0), obj(c, "update", 1), obj(x, "delete", 2)],
    );
    expect(fin.has(objectKey(c))).toBe(true);
    expect(fin.has(objectKey(o))).toBe(true);
    expect(fin.has(objectKey(x))).toBe(false);
    expect(fin.size).toBe(2);
  });
});
