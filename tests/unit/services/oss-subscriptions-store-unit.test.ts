// Unit tests: subscriptions, temp object-set store, saved-set rids.
import { describe, it, expect } from "vitest";
import {
  matchesWhere,
  subscriptionFromCompiled,
  subscriptionRegistry,
  SubscriptionLimitError,
} from "../../../src/services/oss/subscriptionRegistry";
import {
  TemporaryObjectSetStore,
  TEMP_OBJECT_SET_RID_PREFIX,
  SAVED_OBJECT_SET_RID_PREFIX,
  mintSavedObjectSetRid,
} from "../../../src/services/oss/objectSetStore";
import { compileObjectSet } from "../../../src/services/oss/objectSetCompiler";
import { eventBus } from "../../../src/websocket/eventBus";
import type { OverlayRecord, OverlayStore } from "../../../src/services/overlay/overlayStore";
import {
  createSubscriptionCursor,
  decodeSubscriptionCursor,
  SubscriptionProtocolError,
} from "../../../src/services/oss/durableSubscriptions";

const NOW = new Date("2026-07-28T12:00:00Z");

class MemoryStore implements OverlayStore {
  private m = new Map<string, OverlayRecord>();
  async put(k: string, r: OverlayRecord) { this.m.set(k, r); }
  async mget(keys: string[]) { return keys.map((k) => this.m.get(k) ?? null); }
  async scan() { return [...this.m.values()]; }
  async delete(k: string) { this.m.delete(k); }
  async size() { return this.m.size; }
}

describe("matchesWhere", () => {
  const doc = { a: 5, s: "hello world", tags: "x" };
  it("leaf ops", () => {
    expect(matchesWhere(doc, { type: "eq", field: "a", value: 5 })).toBe(true);
    expect(matchesWhere(doc, { type: "gt", field: "a", value: 4 })).toBe(true);
    expect(matchesWhere(doc, { type: "in", field: "a", value: [5, 6] })).toBe(true);
    expect(matchesWhere(doc, { type: "startsWith", field: "s", value: "hello" })).toBe(true);
    expect(matchesWhere(doc, { type: "isNull", field: "missing" })).toBe(true);
  });
  it("compound ops", () => {
    expect(
      matchesWhere(doc, {
        type: "and",
        value: [
          { type: "eq", field: "a", value: 5 },
          { type: "not", value: [{ type: "eq", field: "a", value: 6 }] },
        ],
      }),
    ).toBe(true);
  });
  it("text/geo ops fall back to match (subscriber re-fetches)", () => {
    expect(matchesWhere(doc, { type: "containsAllTerms", field: "s", value: "zz" })).toBe(true);
  });
});

describe("subscriptionRegistry", () => {
  it("emits ADDED_OR_UPDATED for matching changed objects", async () => {
    const compiled = await compileObjectSet(
      {
        type: "filter",
        objectSet: { type: "base", objectType: "Employee" },
        where: { type: "gt", field: "salary", value: 100 },
      } as never,
      { now: () => NOW },
    );
    const events: unknown[] = [];
    const sub = subscriptionFromCompiled({
      id: "sub-1",
      userId: "u-sub-test",
      objectSet: { type: "base", objectType: "Employee" },
      compiled,
      onUpdate: (e) => events.push(e),
    });
    subscriptionRegistry.register(sub);
    eventBus.emit("ws:event", {
      event: "object_set.changed",
      projectId: null,
      payload: {
        objectType: "Employee",
        primaryKeys: ["E-1", "E-2"],
        objects: [
          { __primaryKey: "E-1", salary: 150 },
          { __primaryKey: "E-2", salary: 50 },
        ],
      },
    });
    expect(events).toHaveLength(1);
    const e = events[0] as { updates: Array<{ primaryKey: string; state: string }> };
    expect(e.updates).toEqual([
      { objectType: "Employee", primaryKey: "E-1", state: "ADDED_OR_UPDATED" },
      { objectType: "Employee", primaryKey: "E-2", state: "REMOVED" },
    ]);
    subscriptionRegistry.unregisterAll("u-sub-test");
  });

  it("ignores changes for unsubscribed object types", async () => {
    const compiled = await compileObjectSet(
      { type: "base", objectType: "Company" },
      { now: () => NOW },
    );
    const events: unknown[] = [];
    subscriptionRegistry.register(
      subscriptionFromCompiled({
        id: "sub-2",
        userId: "u-sub-test-2",
        objectSet: { type: "base", objectType: "Company" },
        compiled,
        onUpdate: (e) => events.push(e),
      }),
    );
    eventBus.emit("ws:event", {
      event: "object_set.changed",
      projectId: null,
      payload: { objectType: "Employee", primaryKeys: ["E-1"] },
    });
    expect(events).toHaveLength(0);
    subscriptionRegistry.unregisterAll("u-sub-test-2");
  });

  it("enforces the per-user limit", async () => {
    const compiled = await compileObjectSet(
      { type: "base", objectType: "T" },
      { now: () => NOW },
    );
    const uid = "u-limit-test";
    const { MAX_SUBSCRIPTIONS_PER_USER } = await import(
      "../../../src/services/oss/subscriptionRegistry"
    );
    for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_USER; i++) {
      subscriptionRegistry.register(
        subscriptionFromCompiled({
          id: `lim-${i}`,
          userId: uid,
          objectSet: { type: "base", objectType: "T" },
          compiled,
          onUpdate: () => {},
        }),
      );
    }
    expect(() =>
      subscriptionRegistry.register(
        subscriptionFromCompiled({
          id: "one-too-many",
          userId: uid,
          objectSet: { type: "base", objectType: "T" },
          compiled,
          onUpdate: () => {},
        }),
      ),
    ).toThrowError(SubscriptionLimitError);
    subscriptionRegistry.unregisterAll(uid);
  });
});

describe("durable subscription cursors", () => {
  it("round-trips only for the bound tenant, user, and subscription", () => {
    const token = createSubscriptionCursor({
      subscriptionId: "sub-1",
      tenantId: "tenant-a",
      userId: "user-a",
      sequence: 42,
    });
    expect(
      decodeSubscriptionCursor(token, {
        subscriptionId: "sub-1",
        tenantId: "tenant-a",
        userId: "user-a",
      }),
    ).toBe(42);
    expect(() =>
      decodeSubscriptionCursor(token, {
        subscriptionId: "sub-1",
        tenantId: "tenant-b",
        userId: "user-a",
      }),
    ).toThrowError(SubscriptionProtocolError);
  });

  it("rejects a forged cursor", () => {
    const token = createSubscriptionCursor({
      subscriptionId: "sub-1",
      tenantId: "tenant-a",
      userId: "user-a",
      sequence: 42,
    });
    expect(() =>
      decodeSubscriptionCursor(`${token.slice(0, -1)}x`, {
        subscriptionId: "sub-1",
        tenantId: "tenant-a",
        userId: "user-a",
      }),
    ).toThrowError(SubscriptionProtocolError);
  });
});

describe("TemporaryObjectSetStore", () => {
  it("creates, resolves with tenant+ontology scoping", async () => {
    const store = new TemporaryObjectSetStore(new MemoryStore());
    const { objectSetRid } = await store.create({
      objectSet: { type: "base", objectType: "Employee" },
      ontologyRid: "o1",
      tenant: "tenant-a",
      branchRid: null,
      createdBy: "u1",
    });
    expect(objectSetRid.startsWith(TEMP_OBJECT_SET_RID_PREFIX)).toBe(true);

    // Resolves for the minting tenant+ontology.
    const resolved = await store.resolve(objectSetRid, {
      tenant: "tenant-a",
      ontologyRid: "o1",
      branchRid: null,
      userId: "u1",
    });
    expect(resolved).toMatchObject({ type: "base", objectType: "Employee" });
    expect(
      await store.resolve(objectSetRid, {
        tenant: "tenant-a",
        ontologyRid: "o1",
        branchRid: null,
        userId: "u2",
      }),
    ).toBeNull();

    // NEVER across tenants.
    expect(
      await store.resolve(objectSetRid, {
        tenant: "tenant-b",
        ontologyRid: "o1",
        branchRid: null,
      }),
    ).toBeNull();
    // NEVER across ontologies.
    expect(
      await store.resolve(objectSetRid, {
        tenant: "tenant-a",
        ontologyRid: "o2",
        branchRid: null,
      }),
    ).toBeNull();
  });

  it("unknown rid → null", async () => {
    const store = new TemporaryObjectSetStore(new MemoryStore());
    expect(
      await store.resolve(`${TEMP_OBJECT_SET_RID_PREFIX}nope`, {
        tenant: "t",
        ontologyRid: "o",
        branchRid: null,
      }),
    ).toBeNull();
  });

  it("saved rid uses the verified namespace", () => {
    expect(mintSavedObjectSetRid().startsWith(SAVED_OBJECT_SET_RID_PREFIX)).toBe(true);
    expect(SAVED_OBJECT_SET_RID_PREFIX).toBe(
      "ri.object-set.main.versioned-object-set.",
    );
  });
});
