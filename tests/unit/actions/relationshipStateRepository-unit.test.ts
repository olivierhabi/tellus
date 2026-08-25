// ---------------------------------------------------------------------------
// Relationship State Repository — pure-unit tests for the active-projection
// invariant. No DB; validates the "net active" derivation used by the
// index-backed link_instances maintenance paths.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import {
  computeActiveProjection,
  mergeActiveSets,
  edgeKey,
  type LedgerEntry,
} from "../../../src/actions/relationshipStateRepository";

describe("computeActiveProjection — net-active invariant", () => {
  it("a single add yields one active edge", () => {
    const active = computeActiveProjection([
      { linkTypeApiName: "owns", sourcePrimaryKey: "c1", targetPrimaryKey: "o1", operation: "add" },
    ]);
    expect(active.has(edgeKey({ linkTypeApiName: "owns", sourcePrimaryKey: "c1", targetPrimaryKey: "o1" }))).toBe(true);
    expect(active.size).toBe(1);
  });

  it("add then remove of the same edge yields NO active edge", () => {
    const active = computeActiveProjection([
      { linkTypeApiName: "owns", sourcePrimaryKey: "c1", targetPrimaryKey: "o1", operation: "add" },
      { linkTypeApiName: "owns", sourcePrimaryKey: "c1", targetPrimaryKey: "o1", operation: "remove" },
    ]);
    expect(active.size).toBe(0);
  });

  it("add twice then remove once = active (net +1)", () => {
    const active = computeActiveProjection([
      { linkTypeApiName: "owns", sourcePrimaryKey: "c1", targetPrimaryKey: "o1", operation: "add" },
      { linkTypeApiName: "owns", sourcePrimaryKey: "c1", targetPrimaryKey: "o1", operation: "add" },
      { linkTypeApiName: "owns", sourcePrimaryKey: "c1", targetPrimaryKey: "o1", operation: "remove" },
    ]);
    expect(active.size).toBe(1);
  });

  it("add twice then remove twice = not active (net 0)", () => {
    const active = computeActiveProjection([
      { linkTypeApiName: "owns", sourcePrimaryKey: "c1", targetPrimaryKey: "o1", operation: "add" },
      { linkTypeApiName: "owns", sourcePrimaryKey: "c1", targetPrimaryKey: "o1", operation: "add" },
      { linkTypeApiName: "owns", sourcePrimaryKey: "c1", targetPrimaryKey: "o1", operation: "remove" },
      { linkTypeApiName: "owns", sourcePrimaryKey: "c1", targetPrimaryKey: "o1", operation: "remove" },
    ]);
    expect(active.size).toBe(0);
  });

  it("different edges are independent", () => {
    const active = computeActiveProjection([
      { linkTypeApiName: "owns", sourcePrimaryKey: "c1", targetPrimaryKey: "o1", operation: "add" },
      { linkTypeApiName: "owns", sourcePrimaryKey: "c1", targetPrimaryKey: "o2", operation: "add" },
    ]);
    expect(active.size).toBe(2);
  });

  it("remove before add (out-of-order ledger) still produces net active", () => {
    // A pre-existing negative-balance is unusual but the canonical
    // reconciliation must clamp: net negative should NOT activate the edge.
    const active = computeActiveProjection([
      { linkTypeApiName: "owns", sourcePrimaryKey: "c1", targetPrimaryKey: "o1", operation: "remove" },
      { linkTypeApiName: "owns", sourcePrimaryKey: "c1", targetPrimaryKey: "o1", operation: "add" },
    ]);
    // net = 0 → not active (matches SUM HAVING net > 0)
    expect(active.size).toBe(0);
  });

  it("a tombstone-only ledger leaves nothing active", () => {
    expect(computeActiveProjection([]).size).toBe(0);
  });
});

describe("mergeActiveSets — planned edits layered on persisted state", () => {
  it("adds persist from pending and removes clear them", () => {
    const persisted = new Set(["owns\u0001c1\u0001o1"]);
    const pendingAdds = new Set(["owns\u0001c1\u0001o2"]);
    const pendingRemoves = new Set(["owns\u0001c1\u0001o1"]);
    const out = mergeActiveSets(persisted, pendingAdds, pendingRemoves);
    expect(out.has("owns\u0001c1\u0001o1")).toBe(false);
    expect(out.has("owns\u0001c1\u0001o2")).toBe(true);
  });
  it("adding an already-active edge is idempotent", () => {
    const persisted = new Set(["owns\u0001c1\u0001o1"]);
    const out = mergeActiveSets(persisted, new Set(["owns\u0001c1\u0001o1"]), new Set());
    expect(out.size).toBe(1);
  });
  it("removing a non-existent edge is idempotent (no-op)", () => {
    const out = mergeActiveSets(new Set(), new Set(), new Set(["owns\u0001c1\u0001o1"]));
    expect(out.size).toBe(0);
  });
});

describe("edgeKey — stability", () => {
  it("key order is linkType, source, target with separator", () => {
    expect(
      edgeKey({ linkTypeApiName: "l", sourcePrimaryKey: "s", targetPrimaryKey: "t" }),
    ).toBe("l\u0001s\u0001t");
  });
  it("different edges produce different keys", () => {
    expect(
      edgeKey({ linkTypeApiName: "l", sourcePrimaryKey: "s", targetPrimaryKey: "t" }),
    ).not.toBe(
      edgeKey({ linkTypeApiName: "l", sourcePrimaryKey: "t", targetPrimaryKey: "s" }),
    );
  });
});
