// ---------------------------------------------------------------------------
// Unit tests for B9 Replacement Pipeline and B10 Search Arounds.
// ---------------------------------------------------------------------------

process.env.KAFKA_ENABLED = "false";

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  diffPropertyBag,
  shouldTriggerReplacementForVolume,
  AUTO_TRIGGER_THRESHOLD,
} from "../../../src/services/quickwit/replacement/schemaChangeDetector";
import {
  indexIdForVersion,
} from "../../../src/services/quickwit/replacement/versionManager";
import {
  diffResultSets,
} from "../../../src/services/quickwit/replacement/shadowDiff";

import {
  linkTableName,
  kafkaIngestDdl,
} from "../../../src/services/searchAround/linkMaterializedView";
import {
  buildTraversalSql,
  DEFAULT_CAP,
  ADMIN_MAX_CAP,
} from "../../../src/services/searchAround/clickhouseTraversal";
import { traverse } from "../../../src/services/searchAround/searchAroundService";
import { userSees } from "../../../src/services/searchAround/markingFilter";
import { CDC_LAG_ALERT_SECONDS, readCdcLag } from "../../../src/services/searchAround/cdcLag";
import {
  ClickHouseClient,
  resetClickHouseClientForTesting,
} from "../../../src/services/searchAround/clickhouseClient";
import {
  QuickwitClient,
  resetQuickwitClientForTesting,
} from "../../../src/services/quickwit/client";
import { runDualIndexingActivity } from "../../../src/services/quickwit/replacement/dualIndexingActivity";

// ---------------------------------------------------------------------------
// B9 — Schema change detector
// ---------------------------------------------------------------------------

describe("B9 schema change detector", () => {
  const prop = (api_name: string, base_type = "string", flags: Partial<{ searchable: boolean; sortable: boolean; filterable: boolean }> = {}) => ({
    api_name,
    base_type,
    is_array: false,
    is_required: false,
    searchable: flags.searchable,
    sortable: flags.sortable,
    filterable: flags.filterable,
  });

  it("flags a new property as replacement-required", () => {
    const before = [prop("id"), prop("status")];
    const after = [...before, prop("priority", "integer", { sortable: true })];
    const diff = diffPropertyBag(before, after);
    expect(diff.replacementRequired).toBe(true);
    expect(diff.changes[0].kind).toBe("property_added");
  });

  it("flags property-type change as replacement-required", () => {
    const before = [prop("quantity", "integer")];
    const after = [prop("quantity", "long")];
    const diff = diffPropertyBag(before, after);
    expect(diff.replacementRequired).toBe(true);
    expect(diff.changes[0].kind).toBe("property_retyped");
  });

  it("flags flag-only change as replacement-required (conservative default)", () => {
    const before = [prop("name", "string", { searchable: true })];
    const after = [prop("name", "string", { searchable: false, filterable: true })];
    const diff = diffPropertyBag(before, after);
    expect(diff.replacementRequired).toBe(true);
    expect(diff.changes[0].kind).toBe("property_flags_changed");
  });

  it("no-change produces empty diff and replacement=false", () => {
    const bag = [prop("id"), prop("status")];
    const diff = diffPropertyBag(bag, bag);
    expect(diff.replacementRequired).toBe(false);
    expect(diff.changes).toHaveLength(0);
  });

  it("volume-trigger fires at 80.1%", () => {
    const v = shouldTriggerReplacementForVolume({ rowsChanged: 801, totalRows: 1000 });
    expect(v.shouldTrigger).toBe(true);
    expect(v.ratio).toBeCloseTo(0.801);
    expect(AUTO_TRIGGER_THRESHOLD).toBe(0.8);
  });

  it("volume-trigger stays quiet at exactly the threshold", () => {
    const v = shouldTriggerReplacementForVolume({ rowsChanged: 800, totalRows: 1000 });
    expect(v.shouldTrigger).toBe(false);
  });

  it("volume-trigger declines to fire with totalRows=0", () => {
    const v = shouldTriggerReplacementForVolume({ rowsChanged: 10, totalRows: 0 });
    expect(v.shouldTrigger).toBe(false);
    expect(v.reason).toContain("no baseline");
  });
});

// ---------------------------------------------------------------------------
// B9 — Version-id convention
// ---------------------------------------------------------------------------

describe("B9 index id convention", () => {
  it("version 1 preserves the legacy ot_<name> name", () => {
    expect(indexIdForVersion("Orders", 1)).toBe("ot_orders");
  });
  it("version ≥ 2 appends __v<N>", () => {
    expect(indexIdForVersion("Orders", 2)).toBe("ot_orders__v2");
    expect(indexIdForVersion("Flight-Schedule", 5)).toBe("ot_flight-schedule__v5");
  });
});

// ---------------------------------------------------------------------------
// B9 — Shadow-query diff
// ---------------------------------------------------------------------------

describe("B9 shadow diff", () => {
  it("reports zero diffs for identical result sets", () => {
    const hits = [
      { __pk: "A", status: "open" },
      { __pk: "B", status: "closed" },
    ];
    const { diffCount, totalHits } = diffResultSets({
      objectTypeApiName: "Orders",
      oldVersion: 1,
      newVersion: 2,
      queryBody: {},
      oldHits: hits,
      newHits: hits,
    });
    expect(diffCount).toBe(0);
    expect(totalHits).toBe(2);
  });

  it("detects a single-row property drift", () => {
    const { diffCount } = diffResultSets({
      objectTypeApiName: "Orders",
      oldVersion: 1,
      newVersion: 2,
      queryBody: {},
      oldHits: [{ __pk: "A", status: "open" }],
      newHits: [{ __pk: "A", status: "closed" }],
    });
    expect(diffCount).toBe(1);
  });

  it("detects missing rows on either side", () => {
    const { diffCount, totalHits } = diffResultSets({
      objectTypeApiName: "Orders",
      oldVersion: 1,
      newVersion: 2,
      queryBody: {},
      oldHits: [{ __pk: "A" }, { __pk: "B" }],
      newHits: [{ __pk: "A" }],
    });
    expect(diffCount).toBe(1);
    expect(totalHits).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// B9 — Dual-index tee reader
// ---------------------------------------------------------------------------

describe("B9 dual-index tee", () => {
  beforeEach(() => {
    resetQuickwitClientForTesting();
  });

  it("fans out each merged batch to both primary and sibling in LIVE state (no dual-write)", async () => {
    // Stub versionManager.resolveWriteTargets via the Postgres path: make
    // dbQuery return a LIVE row with no pending. The real query executes
    // UPSERT + SELECT; since tests have no DB, we monkey-patch.
    vi.spyOn(await import("../../../src/db"), "query").mockImplementation(
      async (sql: string) => {
        if (/INSERT INTO object_type_active_index_version/i.test(sql)) {
          return { rows: [], rowCount: 0 } as never;
        }
        return {
          rows: [
            {
              object_type_api_name: "Orders",
              active_version: 1,
              pending_version: null,
              state: "LIVE",
              soak_days: 7,
              diff_rate_threshold: 0.001,
              backfill_started_at: null,
              soak_started_at: null,
              last_cutover_at: null,
              last_rollback_at: null,
              old_index_retained_until: null,
              updated_at: new Date().toISOString(),
            },
          ],
          rowCount: 1,
        } as never;
      }
    );

    const publishedPrimary: Array<{ key: string }> = [];
    const publishDoc = vi.fn(async (_topic: string, key: string) => {
      publishedPrimary.push({ key });
      return publishedPrimary.length;
    });

    const result = await runDualIndexingActivity({
      ontologyId: "o",
      objectTypeApiName: "Orders",
      primaryKeyApiName: "id",
      reader: async function* () {
        yield {
          rows: [
            { primary_key: "A", properties: {}, operation: "INSERT", version: 1 },
            { primary_key: "B", properties: {}, operation: "INSERT", version: 1 },
          ],
          editIds: [],
          kafkaOffsetHigh: 2,
        };
      } as never,
      publishPollMs: 1,
      publishTimeoutMs: 50,
      publishDoc,
      client: new QuickwitClient({
        baseUrl: "http://qw",
        fetchImpl: (async () =>
          new Response(JSON.stringify({ splits: [{ split_id: "s-1", split_state: "Published", publish_timestamp: 1, tags: ["kafka-offset:0:2147483647"] }] }), { status: 200 })) as never,
      }),
    });

    expect(result.dualWrite).toBe(false);
    expect(result.primary.rowsStreamed).toBe(2);
    expect(publishedPrimary.map((p) => p.key)).toEqual(["A", "B"]);
  });

  it("tees batches to both indices in REPLACEMENT_BACKFILL state", async () => {
    vi.spyOn(await import("../../../src/db"), "query").mockImplementation(
      async (sql: string) => {
        if (/INSERT INTO object_type_active_index_version/i.test(sql)) {
          return { rows: [], rowCount: 0 } as never;
        }
        return {
          rows: [
            {
              object_type_api_name: "Orders",
              active_version: 1,
              pending_version: 2,
              state: "REPLACEMENT_BACKFILL",
              soak_days: 7,
              diff_rate_threshold: 0.001,
              backfill_started_at: new Date().toISOString(),
              soak_started_at: null,
              last_cutover_at: null,
              last_rollback_at: null,
              old_index_retained_until: null,
              updated_at: new Date().toISOString(),
            },
          ],
          rowCount: 1,
        } as never;
      }
    );

    const primaryKeys: string[] = [];
    const primaryPublish = vi.fn(async (_topic: string, key: string) => {
      primaryKeys.push(key);
      return primaryKeys.length;
    });

    const result = await runDualIndexingActivity({
      ontologyId: "o",
      objectTypeApiName: "Orders",
      primaryKeyApiName: "id",
      reader: async function* () {
        yield {
          rows: [
            { primary_key: "A", properties: {}, operation: "INSERT", version: 1 },
            { primary_key: "B", properties: {}, operation: "INSERT", version: 1 },
          ],
          editIds: [],
          kafkaOffsetHigh: 2,
        };
      } as never,
      publishPollMs: 1,
      publishTimeoutMs: 50,
      publishDoc: primaryPublish,
      client: new QuickwitClient({
        baseUrl: "http://qw",
        fetchImpl: (async () =>
          new Response(JSON.stringify({ splits: [{ split_id: "s-1", split_state: "Published", publish_timestamp: 1, tags: ["kafka-offset:0:2147483647"] }] }), { status: 200 })) as never,
      }),
    });

    expect(result.dualWrite).toBe(true);
    expect(result.primary.rowsStreamed).toBe(2);
    // sibling publisher is the in-module mergedKafkaProducer; we can't see
    // its output directly without a Kafka stub, but the sibling activity
    // must have consumed the same batch (rowsStreamed mirrors batch count).
    expect(result.sibling?.rowsStreamed).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// B10 — Link table naming
// ---------------------------------------------------------------------------

describe("B10 link table naming", () => {
  it("uses link_<source>__<name>__<target> form with sanitized lowercase", () => {
    expect(
      linkTableName({ sourceObjectType: "Order", linkName: "customer", targetObjectType: "Customer" })
    ).toBe("link__order__customer__customer");
  });
  it("collapses non-alphanumerics to underscore", () => {
    expect(
      linkTableName({ sourceObjectType: "Order-Line", linkName: "has.child", targetObjectType: "Item" })
    ).toBe("link__order_line__has_child__item");
  });
  it("kafkaIngestDdl emits DDL for Kafka engine + materialized view", () => {
    const ddl = kafkaIngestDdl({
      sourceObjectType: "Order",
      linkName: "customer",
      targetObjectType: "Customer",
    });
    expect(ddl.kafkaTable).toBe("link__order__customer__customer__kafka");
    expect(ddl.mv).toBe("link__order__customer__customer__mv");
    expect(ddl.kafkaDdl).toMatch(/ENGINE = Kafka/);
    expect(ddl.mvDdl).toMatch(/CREATE MATERIALIZED VIEW/);
  });
});

// ---------------------------------------------------------------------------
// B10 — Marking filter
// ---------------------------------------------------------------------------

describe("B10 marking filter", () => {
  it("userSees is AND over row markings", () => {
    const user = new Set(["PII", "CONFIDENTIAL"]);
    expect(userSees(["PII"], user)).toBe(true);
    expect(userSees(["PII", "CONFIDENTIAL"], user)).toBe(true);
    expect(userSees(["PII", "SECRET"], user)).toBe(false);
    expect(userSees([], user)).toBe(true);
  });

  // F-P3-17: the post-filter helpers `filterByMarkings` and `filterLinkRows`
  // were dead-code removed. Only `userSees` remains, and is covered above.
});

// ---------------------------------------------------------------------------
// B10 — ClickHouse traversal SQL
// ---------------------------------------------------------------------------

describe("B10 clickhouse traversal SQL", () => {
  const hop = (src: string, name: string, tgt: string) => ({
    linkType: { sourceObjectType: src, linkName: name, targetObjectType: tgt },
  });
  const iso = { tenantId: "t-a", ontologyId: "ont-1", branchId: "main" };

  it("single-hop builds a SELECT DISTINCT over one link table", () => {
    const sql = buildTraversalSql({
      anchorPks: ["O-1", "O-2"],
      hops: [hop("Order", "customer", "Customer")],
      isolation: { tenantId: "t-a", ontologyId: "ont-1", branchId: "main" },
      userMarkings: new Set(["PII"]),
      isolation: iso,
      cap: 1000,
    });
    // Versioned latest-state: argMax projection per edge identity.
    expect(sql).toMatch(/FROM link__order__customer__customer/);
    expect(sql).toMatch(/argMax\(link_props, event_version\)/);
    expect(sql).toContain(") AS l1");
    expect(sql).toContain("l1.source_pk IN ['O-1','O-2']");
    expect(sql).toContain("l1.deleted = 0");
    // Isolation embedded in the subquery (tenant/ontology/branch).
    expect(sql).toContain("tenant_id = 't-a'");
    expect(sql).toContain("ontology_id = 'ont-1'");
    expect(sql).toContain("branch_id = 'main'");
    expect(sql).toContain("LIMIT 1000");
  });

  it("multi-hop JOINs link tables on target_pk → source_pk", () => {
    const sql = buildTraversalSql({
      anchorPks: ["O-1"],
      hops: [
        hop("Order", "customer", "Customer"),
        hop("Customer", "account", "Account"),
        hop("Account", "transaction", "Transaction"),
      ],
      isolation: { tenantId: "t-a", ontologyId: "ont-1", branchId: "main" },
      userMarkings: new Set(["PII", "FINANCE"]),
      isolation: iso,
      cap: 100,
    });
    expect(sql).toMatch(/INNER JOIN[\s\S]*FROM link__customer__account__account[\s\S]*\) AS l2 ON l1\.target_pk = l2\.source_pk/);
    expect(sql).toMatch(/INNER JOIN[\s\S]*FROM link__account__transaction__transaction[\s\S]*\) AS l3 ON l2\.target_pk = l3\.source_pk/);
    // 3 marking clauses + 3 argMax marking projections — 6 marking occurrences
    const markingCount = (sql.match(/arrayAll/g) ?? []).length;
    expect(markingCount).toBe(3);
    // Each hop enforces latest-state liveness.
    const stateClauses = (sql.match(/deleted = 0/g) ?? []).length;
    expect(stateClauses).toBe(3);
  });

  it("escapes single quotes in PK literals", () => {
    const sql = buildTraversalSql({
      anchorPks: ["O'1"],
      hops: [hop("Order", "customer", "Customer")],
      isolation: { tenantId: "t-a", ontologyId: "ont-1", branchId: "main" },
      userMarkings: new Set(),
      isolation: iso,
      cap: 10,
    });
    expect(sql).toContain("'O''1'");
  });
});

// ---------------------------------------------------------------------------
// B10 — Top-level traverse()
// ---------------------------------------------------------------------------

describe("B10 traverse() routing", () => {
  beforeEach(() => {
    resetQuickwitClientForTesting();
    resetClickHouseClientForTesting();
  });

  it("stays in Quickwit when each hop fits under the fast-path cap", async () => {
    const qwCalls: Array<{ url: string; body: unknown }> = [];
    const fakeQwFetch = vi.fn(async (url: string, init: RequestInit) => {
      // /search/stream is a GET that emits CSV — B10 now routes hops
      // through it for 3M+ rows/sec throughput.
      if (url.includes("/search/stream")) {
        qwCalls.push({ url, body: null });
        return new Response("C-1\nC-2\nC-3\n", { status: 200 });
      }
      if (url.includes("/search")) {
        qwCalls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(
          JSON.stringify({
            num_hits: 3,
            hits: [
              { target_pk: "C-1" },
              { target_pk: "C-2" },
              { target_pk: "C-3" },
            ],
            elapsed_time_micros: 0,
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 200 });
    });
    const quickwitClient = new QuickwitClient({
      baseUrl: "http://qw",
      fetchImpl: fakeQwFetch as unknown as typeof fetch,
    });
    const result = await traverse({
      anchorObjectType: "Order",
      anchorPks: ["O-1", "O-2"],
      hops: [
        { linkType: { sourceObjectType: "Order", linkName: "customer", targetObjectType: "Customer" } },
      ],
      isolation: { tenantId: "t-a", ontologyId: "ont-1", branchId: "main" },
      userMarkings: new Set(["PII"]),
      quickwitClient,
      endpointSecurityLookup: async () => ({
        markings: new Map([["C-1", []], ["C-2", []], ["C-3", []]]),
        error: false,
      }),
    });
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0].viaBackend).toBe("quickwit");
    expect(result.targetPks).toEqual(["C-1", "C-2", "C-3"]);
    expect(qwCalls).toHaveLength(1);
  });

  it("escalates to ClickHouse when start set exceeds the fast-path cap", async () => {
    const chCalls: Array<{ sql: string }> = [];
    const fakeChFetch = vi.fn(async (url: string, _init: RequestInit) => {
      const sql = new URL(url).searchParams.get("query") ?? "";
      chCalls.push({ sql });
      return new Response('{"pk":"T-1"}\n{"pk":"T-2"}\n', { status: 200 });
    });
    const clickhouseClient = new ClickHouseClient({
      baseUrl: "http://ch",
      fetchImpl: fakeChFetch as unknown as typeof fetch,
    });
    const bigAnchor = Array.from({ length: 101 }, (_, i) => `O-${i}`);
    const result = await traverse({
      anchorObjectType: "Order",
      anchorPks: bigAnchor,
      hops: [
        { linkType: { sourceObjectType: "Order", linkName: "customer", targetObjectType: "Customer" } },
      ],
      isolation: { tenantId: "t-a", ontologyId: "ont-1", branchId: "main" },
      userMarkings: new Set(["PII"]),
      maxQuickwitHopSize: 100, // force escalation
      clickhouseClient,
      endpointSecurityLookup: async () => ({
        markings: new Map([["T-1", []], ["T-2", []]]),
        error: false,
      }),
    });
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0].viaBackend).toBe("clickhouse");
    expect(result.targetPks).toEqual(["T-1", "T-2"]);
    expect(chCalls[0].sql).toMatch(/FROM link__order__customer__customer/);
  });

  it("caps at DEFAULT_CAP unless adminOverride is set", async () => {
    const fakeChFetch = vi.fn(async () =>
      new Response("", { status: 200 })
    );
    const clickhouseClient = new ClickHouseClient({
      baseUrl: "http://ch",
      fetchImpl: fakeChFetch as unknown as typeof fetch,
    });
    const result = await traverse({
      anchorObjectType: "Order",
      anchorPks: Array.from({ length: 101 }, (_, i) => `O-${i}`),
      hops: [
        { linkType: { sourceObjectType: "Order", linkName: "customer", targetObjectType: "Customer" } },
      ],
      isolation: { tenantId: "t-a", ontologyId: "ont-1", branchId: "main" },
      userMarkings: new Set(),
      maxRows: 500_000, // > DEFAULT_CAP, no admin override
      maxQuickwitHopSize: 100,
      clickhouseClient,
    });
    expect(result.warnings.some((w) => w.includes("exceeds default cap"))).toBe(true);
  });

  it("admin override 1M is honored (warns); >1M clamped", async () => {
    const fakeChFetch = vi.fn(async () => new Response("", { status: 200 }));
    const clickhouseClient = new ClickHouseClient({
      baseUrl: "http://ch",
      fetchImpl: fakeChFetch as unknown as typeof fetch,
    });
    const r1 = await traverse({
      anchorObjectType: "Order",
      anchorPks: Array.from({ length: 101 }, (_, i) => `O-${i}`),
      hops: [{ linkType: { sourceObjectType: "Order", linkName: "customer", targetObjectType: "Customer" } }],
      isolation: { tenantId: "t-a", ontologyId: "ont-1", branchId: "main" },
      userMarkings: new Set(),
      maxRows: 1_000_000,
      adminOverride: true,
      maxQuickwitHopSize: 100,
      clickhouseClient,
    });
    expect(r1.warnings.some((w) => w.includes("admin-override"))).toBe(true);

    const r2 = await traverse({
      anchorObjectType: "Order",
      anchorPks: Array.from({ length: 101 }, (_, i) => `O-${i}`),
      hops: [{ linkType: { sourceObjectType: "Order", linkName: "customer", targetObjectType: "Customer" } }],
      isolation: { tenantId: "t-a", ontologyId: "ont-1", branchId: "main" },
      userMarkings: new Set(),
      maxRows: 10_000_000,
      adminOverride: true,
      maxQuickwitHopSize: 100,
      clickhouseClient,
    });
    expect(r2.warnings.some((w) => w.includes(`exceeds admin-override max ${ADMIN_MAX_CAP}`))).toBe(true);
  });

  it("empty anchor set short-circuits with no backend calls", async () => {
    const result = await traverse({
      anchorObjectType: "Order",
      anchorPks: [],
      hops: [
        { linkType: { sourceObjectType: "Order", linkName: "customer", targetObjectType: "Customer" } },
      ],
      isolation: { tenantId: "t-a", ontologyId: "ont-1", branchId: "main" },
      userMarkings: new Set(),
    });
    expect(result.targetPks).toEqual([]);
    expect(result.trace).toEqual([]);
    expect(DEFAULT_CAP).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// B10 — CDC lag
// ---------------------------------------------------------------------------

describe("B10 CDC lag reader", () => {
  beforeEach(() => {
    resetClickHouseClientForTesting();
  });

  it("alerts when lag exceeds 30s", async () => {
    const now = new Date("2026-04-17T12:00:00.000Z");
    const tenMinutesAgo = new Date(now.getTime() - 600_000).toISOString();
    const fakeFetch = vi.fn(async () => {
      // Respond with JSONEachRow: one row with rc and ts
      const body = JSON.stringify({ rc: "42", ts: tenMinutesAgo }) + "\n";
      return new Response(body, { status: 200 });
    });
    const client = new ClickHouseClient({
      baseUrl: "http://ch",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    const reading = await readCdcLag(
      { sourceObjectType: "Order", linkName: "customer", targetObjectType: "Customer" },
      client,
      now
    );
    expect(reading.rowCount).toBe(42);
    expect(reading.lagSeconds).toBeGreaterThan(CDC_LAG_ALERT_SECONDS);
    expect(reading.alerting).toBe(true);
  });

  it("does not alert when lag is within threshold", async () => {
    const now = new Date("2026-04-17T12:00:00.000Z");
    const freshTs = new Date(now.getTime() - 5_000).toISOString();
    const fakeFetch = vi.fn(async () =>
      new Response(JSON.stringify({ rc: "10", ts: freshTs }) + "\n", { status: 200 })
    );
    const client = new ClickHouseClient({
      baseUrl: "http://ch",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    const reading = await readCdcLag(
      { sourceObjectType: "Order", linkName: "customer", targetObjectType: "Customer" },
      client,
      now
    );
    expect(reading.alerting).toBe(false);
    expect(reading.lagSeconds).toBeLessThan(CDC_LAG_ALERT_SECONDS);
  });

  it("skips alerting when table is empty (no rows = no lag to report)", async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(JSON.stringify({ rc: "0", ts: null }) + "\n", { status: 200 })
    );
    const client = new ClickHouseClient({
      baseUrl: "http://ch",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    const reading = await readCdcLag(
      { sourceObjectType: "Order", linkName: "customer", targetObjectType: "Customer" },
      client
    );
    expect(reading.rowCount).toBe(0);
    expect(reading.alerting).toBe(false);
  });
});
