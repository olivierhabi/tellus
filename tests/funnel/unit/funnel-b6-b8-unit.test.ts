// ---------------------------------------------------------------------------
// Unit tests for the B6 Quickwit Indexing stage, B7 Writeback Overlay, and
// B8 Hydration activity.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  buildFieldMapping,
  buildIndexConfig,
  getQuickwitIndexId,
} from "../../../src/services/quickwit/docMapping";
import {
  buildQuickwitDoc,
  buildQuickwitNdjson,
} from "../../../src/services/quickwit/docBuilder";
import { runIndexingActivity } from "../../../src/services/quickwit/indexingActivity";
import {
  runHydrationActivity,
} from "../../../src/services/quickwit/hydrationActivity";
import {
  groupBySearcher,
  planPlacement,
  routeSplit,
} from "../../../src/services/quickwit/searcherTopology";
import {
  __resetSearcherPoolsForTesting,
  setPools,
  promoteSecondary,
  getPrimaryPool,
  getSecondaryPool,
} from "../../../src/services/quickwit/searcherPool";
import {
  QuickwitClient,
  resetQuickwitClientForTesting,
} from "../../../src/services/quickwit/client";

import { MemoryOverlayStore } from "../../../src/services/overlay/memoryStore";
import {
  applyOverlayToResults,
  collectFilterMatchingOverlays,
  mergeOverlayIntoSearch,
  writeOverlayForEdit,
} from "../../../src/services/overlay/writebackOverlay";
import { setOverlayStoreForTesting } from "../../../src/services/overlay/getOverlayStore";
import {
  __resetOverlaySlisForTesting,
  getOverlaySloSnapshot,
  recordIndexApplied,
  recordOverlayWrite,
} from "../../../src/services/overlay/slis";
import { sweepOnce } from "../../../src/services/overlay/sweeper";
import { overlayKey } from "../../../src/services/overlay/overlayStore";

// ---------------------------------------------------------------------------
// B6 — Doc mapping + index config
// ---------------------------------------------------------------------------

describe("B6 doc mapping", () => {
  it("maps searchable=true to fast=false indexed=true stored=true", () => {
    const field = buildFieldMapping({
      api_name: "title",
      base_type: "string",
      searchable: true,
      sortable: false,
      filterable: false,
    });
    expect(field.type).toBe("text");
    expect(field.fast).toBe(false);
    expect(field.indexed).toBe(true);
    expect(field.stored).toBe(true);
    expect(field.tokenizer).toBe("default");
  });

  it("maps sortable=true to fast=true", () => {
    const field = buildFieldMapping({
      api_name: "priority",
      base_type: "integer",
      sortable: true,
      searchable: false,
      filterable: false,
    });
    expect(field.fast).toBe(true);
    expect(field.type).toBe("i64");
  });

  it("maps filterable=true to indexed=true", () => {
    const field = buildFieldMapping({
      api_name: "status",
      base_type: "string",
      filterable: true,
      sortable: false,
      searchable: false,
    });
    expect(field.indexed).toBe(true);
  });

  it("turning off searchable removes full-text indexing for a text field", () => {
    const off = buildFieldMapping({
      api_name: "notes",
      base_type: "string",
      searchable: false,
      filterable: false,
      sortable: false,
    });
    expect(off.stored).toBe(false);
    expect(off.indexed).toBe(false);
  });

  it("maps property types per B6 contract", () => {
    const cases: Array<[string, string]> = [
      ["string", "text"],
      ["integer", "i64"],
      ["long", "i64"],
      ["double", "f64"],
      ["float", "f64"],
      ["boolean", "bool"],
      ["date", "datetime"],
      ["timestamp", "datetime"],
      ["geopoint", "LatLng"],
    ];
    for (const [base, target] of cases) {
      expect(
        buildFieldMapping({ api_name: "x", base_type: base }).type
      ).toBe(target);
    }
  });

  it("throws on unsupported base type", () => {
    expect(() =>
      buildFieldMapping({ api_name: "x", base_type: "blob" } as never)
    ).toThrow(/Unsupported base_type/);
  });

  it("index id follows ot_<lowercased api_name> convention", () => {
    expect(getQuickwitIndexId("Orders")).toBe("ot_orders");
    expect(getQuickwitIndexId("Flight-Schedule")).toBe("ot_flight-schedule");
    expect(getQuickwitIndexId("User.Preferences")).toBe("ot_user-preferences");
  });

  it("buildIndexConfig sets commit_timeout_secs=60 by default", () => {
    const cfg = buildIndexConfig({
      objectTypeApiName: "Orders",
      primaryKeyApiName: "orderId",
      properties: [
        { api_name: "orderId", base_type: "string", searchable: false, filterable: true, sortable: true },
        { api_name: "total", base_type: "double", sortable: true, filterable: true },
      ],
    });
    expect(cfg.indexing_settings.commit_timeout_secs).toBe(60);
    expect(cfg.index_id).toBe("ot_orders");
    expect(cfg.doc_mapping.mode).toBe("strict");
    // System fields must appear
    const names = cfg.doc_mapping.field_mappings.map((f) => f.name);
    expect(names).toContain("__pk");
    expect(names).toContain("__deleted");
    expect(names).toContain("__version");
  });
});

// ---------------------------------------------------------------------------
// B6 — Doc builder
// ---------------------------------------------------------------------------

describe("B6 doc builder", () => {
  it("emits user properties for INSERT/UPDATE", () => {
    const doc = buildQuickwitDoc({
      objectTypeApiName: "Orders",
      primaryKeyApiName: "orderId",
      row: {
        primary_key: "O-1",
        properties: { total: 99.5, status: "open" },
        operation: "UPDATE",
        version: 3,
      },
    });
    expect(doc.__pk).toBe("O-1");
    expect(doc.__version).toBe(3);
    expect(doc.__deleted).toBe(false);
    expect(doc.total).toBe(99.5);
    expect(doc.status).toBe("open");
    expect(doc.orderId).toBe("O-1");
  });

  it("drops property payload for DELETE tombstones", () => {
    const doc = buildQuickwitDoc({
      objectTypeApiName: "Orders",
      primaryKeyApiName: "orderId",
      row: {
        primary_key: "O-2",
        properties: { total: 1 },
        operation: "DELETE",
        version: 5,
      },
    });
    expect(doc.__deleted).toBe(true);
    expect(doc.total).toBeUndefined();
    expect(doc.__pk).toBe("O-2");
  });

  it("serializes a batch as NDJSON", () => {
    const ndjson = buildQuickwitNdjson(
      [
        {
          primary_key: "A",
          properties: { name: "x" },
          operation: "INSERT",
          version: 1,
        },
        {
          primary_key: "B",
          properties: {},
          operation: "DELETE",
          version: 2,
        },
      ],
      { objectTypeApiName: "T", primaryKeyApiName: "id" }
    );
    const lines = ndjson.split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).__pk).toBe("A");
    expect(JSON.parse(lines[1]).__deleted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B6 — Quickwit client
// ---------------------------------------------------------------------------

describe("B6 Quickwit client (stubbed)", () => {
  beforeEach(() => {
    resetQuickwitClientForTesting();
  });

  it("retries transient 503s and surfaces the final 500 body", async () => {
    let calls = 0;
    const fakeFetch = vi.fn(async () => {
      calls++;
      return new Response("boom", { status: 500 });
    });
    const client = new QuickwitClient({
      baseUrl: "http://unused",
      fetchImpl: fakeFetch as unknown as typeof fetch,
      maxRetries: 2,
      timeoutMs: 1000,
    });
    await expect(client.health()).resolves.toMatchObject({ reachable: false });
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("createKafkaSource posts to the correct path and body", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(String(init.body), { status: 200 });
    });
    const client = new QuickwitClient({
      baseUrl: "http://qw",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await client.createKafkaSource("ot_orders", "ot_orders-kafka", "merged.orders", ["k1:9092"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://qw/api/v1/indexes/ot_orders/sources");
    expect(calls[0].body).toMatchObject({
      source_type: "kafka",
      params: { topic: "merged.orders", client_params: { "bootstrap.servers": "k1:9092" } },
    });
  });

  it("returns null from describeIndex on 404", async () => {
    const fakeFetch = vi.fn(async () => new Response("missing", { status: 404 }));
    const client = new QuickwitClient({
      baseUrl: "http://qw",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect(await client.describeIndex("nope")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// B6 — Indexing activity
// ---------------------------------------------------------------------------

describe("B6 indexing activity", () => {
  beforeEach(() => {
    resetQuickwitClientForTesting();
  });

  it("streams merged rows, waits for publish, returns stats", async () => {
    const published: Array<{ topic: string; key: string; doc: Record<string, unknown> }> = [];
    const publishDoc = vi.fn(async (topic: string, key: string, doc: Record<string, unknown>) => {
      published.push({ topic, key, doc });
      return published.length; // monotonically increasing offset
    });

    // Fake client that reports a published split after one poll.
    let listCalls = 0;
    const fakeFetch = vi.fn(async () => {
      listCalls++;
      return new Response(
        JSON.stringify({
          splits: [
            {
              split_id: "split-1",
              index_id: "ot_orders",
              num_docs: 2,
              uncompressed_docs_size_bytes: 100,
              split_state: "Published",
              publish_timestamp: 999_999_999,
            },
          ],
        }),
        { status: 200 }
      );
    });
    const client = new QuickwitClient({
      baseUrl: "http://qw",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });

    const result = await runIndexingActivity({
      ontologyId: "ont-1",
      objectTypeApiName: "Orders",
      primaryKeyApiName: "orderId",
      reader: async function* () {
        yield {
          rows: [
            { primary_key: "O-1", properties: { total: 9 }, operation: "INSERT", version: 1 },
            { primary_key: "O-2", properties: {}, operation: "DELETE", version: 1 },
          ],
          editIds: [],
          kafkaOffsetHigh: 2,
        };
      } as never,
      publishPollMs: 1,
      publishTimeoutMs: 500,
      client,
      publishDoc,
    });

    expect(result.rowsStreamed).toBe(2);
    expect(result.indexId).toBe("ot_orders");
    expect(result.publishedSplitIds).toContain("split-1");
    expect(published.map((p) => p.key)).toEqual(["O-1", "O-2"]);
    // The delete row must emit a tombstone doc.
    expect(published[1].doc.__deleted).toBe(true);
    // Must have polled split metadata at least once.
    expect(listCalls).toBeGreaterThanOrEqual(1);
  });

  it("times out gracefully when no splits publish", async () => {
    const client = new QuickwitClient({
      baseUrl: "http://qw",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ splits: [] }), { status: 200 })) as never,
    });
    const result = await runIndexingActivity({
      ontologyId: "o",
      objectTypeApiName: "X",
      primaryKeyApiName: "id",
      reader: async function* () {
        yield {
          rows: [{ primary_key: "A", properties: {}, operation: "INSERT", version: 1 }],
          editIds: [],
          kafkaOffsetHigh: 42,
        };
      } as never,
      publishPollMs: 1,
      publishTimeoutMs: 50, // short so the test is fast
      client,
      publishDoc: async () => 42,
    });
    expect(result.publishedSplitIds).toEqual([]);
    expect(result.rowsStreamed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// B7 — Overlay store + writeback
// ---------------------------------------------------------------------------

describe("B7 overlay store", () => {
  let store: MemoryOverlayStore;
  beforeEach(() => {
    store = new MemoryOverlayStore();
    setOverlayStoreForTesting(store);
    __resetOverlaySlisForTesting();
  });

  it("mget returns null for missing keys", async () => {
    const got = await store.mget(["overlay:X:1"]);
    expect(got).toEqual([null]);
  });

  it("TTL evicts entries after expiry", async () => {
    let now = 1000;
    const ttlStore = new MemoryOverlayStore(() => now);
    await ttlStore.put(
      "overlay:X:1",
      {
        objectType: "X",
        primaryKey: "1",
        doc: {},
        deleted: false,
        version: 1,
        createdAt: 1000,
        editId: "e1",
      },
      1
    );
    now = 2001;
    const [res] = await ttlStore.mget(["overlay:X:1"]);
    expect(res).toBeNull();
  });

  it("scan returns live overlays for a given object type", async () => {
    await store.put(
      "overlay:Orders:O-1",
      {
        branchId: "_main",
        objectType: "Orders",
        primaryKey: "O-1",
        doc: { status: "open" },
        deleted: false,
        version: 1,
        createdAt: Date.now(),
        editId: "e",
      },
      60
    );
    await store.put(
      "overlay:Customers:C-1",
      {
        branchId: "_main",
        objectType: "Customers",
        primaryKey: "C-1",
        doc: {},
        deleted: false,
        version: 1,
        createdAt: Date.now(),
        editId: "e2",
      },
      60
    );
    const result = await store.scan("Orders");
    expect(result.map((r) => r.primaryKey)).toEqual(["O-1"]);
  });
});

describe("B7 overlay query merge", () => {
  beforeEach(() => {
    setOverlayStoreForTesting(new MemoryOverlayStore());
    __resetOverlaySlisForTesting();
  });

  it("replaces Quickwit hit with overlay doc when overlay is newer", async () => {
    const store = new MemoryOverlayStore();
    await store.put(
      overlayKey(null, "Orders", "O-1"),
      {
        branchId: "_main",
        objectType: "Orders",
        primaryKey: "O-1",
        doc: { status: "paid", total: 100 },
        deleted: false,
        version: 5,
        createdAt: Date.now(),
        editId: "e",
      },
      60
    );
    const hits = [
      { __pk: "O-1", __version: 4, status: "open", total: 100 },
      { __pk: "O-2", __version: 1, status: "open" },
    ];
    const merged = await applyOverlayToResults("Orders", hits, store);
    expect(merged).toHaveLength(2);
    expect(merged[0].status).toBe("paid");
    expect(merged[0].__overlay_source).toBe("writeback");
    expect(merged[1].status).toBe("open");
  });

  it("drops rows whose overlay is a delete tombstone", async () => {
    const store = new MemoryOverlayStore();
    await store.put(
      overlayKey(null, "Orders", "O-1"),
      {
        branchId: "_main",
        objectType: "Orders",
        primaryKey: "O-1",
        doc: {},
        deleted: true,
        version: 2,
        createdAt: Date.now(),
        editId: "e",
      },
      60
    );
    const merged = await applyOverlayToResults("Orders", [{ __pk: "O-1" }], store);
    expect(merged).toEqual([]);
  });

  it("yields overlay to index when indexed __version is strictly newer", async () => {
    const store = new MemoryOverlayStore();
    await store.put(
      overlayKey(null, "Orders", "O-1"),
      {
        branchId: "_main",
        objectType: "Orders",
        primaryKey: "O-1",
        doc: { status: "old" },
        deleted: false,
        version: 2,
        createdAt: Date.now(),
        editId: "e",
      },
      60
    );
    const merged = await applyOverlayToResults(
      "Orders",
      [{ __pk: "O-1", __version: 3, status: "fresh-from-index" }],
      store
    );
    expect(merged[0].status).toBe("fresh-from-index");
  });

  it("collectFilterMatchingOverlays returns matches for not-yet-indexed edits", async () => {
    const store = new MemoryOverlayStore();
    await store.put(
      overlayKey(null, "Orders", "O-new"),
      {
        branchId: "_main",
        objectType: "Orders",
        primaryKey: "O-new",
        doc: { status: "open", total: 50 },
        deleted: false,
        version: 1,
        createdAt: Date.now(),
        editId: "e",
      },
      60
    );
    const matches = await collectFilterMatchingOverlays(
      "Orders",
      (d) => d.status === "open",
      store
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].__pk).toBe("O-new");
  });

  it("mergeOverlayIntoSearch dedupes by PK", async () => {
    const store = new MemoryOverlayStore();
    await store.put(
      overlayKey(null, "Orders", "O-1"),
      {
        branchId: "_main",
        objectType: "Orders",
        primaryKey: "O-1",
        doc: { status: "paid" },
        deleted: false,
        version: 2,
        createdAt: Date.now(),
        editId: "e1",
      },
      60
    );
    const out = await mergeOverlayIntoSearch({
      objectType: "Orders",
      hits: [{ __pk: "O-1", __version: 1, status: "open" }],
      filter: () => true,
      store,
    });
    const pks = out.map((r) => r.__pk);
    expect(new Set(pks).size).toBe(pks.length);
  });
});

describe("B7 overlay SLI", () => {
  beforeEach(() => {
    __resetOverlaySlisForTesting();
    setOverlayStoreForTesting(new MemoryOverlayStore());
  });

  it("tracks lag and flags alerting when p99 > 60s", () => {
    const now = 1_000_000;
    for (let i = 0; i < 100; i++) recordOverlayWrite(`e${i}`, now);
    for (let i = 0; i < 90; i++) recordIndexApplied(`e${i}`, now + 100);
    for (let i = 90; i < 100; i++) recordIndexApplied(`e${i}`, now + 80_000);
    const snap = getOverlaySloSnapshot();
    expect(snap.resolved).toBe(100);
    expect(snap.p99Ms).toBeGreaterThanOrEqual(60_000);
    expect(snap.alerting).toBe(true);
  });
});

describe("B7 overlay sweeper", () => {
  beforeEach(() => {
    setOverlayStoreForTesting(new MemoryOverlayStore());
    __resetOverlaySlisForTesting();
  });

  it("sweeps overlays whose edit has been applied to the index", async () => {
    const store = new MemoryOverlayStore();
    setOverlayStoreForTesting(store);

    // Simulate one still-pending and one already-indexed edit.
    await store.put(
      overlayKey(null, "Orders", "O-a"),
      {
        branchId: "_main",
        objectType: "Orders",
        primaryKey: "O-a",
        doc: {},
        deleted: false,
        version: 1,
        createdAt: 1000,
        editId: "00000000-0000-0000-0000-0000000000aa",
      },
      60
    );
    await store.put(
      overlayKey(null, "Orders", "O-b"),
      {
        branchId: "_main",
        objectType: "Orders",
        primaryKey: "O-b",
        doc: {},
        deleted: false,
        version: 1,
        createdAt: 500, // indexed at 1000 > createdAt ⇒ sweep
        editId: "00000000-0000-0000-0000-0000000000bb",
      },
      60
    );

    // Swap sweeper's DB helpers: we can't hit Postgres here, so monkey-patch
    // the overlay store's `scan` to return the seeded overlays and inject
    // an in-memory applied-map via a fake `query`.
    const dbMod = await import("../../../src/db");
    const originalQuery = dbMod.query;
    vi.spyOn(dbMod, "query").mockImplementation(async (sql: string) => {
      if (/FROM object_type/i.test(sql)) {
        return { rows: [{ api_name: "Orders" }], rowCount: 1 } as never;
      }
      if (/FROM ontology_edit|FROM object_edits/i.test(sql)) {
        return {
          rows: [
            {
              edit_id: "00000000-0000-0000-0000-0000000000bb",
              applied_to_index_at: new Date(1000).toISOString(),
            },
          ],
          rowCount: 1,
        } as never;
      }
      return originalQuery(sql);
    });

    const result = await sweepOnce({ store });
    expect(result.overlayKeysDeleted).toBe(1);
    expect(await store.size()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// B7 — writeOverlayForEdit (transaction-bound, uses a fake PoolClient)
// ---------------------------------------------------------------------------

describe("B7 writeOverlayForEdit", () => {
  beforeEach(() => {
    setOverlayStoreForTesting(new MemoryOverlayStore());
    __resetOverlaySlisForTesting();
  });

  it("writes overlay + records SLI even when object_instances table is absent", async () => {
    const store = new MemoryOverlayStore();
    setOverlayStoreForTesting(store);

    // Fake PoolClient that throws the specific "missing relation" error
    // for the object_instances INSERT but succeeds on savepoint bookkeeping
    // — the source now wraps the risky INSERT in a SAVEPOINT so a missing
    // B1 table in transitional deployments doesn't poison the outer txn.
    const fakeClient = {
      query: vi.fn(async (sql: string) => {
        const text = typeof sql === "string" ? sql : "";
        if (/^\s*(SAVEPOINT|ROLLBACK TO SAVEPOINT|RELEASE SAVEPOINT)\b/i.test(text)) {
          return { rowCount: 0, rows: [] };
        }
        throw new Error("relation \"object_instances\" does not exist");
      }),
    };
    const result = await writeOverlayForEdit(fakeClient as never, {
      ontologyId: "ont-1",
      objectType: "Orders",
      primaryKey: "O-1",
      doc: { status: "open" },
      deleted: false,
      version: 1,
      editId: "e-1",
    });
    expect(result.wroteOverlay).toBe(true);
    expect(result.upsertedInstance).toBe(false);
    const [rec] = await store.mget([overlayKey(null, "Orders", "O-1")]);
    expect(rec?.doc.status).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// B8 — Searcher topology + pool
// ---------------------------------------------------------------------------

describe("B8 searcher topology", () => {
  beforeEach(() => {
    __resetSearcherPoolsForTesting();
  });

  it("routeSplit picks the same searcher for the same splitId across runs", () => {
    const searchers = [
      { id: "s1" },
      { id: "s2" },
      { id: "s3" },
      { id: "s4" },
    ];
    const first = routeSplit("split-abc", searchers);
    const second = routeSplit("split-abc", searchers);
    expect(first?.id).toBe(second?.id);
  });

  it("adding one node remaps only ~1/n splits (HRW minimal disruption)", () => {
    const before = [
      { id: "s1" },
      { id: "s2" },
      { id: "s3" },
    ];
    const after = [...before, { id: "s4" }];
    const N = 1000;
    let moved = 0;
    for (let i = 0; i < N; i++) {
      const a = routeSplit(`split-${i}`, before)!.id;
      const b = routeSplit(`split-${i}`, after)!.id;
      if (a !== b) moved++;
    }
    // Expect ~25% (1/n = 1/4). Allow a healthy band.
    expect(moved).toBeGreaterThan(N * 0.1);
    expect(moved).toBeLessThan(N * 0.4);
  });

  it("planPlacement + groupBySearcher distributes splits across searchers", () => {
    const searchers = [{ id: "s1" }, { id: "s2" }, { id: "s3" }];
    const splits = Array.from({ length: 20 }, (_, i) => `split-${i}`);
    const placements = planPlacement(splits, searchers);
    expect(placements).toHaveLength(20);
    const groups = groupBySearcher(placements);
    // Every searcher should have at least one split with 20 inputs and 3 nodes.
    expect(groups.size).toBeGreaterThan(1);
  });
});

describe("B8 searcher pool", () => {
  beforeEach(() => {
    __resetSearcherPoolsForTesting();
  });

  it("promoteSecondary swaps primary and secondary pools", () => {
    setPools({
      primary: [{ id: "live-1", role: "primary" }],
      secondary: [{ id: "warm-1", role: "secondary" }],
    });
    const { promoted, demoted } = promoteSecondary();
    expect(promoted[0].id).toBe("warm-1");
    expect(demoted[0].id).toBe("live-1");
    expect(getPrimaryPool()[0].id).toBe("warm-1");
    expect(getSecondaryPool()[0].id).toBe("live-1");
  });
});

// ---------------------------------------------------------------------------
// B8 — Hydration activity
// ---------------------------------------------------------------------------

describe("B8 hydration activity", () => {
  beforeEach(() => {
    __resetSearcherPoolsForTesting();
    resetQuickwitClientForTesting();
  });

  it("prefetches each split on the searcher that will own it", async () => {
    const prefetchCalls: Array<{ index_id: string; split_ids: string[] }> = [];
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/api/v1/searcher/split-cache/prefetch")) {
        prefetchCalls.push(JSON.parse(String(init.body)));
        return new Response("{}", { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    const client = new QuickwitClient({
      baseUrl: "http://qw",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });

    setPools({
      primary: [
        { id: "s1", role: "primary" },
        { id: "s2", role: "primary" },
      ],
    });

    const result = await runHydrationActivity({
      objectTypeApiName: "Orders",
      splitIds: ["split-1", "split-2", "split-3"],
      client,
    });
    expect(result.prefetchedSplitCount).toBe(3);
    expect(result.perSearcherPlan.length).toBeGreaterThanOrEqual(1);
    // Every prefetch call targets ot_orders.
    for (const c of prefetchCalls) {
      expect(c.index_id).toBe("ot_orders");
    }
    // Total splits prefetched across all calls = 3
    const totalSplits = prefetchCalls.reduce((acc, c) => acc + c.split_ids.length, 0);
    expect(totalSplits).toBe(3);
  });

  it("returns a no-op result when no searchers are registered", async () => {
    const result = await runHydrationActivity({
      objectTypeApiName: "Orders",
      splitIds: ["split-1"],
      client: new QuickwitClient({
        baseUrl: "http://qw",
        fetchImpl: (async () => new Response("{}", { status: 200 })) as never,
      }),
    });
    expect(result.prefetchedSplitCount).toBe(0);
    expect(result.promoted).toBe(false);
  });

  it("auto-promote swaps pools when mode=replacement and autoPromote=true", async () => {
    setPools({
      primary: [{ id: "live", role: "primary" }],
      secondary: [{ id: "warm", role: "secondary" }],
    });
    const result = await runHydrationActivity({
      objectTypeApiName: "Orders",
      splitIds: ["split-1"],
      mode: "replacement",
      autoPromote: true,
      client: new QuickwitClient({
        baseUrl: "http://qw",
        fetchImpl: (async () => new Response("{}", { status: 200 })) as never,
      }),
    });
    expect(result.promoted).toBe(true);
    expect(getPrimaryPool()[0].id).toBe("warm");
  });
});
