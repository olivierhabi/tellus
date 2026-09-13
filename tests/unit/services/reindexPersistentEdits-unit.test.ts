import { describe, expect, it } from "vitest";
import {
  replayUserEditsOnObjectMap,
  staleInstancePrimaryKeys,
  type ReplayedEdit,
} from "../../../src/services/reindexService";

function baseline(pks: string[]): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const pk of pks) map.set(pk, { pk, signalStatus: "OPEN", amount: 100 });
  return map;
}

function edit(partial: Partial<ReplayedEdit>): ReplayedEdit {
  return {
    edit_id: partial.edit_id ?? `ed-${Math.random().toString(36).slice(2)}`,
    primary_key: partial.primary_key ?? "PK-1",
    operation: partial.operation ?? "update",
    property_values: partial.property_values ?? {},
    executed_at: partial.executed_at ?? "2026-09-02T00:00:00.000Z",
    indexed: partial.indexed ?? false,
  };
}

describe("replayUserEditsOnObjectMap — persistent edits survive force reindex", () => {
  // THE regression: a force reindex rebuilds the map from the datasource
  // snapshot (no `signalStatus` there), and previously-indexed edits used to
  // be dropped — wiping user-editable properties back to baseline.
  it("re-applies an already-indexed (persistent) update after a from-scratch rebuild", () => {
    const map = baseline(["SIG-1"]); // rebuilt from snapshot — signalStatus=OPEN
    const res = replayUserEditsOnObjectMap(map, [
      edit({
        edit_id: "ed-persistent",
        primary_key: "SIG-1",
        operation: "update",
        property_values: { signalStatus: "DISMISSED" },
        indexed: true, // consumed by a previous reindex
        executed_at: "2026-09-01T10:00:00.000Z",
      }),
    ]);

    expect(map.get("SIG-1")!.signalStatus).toBe("DISMISSED");
    // Untouched datasource properties survive the overlay.
    expect(map.get("SIG-1")!.amount).toBe(100);
    expect(res).toMatchObject({ updates: 1, creates: 0, deletes: 0, pendingEditIds: [] });
  });

  it("is idempotent across consecutive reindexes (second run keeps the pinned value)", () => {
    const map = baseline(["SIG-1"]);
    const persistent = edit({
      edit_id: "ed-persistent",
      primary_key: "SIG-1",
      operation: "update",
      property_values: { signalStatus: "DISMISSED" },
      indexed: true,
      executed_at: "2026-09-01T10:00:00.000Z",
    });

    replayUserEditsOnObjectMap(map, [persistent]);
    const second = replayUserEditsOnObjectMap(map, [persistent]);

    expect(map.get("SIG-1")!.signalStatus).toBe("DISMISSED");
    expect(second.updates).toBe(1);
    expect(second.pendingEditIds).toEqual([]); // never re-stamped as pending
  });

  it("replays pending edits after persistent ones when timestamps order them so", () => {
    const map = baseline(["SIG-1"]);
    const res = replayUserEditsOnObjectMap(map, [
      // Array deliberately out of chronological order.
      edit({
        edit_id: "ed-new",
        primary_key: "SIG-1",
        operation: "update",
        property_values: { signalStatus: "CONFIRMED" },
        indexed: false,
        executed_at: "2026-09-02T12:00:00.000Z",
      }),
      edit({
        edit_id: "ed-old",
        primary_key: "SIG-1",
        operation: "update",
        property_values: { signalStatus: "DISMISSED" },
        indexed: true,
        executed_at: "2026-09-01T10:00:00.000Z",
      }),
    ]);

    expect(map.get("SIG-1")!.signalStatus).toBe("CONFIRMED"); // latest wins
    expect(res.updates).toBe(2);
    expect(res.pendingEditIds).toEqual(["ed-new"]); // only pending graduates
  });

  it("newer delete beats older update; object is gone", () => {
    const map = baseline(["SIG-1"]);
    const res = replayUserEditsOnObjectMap(map, [
      edit({
        primary_key: "SIG-1",
        operation: "update",
        property_values: { signalStatus: "DISMISSED" },
        indexed: true,
        executed_at: "2026-09-01T10:00:00.000Z",
      }),
      edit({
        primary_key: "SIG-1",
        operation: "delete",
        indexed: false,
        executed_at: "2026-09-02T10:00:00.000Z",
      }),
    ]);

    expect(map.has("SIG-1")).toBe(false);
    expect(res).toMatchObject({ updates: 1, deletes: 1 });
  });

  it("update after delete does not resurrect a stub row (deferred, stays pinned)", () => {
    const map = baseline([]);
    const res = replayUserEditsOnObjectMap(map, [
      edit({
        primary_key: "SIG-GONE",
        operation: "delete",
        indexed: true,
        executed_at: "2026-09-01T10:00:00.000Z",
      }),
      edit({
        primary_key: "SIG-GONE",
        operation: "update",
        property_values: { signalStatus: "CONFIRMED" },
        indexed: false,
        executed_at: "2026-09-02T10:00:00.000Z",
      }),
    ]);

    expect(map.has("SIG-GONE")).toBe(false); // no stub resurrection
    expect(res).toMatchObject({ deletes: 0, updates: 0, skippedUpdates: 1, skippedDeletes: 1 });
    expect(res.pendingEditIds).toEqual([expect.any(String)]); // still graduates
  });

  it("create edit materializes a new row and is counted as a create", () => {
    const map = baseline(["SIG-1"]);
    const res = replayUserEditsOnObjectMap(map, [
      edit({
        primary_key: "SIG-NEW",
        operation: "create",
        property_values: { pk: "SIG-NEW", signalStatus: "OPEN" },
        indexed: false,
        executed_at: "2026-09-02T10:00:00.000Z",
      }),
    ]);

    expect(map.get("SIG-NEW")).toEqual({ pk: "SIG-NEW", signalStatus: "OPEN" });
    expect(res).toMatchObject({ creates: 1 });
    expect(res.pendingEditIds).toHaveLength(1);
  });

  it("create edit colliding with a datasource row overlays instead of clobbering", () => {
    const map = baseline(["SIG-1"]);
    const res = replayUserEditsOnObjectMap(map, [
      edit({
        primary_key: "SIG-1",
        operation: "create",
        property_values: { signalStatus: "CONFIRMED" },
        indexed: false,
        executed_at: "2026-09-02T10:00:00.000Z",
      }),
    ]);

    expect(map.get("SIG-1")!.signalStatus).toBe("CONFIRMED");
    expect(map.get("SIG-1")!.amount).toBe(100); // survived the collision
    expect(res).toMatchObject({ creates: 0, updates: 1 }); // editMerger Test 8 parity
  });

  it("ghost delete (indexed, PK absent) is a counted no-op", () => {
    const map = baseline(["SIG-1"]);
    const res = replayUserEditsOnObjectMap(map, [
      edit({
        primary_key: "SIG-NEVER-WAS",
        operation: "delete",
        indexed: true,
        executed_at: "2026-09-02T10:00:00.000Z",
      }),
    ]);

    expect(map.has("SIG-1")).toBe(true);
    expect(res).toMatchObject({ deletes: 0, skippedDeletes: 1 });
  });

  it("null property_values on an update touches nothing but still counts", () => {
    const map = baseline(["SIG-1"]);
    const res = replayUserEditsOnObjectMap(map, [
      edit({
        primary_key: "SIG-1",
        operation: "update",
        property_values: null,
        indexed: false,
        executed_at: "2026-09-02T10:00:00.000Z",
      }),
    ]);

    expect(map.get("SIG-1")).toEqual({ pk: "SIG-1", signalStatus: "OPEN", amount: 100 });
    expect(res.updates).toBe(1);
  });

  it("deterministically orders timestamp ties by edit_id", () => {
    const map = baseline(["SIG-1"]);
    replayUserEditsOnObjectMap(map, [
      edit({
        edit_id: "aaa",
        primary_key: "SIG-1",
        operation: "update",
        property_values: { signalStatus: "DISMISSED" },
        indexed: false,
        executed_at: "2026-09-02T10:00:00.000Z",
      }),
      edit({
        edit_id: "zzz",
        primary_key: "SIG-1",
        operation: "update",
        property_values: { signalStatus: "CONFIRMED" },
        indexed: false,
        executed_at: "2026-09-02T10:00:00.000Z",
      }),
    ]);

    expect(map.get("SIG-1")!.signalStatus).toBe("CONFIRMED");
  });
});

describe("staleInstancePrimaryKeys — replacement snapshot parity", () => {
  it("prunes only rows absent from the final datasource + edit map", () => {
    const final = new Set(["APP-1", "APP-2", "ACTION-CREATED"]);

    expect(
      staleInstancePrimaryKeys(
        ["APP-1", "OLD-SNAPSHOT-1", "ACTION-CREATED", "OLD-SNAPSHOT-2"],
        final,
      ),
    ).toEqual(["OLD-SNAPSHOT-1", "OLD-SNAPSHOT-2"]);
  });
});
