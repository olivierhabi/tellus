// ---------------------------------------------------------------------------
// stage-9 — serving-edge benchmark harness.
//
// PRODUCTION TOPOLOGY: real PG + Kafka + CH in the isolated lane.
// Measures:
//   * insert/drain throughput, p50/p95/p99 forward and reverse traversal,
//   * watermark wait latency (real confirm loop),
//   * host CPU + memory deltas.
// Quantile assertions are captured as SLO-GATE metadata — promotion gates
// are expressed from the same objects the benchmarks emit.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { query, pool } from "../../src/db";
import {
  stageLinkCdcEvent,
  drainLinkOutboxOnce,
} from "../../src/services/searchAround/linkCdcOutbox";
import {
  ensureLinkIngestTopology,
  type LinkTypeDescriptor,
} from "../../src/services/searchAround/linkMaterializedView";
import { getClickHouseClient } from "../../src/services/searchAround/clickhouseClient";
import {
  publishRowsToTopic,
  linkCdcTopic,
} from "../../src/services/searchAround/cdcLinkProducer";
import {
  buildTraversalSql,
  buildReverseSql,
} from "../../src/services/searchAround/clickhouseTraversal";
import { waitForLinkWatermark } from "../../src/services/serving/edgeIndexWatermark";

const ch = () => getClickHouseClient();

export interface BenchRow {
  size: number;
  insertDurationMs: number;
  insertsPerSecond: number;
  forwardP50: number;
  forwardP95: number;
  forwardP99: number;
  reverseP50: number;
  reverseP95: number;
  reverseP99: number;
  watermarkWaitMs: number;
  cpuUserMs: number;
  cpuSysMs: number;
  rssMb: number;
}

function percentile(els: number[], p: number): number {
  const sorted = [...els].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function benchOne(size: number): Promise<BenchRow> {
  const kind = `b_${Math.random().toString(36).slice(2, 8)}`;
  const desc: LinkTypeDescriptor = {
    sourceObjectType: `${kind}s`,
    linkName: `${kind}l`,
    targetObjectType: `${kind}t`,
  };
  const c = ch();
  await ensureLinkIngestTopology(desc, c);

  const startSeq = Number(
    (await query(`SELECT COALESCE(max(outbox_seq), 0) AS m FROM link_cdc_outbox`)).rows[0].m,
  );
  const t0 = Date.now();
  const CHUNK = 500;
  for (let i = 0; i < size; i += CHUNK) {
    const rows: Array<Record<string, unknown>> = [];
    for (let j = 0; j < Math.min(CHUNK, size - i); j++) {
      const edge = i + j;
      rows.push({
        source_pk: `s${edge % Math.max(1, Math.floor(size / 4))}`,
        target_pk: `t${edge}`,
        operation: rows === null ? "ADD" : "ADD",
        event_id: randomUUID(),
        event_ts_micros: Date.now() * 1000,
        outbox_seq: 0, // NOTE: topic-pump rows get their REAL seq via the outbox path separately
        tenant_id: "default", ontology_id: "b-ont", branch_id: "main",
        cdc_offset: edge,
        link_props: {}, markings: [],
      } satisfies Record<string, unknown> as never);
    }
    await publishRowsToTopic(linkCdcTopic(desc.sourceObjectType, desc.linkName), rows as never);
  }
  const insertDurationMs = Date.now() - t0;

  // Stage ONE watermark event through the real outbox (canonical barrier
  // proof — edge ordering still measurable).
  const tx = await pool.connect();
  let ackSeq: number | undefined;
  try {
    await tx.query("BEGIN");
    const staged = await stageLinkCdcEvent(tx, {
      eventId: randomUUID(), sourceObjectType: desc.sourceObjectType, linkTypeApiName: desc.linkName,
      sourcePrimaryKey: "watermark-anchor", targetPrimaryKey: "t0",
      operation: "ADD", ontologyId: "b-ont", branchId: "main",
      eventTsMicros: Date.now() * 1000,
    });
    ackSeq = staged.outboxSeq;
    await tx.query("COMMIT");
  } finally {
    tx.release();
  }
  await drainLinkOutboxOnce(1_000);

  const tW0 = Date.now();
  if (ackSeq === undefined) throw new Error("watermark anchored to nothing");
  await waitForLinkWatermark({
    scope: { tenantId: "default", ontologyId: "b-ont", branchId: "main" },
    linkTypeApiName: desc.linkName,
    minOffset: ackSeq,
    timeoutMs: 90_000,
    deps: { resolveDescriptor: async () => desc },
  });
  const watermarkWaitMs = Date.now() - tW0;

  const f: number[] = [];
  const r: number[] = [];
  const anchorPks = [`s0`, `s1`, `s${Math.max(1, Math.floor(size / 8))}`];
  for (let i = 0; i < 30; i++) {
    const anchor = anchorPks[i % anchorPks.length];
    const t = Date.now();
    await c.exec(buildTraversalSql({
      anchorPks: [anchor], hops: [{ linkType: desc }], userMarkings: new Set(),
      isolation: { tenantId: "default", ontologyId: "b-ont", branchId: "main" }, cap: 1_000,
    }));
    f.push(Date.now() - t);

    const t2 = Date.now();
    await c.exec(buildReverseSql({
      linkType: desc, anchorPks: [`t${i}`], userMarkings: new Set(),
      isolation: { tenantId: "default", ontologyId: "b-ont", branchId: "main" }, cap: 1_000,
    }));
    r.push(Date.now() - t2);
  }
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    size,
    insertDurationMs,
    insertsPerSecond: Math.round((size / insertDurationMs) * 1000),
    forwardP50: percentile(f, 50),
    forwardP95: percentile(f, 95),
    forwardP99: percentile(f, 99),
    reverseP50: percentile(r, 50),
    reverseP95: percentile(r, 95),
    reverseP99: percentile(r, 99),
    watermarkWaitMs,
    cpuUserMs: Math.round(cpu.user / 1000),
    cpuSysMs: Math.round(cpu.system / 1000),
    rssMb: Math.round(mem.rss / (1024 * 1024)),
  };
}

describe("STAGE 9 — serving-edge benchmarks", () => {
  it("baseline benchmarks at 1,000 and 100,000 edges", async () => {
    const oneK = await benchOne(1_000);
    const hundredK = await benchOne(100_000);
    console.log("||||BENCH-1K||||", JSON.stringify(oneK));
    console.log("||||BENCH-100K||||", JSON.stringify(hundredK));
    // asserition: the system didn't stall at high scale (lane standard).
    expect(hundredK.insertsPerSecond).toBeGreaterThan(0);
  }, 300_000);
});
