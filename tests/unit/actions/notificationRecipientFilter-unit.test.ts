// ---------------------------------------------------------------------------
// Unit tests for src/actions/notificationRecipientFilter.ts — Phase 6.1
// notification recipient-data-filter.
//
// Mocks `../db` (for `user_markings`) and `../models/objectInstance`
// (for `getInstance`). Each test drives `recipientVisibilityFilter` with
// a synthetic resolver + scripted instance rows.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/db", () => ({
  query: vi.fn(),
}));
vi.mock("../../../src/models/objectInstance", () => ({
  getInstance: vi.fn(),
}));

import {
  recipientVisibilityFilter,
  unionObjectMarkings,
  __clearUserMarkingsCacheForTests,
  type AffectedObjectInfo,
  type RecipientPreFilter,
  type RecipientResolver,
} from "../../../src/actions/notificationRecipientFilter";
import { query } from "../../../src/db";
import { getInstance } from "../../../src/models/objectInstance";

const mockedQuery = query as unknown as ReturnType<typeof vi.fn>;
const mockedGetInstance = getInstance as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockedQuery.mockReset();
  mockedGetInstance.mockReset();
  __clearUserMarkingsCacheForTests();
});

const resolverYes = (async (p: string): Promise<string | null> => "user-uuid-1") as RecipientResolver;
const resolverNull = (async (p: string): Promise<string | null> => null) as RecipientResolver;
const resolverThrows = (async (p: string): Promise<string | null> => {
  throw new Error("kc down");
}) as RecipientResolver;

function setUserMarkings(uuid: string, markings: string[]) {
  mockedQuery.mockImplementation((text: string) => {
    if (text.includes("FROM user_markings")) {
      return Promise.resolve({ rows: markings.map((m) => ({ marking_id: m })) });
    }
    return Promise.resolve({ rows: [] });
  });
}

function setInstanceMarkings(rows: Array<{ objectType: string; primaryKey: string; markings: string[] | null }>) {
  mockedGetInstance.mockImplementation((ontologyId, otApi, pk) => {
    const match = rows.find((r) => r.objectType === otApi && r.primaryKey === pk);
    if (!match) return Promise.resolve(null);
    return Promise.resolve({ markings: match.markings ?? [] });
  });
}

describe("recipientVisibilityFilter — empty / trivial cases", () => {
  it("empty affectedObjects ⇒ ALLOW", async () => {
    setUserMarkings("user-uuid-1", []);
    const r = await recipientVisibilityFilter("ont-1", [], { principal: "alice@test", principalKind: "user" }, resolverYes);
    expect(r.ok).toBe(true);
    expect(r.resolvedUserId).toBe("user-uuid-1");
  });

  it("resolver returns null ⇒ DROP with user_not_resolved", async () => {
    const r = await recipientVisibilityFilter("ont-1", [
      { objectType: "X", primaryKey: "k1" },
    ], { principal: "unknown@test", principalKind: "user" }, resolverNull);
    expect(r.ok).toBe(false);
    expect(r.droppedReason).toBe("user_not_resolved");
  });

  it("resolver throws ⇒ DROP with lookup_error", async () => {
    const r = await recipientVisibilityFilter("ont-1", [
      { objectType: "X", primaryKey: "k1" },
    ], { principal: "alice@test", principalKind: "user" }, resolverThrows);
    expect(r.ok).toBe(false);
    expect(r.droppedReason).toBe("lookup_error");
  });

  it("unknown instance ⇒ instance lookup returns null — treated as no markings required", async () => {
    mockedGetInstance.mockResolvedValue(null);
    setUserMarkings("user-uuid-1", []);
    const r = await recipientVisibilityFilter("ont-1", [
      { objectType: "X", primaryKey: "k1" },
    ], { principal: "alice@test", principalKind: "user" }, resolverYes);
    // Object's required markings = empty set → ALLOW.
    expect(r.ok).toBe(true);
    expect(r.resolvedUserId).toBe("user-uuid-1");
  });
});

describe("recipientVisibilityFilter — markings enforcement", () => {
  it("object requires CONFIDENTIAL; user holds it ⇒ ALLOW", async () => {
    setInstanceMarkings([{ objectType: "O", primaryKey: "k1", markings: ["CONFIDENTIAL"] }]);
    setUserMarkings("user-uuid-1", ["CONFIDENTIAL"]);
    const r = await recipientVisibilityFilter("ont-1", [
      { objectType: "O", primaryKey: "k1" },
    ], { principal: "alice@test", principalKind: "user" }, resolverYes);
    expect(r.ok).toBe(true);
  });

  it("union of multi-object markings; user holds every ⇒ ALLOW", async () => {
    setInstanceMarkings([
      { objectType: "O", primaryKey: "k1", markings: ["CONFIDENTIAL"] },
      { objectType: "O2", primaryKey: "k2", markings: ["RESTRICTED", "TK"] },
      { objectType: "O3", primaryKey: "k3", markings: ["CONFIDENTIAL"] },
    ]);
    setUserMarkings("user-uuid-1", ["CONFIDENTIAL", "RESTRICTED", "TK"]);
    const r = await recipientVisibilityFilter("ont-1", [
      { objectType: "O", primaryKey: "k1" },
      { objectType: "O2", primaryKey: "k2" },
      { objectType: "O3", primaryKey: "k3" },
    ], { principal: "alice@test", principalKind: "user" }, resolverYes);
    expect(r.ok).toBe(true);
  });

  it("union exceeds possession; user missing 2 of 3 ⇒ DROP + missingMarkings", async () => {
    setInstanceMarkings([
      { objectType: "O", primaryKey: "k1", markings: ["CONFIDENTIAL", "RESTRICTED"] },
      { objectType: "O", primaryKey: "k2", markings: ["TK"] },
    ]);
    setUserMarkings("user-uuid-1", ["CONFIDENTIAL"]); // missing RESTRICTED + TK
    const r = await recipientVisibilityFilter("ont-1", [
      { objectType: "O", primaryKey: "k1" },
      { objectType: "O", primaryKey: "k2" },
    ], { principal: "alice@test", principalKind: "user" }, resolverYes);
    expect(r.ok).toBe(false);
    expect(r.droppedReason).toBe("insufficient_visibility");
    const missing = r.missingMarkings ?? [];
    expect(missing.sort()).toEqual(["RESTRICTED", "TK"]);
  });

  it("markings-with-no-required (objects have null markings column) ⇒ ALLOW", async () => {
    setInstanceMarkings([{ objectType: "O", primaryKey: "k1", markings: null }]);
    setUserMarkings("user-uuid-1", []);
    const r = await recipientVisibilityFilter("ont-1", [
      { objectType: "O", primaryKey: "k1" },
    ], { principal: "alice@test", principalKind: "user" }, resolverYes);
    expect(r.ok).toBe(true);
  });

  it("user markings query fails ⇒ defensive empty set ⇒ DROP on requiredMarkings > 0", async () => {
    setInstanceMarkings([{ objectType: "O", primaryKey: "k1", markings: ["TOP_SECRET"] }]);
    mockedQuery.mockRejectedValue(new Error("PG hiccup"));
    const r = await recipientVisibilityFilter("ont-1", [
      { objectType: "O", primaryKey: "k1" },
    ], { principal: "alice@test", principalKind: "user" }, resolverYes);
    expect(r.ok).toBe(false);
    expect(r.droppedReason).toBe("insufficient_visibility");
  });
});

describe("unionObjectMarkings", () => {
  it("dedupes + sorts", () => {
    const u = unionObjectMarkings([["B", "A"], ["A", "C"], []]);
    expect(u).toEqual(["A", "B", "C"]);
  });

  it("handles empty input", () => {
    expect(unionObjectMarkings([])).toEqual([]);
    expect(unionObjectMarkings([[], []])).toEqual([]);
  });
});
