// ---------------------------------------------------------------------------
// Stage 3 — LINK-INDEX CONFIRMATION (real PG + real Kafka + real ClickHouse).
//
// Proves the full pre-e2e ack chain:
//   stage (in-txn, monotonic outbox_seq) → drain (real broker) → index row
//   arrives in the versioned CH table → confirmEdgeIndexVisibility resolves
//   → per-scope watermark row persisted (real PG).
//
// CONSUMER STAND-IN: until the Kafka-engine → MV ingest is wired
// (Stage 8 e2e), the CH row is placed via the production backfill path
// `insertLinkRows` — the SAME row shape the MV v3 passthrough produces from
// the Kafka payload. This test does NOT claim the Kafka-engine topology.
// The confirmation barrier itself (read-after-write) is backend-agnostic
// and exactly what a live MV would satisfy.
// ---------------------------------------------------------------------------

import { describe, it, expect, afterAll } from "vitest";
import crypto from "node:crypto";
import { query, getClient } from "../../../src/db";
import {
  stageLinkCdcEvent,
  drainLinkOutboxOnce,
} from "../../../src/services/searchAround/linkCdcOutbox";
import { shutdownCdcLinkProducer } from "../../../src/services/searchAround/cdcLinkProducer";
import {
  ensureLinkTable,
  insertLinkRows,
  linkTableName,
  type LinkTypeDescriptor,
} from "../../../src/services/searchAround/linkMaterializedView";
import {
  confirmEdgeIndexVisibility,
  waitForLinkWatermark,
} from "../../../src/services/serving/edgeIndexWatermark";
import { StoreWatermarkTimeout } from "../../../src/services/serving/contracts";

const rnd = () => Math.random().toString(36).slice(2, 8);
const OT = `AckSrc${rnd()}`;
const TT = `AckTgt${rnd()}`;
const LT = `ackOwnedBy${rnd()}`;
const DESCRIPTOR: LinkTypeDescriptor = {
  sourceObjectType: OT,
  linkName: LT,
  targetObjectType: TT,
};
const SCOPE = { tenantId: "", ontologyId: `ack-ont-${rnd()}`, branchId: `ack-branch-${rnd()}` };
const EVENT_VERSION = Date.now() * 1000;

async function stageCommittedEv(input: { sourcePk: string; targetPk: string; eventId: string }) {
  const tx = await getClient();
  try {
    await tx.query("BEGIN");
    const staged = await stageLinkCdcEvent(tx, {
      eventId: input.eventId,
      sourceObjectType: OT,
      linkTypeApiName: LT,
      sourcePrimaryKey: input.sourcePk,
      targetPrimaryKey: input.targetPk,
      operation: "ADD",
      ontologyId: SCOPE.ontologyId,
      branchId: SCOPE.branchId,
      tenantId: SCOPE.tenantId || null,
      eventTsMicros: EVENT_VERSION,
    });
    await tx.query("COMMIT");
    return staged;
  } finally {
    tx.release();
  }
}

async function stageThenIngest(input: { sourcePk: string; targetPk: string; eventId: string }) {
  const staged = await stageCommittedEv(input);
  // Real broker acceptance:
  await drainLinkOutboxOnce(100);
  const row = await query(
    `SELECT payload FROM link_cdc_outbox WHERE event_id = $1`,
    [input.eventId],
  );
  expect(row.rows[0].payload.published_ack_placeholder).toBeUndefined();
  expect(row.rows[0].payload.outbox_seq).toBe(staged.outboxSeq);
  // Consumer stand-in: map the published payload into the serving row
  // exactly as kafkaIngestDdl's MV v3 passthrough would (same columns).
  await insertLinkRows(DESCRIPTOR, [
    {
      source_pk: input.sourcePk,
      target_pk: input.targetPk,
      operation: "ADD",
      event_id: input.eventId,
      event_version: EVENT_VERSION,
      outbox_seq: staged.outboxSeq,
      ontology_id: SCOPE.ontologyId,
      branch_id: SCOPE.branchId,
      tenant_id: SCOPE.tenantId,
    },
  ]);
  return staged;
}

describe("link edge-index confirmation — real PG+Kafka+ClickHouse", () => {
  afterAll(async () => {
    await shutdownCdcLinkProducer();
  });

  it("full chain: outbox_seq flows through drain+index; per-event confirmation resolves; watermark persisted", async () => {
    await ensureLinkTable(DESCRIPTOR);
    const ev = crypto.randomUUID();
    const staged = await stageThenIngest({ sourcePk: "A", targetPk: "B", eventId: ev });

    expect(staged.outboxSeq).toBeGreaterThan(0);

    const conf = await confirmEdgeIndexVisibility({
      scope: SCOPE,
      handles: [
        {
          eventId: ev,
          outboxSeq: staged.outboxSeq,
          linkTypeApiName: LT,
          sourceObjectType: OT,
          ontologyId: SCOPE.ontologyId,
        },
      ],
      timeoutMs: 5_000,
      deps: { resolveDescriptor: async () => DESCRIPTOR },
    });
    expect(conf.confirmed).toBe(true);
    expect(conf.deferred).toBe(0);

    // Watermark stats recorded in real PG for the scope.
    const wm = await query(
      `SELECT confirmed_seq, confirmed_event_version FROM link_edge_watermarks
        WHERE tenant_id=$1 AND ontology_id=$2 AND branch_id=$3 AND link_type_api_name=$4`,
      [SCOPE.tenantId, SCOPE.ontologyId, SCOPE.branchId, LT],
    );
    expect(Number(wm.rows[0]?.confirmed_seq)).toBeGreaterThanOrEqual(staged.outboxSeq);
    expect(Number(wm.rows[0]?.conf_event_version ?? wm.rows[0]?.confirmed_event_version)).toBe(EVENT_VERSION);
  });

  it("published-but-never-indexed ⇒ deferred (timeout), watermark does NOT advance to that seq", async () => {
    const ev2 = crypto.randomUUID();
    // Stage + publish but DO NOT ingest into CH (Kafka outage on the way
    // to the index would look identical to the barrier).
    const staged = await stageCommittedEv({ sourcePk: "C", targetPk: "D", eventId: ev2 });
    await drainLinkOutboxOnce(100);

    const conf = await confirmEdgeIndexVisibility({
      scope: SCOPE,
      handles: [
        { eventId: ev2, outboxSeq: staged.outboxSeq, linkTypeApiName: LT, sourceObjectType: OT, ontologyId: SCOPE.ontologyId },
      ],
      timeoutMs: 800,
      pollMs: 100,
      deps: { resolveDescriptor: async () => DESCRIPTOR },
    });
    expect(conf.confirmed).toBe(false);
    expect(conf.deferred).toBe(1);
    expect(conf.reason).toBe("timeout");

    const wm = await query(
      `SELECT confirmed_seq FROM link_edge_watermarks
        WHERE tenant_id=$1 AND ontology_id=$2 AND branch_id=$3 AND link_type_api_name=$4`,
      [SCOPE.tenantId, SCOPE.ontologyId, SCOPE.branchId, LT],
    );
    // The first test advanced the watermark; this seq MUST be newer and
    // must NOT have been stamped by the failed confirmation.
    expect(Number(wm.rows[0].confirmed_seq)).toBeLessThan(staged.outboxSeq);
  });

  it("waitForWatermark: ≤ first confirmed offset resolves; > it throws StoreWatermarkTimeout", async () => {
    const wm = await query(
      `SELECT confirmed_seq FROM link_edge_watermarks
        WHERE tenant_id=$1 AND ontology_id=$2 AND branch_id=$3 AND link_type_api_name=$4`,
      [SCOPE.tenantId, SCOPE.ontologyId, SCOPE.branchId, LT],
    );
    const maxConfirmed = Number(wm.rows[0].confirmed_seq);

    await expect(
      waitForLinkWatermark({
        scope: SCOPE,
        linkTypeApiName: LT,
        minOffset: maxConfirmed,
        timeoutMs: 3_000,
        deps: { resolveDescriptor: async () => DESCRIPTOR },
      }),
    ).resolves.toBeUndefined();

    // Beyond the latest ingested seq: pending outbox rows (test 2) are
    // published but absent from CH → sound set-diff must time out.
    await expect(
      waitForLinkWatermark({
        scope: SCOPE,
        linkTypeApiName: LT,
        minOffset: maxConfirmed + 1_000,
        timeoutMs: 600,
        pollMs: 100,
        deps: { resolveDescriptor: async () => DESCRIPTOR },
      }),
    ).rejects.toBeInstanceOf(StoreWatermarkTimeout);
  });

  it("cross-scope probes see nothing (isolation in the probe)", async () => {
    const ev3 = crypto.randomUUID();
    const staged = await stageThenIngest({ sourcePk: "E", targetPk: "F", eventId: ev3 });
    const conf = await confirmEdgeIndexVisibility({
      scope: { ...SCOPE, tenantId: "other-tenant" },
      handles: [
        { eventId: ev3, outboxSeq: staged.outboxSeq, linkTypeApiName: LT, sourceObjectType: OT, ontologyId: SCOPE.ontologyId },
      ],
      timeoutMs: 400,
      pollMs: 100,
      deps: { resolveDescriptor: async () => DESCRIPTOR },
    });
    expect(conf.confirmed).toBe(false);
    expect(conf.deferred).toBe(1);
    expect(linkTableName(DESCRIPTOR)).toContain("link_");
  });
});
