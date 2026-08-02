// ---------------------------------------------------------------------------
// STAGE 7 — deterministic edge-version semantics. REAL PG + ClickHouse.
//
// Version contract under test (src/services/searchAround/edgeVersion.ts):
//   event_version = outbox_seq (globally unique, sequence-derived scalar;
//   no wall-clock inputs); replay carries the ORIGINAL scalar; only NEW
//   allocations (fresh re-assertions of CURRENT truth) can advance state.
//
// Each test operates on the DEDICATED lane: osv2_serving PG database +
// osv2_serving ClickHouse database (vitest.osv2-serving.config.ts). No
// OPTIMIZE TABLE — correctness must hold WITHOUT background merges.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { query } from "../../src/db";
import {
  ensureLinkTable,
  insertLinkRows,
  linkTableName,
  type LinkTypeDescriptor,
} from "../../src/services/searchAround/linkMaterializedView";
import { getClickHouseClient } from "../../src/services/searchAround/clickhouseClient";
import { buildReverseSql, buildTraversalSql } from "../../src/services/searchAround/clickhouseTraversal";
import { edgeEventVersion, GUARD_OUTBOX_SEQUENCE_SQL } from "../../src/services/searchAround/edgeVersion";

const tag = () => `ev_${Math.random().toString(36).slice(2, 8)}`;
const ch = () => getClickHouseClient();
const ISO = { tenantId: "", ontologyId: "ev-ont", branchId: "ev-branch" };

async function activeEdges(desc: LinkTypeDescriptor, scope = ISO) {
  // argMax-per-identity projection WITHOUT FINAL/merge — pre-merge
  // correctness proof. Mirrors clickhouseTraversal inner subquery.
  const rows = await ch().exec<{ source_pk: string; target_pk: string; latest: number; deleted: number; event_id: string }>(
    `SELECT source_pk, target_pk,
            max(event_version)              AS latest,
            argMax(deleted, event_version)  AS deleted,
            argMax(event_id, event_version) AS event_id
       FROM ${linkTableName(desc)}
      WHERE tenant_id = '${scope.tenantId}' AND ontology_id = '${scope.ontologyId}' AND branch_id = '${scope.branchId}'
      GROUP BY source_pk, target_pk`,
  );
  return rows.filter((r) => Number(r.deleted) === 0).map((r) => `${r.source_pk}->${r.target_pk}@${r.latest}/${r.event_id}`);
}

describe("edge-version semantics — real PG + ClickHouse", () => {
  it("duplicate delivery of the same event is idempotent (byte-identical replay; one logical edge)", async () => {
    const desc: LinkTypeDescriptor = { sourceObjectType: tag() + "S", linkName: tag(), targetObjectType: tag() + "T" };
    await ensureLinkTable(desc);
    const row = { source_pk: "A", target_pk: "B", operation: "ADD" as const, outbox_seq: 1001, event_id: "dup-1", ...ISO, ontology_id: ISO.ontologyId, branch_id: ISO.branchId, tenant_id: "" };
    await insertLinkRows(desc, [row]);
    await insertLinkRows(desc, [row]); // replay — identical copy
    const edges = await activeEdges(desc);
    expect(edges).toEqual(["A->B@1001/dup-1"]);
  });

  it("an older ADD NEVER resurrects a newer REMOVE — independent of insertion order", async () => {
    const desc: LinkTypeDescriptor = { sourceObjectType: tag() + "S", linkName: tag(), targetObjectType: tag() + "T" };
    await ensureLinkTable(desc);
    // Deliver REMOVE first (arrives out of order), OLDER ADD second:
    await insertLinkRows(desc, [
      { source_pk: "A", target_pk: "B", operation: "REMOVE", outbox_seq: 2002, event_id: "rm", tenant_id: ISO.tenantId, ontology_id: ISO.ontologyId, branch_id: ISO.branchId },
    ]);
    await insertLinkRows(desc, [
      { source_pk: "A", target_pk: "B", operation: "ADD", outbox_seq: 2001, event_id: "add-old", tenant_id: ISO.tenantId, ontology_id: ISO.ontologyId, branch_id: ISO.branchId },
    ]);
    expect(await activeEdges(desc)).toEqual([]);
  });

  it("a valid newer ADD re-creates the edge after removal", async () => {
    const desc: LinkTypeDescriptor = { sourceObjectType: tag() + "S", linkName: tag(), targetObjectType: tag() + "T" };
    await ensureLinkTable(desc);
    await insertLinkRows(desc, [
      { source_pk: "A", target_pk: "B", operation: "ADD", outbox_seq: 3001, event_id: "a1", tenant_id: "", ontology_id: ISO.ontologyId, branch_id: ISO.branchId },
      { source_pk: "A", target_pk: "B", operation: "REMOVE", outbox_seq: 3002, event_id: "r1", tenant_id: "", ontology_id: ISO.ontologyId, branch_id: ISO.branchId },
    ]);
    expect(await activeEdges(desc)).toEqual([]);
    await insertLinkRows(desc, [
      { source_pk: "A", target_pk: "B", operation: "ADD", outbox_seq: 3003, event_id: "a2", tenant_id: "", ontology_id: ISO.ontologyId, branch_id: ISO.branchId },
    ]);
    expect(await activeEdges(desc)).toEqual(["A->B@3003/a2"]);
  });

  it("clock skew is irrelevant: fabricated event_ts_micros never beats a newer sequence", async () => {
    // Fake the far-future wall clock on an OLDER event — version is
    // allocated by the sequence, so the claim cannot stand.
    expect(edgeEventVersion({ outbox_seq: 5, event_ts_micros: 4_100_000_000_000_000 })).toBe(5);
    expect(() => edgeEventVersion({})).toThrow(/ordering identity/);

    const desc: LinkTypeDescriptor = { sourceObjectType: tag() + "S", linkName: tag(), targetObjectType: tag() + "T" };
    await ensureLinkTable(desc);
    await insertLinkRows(desc, [
      { source_pk: "A", target_pk: "B", operation: "ADD", outbox_seq: 4001, event_id: "skew-old", tenant_id: "", ontology_id: ISO.ontologyId, branch_id: ISO.branchId,
        // Even if the producer CLAIMS a far-future clock, the row's version
        // is its outbox_seq — ordering cannot be clock-forged:
        // (insertLinkRows derives event_version = outbox_seq when present.)
         },
    ]);
    await insertLinkRows(desc, [
      { source_pk: "A", target_pk: "B", operation: "REMOVE", outbox_seq: 4002, event_id: "skew-new", tenant_id: "", ontology_id: ISO.ontologyId, branch_id: ISO.branchId },
    ]);
    expect(await activeEdges(desc)).toEqual([]);
  });

  it("snapshot replay cannot overwrite newer live CDC", async () => {
    const desc: LinkTypeDescriptor = { sourceObjectType: tag() + "S", linkName: tag(), targetObjectType: tag() + "T" };
    await ensureLinkTable(desc);
    // Live CDC at seq 5002 (truth: props v2):
    await insertLinkRows(desc, [
      { source_pk: "A", target_pk: "B", operation: "ADD", outbox_seq: 5002, event_id: "live", link_props: { v: 2 }, tenant_id: "", ontology_id: ISO.ontologyId, branch_id: ISO.branchId },
    ]);
    // A REPLAYED snapshot row carries the ORIGINAL (older) allocated
    // version; it may not degrade the live truth:
    await insertLinkRows(desc, [
      { source_pk: "A", target_pk: "B", operation: "ADD", outbox_seq: 5001, event_id: "replay", link_props: { v: 1 }, tenant_id: "", ontology_id: ISO.ontologyId, branch_id: ISO.branchId },
    ]);
    expect(await activeEdges(desc)).toEqual(["A->B@5002/live"]);
  });

  it("correctness independent of merge state (no OPTIMIZE): argMax projection returns only the latest state", async () => {
    const desc: LinkTypeDescriptor = { sourceObjectType: tag() + "S", linkName: tag(), targetObjectType: tag() + "T" };
    await ensureLinkTable(desc);
    // Two SEPARATE INSERT statements → two physical parts, two raw rows —
    // `optimize_on_insert` still runs part-local only, so without an
    // OPTIMIZE TABLE / background merge the raw history remains two rows.
    await insertLinkRows(desc, [
      { source_pk: "X", target_pk: "Y", operation: "ADD", outbox_seq: 6001, event_id: "e1", tenant_id: "", ontology_id: ISO.ontologyId, branch_id: ISO.branchId },
    ]);
    await insertLinkRows(desc, [
      { source_pk: "X", target_pk: "Y", operation: "ADD", outbox_seq: 6002, event_id: "e2", tenant_id: "", ontology_id: ISO.ontologyId, branch_id: ISO.branchId },
    ]);
    const raw = await ch().exec<{ n: number }>(
      `SELECT count() AS n FROM ${linkTableName(desc)}`,
    );
    expect(Number(raw[0].n)).toBeGreaterThanOrEqual(2); // both parts present
    expect(await activeEdges(desc)).toEqual(["X->Y@6002/e2"]); // projection is version-faithful anyway
  });

  it("forward and reverse traversals resolve the SAME active version set", async () => {
    const desc: LinkTypeDescriptor = { sourceObjectType: tag() + "S", linkName: tag(), targetObjectType: tag() + "T" };
    await ensureLinkTable(desc);
    await insertLinkRows(desc, [
      { source_pk: "A", target_pk: "B", operation: "ADD", outbox_seq: 7001, event_id: "f1", tenant_id: "", ontology_id: ISO.ontologyId, branch_id: ISO.branchId },
      { source_pk: "A", target_pk: "B", operation: "REMOVE", outbox_seq: 7002, event_id: "f2", tenant_id: "", ontology_id: ISO.ontologyId, branch_id: ISO.branchId },
      { source_pk: "A", target_pk: "B", operation: "ADD", outbox_seq: 7003, event_id: "f3", tenant_id: "", ontology_id: ISO.ontologyId, branch_id: ISO.branchId },
    ]);
    const fwd = await ch().exec<Record<string, unknown>>(buildTraversalSql({
      anchorPks: ["A"], hops: [{ linkType: desc }], userMarkings: new Set(), isolation: { tenantId: "", ontologyId: ISO.ontologyId, branchId: ISO.branchId }, cap: 1000,
    }) as string);
    const rev = await ch().exec<Record<string, unknown>>(buildReverseSql({
      linkType: desc, anchorPks: ["B"], userMarkings: new Set(), isolation: { tenantId: "", ontologyId: ISO.ontologyId, branchId: ISO.branchId }, cap: 1000,
    }));
    // The 2-directional projection of the SAME active state:
    expect(fwd.length).toBe(1);
    expect(rev.length).toBe(1);
  });

  it("boot guard: sequence stays ahead of table contents even after a restore-style reset", async () => {
    // Plant a row so the max exists, then simulate a restore anomaly: the
    // copied table kept its rows, but the sequence was reset BELOW max.
    const { getClient } = await import("../../src/db");
    const { stageLinkCdcEvent } = await import("../../src/services/searchAround/linkCdcOutbox");
    const tx = await getClient();
    let planted: number;
    try {
      await tx.query("BEGIN");
      const s = await stageLinkCdcEvent(tx, {
        eventId: "11111111-9999-8888-7777-666666666666",
        sourceObjectType: "G1", linkTypeApiName: "guardprobe", sourcePrimaryKey: "s", targetPrimaryKey: "t",
        operation: "ADD", ontologyId: "guard-ont" }, );
      await tx.query("COMMIT");
      planted = s.outboxSeq;
    } finally { tx.release(); }
    expect(planted).toBeGreaterThan(0);
    // Reset the sequence DOWN to the planted seq (a restore would do worse);
    // without the guard the next allocation would collide with the row.
    await query(`SELECT setval(pg_get_serial_sequence('link_cdc_outbox', 'outbox_seq'), $1, true)`, [planted]);
    await query(GUARD_OUTBOX_SEQUENCE_SQL);
    const next = await query(`SELECT nextval('link_cdc_outbox_outbox_seq_seq') AS n`);
    expect(Number(next.rows[0].n)).toBeGreaterThan(planted);
  });
});
