// ---------------------------------------------------------------------------
// Phase J (F-J77-2) — read-your-writes overlay visibility for Action-created
// objects.
//
// Defect: an Action-created RssbFraudCase was readable by get-by-PK (PG-first)
// but invisible to /objects/search, because
//   (a) overlay EXTRAS were only merged when `buildOverlayFilter` produced a
//       predicate — unfiltered searches (and every non-eq filter shape)
//       silently skipped `collectFilterMatchingOverlays`; and
//   (b) overlay-emitted documents lacked `__primaryKey`/`__objectType`, so a
//       created object surfaced with `__primaryKey: null`.
//
// Fix contract:
//   1. Unfiltered search → match-all overlay extras (OSv2 read-your-writes).
//   2. Supported where shapes (eq/in/range/string/null + and/or/not) →
//      precise predicates evaluated against the emitted doc.
//   3. Unsupported shapes → no extras (conservative; replacement path still
//      upgrades edited rows already in the result).
//   4. Overlay docs carry the canonical identity fields (`__pk`,
//      `__primaryKey`, `__objectType`) like an indexed hit.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { __internals } from "../../../src/routes/objects";
import {
  writeOverlay,
  applyOverlayToResults,
  collectFilterMatchingOverlays,
  mergeOverlayIntoSearch,
} from "../../../src/services/overlay/writebackOverlay";
import { MemoryOverlayStore } from "../../../src/services/overlay/memoryStore";
import { MAIN_BRANCH_SENTINEL } from "../../../src/services/overlay/overlayStore";

const { buildOverlayFilter } = __internals;

describe("buildOverlayFilter (B7 extras predicate)", () => {
  it("matches everything for an unfiltered search (where == null)", () => {
    const filter = buildOverlayFilter(undefined);
    expect(filter).toBeDefined();
    expect(filter!({ anything: 1 })).toBe(true);
    const filter2 = buildOverlayFilter(null);
    expect(filter2).toBeDefined();
    expect(filter2!({})).toBe(true);
  });

  it("compiles eq on a top-level property", () => {
    const filter = buildOverlayFilter({ type: "eq", field: "status", value: "OPEN" });
    expect(filter!({ status: "OPEN" })).toBe(true);
    expect(filter!({ status: "CLOSED" })).toBe(false);
  });

  it("compiles in-membership (derived-set __pk whitelists)", () => {
    const filter = buildOverlayFilter({ type: "in", field: "__pk", value: ["A", "B"] });
    expect(filter!({ __pk: "A" })).toBe(true);
    expect(filter!({ __pk: "C" })).toBe(false);
  });

  it("compiles range + string leaves and boolean combinators", () => {
    const range = buildOverlayFilter({ type: "gte", field: "amount", value: 10 });
    expect(range!({ amount: 12 })).toBe(true);
    expect(range!({ amount: 4 })).toBe(false);
    const contains = buildOverlayFilter({ type: "contains", field: "name", value: "Fraud" });
    expect(contains!({ name: "Fraud Case" })).toBe(true);
    const not = buildOverlayFilter({ type: "not", filter: { type: "eq", field: "s", value: "X" } });
    expect(not!({ s: "Y" })).toBe(true);
    const or = buildOverlayFilter({ type: "or", filters: [
      { type: "eq", field: "s", value: "A" },
      { type: "eq", field: "s", value: "B" },
    ] });
    expect(or!({ s: "B" })).toBe(true);
    expect(or!({ s: "Z" })).toBe(false);
  });

  it("returns undefined for unsupported shapes (conservative — no extras)", () => {
    expect(buildOverlayFilter({ type: "geoDistance", field: "loc", value: {} })).toBeUndefined();
    expect(buildOverlayFilter("not-an-object")).toBeUndefined();
    expect(buildOverlayFilter({ type: "and", filters: [
      { type: "eq", field: "s", value: "A" },
      { type: "geoDistance", field: "loc", value: {} },
    ] })).toBeUndefined();
  });
});

describe("overlay emitted-document identity (F-J77-2)", () => {
  let store: MemoryOverlayStore;

  beforeEach(async () => {
    store = new MemoryOverlayStore();
    process.env.OVERLAY_READ_LEGACY = "true";
    process.env.OVERLAY_DUAL_WRITE = "false";
    await writeOverlay(
      {
        branchId: MAIN_BRANCH_SENTINEL,
        objectType: "RssbFraudCase",
        primaryKey: "FC-NEW-1",
        doc: { status: "OPEN", fraudSignalId: "SIG-1", auditId: "FC-NEW-1" },
        deleted: false,
        version: 1,
        createdAt: Date.now(),
        editId: "edit-1",
        actorUserId: null,
      },
      store,
      3600,
    );
  });

  afterEach(() => {
    delete process.env.OVERLAY_READ_LEGACY;
    delete process.env.OVERLAY_DUAL_WRITE;
  });

  it("collectFilterMatchingOverlays emits canonical identity fields", async () => {
    const extras = await collectFilterMatchingOverlays(
      "RssbFraudCase",
      () => true,
      store,
      null,
    );
    expect(extras).toHaveLength(1);
    const doc = extras[0] as Record<string, unknown>;
    expect(doc.__pk).toBe("FC-NEW-1");
    expect(doc.__primaryKey).toBe("FC-NEW-1");
    expect(doc.__objectType).toBe("RssbFraudCase");
    expect(doc.status).toBe("OPEN");
  });

  it("the extras predicate evaluates against the emitted doc (incl. __pk)", async () => {
    const filter = buildOverlayFilter({ type: "in", field: "__pk", value: ["FC-NEW-1"] });
    const extras = await collectFilterMatchingOverlays("RssbFraudCase", filter!, store, null);
    expect(extras).toHaveLength(1);
    const none = await collectFilterMatchingOverlays(
      "RssbFraudCase",
      buildOverlayFilter({ type: "in", field: "__pk", value: ["FC-OTHER"] })!,
      store,
      null,
    );
    expect(none).toHaveLength(0);
  });

  it("applyOverlayToResults replacements carry __primaryKey + __objectType", async () => {
    const replaced = await applyOverlayToResults(
      "RssbFraudCase",
      [{ __pk: "FC-NEW-1", __primaryKey: "FC-NEW-1", __objectType: "RssbFraudCase", __version: 0, status: "STALE" }],
      store,
      null,
    );
    expect(replaced).toHaveLength(1);
    const doc = replaced[0] as Record<string, unknown>;
    expect(doc.__primaryKey).toBe("FC-NEW-1");
    expect(doc.__objectType).toBe("RssbFraudCase");
    expect(doc.status).toBe("OPEN"); // overlay wins over the stale index doc
  });

  it("an unfiltered search merges created objects the index has not absorbed", async () => {
    const merged = await mergeOverlayIntoSearch({
      objectType: "RssbFraudCase",
      hits: [
        { __pk: "FC-OLD-1", __primaryKey: "FC-OLD-1", __objectType: "RssbFraudCase", __version: 7, status: "OPEN" },
      ],
      filter: buildOverlayFilter(undefined),
      store,
      branchId: null,
    });
    const pks = merged.map((d) => (d as Record<string, unknown>).__primaryKey);
    expect(pks).toContain("FC-OLD-1");
    expect(pks).toContain("FC-NEW-1");
  });
});
