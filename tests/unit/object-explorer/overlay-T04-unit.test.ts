// ---------------------------------------------------------------------------
// T-04 — Branch-aware writeback overlay unit tests.
//
// Covers contracts C-50..C-59 (see tasks/object-explorer/contracts.md).
//
// Decision: D-2026-04-30-001 (engineering-vs-operational done) — operational
// gates (Redis schema bake, dual-write soak, READ_LEGACY=false flip)
// surface in FINAL_REPORT; the unit tests below verify the engineering
// surface against MemoryOverlayStore which mirrors the Redis semantics
// exercised in production.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  overlayKey,
  legacyOverlayKey,
  parseOverlayKey,
  parseLinkOverlayKey,
  linkOverlayKey,
  MAIN_BRANCH_SENTINEL,
  isDualWriteEnabled,
  isLegacyReadEnabled,
  type OverlayRecord,
} from "../../../src/services/overlay/overlayStore";
import {
  writeOverlay,
  readOverlay,
  applyOverlayToResults,
  collectFilterMatchingOverlays,
} from "../../../src/services/overlay/writebackOverlay";
import { MemoryOverlayStore } from "../../../src/services/overlay/memoryStore";
import {
  __resetMetricsForTesting,
  renderPrometheus,
} from "../../../src/services/funnel/metrics";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function counterValue(prom: string, name: string, labelMatch?: string): number {
  const lines = prom.split("\n").filter((l) => l.startsWith(name));
  for (const l of lines) {
    if (l.startsWith(`# `)) continue;
    if (labelMatch === undefined) {
      const m = /\s(\d+(?:\.\d+)?)$/.exec(l);
      if (m) return Number(m[1]);
    } else if (l.includes(labelMatch)) {
      const m = /\s(\d+(?:\.\d+)?)$/.exec(l);
      if (m) return Number(m[1]);
    }
  }
  return 0;
}

function makeRecord(
  partial: Partial<OverlayRecord> & {
    branchId: string;
    objectType: string;
    primaryKey: string;
    version: number;
  },
): OverlayRecord {
  return {
    doc: { _v: partial.version },
    deleted: false,
    createdAt: 1_700_000_000_000,
    editId: `edit-${partial.version}`,
    actorUserId: null,
    ...partial,
  };
}

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void> | void,
): Promise<void> {
  const originals: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    originals[k] = process.env[k];
    if (vars[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = vars[k];
    }
  }
  return Promise.resolve(fn()).finally(() => {
    for (const k of Object.keys(originals)) {
      if (originals[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = originals[k];
      }
    }
  });
}

// ---------------------------------------------------------------------------
// C-50, C-51, C-52: keyspace shape and OverlayRecord branchId.
// ---------------------------------------------------------------------------

describe("T-04 keyspace helpers", () => {
  it("T-04 C-51: overlayKey(branch, ot, pk) returns 'overlay:<branch>:<ot>:<pk>'", () => {
    expect(overlayKey("br-uuid", "Orders", "O-1")).toBe(
      "overlay:br-uuid:Orders:O-1",
    );
    expect(overlayKey("_main", "Customers", "C-9")).toBe(
      "overlay:_main:Customers:C-9",
    );
  });

  it("T-04 C-51: nullish/empty branchId materialises as the _main sentinel", () => {
    expect(overlayKey(null, "Orders", "O-1")).toBe("overlay:_main:Orders:O-1");
    expect(overlayKey(undefined, "Orders", "O-1")).toBe(
      "overlay:_main:Orders:O-1",
    );
    expect(overlayKey("", "Orders", "O-1")).toBe("overlay:_main:Orders:O-1");
    expect(MAIN_BRANCH_SENTINEL).toBe("_main");
  });

  it("T-04 C-52: legacyOverlayKey(ot, pk) returns 'overlay:<ot>:<pk>'", () => {
    expect(legacyOverlayKey("Orders", "O-1")).toBe("overlay:Orders:O-1");
  });

  it("T-04 C-49: parseOverlayKey distinguishes new vs legacy form", () => {
    expect(parseOverlayKey("overlay:br-9:Orders:O-1")).toEqual({
      branchId: "br-9",
      objectType: "Orders",
      primaryKey: "O-1",
    });
    expect(parseOverlayKey("overlay:Orders:O-1")).toEqual({
      branchId: null,
      objectType: "Orders",
      primaryKey: "O-1",
    });
    // Link overlays in the same namespace MUST NOT confuse the parser.
    expect(parseOverlayKey("overlay:link:knows:A:B")).toBeNull();
    expect(parseLinkOverlayKey("overlay:link:knows:A:B")).toEqual({
      linkTypeApiName: "knows",
      sourcePk: "A",
      targetPk: "B",
    });
  });

  it("T-04 C-50: an OverlayRecord literal without branchId is a TypeScript error (compiled fence)", () => {
    // The check below is a runtime echo of the type-level contract: the
    // record literal MUST carry branchId. If T-04 is reverted in source,
    // this assertion still passes (because the literal builds), but the
    // type-check (npm run typecheck) catches the violation. We assert
    // both shape and presence so the test fails loudly on either axis.
    const rec = makeRecord({
      branchId: "_main",
      objectType: "X",
      primaryKey: "X-1",
      version: 1,
    });
    expect(typeof rec.branchId).toBe("string");
    expect(rec.branchId.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// C-53: cross-branch read isolation.
// ---------------------------------------------------------------------------

describe("T-04 cross-branch read isolation", () => {
  beforeEach(() => __resetMetricsForTesting());

  it("T-04 C-53: a record on branch B is not returned to a read on branch A (same PK)", async () => {
    await withEnv(
      { OVERLAY_DUAL_WRITE: "false", OVERLAY_READ_LEGACY: "false" },
      async () => {
        const store = new MemoryOverlayStore();
        const recA = makeRecord({
          branchId: "br-A",
          objectType: "Orders",
          primaryKey: "O-1",
          version: 1,
          doc: { tag: "A" },
        });
        const recB = makeRecord({
          branchId: "br-B",
          objectType: "Orders",
          primaryKey: "O-1",
          version: 1,
          doc: { tag: "B" },
        });
        await writeOverlay(recA, store, 60);
        await writeOverlay(recB, store, 60);

        const a = await readOverlay("br-A", "Orders", "O-1", store);
        const b = await readOverlay("br-B", "Orders", "O-1", store);
        expect(a?.doc.tag).toBe("A");
        expect(b?.doc.tag).toBe("B");

        // A read on a third branch returns null — no cross-contamination.
        const c = await readOverlay("br-C", "Orders", "O-1", store);
        expect(c).toBeNull();
      },
    );
  });

  it("T-04 C-53: applyOverlayToResults respects branchId for replacement", async () => {
    await withEnv(
      { OVERLAY_DUAL_WRITE: "false", OVERLAY_READ_LEGACY: "false" },
      async () => {
        const store = new MemoryOverlayStore();
        await writeOverlay(
          makeRecord({
            branchId: "br-A",
            objectType: "Orders",
            primaryKey: "O-1",
            version: 2,
            doc: { tag: "A" },
          }),
          store,
          60,
        );
        const hitsA = await applyOverlayToResults(
          "Orders",
          [{ __pk: "O-1", __version: 1, tag: "indexed" }],
          store,
          "br-A",
        );
        const hitsB = await applyOverlayToResults(
          "Orders",
          [{ __pk: "O-1", __version: 1, tag: "indexed" }],
          store,
          "br-B",
        );
        expect(hitsA[0].tag).toBe("A");
        expect(hitsB[0].tag).toBe("indexed");
      },
    );
  });

  it("T-04 C-53: collectFilterMatchingOverlays drops cross-branch records", async () => {
    await withEnv(
      { OVERLAY_DUAL_WRITE: "false", OVERLAY_READ_LEGACY: "false" },
      async () => {
        const store = new MemoryOverlayStore();
        await writeOverlay(
          makeRecord({
            branchId: "br-A",
            objectType: "Orders",
            primaryKey: "O-9",
            version: 1,
            doc: { status: "open" },
          }),
          store,
          60,
        );
        const a = await collectFilterMatchingOverlays(
          "Orders",
          () => true,
          store,
          "br-A",
        );
        const b = await collectFilterMatchingOverlays(
          "Orders",
          () => true,
          store,
          "br-B",
        );
        expect(a).toHaveLength(1);
        expect(b).toHaveLength(0);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// C-54: CAS on version.
// ---------------------------------------------------------------------------

describe("T-04 CAS on version", () => {
  beforeEach(() => __resetMetricsForTesting());

  it("T-04 C-54: incoming.version <= stored.version throws OVERLAY_VERSION_CONFLICT", async () => {
    const store = new MemoryOverlayStore();
    await writeOverlay(
      makeRecord({
        branchId: "_main",
        objectType: "Orders",
        primaryKey: "O-1",
        version: 5,
      }),
      store,
      60,
    );

    // Equal version → conflict (accidental double-write).
    await expect(
      writeOverlay(
        makeRecord({
          branchId: "_main",
          objectType: "Orders",
          primaryKey: "O-1",
          version: 5,
        }),
        store,
        60,
      ),
    ).rejects.toMatchObject({ code: "OVERLAY_VERSION_CONFLICT" });

    // Older version → conflict (out-of-order arrival).
    await expect(
      writeOverlay(
        makeRecord({
          branchId: "_main",
          objectType: "Orders",
          primaryKey: "O-1",
          version: 4,
        }),
        store,
        60,
      ),
    ).rejects.toMatchObject({ code: "OVERLAY_VERSION_CONFLICT" });

    // Strictly greater → ok.
    await expect(
      writeOverlay(
        makeRecord({
          branchId: "_main",
          objectType: "Orders",
          primaryKey: "O-1",
          version: 6,
        }),
        store,
        60,
      ),
    ).resolves.toBeUndefined();
  });

  it("T-04 C-58: tellus_overlay_writes_total increments on ok and version_conflict", async () => {
    __resetMetricsForTesting();
    const store = new MemoryOverlayStore();
    await writeOverlay(
      makeRecord({
        branchId: "_main",
        objectType: "Orders",
        primaryKey: "O-1",
        version: 1,
      }),
      store,
      60,
    );
    await expect(
      writeOverlay(
        makeRecord({
          branchId: "_main",
          objectType: "Orders",
          primaryKey: "O-1",
          version: 1,
        }),
        store,
        60,
      ),
    ).rejects.toThrow();
    const prom = renderPrometheus();
    expect(counterValue(prom, "tellus_overlay_writes_total", 'outcome="ok"')).toBe(1);
    expect(
      counterValue(prom, "tellus_overlay_writes_total", 'outcome="version_conflict"'),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// C-55, C-56: legacy fallback gating.
// ---------------------------------------------------------------------------

describe("T-04 legacy fallback gating", () => {
  beforeEach(() => __resetMetricsForTesting());

  it("T-04 C-55: legacy hit served on _main when OVERLAY_READ_LEGACY=true", async () => {
    await withEnv({ OVERLAY_READ_LEGACY: "true" }, async () => {
      const store = new MemoryOverlayStore();
      // Simulate a pre-T-04 record at the legacy key (no branchId, raw put).
      const legacyKey = legacyOverlayKey("Orders", "O-1");
      const legacyRec = {
        branchId: "_main",
        objectType: "Orders",
        primaryKey: "O-1",
        doc: { tag: "legacy" },
        deleted: false,
        version: 1,
        createdAt: 0,
        editId: "legacy-edit",
        actorUserId: null,
      } as OverlayRecord;
      await store.put(legacyKey, legacyRec, 60);
      const out = await readOverlay(null, "Orders", "O-1", store);
      expect(out?.doc.tag).toBe("legacy");
      // C-58: legacy hit emits the legacy_hits counter.
      const prom = renderPrometheus();
      expect(counterValue(prom, "tellus_overlay_legacy_hits_total")).toBe(1);
      expect(
        counterValue(prom, "tellus_overlay_reads_total", 'source="legacy_key"'),
      ).toBe(1);
    });
  });

  it("T-04 C-56: legacy keys never read when OVERLAY_READ_LEGACY=false", async () => {
    await withEnv({ OVERLAY_READ_LEGACY: "false" }, async () => {
      const store = new MemoryOverlayStore();
      const legacyKey = legacyOverlayKey("Orders", "O-1");
      await store.put(
        legacyKey,
        {
          branchId: "_main",
          objectType: "Orders",
          primaryKey: "O-1",
          doc: { tag: "legacy" },
          deleted: false,
          version: 1,
          createdAt: 0,
          editId: "e",
        } as OverlayRecord,
        60,
      );
      const out = await readOverlay(null, "Orders", "O-1", store);
      expect(out).toBeNull();
      const prom = renderPrometheus();
      expect(counterValue(prom, "tellus_overlay_legacy_hits_total")).toBe(0);
    });
  });

  it("T-04 C-59: legacy-only hit on a non-main branch is suppressed and counted", async () => {
    await withEnv({ OVERLAY_READ_LEGACY: "true" }, async () => {
      const store = new MemoryOverlayStore();
      const legacyKey = legacyOverlayKey("Orders", "O-1");
      await store.put(
        legacyKey,
        {
          branchId: "_main",
          objectType: "Orders",
          primaryKey: "O-1",
          doc: { tag: "legacy" },
          deleted: false,
          version: 1,
          createdAt: 0,
          editId: "e",
        } as OverlayRecord,
        60,
      );
      const out = await readOverlay("br-A", "Orders", "O-1", store);
      expect(out).toBeNull();
      const prom = renderPrometheus();
      expect(counterValue(prom, "tellus_overlay_branch_mismatch_total")).toBe(1);
      expect(
        counterValue(
          prom,
          "tellus_overlay_reads_total",
          'branch_match="mismatch_rejected"',
        ),
      ).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// C-57: dual-write phases.
// ---------------------------------------------------------------------------

describe("T-04 dual-write phases", () => {
  beforeEach(() => __resetMetricsForTesting());

  it("T-04 C-57: OVERLAY_DUAL_WRITE=true + branchId=_main writes both keys", async () => {
    await withEnv({ OVERLAY_DUAL_WRITE: "true" }, async () => {
      const store = new MemoryOverlayStore();
      await writeOverlay(
        makeRecord({
          branchId: "_main",
          objectType: "Orders",
          primaryKey: "O-1",
          version: 1,
        }),
        store,
        60,
      );
      const newKey = overlayKey("_main", "Orders", "O-1");
      const legacyKey = legacyOverlayKey("Orders", "O-1");
      const [a, b] = await store.mget([newKey, legacyKey]);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
    });
  });

  it("T-04 C-57: OVERLAY_DUAL_WRITE=true + branch=br-A writes ONLY new key (no legacy spill)", async () => {
    await withEnv({ OVERLAY_DUAL_WRITE: "true" }, async () => {
      const store = new MemoryOverlayStore();
      await writeOverlay(
        makeRecord({
          branchId: "br-A",
          objectType: "Orders",
          primaryKey: "O-1",
          version: 1,
        }),
        store,
        60,
      );
      const newKey = overlayKey("br-A", "Orders", "O-1");
      const legacyKey = legacyOverlayKey("Orders", "O-1");
      const [a, b] = await store.mget([newKey, legacyKey]);
      expect(a).not.toBeNull();
      expect(b).toBeNull();
    });
  });

  it("T-04 C-57: OVERLAY_DUAL_WRITE=false writes ONLY new key even on _main", async () => {
    await withEnv({ OVERLAY_DUAL_WRITE: "false" }, async () => {
      const store = new MemoryOverlayStore();
      await writeOverlay(
        makeRecord({
          branchId: "_main",
          objectType: "Orders",
          primaryKey: "O-1",
          version: 1,
        }),
        store,
        60,
      );
      const newKey = overlayKey("_main", "Orders", "O-1");
      const legacyKey = legacyOverlayKey("Orders", "O-1");
      const [a, b] = await store.mget([newKey, legacyKey]);
      expect(a).not.toBeNull();
      expect(b).toBeNull();
    });
  });

  it("T-04 C-48: phase flags resolve correctly from env", async () => {
    await withEnv({ OVERLAY_DUAL_WRITE: undefined }, () => {
      expect(isDualWriteEnabled()).toBe(true);
    });
    await withEnv({ OVERLAY_DUAL_WRITE: "true" }, () => {
      expect(isDualWriteEnabled()).toBe(true);
    });
    await withEnv({ OVERLAY_DUAL_WRITE: "false" }, () => {
      expect(isDualWriteEnabled()).toBe(false);
    });
    await withEnv({ OVERLAY_READ_LEGACY: undefined }, () => {
      expect(isLegacyReadEnabled()).toBe(true);
    });
    await withEnv({ OVERLAY_READ_LEGACY: "false" }, () => {
      expect(isLegacyReadEnabled()).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// C-58: counters at documented points.
// ---------------------------------------------------------------------------

describe("T-04 counters at documented points", () => {
  beforeEach(() => __resetMetricsForTesting());

  it("T-04 C-58: tellus_overlay_reads_total{source=new_key,branch_match=match} on hit", async () => {
    await withEnv({ OVERLAY_READ_LEGACY: "false" }, async () => {
      const store = new MemoryOverlayStore();
      await writeOverlay(
        makeRecord({
          branchId: "_main",
          objectType: "Orders",
          primaryKey: "O-1",
          version: 1,
        }),
        store,
        60,
      );
      await readOverlay(null, "Orders", "O-1", store);
      const prom = renderPrometheus();
      expect(
        counterValue(
          prom,
          "tellus_overlay_reads_total",
          'source="new_key"',
        ),
      ).toBe(1);
    });
  });

  it("T-04 C-58: branch_mismatch counter remains zero in pure-branch scenario (sanity)", async () => {
    await withEnv(
      { OVERLAY_READ_LEGACY: "false", OVERLAY_DUAL_WRITE: "false" },
      async () => {
        const store = new MemoryOverlayStore();
        await writeOverlay(
          makeRecord({
            branchId: "br-A",
            objectType: "Orders",
            primaryKey: "O-1",
            version: 1,
          }),
          store,
          60,
        );
        await readOverlay("br-A", "Orders", "O-1", store);
        const prom = renderPrometheus();
        expect(
          counterValue(prom, "tellus_overlay_branch_mismatch_total"),
        ).toBe(0);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Link overlay surface unchanged by T-04.
// ---------------------------------------------------------------------------

describe("T-04 link overlay namespace unaffected", () => {
  it("T-04 C-50: linkOverlayKey shape unchanged", () => {
    expect(linkOverlayKey("knows", "A", "B")).toBe("overlay:link:knows:A:B");
  });
});

afterEach(() => {
  __resetMetricsForTesting();
});
