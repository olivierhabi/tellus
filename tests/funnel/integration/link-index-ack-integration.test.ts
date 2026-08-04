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
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import request from "supertest";
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
// The serving layer folds the empty tenant to "default" (edgeVersion
// canonicalTenant); watermark rows are stamped under the folded value.
import { canonicalTenant } from "../../../src/services/searchAround/edgeVersion";
import actionsRouter from "../../../src/routes/actions";
import { globalAuditRouter } from "../../../src/routes/auditLog";
import { deriveMainBranchId } from "../../../src/services/branchContext";
import { client as osClient } from "../../../src/services/opensearch/client";
import { getIndexName } from "../../../src/services/opensearch/indexMappingGenerator";
import { limiter } from "../../../src/middleware/rateLimiter";

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
  // IMPORTANT: the payload's scope columns are the ones the broker carried
  // — staging canonicalises the empty tenant ("default", edgeVersion's
  // canonicalTenant fold), so forwarding SCOPE.tenantId raw ("") would
  // write a row the folded confirmation probes can never see.
  await insertLinkRows(DESCRIPTOR, [
    {
      source_pk: input.sourcePk,
      target_pk: input.targetPk,
      operation: "ADD",
      event_id: input.eventId,
      event_version: EVENT_VERSION,
      outbox_seq: staged.outboxSeq,
      ontology_id: row.rows[0].payload.ontology_id,
      branch_id: row.rows[0].payload.branch_id,
      tenant_id: row.rows[0].payload.tenant_id,
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
      [canonicalTenant(SCOPE.tenantId), SCOPE.ontologyId, SCOPE.branchId, LT],
    );
    expect(Number(wm.rows[0]?.confirmed_seq)).toBeGreaterThanOrEqual(staged.outboxSeq);
    // Ordering identity: the MV passthrough AND insertLinkRows both write
    // event_version = outbox_seq when outbox_seq > 0 (stage-8b design), so
    // the watermark's confirmed_event_version tracks the seq, not the raw
    // event_ts_micros (EVENT_VERSION).
    expect(
      Number(wm.rows[0]?.conf_event_version ?? wm.rows[0]?.confirmed_event_version),
    ).toBeGreaterThanOrEqual(staged.outboxSeq);
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
      [canonicalTenant(SCOPE.tenantId), SCOPE.ontologyId, SCOPE.branchId, LT],
    );
    // The first test advanced the watermark; this seq MUST be newer and
    // must NOT have been stamped by the failed confirmation.
    expect(Number(wm.rows[0].confirmed_seq)).toBeLessThan(staged.outboxSeq);
  });

  it("waitForWatermark: ≤ first confirmed offset resolves; > it throws StoreWatermarkTimeout", async () => {
    const wm = await query(
      `SELECT confirmed_seq FROM link_edge_watermarks
        WHERE tenant_id=$1 AND ontology_id=$2 AND branch_id=$3 AND link_type_api_name=$4`,
      [canonicalTenant(SCOPE.tenantId), SCOPE.ontologyId, SCOPE.branchId, LT],
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

// ---------------------------------------------------------------------------
// STAGE 3b — FULL HTTP PROPAGATION (the ack surplus fix, end to end):
//
//   POST /api/v1/ontology/:ontologyId/actions/:actionTypeApiName/apply
//     → executeAction → applyEdits stages the link CDC event in-txn
//     → LINK_INDEX_ACK_REQUIRED=true barrier waits on the edge index
//     → consumer STALLED  ⇒ HTTP 202 result:"COMMITTED_INDEX_PENDING"
//                           (+ executionId + pollable statusUrl), PG COMMITTED
//     → consumer catches up (drain + serving-row insert stand-in)
//     ⇒ a FRESH apply confirms → HTTP 200 linkIndexAck.confirmed:true, and
//       the first event is under the watermark.
//
// Uses the CANONICAL ontology singleton + its derived main branch (real
// ontology/object_type/link_type/action_type rows are required — the REST
// path resolves link descriptors from PG, unlike the direct-stage tests
// above which inject `resolveDescriptor`).
// ---------------------------------------------------------------------------

const ONT = "00000000-0000-0000-0000-000000000001"; // canonical singleton
const REST_BRANCH = deriveMainBranchId(ONT);
const REST_SCOPE = { tenantId: "", ontologyId: ONT, branchId: REST_BRANCH };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function buildAckApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as Record<string, unknown>).security = {
      userId: "ack-funnel-system",
      markings: ["PUBLIC"],
      organizations: [],
      cbac: { allowPatterns: [], denyPatterns: [] },
      markingMode: "disjunctive",
      systemPrincipal: true,
      markingBypass: true,
    };
    next();
  });
  app.use("/api/v1/ontology/:ontologyId/actions", actionsRouter);
  app.use("/api/v1/audit", globalAuditRouter);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res
      .status((err as { statusCode?: number }).statusCode ?? 500)
      .json({ error: { message: err.message } });
  });
  return app;
}

async function seedRestDomain(): Promise<{ apiName: string }> {
  const sourceOtId = crypto.randomUUID();
  const targetOtId = crypto.randomUUID();
  await query(
    `INSERT INTO object_type (object_type_id, ontology_id, api_name, display_name, version)
     VALUES ($1, $2, $3, $3, 1), ($4, $2, $5, $5, 1)`,
    [sourceOtId, ONT, OT, targetOtId, TT],
  );
  await query(
    `INSERT INTO link_type
       (ontology_id, api_name, display_name, cardinality,
        source_object_type, target_object_type)
     VALUES ($1, $2, $2, 'MANY_TO_MANY', $3, $4)`,
    [ONT, LT, sourceOtId, targetOtId],
  );
  // addLink rule compilation verifies object EXISTENCE via OpenSearch
  // (objectChecker.objectExists); the post-commit editApplicator bulk update
  // is keyed on `_id === primaryKey` — pin the doc ids so that update lands.
  for (const [ot, pk] of [
    [OT, "s-1"], [OT, "s-2"], [TT, "t-1"], [TT, "t-2"],
  ] as const) {
    await osClient.index({
      id: pk,
      index: getIndexName(ot),
      body: { __pk: pk, __objectType: ot, __ontology: ONT, kind: "ack-rest" },
      refresh: "wait_for",
    });
  }
  await ensureLinkTable(DESCRIPTOR);
  const apiName = `${LT}-rest-adder`;
  await query(
    `INSERT INTO action_type
       (ontology_id, api_name, display_name, parameters, rules,
        is_enabled, created_by, semantics_version, execution_mode, delete_policy)
     VALUES ($1, $2, $2, $3::jsonb, $4::jsonb, true, 'ack-funnel', 1, 'declarative', 'legacy_unchecked')`,
    [
      ONT,
      apiName,
      JSON.stringify([
        { apiName: "sourcePk", displayName: "Source PK", type: "string", required: true },
        { apiName: "targetPk", displayName: "Target PK", type: "string", required: true },
      ]),
      JSON.stringify([
        {
          type: "addLink",
          linkType: LT,
          sourceObject: { source: "parameter", param: "sourcePk" },
          targetObject: { source: "parameter", param: "targetPk" },
        },
      ]),
    ],
  );
  return { apiName };
}

// Seeding installs unique-keyed PG rows (object_type / link_type) — memoize
// so later stages in this file reuse the same rows instead of violating the
// (ontology_id, api_name) uniqueness with a second INSERT.
let restDomainPromise: Promise<{ apiName: string }> | null = null;
function seedRestDomainOnce(): Promise<{ apiName: string }> {
  if (!restDomainPromise) restDomainPromise = seedRestDomain();
  return restDomainPromise;
}

describe("STAGE 3b — HTTP propagation: stalled consumer ⇒ 202; catch-up ⇒ 200", () => {
  const savedAckRequired = process.env.LINK_INDEX_ACK_REQUIRED;
  const savedAckTimeout = process.env.LINK_INDEX_ACK_TIMEOUT_MS;

  afterAll(async () => {
    if (savedAckRequired === undefined) delete process.env.LINK_INDEX_ACK_REQUIRED;
    else process.env.LINK_INDEX_ACK_REQUIRED = savedAckRequired;
    if (savedAckTimeout === undefined) delete process.env.LINK_INDEX_ACK_TIMEOUT_MS;
    else process.env.LINK_INDEX_ACK_TIMEOUT_MS = savedAckTimeout;
    await query(`DELETE FROM action_type WHERE api_name LIKE '%_rest-adder'`).catch(() => {});
  });

  it("apply with stalled consumer ⇒ 202 COMMITTED_INDEX_PENDING (PG committed); catch-up ⇒ fresh apply 200 confirmed; status URL stays queryable", async () => {
    process.env.LINK_INDEX_ACK_REQUIRED = "true";
    const { apiName } = await seedRestDomainOnce();
    const app = buildAckApp();
    const apply = (parameters: Record<string, unknown>) =>
      request(app)
        .post(`/api/v1/ontology/${ONT}/actions/${apiName}/apply`)
        .send({ parameters });

    // --- Phase 1: consumer stalled (no drain, no ingest) → barrier timeout.
    process.env.LINK_INDEX_ACK_TIMEOUT_MS = "1500";
    const r1 = await apply({ sourcePk: "s-1", targetPk: "t-1" });
    console.log("[ack-http] stalled status/body:", r1.status, JSON.stringify(r1.body).slice(0, 500));
    expect(r1.status).toBe(202); // NEVER a client-visible failure
    expect(r1.status).not.toBeGreaterThanOrEqual(400);
    expect(r1.body.result).toBe("COMMITTED_INDEX_PENDING");
    expect(r1.body.executionId).toBeDefined();
    expect(r1.body.statusUrl).toBe(`/api/v1/audit/log/${r1.body.executionId}`);
    expect(r1.body.linkIndexAck?.confirmed).toBe(false);
    expect(r1.body.linkIndexAck?.reason).toBe("timeout");

    // The mutation IS committed in PG regardless of the index deferral.
    const le = await query(
      `SELECT execution_id FROM link_edit
        WHERE link_type_api_name = $1 AND source_primary_key = 's-1' AND target_primary_key = 't-1'`,
      [LT],
    );
    expect(le.rowCount).toBe(1);
    expect(le.rows[0].execution_id).toBe(r1.body.executionId);
    const ob = await query(
      `SELECT event_id, outbox_seq FROM link_cdc_outbox
        WHERE link_type_api_name = $1 AND source_primary_key = 's-1' AND target_primary_key = 't-1'`,
      [LT],
    );
    expect(ob.rowCount).toBe(1);
    const firstSeq = Number(ob.rows[0].outbox_seq);

    // The pollable status URL resolves to the committed audit entry.
    const st = await request(app).get(r1.body.statusUrl);
    expect(st.status).toBe(200);
    expect(st.body.executionId).toBe(r1.body.executionId);
    expect(st.body.result).toBe("success");

    // --- Phase 2: consumer catches up; a FRESH apply confirms → 200.
    process.env.LINK_INDEX_ACK_TIMEOUT_MS = "45000";
    const ingested = new Set<string>([]);
    let pumpDone = false;
    const pump = (async () => {
      while (!pumpDone) {
        try {
          await drainLinkOutboxOnce(100);
          const rows = await query(
            `SELECT payload FROM link_cdc_outbox
              WHERE link_type_api_name = $1 AND published_at IS NOT NULL`,
            [LT],
          );
          for (const { payload: p } of rows.rows) {
            if (ingested.has(p.event_id)) continue; // at-least-once guard
            try {
              await insertLinkRows(DESCRIPTOR, [
                {
                  source_pk: p.source_pk,
                  target_pk: p.target_pk,
                  operation: p.operation,
                  event_id: p.event_id,
                  event_version: Number(p.event_ts_micros),
                  outbox_seq: Number(p.outbox_seq),
                  ontology_id: p.ontology_id,
                  branch_id: p.branch_id,
                  tenant_id: p.tenant_id,
                },
              ]);
            } catch (err) {
              console.warn("[ack-http] pump insert:", (err as Error).message);
              continue; // NOT marked — retried next iteration
            }
            ingested.add(p.event_id); // marked ONLY after a landed insert
          }
        } catch (err) {
          console.warn("[ack-http] pump:", (err as Error).message);
        }
        await sleep(150);
      }
    })();
    try {
      const r2 = await apply({ sourcePk: "s-2", targetPk: "t-2" });
      console.log("[ack-http] caught-up status/body:", r2.status, JSON.stringify(r2.body).slice(0, 500));
      expect(r2.status).toBe(200);
      expect(r2.body.result).toBe("success");
      expect(r2.body.linkIndexAck?.confirmed).toBe(true);
      expect(r2.body.statusUrl).toBeUndefined();
    } finally {
      pumpDone = true;
      await pump;
    }

    // The DEFERRED first event is now under the scope watermark too —
    // set-diff confirmation proves it became queryable after catch-up.
    await expect(
      waitForLinkWatermark({
        scope: REST_SCOPE,
        linkTypeApiName: LT,
        minOffset: firstSeq,
        timeoutMs: 15_000,
      }),
    ).resolves.toBeUndefined();

    // The status URL for the deferred execution still resolves (committed).
    const st2 = await request(app).get(r1.body.statusUrl);
    expect(st2.status).toBe(200);
    expect(st2.body.result).toBe("success");
  }, 120_000);
});

// ---------------------------------------------------------------------------
// STAGE 3c — BATCH HTTP PROPAGATION (applyBatch end to end):
//
//   POST /api/v1/ontology/:ontologyId/actions/:actionTypeApiName/applyBatch
//     → executeAction PER ITEM → each item stages its own link CDC event
//     → per-item ack verdicts aggregate (actions/linkIndexAckHttp.ts):
//       consumer STALLED  ⇒ HTTP 202 result:"COMMITTED_INDEX_PENDING",
//                           EVERY item committed (failedCount 0) and each
//                           carries its own executionId + pollable statusUrl
//     → consumer catches up ⇒ a FRESH 2-item batch ⇒ HTTP 200 with
//       per-item linkIndexAck.confirmed:true and no statusUrl.
//
// Reuses the STAGE 3b domain (memoized) plus its own action type and FOUR
// FRESH object docs (s-3/s-4/t-3/t-4) so the two stages never collide on PG
// keys — and, crucially, so neither phase RE-ADDS a pair another row already
// staged: the serving table is ReplacingMergeTree(event_version) ordered by
// (scope, source_pk, target_pk), so re-adding an already-staged pair collapses
// the older row in a background merge and the watermark set-diff
// (DISTINCT outbox_seq, no FINAL) can then never resolve. Phase 1 links
// s-3→t-3 + s-4→t-4; phase 2 links s-3→t-4 + s-4→t-3 — every edge row keeps
// its own versioned entry.
// ---------------------------------------------------------------------------

describe("STAGE 3c — applyBatch propagation: stalled ⇒ 202 per-item pending; catch-up ⇒ 200 all-confirmed", () => {
  const savedAckRequired = process.env.LINK_INDEX_ACK_REQUIRED;
  const savedAckTimeout = process.env.LINK_INDEX_ACK_TIMEOUT_MS;

  afterAll(async () => {
    if (savedAckRequired === undefined) delete process.env.LINK_INDEX_ACK_REQUIRED;
    else process.env.LINK_INDEX_ACK_REQUIRED = savedAckRequired;
    if (savedAckTimeout === undefined) delete process.env.LINK_INDEX_ACK_TIMEOUT_MS;
    else process.env.LINK_INDEX_ACK_TIMEOUT_MS = savedAckTimeout;
    await query(`DELETE FROM action_type WHERE api_name LIKE '%_batch-adder'`).catch(() => {});
  });

  it("batch with stalled consumer ⇒ 202 + per-item pending acks (PG committed); catch-up ⇒ fresh batch 200 confirmed; status URLs queryable", async () => {
    process.env.LINK_INDEX_ACK_REQUIRED = "true";
    await seedRestDomainOnce();

    // Own action type so this stage never collides with 3b's rest-adder.
    const batchApiName = `${LT}-batch-adder`;
    await query(
      `INSERT INTO action_type
         (ontology_id, api_name, display_name, parameters, rules,
          is_enabled, created_by, semantics_version, execution_mode, delete_policy)
       VALUES ($1, $2, $2, $3::jsonb, $4::jsonb, true, 'ack-funnel', 1, 'declarative', 'legacy_unchecked')`,
      [
        ONT,
        batchApiName,
        JSON.stringify([
          { apiName: "sourcePk", displayName: "Source PK", type: "string", required: true },
          { apiName: "targetPk", displayName: "Target PK", type: "string", required: true },
        ]),
        JSON.stringify([
          {
            type: "addLink",
            linkType: LT,
            sourceObject: { source: "parameter", param: "sourcePk" },
            targetObject: { source: "parameter", param: "targetPk" },
          },
        ]),
      ],
    );

    const app = buildAckApp();
    const applyBatch = (requests: Array<Record<string, unknown>>) =>
      request(app)
        .post(`/api/v1/ontology/${ONT}/actions/${batchApiName}/applyBatch`)
        .send({ requests });

    // Four fresh docs — addLink rule compilation verifies object existence
    // via OpenSearch (docs seeded by 3b only cover s-1/s-2/t-1/t-2).
    for (const [ot, pk] of [
      [OT, "s-3"], [OT, "s-4"], [TT, "t-3"], [TT, "t-4"],
    ] as const) {
      await osClient.index({
        id: pk,
        index: getIndexName(ot),
        body: { __pk: pk, __objectType: ot, __ontology: ONT, kind: "ack-rest" },
        refresh: "wait_for",
      });
    }

    // --- Phase 1: consumer stalled (no drain, no ingest) → per-item barrier
    // timeouts aggregate to ONE 202; BOTH items committed.
    process.env.LINK_INDEX_ACK_TIMEOUT_MS = "1500";
    const r1 = await applyBatch([
      { parameters: { sourcePk: "s-3", targetPk: "t-3" } },
      { parameters: { sourcePk: "s-4", targetPk: "t-4" } },
    ]);
    console.log("[ack-batch] stalled status/body:", r1.status, JSON.stringify(r1.body).slice(0, 800));
    expect(r1.status).toBe(202); // NEVER a client-visible failure
    expect(r1.status).not.toBeGreaterThanOrEqual(400);
    expect(r1.body.result).toBe("COMMITTED_INDEX_PENDING");
    expect(r1.body.totalRequests).toBe(2);
    expect(r1.body.failedCount).toBe(0);
    expect(r1.body.successCount).toBe(2);
    for (const item of r1.body.results) {
      expect(item.success).toBe(true);
      expect(item.failureType).toBeUndefined(); // a deferral is not a failure
      expect(item.executionId).toBeTruthy();
      expect(item.linkIndexAck?.confirmed).toBe(false);
      expect(item.linkIndexAck?.reason).toBe("timeout");
      expect(item.statusUrl).toBe(`/api/v1/audit/log/${item.executionId}`);
    }

    // PG proof: BOTH item mutations are committed (link_edit + outbox).
    const le = await query(
      `SELECT execution_id, source_primary_key, target_primary_key FROM link_edit
        WHERE link_type_api_name = $1
          AND ((source_primary_key = 's-3' AND target_primary_key = 't-3')
            OR (source_primary_key = 's-4' AND target_primary_key = 't-4'))`,
      [LT],
    );
    expect(le.rowCount).toBe(2);
    expect(le.rows.map((row: { execution_id: string }) => row.execution_id).sort())
      .toEqual(r1.body.results.map((i: { executionId: string }) => i.executionId).sort());
    const ob = await query(
      `SELECT event_id, outbox_seq FROM link_cdc_outbox
        WHERE link_type_api_name = $1
          AND ((source_primary_key = 's-3' AND target_primary_key = 't-3')
            OR (source_primary_key = 's-4' AND target_primary_key = 't-4'))`,
      [LT],
    );
    expect(ob.rowCount).toBe(2);
    const firstSeqs = ob.rows.map((row: { outbox_seq: string }) => Number(row.outbox_seq));

    // The per-item pollable status URLs resolve to committed audit entries.
    for (const item of r1.body.results) {
      const st = await request(app).get(item.statusUrl);
      expect(st.status).toBe(200);
      expect(st.body.executionId).toBe(item.executionId);
      expect(st.body.result).toBe("success");
    }

    // --- Phase 2: consumer catches up; a FRESH 2-item batch confirms → 200.
    process.env.LINK_INDEX_ACK_TIMEOUT_MS = "45000";
    const ingested = new Set<string>([]);
    let pumpDone = false;
    const pump = (async () => {
      while (!pumpDone) {
        try {
          await drainLinkOutboxOnce(100);
          const rows = await query(
            `SELECT payload FROM link_cdc_outbox
              WHERE link_type_api_name = $1 AND published_at IS NOT NULL`,
            [LT],
          );
          for (const { payload: p } of rows.rows) {
            if (ingested.has(p.event_id)) continue; // at-least-once guard
            try {
              await insertLinkRows(DESCRIPTOR, [
                {
                  source_pk: p.source_pk,
                  target_pk: p.target_pk,
                  operation: p.operation,
                  event_id: p.event_id,
                  event_version: Number(p.event_ts_micros),
                  outbox_seq: Number(p.outbox_seq),
                  ontology_id: p.ontology_id,
                  branch_id: p.branch_id,
                  tenant_id: p.tenant_id,
                },
              ]);
            } catch (err) {
              console.warn("[ack-batch] pump insert:", (err as Error).message);
              continue; // NOT marked — retried next iteration
            }
            ingested.add(p.event_id); // marked ONLY after a landed insert
          }
        } catch (err) {
          console.warn("[ack-batch] pump:", (err as Error).message);
        }
        await sleep(150);
      }
    })();
    try {
      const r2 = await applyBatch([
        { parameters: { sourcePk: "s-3", targetPk: "t-4" } },
        { parameters: { sourcePk: "s-4", targetPk: "t-3" } },
      ]);
      console.log("[ack-batch] caught-up status/body:", r2.status, JSON.stringify(r2.body).slice(0, 800));
      expect(r2.status).toBe(200);
      expect("result" in r2.body).toBe(false); // no marker when nothing pending
      expect(r2.body.successCount).toBe(2);
      for (const item of r2.body.results) {
        expect(item.linkIndexAck?.confirmed).toBe(true);
        expect(item.statusUrl).toBeUndefined();
      }
    } finally {
      pumpDone = true;
      await pump;
    }

    // The DEFERRED phase-1 events are now under the scope watermark too —
    // they became queryable through the indexed serving path after catch-up.
    await expect(
      waitForLinkWatermark({
        scope: REST_SCOPE,
        linkTypeApiName: LT,
        minOffset: Math.max(...firstSeqs),
        timeoutMs: 15_000,
      }),
    ).resolves.toBeUndefined();

    // Phase-1 status URLs still resolve (the mutations were always durable).
    for (const item of r1.body.results) {
      const st = await request(app).get(item.statusUrl);
      expect(st.status).toBe(200);
      expect(st.body.result).toBe("success");
    }
  }, 180_000);
});

// ---------------------------------------------------------------------------
// STAGE 3d — STATUSURL LIFECYCLE (Fix 1 end-to-end). 202 is terminal —
// idempotency replays it forever — the pollable statusUrl is a deferred
// client's ONLY mechanism to learn the serving index caught up. Today
// the audit-log GET /log/:executionId returned `result:"success"` while
// the edges were NOT yet queryable; Fix 1 overlays an additive
// `indexVisibility: "PENDING" | "VISIBLE"` (linkIndexAckHttp.ts) probed
// via the SAME per-event_id barrier the write path used.
//
// Proves with real PG+Kafka+CH:
//   * stalled consumer ⇒ 202 + statusUrl polls indexVisibility "PENDING"
//     while the audit row says result:"success" (commit outcome ≠ serving).
//   * consumer resumes ⇒ SAME statusUrl (no new write) polls "VISIBLE".
//   * the edge IS queryable end-state (CH serving table contains it).
//
// Uses ONE fresh pair (s-5→t-5) on four fresh docs so the probed event
// row is never superseded within its own visibility probe window
// (no ReplacingMergeTree collapse); the probe vocabulary flips exactly
// once: PENDING ⇒ VISIBLE.
// ---------------------------------------------------------------------------

describe("STAGE 3d — statusUrl lifecycle: stalled ⇒ PENDING; catch-up ⇒ VISIBLE (same URL)", () => {
  const savedAckRequired = process.env.LINK_INDEX_ACK_REQUIRED;
  const savedAckTimeout = process.env.LINK_INDEX_ACK_TIMEOUT_MS;

  afterAll(async () => {
    if (savedAckRequired === undefined) delete process.env.LINK_INDEX_ACK_REQUIRED;
    else process.env.LINK_INDEX_ACK_REQUIRED = savedAckRequired;
    if (savedAckTimeout === undefined) delete process.env.LINK_INDEX_ACK_TIMEOUT_MS;
    else process.env.LINK_INDEX_ACK_TIMEOUT_MS = savedAckTimeout;
    await query(`DELETE FROM action_type WHERE api_name LIKE '%_status-adder'`).catch(() => {});
  });

  it("statusUrl polls PENDING while stalled; on catch-up the SAME statusUrl polls VISIBLE", async () => {
    process.env.LINK_INDEX_ACK_REQUIRED = "true";
    await seedRestDomainOnce();

    // Fresh action type + four fresh OS docs so the probed event row is
    // never superseded during this scope's lifecycle.
    const statusApiName = `${LT}-status-adder`;
    await query(
      `INSERT INTO action_type
         (ontology_id, api_name, display_name, parameters, rules,
          is_enabled, created_by, semantics_version, execution_mode, delete_policy)
       VALUES ($1, $2, $2, $3::jsonb, $4::jsonb, true, 'ack-funnel', 1, 'declarative', 'legacy_unchecked')`,
      [
        ONT,
        statusApiName,
        JSON.stringify([
          { apiName: "sourcePk", displayName: "Source PK", type: "string", required: true },
          { apiName: "targetPk", displayName: "Target PK", type: "string", required: true },
        ]),
        JSON.stringify([
          {
            type: "addLink",
            linkType: LT,
            sourceObject: { source: "parameter", param: "sourcePk" },
            targetObject: { source: "parameter", param: "targetPk" },
          },
        ]),
      ],
    );
    for (const [ot, pk] of [
      [OT, "s-5"], [TT, "t-5"],
    ] as const) {
      await osClient.index({
        id: pk,
        index: getIndexName(ot),
        body: { __pk: pk, __objectType: ot, __ontology: ONT, kind: "ack-rest" },
        refresh: "wait_for",
      });
    }

    const app = buildAckApp();
    const apply = (parameters: Record<string, unknown>) =>
      request(app)
        .post(`/api/v1/ontology/${ONT}/actions/${statusApiName}/apply`)
        .send({ parameters });

    // Phase 1: consumer STALLED → 202 + statusUrl; the audit row says
    // result:"success" (commit outcome) but indexVisibility must be PENDING.
    process.env.LINK_INDEX_ACK_TIMEOUT_MS = "1500";
    const r1 = await apply({ sourcePk: "s-5", targetPk: "t-5" });
    console.log("[ack-status] stalled:", r1.status, JSON.stringify(r1.body).slice(0, 400));
    expect(r1.status).toBe(202);
    expect(r1.body.result).toBe("COMMITTED_INDEX_PENDING");
    expect(r1.body.statusUrl).toBe(`/api/v1/audit/log/${r1.body.executionId}`);
    const statusUrl = r1.body.statusUrl;

    const stP = await request(app).get(statusUrl);
    expect(stP.status).toBe(200);
    expect(stP.body.result).toBe("success"); // PG commit outcome, dual vocab
    expect(stP.body.indexVisibility).toBe("PENDING"); // serving not-yet-visible

    // Phase 2: consumer resumes; NO new write — the SAME statusUrl should
    // flip to VISIBLE once the pump ingests the single staged event.
    process.env.LINK_INDEX_ACK_TIMEOUT_MS = "45000";
    let pumpDone = false;
    const ingested = new Set<string>([]);
    const pump = (async () => {
      while (!pumpDone) {
        try {
          await drainLinkOutboxOnce(100);
          const rows = await query(
            `SELECT payload FROM link_cdc_outbox
              WHERE link_type_api_name = $1 AND published_at IS NOT NULL`,
            [LT],
          );
          for (const { payload: p } of rows.rows) {
            if (ingested.has(p.event_id)) continue;
            try {
              await insertLinkRows(DESCRIPTOR, [
                {
                  source_pk: p.source_pk,
                  target_pk: p.target_pk,
                  operation: p.operation,
                  event_id: p.event_id,
                  event_version: Number(p.event_ts_micros),
                  outbox_seq: Number(p.outbox_seq),
                  ontology_id: p.ontology_id,
                  branch_id: p.branch_id,
                  tenant_id: p.tenant_id,
                },
              ]);
            } catch (err) {
              console.warn("[ack-status] pump insert:", (err as Error).message);
              continue;
            }
            ingested.add(p.event_id);
          }
        } catch (err) {
          console.warn("[ack-status] pump:", (err as Error).message);
        }
        await sleep(150);
      }
    })();
    try {
      // Poll the SAME statusUrl until VISIBLE — proves the deferred
      // event became queryable through the probed serving path WITHOUT
      // any new mutation. Bounded: a healthy consumer confirms the single
      // event inside a couple of seconds at most.
      let visible = false;
      for (let i = 0; i < 30 && !visible; i++) {
        await sleep(500);
        const st = await request(app).get(statusUrl);
        if (st.body.indexVisibility === "VISIBLE") {
          visible = true;
          break;
        }
      }
      expect(visible).toBe(true);
    } finally {
      pumpDone = true;
      await pump;
    }

    // End-state: the edge IS queryable in the serving table (linkTableName
    // already created for this scope by ensureLinkTable within seedRestDomain).
    const chRows = await (
      await import("../../../src/services/searchAround/clickhouseClient")
    )
      .getClickHouseClient()
      .exec<{ event_id: string }>(
        `SELECT event_id FROM ${linkTableName(DESCRIPTOR)}
           WHERE ontology_id = '${ONT}' AND source_pk = 's-5' AND target_pk = 't-5'
           LIMIT 1`,
      );
    expect(chRows.length).toBeGreaterThan(0);
  }, 90_000);
});
