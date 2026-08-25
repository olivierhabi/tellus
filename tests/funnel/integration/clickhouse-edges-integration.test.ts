// ---------------------------------------------------------------------------
// LANE test — versioned ClickHouse edge lifecycle (real ClickHouse).
//
// Proves the ReplacingMergeTree latest-version semantics end-to-end:
//   1. ADD(v1) appears in forward AND reverse traversal;
//   2. REMOVE(v2) hides the edge in both directions;
//   3. replaying an OLDER add (v1) afterwards can NEVER resurrect it;
//   4. a NEWER valid ADD (v3) re-creates the edge;
//   5. replaying the SAME event (duplicate delivery) is idempotent;
//   6. cross-tenant queries return NOTHING (isolation in the key);
//   7. edges with markings the user lacks are invisible.
// ---------------------------------------------------------------------------

import { afterAll, describe, expect, it } from "vitest";
import {
  ensureLinkTable,
  insertLinkRows,
  linkTableName,
} from "../../../src/services/searchAround/linkMaterializedView";
import { ClickHouseClient } from "../../../src/services/searchAround/clickhouseClient";
import {
  buildTraversalSql,
  buildReverseSql,
} from "../../../src/services/searchAround/clickhouseTraversal";

const ch = new ClickHouseClient({
  baseUrl: "http://localhost:8123",
  username: "tellus",
  password: "tellus_ch_pw",
});

const descriptor = {
  sourceObjectType: "ITestOrder",
  linkName: `itest${Date.now()}`,
  targetObjectType: "ITestCustomer",
};
const iso = { tenantId: "t-alpha", ontologyId: "ont-alpha", branchId: "main" };
const TABLE = linkTableName(descriptor);

async function forward(anchor: string, userMarkings: Set<string>): Promise<string[]> {
  const rows = await ch.exec<{ pk: string }>(
    buildTraversalSql({
      anchorPks: [anchor],
      hops: [{ linkType: descriptor }],
      userMarkings,
      isolation: iso,
      cap: 100,
    }),
  );
  return rows.map((r) => r.pk).sort();
}

async function reverse(anchor: string, userMarkings: Set<string>): Promise<string[]> {
  const rows = await ch.exec<{ pk: string }>(
    buildReverseSql({
      linkType: descriptor,
      anchorPks: [anchor],
      userMarkings,
      isolation: iso,
      cap: 100,
    }),
  );
  return rows.map((r) => r.pk).sort();
}

describe("versioned ClickHouse edge lifecycle (real CH)", () => {
  afterAll(async () => {
    await ch.command(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => {});
  });

  it("ADD(v1) shows in both directions; REMOVE(v2) hides; older ADD CANNOT resurrect; newer ADD re-creates; duplicates idempotent", async () => {
    await ensureLinkTable(descriptor, ch);

    const baseMicros = 1_800_000_000_000_000;
    // 1. ADD, version 1
    await insertLinkRows(descriptor, [
      {
        source_pk: "S1",
        target_pk: "T1",
        operation: "ADD",
        event_id: "e-add-1",
        event_version: baseMicros + 1,
        ...iso_legs(iso),
      },
    ], ch);
    expect(await forward("S1", new Set())).toEqual(["T1"]);
    expect(await reverse("T1", new Set())).toEqual(["S1"]);

    // 2. REMOVE, version 2 — appears in both directions as tombstone.
    await insertLinkRows(descriptor, [
      {
        source_pk: "S1",
        target_pk: "T1",
        operation: "REMOVE",
        event_id: "e-rm-2",
        event_version: baseMicros + 2,
        ...iso_legs(iso),
      },
    ], ch);
    // ReplacingMergeTree collapses asynchronously; argMax queries are
    // correct regardless of merging, so no OPTIMIZE needed.
    expect(await forward("S1", new Set())).toEqual([]);
    expect(await reverse("T1", new Set())).toEqual([]);

    // 3. Replay an OLDER add — must never resurrect the removed edge.
    await insertLinkRows(descriptor, [
      {
        source_pk: "S1",
        target_pk: "T1",
        operation: "ADD",
        event_id: "e-add-1-dup",
        event_version: baseMicros + 1, // older version than the REMOVE
        ...iso_legs(iso),
      },
    ], ch);
    expect(await forward("S1", new Set())).toEqual([]);
    expect(await reverse("T1", new Set())).toEqual([]);

    // 4. A valid NEWER add re-creates the relationship.
    await insertLinkRows(descriptor, [
      {
        source_pk: "S1",
        target_pk: "T1",
        operation: "ADD",
        event_id: "e-add-3",
        event_version: baseMicros + 3,
        ...iso_legs(iso),
      },
    ], ch);
    expect(await forward("S1", new Set())).toEqual(["T1"]);
    expect(await reverse("T1", new Set())).toEqual(["S1"]);

    // 5. Duplicate delivery of the SAME event: harmless.
    await insertLinkRows(descriptor, [
      {
        source_pk: "S1",
        target_pk: "T1",
        operation: "ADD",
        event_id: "e-add-3",
        event_version: baseMicros + 3,
        ...iso_legs(iso),
      },
    ], ch);
    expect(await forward("S1", new Set())).toEqual(["T1"]);
  });

  it("cross-tenant queries return NOTHING (isolation dimensions in the key)", async () => {
    // Table has the S1->T1 edge for t-alpha from the previous test; a
    // t-beta lookup against the same PKs must see nothing.
    const sqlOther = buildTraversalSql({
      anchorPks: ["S1"],
      hops: [{ linkType: descriptor }],
      userMarkings: new Set(),
      isolation: { tenantId: "t-beta", ontologyId: "ont-alpha", branchId: "main" },
      cap: 100,
    });
    expect((await ch.exec<{ pk: string }>(sqlOther)).map((r) => r.pk)).toEqual([]);

    const sqlOtherOnt = buildTraversalSql({
      anchorPks: ["S1"],
      hops: [{ linkType: descriptor }],
      userMarkings: new Set(),
      isolation: { tenantId: "t-alpha", ontologyId: "ont-beta", branchId: "main" },
      cap: 100,
    });
    expect((await ch.exec<{ pk: string }>(sqlOtherOnt)).map((r) => r.pk)).toEqual([]);
  });

  it("edges with markings the user lacks are invisible (fail-closed edge security)", async () => {
    await insertLinkRows(descriptor, [
      {
        source_pk: "S2",
        target_pk: "T2",
        operation: "ADD",
        event_id: "e-add-sec",
        event_version: 1_800_000_001_000_000,
        markings: ["SECRET"],
        ...iso_legs(iso),
      },
    ], ch);
    // User without SECRET cannot see it; user with SECRET can.
    expect(await forward("S2", new Set())).toEqual([]);
    expect(await reverse("T2", new Set())).toEqual([]);
    expect(await forward("S2", new Set(["SECRET"]))).toEqual(["T2"]);
    expect(await reverse("T2", new Set(["SECRET"]))).toEqual(["S2"]);
  });
});

function iso_legs(iso: { tenantId: string; ontologyId: string; branchId: string }) {
  return {
    tenant_id: iso.tenantId,
    ontology_id: iso.ontologyId,
    branch_id: iso.branchId,
  };
}
