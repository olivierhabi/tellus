// ---------------------------------------------------------------------------
// STAGE 2 — Action read-after-write: the declarative addLink Action, driven
// through the REAL REST path, only COMPLETES once the edge is queryable in
// the serving edge index.
//
//   POST /api/v1/ontology/:ontologyId/actions/:actionTypeApiName/apply
//     → executeAction → compileRules(addLink) → applyEdits
//     → [barrier] confirmEdgeIndexVisibility  (env LINK_INDEX_ACK_REQUIRED=true)
//     → ExecutionResult.linkIndexAck surfaced into the REST response body
//
// The two production patches under test:
//   * src/actions/actionExecutor.ts  — ExecutionResult.linkIndexAck populated
//     from application.linkIndexAck (declarative branch).
//   * src/routes/actions.ts          — /apply successBody spreads linkIndexAck.
//
// Lane: vitest.osv2-serving.config.ts (osv2_serving PG/CH/Kafka; singleFork;
//       testTimeout 300s). Topology is real: PG → outbox → drainer → Kafka →
//       CH Kafka-engine → MV → versioned-edge table → confirmEdgeIndexVisibility.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import net from "node:net";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import request from "supertest";
import { query } from "../../src/db";
import linksRouter from "../../src/routes/links";
import actionsRouter from "../../src/routes/actions";
import { limiter } from "../../src/middleware/rateLimiter";
import {
  buildEdgeDomain,
  ensureOsv2IndexTemplate,
  setServingMode,
  type EdgeDomainFixture,
} from "./_harness";
import { startLinkCdcDrainer } from "../../src/services/searchAround/linkCdcOutbox";
import { shutdownCdcLinkProducer } from "../../src/services/searchAround/cdcLinkProducer";
import {
  ensureLinkIngestTopology,
  linkTableName,
  type LinkTypeDescriptor,
} from "../../src/services/searchAround/linkMaterializedView";
import { waitForLinkWatermark } from "../../src/services/serving/edgeIndexWatermark";
import { getClickHouseClient } from "../../src/services/searchAround/clickhouseClient";
import { client as osClient } from "../../src/services/opensearch/client";
import { getIndexName } from "../../src/services/opensearch/indexMappingGenerator";

const ONT = "00000000-0000-0000-0000-000000000001"; // canonical singleton
const ch = () => getClickHouseClient();

// minimal v2 object doc shape (mirrors cdc-topology-e2e-integration.test.ts).
async function seedOaObjects(tag: string, otApi: string, pks: string[]) {
  for (const pk of pks) {
    await osClient.index({
      // IMPORTANT: the editApplicator post-commit OS write is a bulk
      // UPDATE by `_id = edit.primaryKey` (editApplicator.ts:671). If the
      // doc's `_id` is auto-generated (the precedent's mistake for the
      // direct-stage path), the update throws `document_missing_exception`
      // → failedEdits>0 → result "partial" instead of "success". Pin the
      // `_id` to the primary key so the update resolves.
      id: pk,
      index: getIndexName(otApi),
      body: {
        __pk: pk,
        __objectType: otApi,
        __ontology: ONT,
        kind: tag,
      },
      refresh: "wait_for",
    });
  }
}

// ---------------------------------------------------------------------------
// App: mount BOTH the actions router (under test) and the public links
// router (for searchAround read-after-write). Same shim security principal
// as _harness.buildOsv2RouteApp — systemPrincipal + markingBypass so the
// declarative action's Stage 1c CBAC gate passes and indexed-mode reads are
// unfiltered.
// ---------------------------------------------------------------------------
function buildActionApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as Record<string, unknown>).security = {
      userId: "e2e-serve-system",
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
  app.use("/api/v1/ontology/:ontologyId/linkTypes", linksRouter);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res
      .status((err as { statusCode?: number }).statusCode ?? 500)
      .json({ error: { code: (err as { statusCode?: number }).statusCode ?? 500, message: err.message } });
  });
  return app;
}

// ---------------------------------------------------------------------------
// Action-type seeding: one declarative addLink / removeLink action per link.
// All required action_type columns per src/models/actionType.ts and the
// automate-repository raw-INSERT template (tests/integration/automate/
// automate-repository-integration.test.ts:145).
// ---------------------------------------------------------------------------
async function seedLinkAction(
  fix: EdgeDomainFixture,
  kind: "addLink" | "removeLink",
  apiSuffix: string,
): Promise<string> {
  const apiName = `${fix.linkApiName}-${apiSuffix}`;
  const parameters = [
    { apiName: "sourcePk", displayName: "Source PK", type: "string", required: true },
    { apiName: "targetPk", displayName: "Target PK", type: "string", required: true },
  ];
  const rules = [
    {
      type: kind,
      linkType: fix.linkApiName,
      sourceObject: { source: "parameter", param: "sourcePk" },
      targetObject: { source: "parameter", param: "targetPk" },
    },
  ];
  await query(
    `INSERT INTO action_type
       (ontology_id, api_name, display_name, parameters, rules,
        is_enabled, created_by, semantics_version, execution_mode, delete_policy)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, true, 'e2e-serve', 1, 'declarative', 'legacy_unchecked')`,
    [fix.ontologyId, apiName, apiName, JSON.stringify(parameters), JSON.stringify(rules)],
  );
  return apiName;
}

async function applyAction(
  app: Express,
  actionApi: string,
  parameters: Record<string, unknown>,
  fix: EdgeDomainFixture,
  headers: Record<string, string> = {},
) {
  const r = await request(app)
    .post(`/api/v1/ontology/${fix.ontologyId}/actions/${actionApi}/apply`)
    .set(headers)
    .send({ parameters, branchId: fix.branchId });
  return { status: r.status, body: r.body, headers: r.headers };
}

async function searchAround(
  app: Express,
  linkApi: string,
  opts: Record<string, unknown> = {},
) {
  const r = await request(app)
    .post(`/api/v1/ontology/${ONT}/linkTypes/${linkApi}/searchAround`)
    .send({ direction: "forward", ...opts });
  return { status: r.status, body: r.body };
}

async function setupDomain(tag: string) {
  const fix = await buildEdgeDomain(tag);
  const desc: LinkTypeDescriptor = {
    sourceObjectType: fix.sourceOtApiName,
    linkName: fix.linkApiName,
    targetObjectType: fix.targetOtApiName,
  };
  await ensureLinkIngestTopology(desc, ch());
  await seedOaObjects(tag, fix.sourceOtApiName, fix.sourcePKs);
  await seedOaObjects(tag, fix.targetOtApiName, fix.targetPKs);
  await setServingMode("link_type", fix.linkApiName, "indexed");
  return { fix, desc };
}

// highest outbox_seq for this link type — used as the floor for "the new
// Action's event must be visible past this point" watermark probes.
async function maxOutboxSeq(linkApiName: string): Promise<number> {
  const r = await query(
    `SELECT COALESCE(max(outbox_seq), 0) AS m FROM link_cdc_outbox WHERE link_type_api_name = $1`,
    [linkApiName],
  );
  return Number(r.rows[0].m);
}

// ---------------------------------------------------------------------------
// Kafka readiness gate. The lane broker (tellus-kafka-1) can take ~1 min to
// recover 200+ leftover topic partitions after a host/container restart; it
// does NOT bind 9092 until log recovery completes, and even after the TCP
// socket opens the transactional coordinator can report "loading" for a few
// seconds. Cases that `ensureLinkCdcTopic` or publish before the broker is
// ready see CreateTopics timeouts / InitProducerId rejects and the ack
// barrier can't confirm. Block beforeAll until TCP-9092 is open, plus a
// short grace for the coordinator, so cases stand on a live broker.
// ---------------------------------------------------------------------------
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function tcpOpen(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise<boolean>((res) => {
    const s = net.connect(port, host);
    const t = setTimeout(() => {
      s.destroy();
      res(false);
    }, timeoutMs);
    s.on("connect", () => {
      clearTimeout(t);
      s.destroy();
      res(true);
    });
    s.on("error", () => {
      clearTimeout(t);
      res(false);
    });
  });
}

async function waitForKafkaReady(timeoutMs = 120_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await tcpOpen("localhost", 9092)) {
      await sleep(3_000); // grace: coordinator finishes loading shortly after TCP opens
      console.log("[ack-gate] kafka broker reachable on localhost:9092");
      return;
    }
    await sleep(2_000);
  }
  throw new Error("kafka broker not reachable on localhost:9092 within 120s — aborting lane");
}

// ---------------------------------------------------------------------------
// Env save/restore — LINK_INDEX_ACK_REQUIRED must be "true" (strict string
// equality at editApplicator.ts:826) for the barrier to run.
// ---------------------------------------------------------------------------
let savedAckRequired: string | undefined;
let savedAckTimeout: string | undefined;

describe("STAGE 2 — Action read-after-write (linkIndexAck REST contract)", () => {
  beforeAll(async () => {
    await ensureOsv2IndexTemplate();
    savedAckRequired = process.env.LINK_INDEX_ACK_REQUIRED;
    savedAckTimeout = process.env.LINK_INDEX_ACK_TIMEOUT_MS;
    process.env.LINK_INDEX_ACK_REQUIRED = "true";
    process.env.LINK_INDEX_ACK_TIMEOUT_MS = "90000";
    // Block until the lane broker is past log-recovery + coordinator
    // loading — otherwise the early cases see CreateTopics timeouts and
    // can't confirm the ack barrier.
    await waitForKafkaReady();
    // drop stale action_type rows from prior lane cycles (tag-randomised,
    // so collisions are impossible; this just keeps the lane DB tidy).
    await query(
      `DELETE FROM action_type WHERE api_name LIKE '%_link-adder' OR api_name LIKE '%_link-remover'`,
    ).catch(() => {});
  });

  afterAll(async () => {
    process.env.LINK_INDEX_ACK_REQUIRED = savedAckRequired;
    process.env.LINK_INDEX_ACK_TIMEOUT_MS = savedAckTimeout;
    await shutdownCdcLinkProducer();
    // kill the in-memory rate-limiter's 60s cleanup interval so the fork
    // can exit cleanly (the lane config does not set forceExit). This file
    // is the only OSv2-lane consumer of the actions router / limiter.
    try {
      limiter.destroy();
    } catch {}
  });

  it("ADD Action completes only after the edge is queryable — linkIndexAck.confirmed surfaces in the REST body", async () => {
    const tag = `ack_add_${Math.random().toString(36).slice(2, 8)}`;
    const { fix } = await setupDomain(tag);
    const adderApi = await seedLinkAction(fix, "addLink", "adder");
    const app = buildActionApp();
    const stop = startLinkCdcDrainer(400);
    try {
      const r = await applyAction(app, adderApi, { sourcePk: "s-1", targetPk: "t-1" }, fix);
      console.log("[ack-ADD] status/body:", r.status, JSON.stringify(r.body).slice(0, 500));
      expect(r.status).toBe(200);
      expect(r.body.result).toBe("success");
      // Production patch 1+2: the verdict is surfaced to the REST client.
      expect(r.body.linkIndexAck).toBeDefined();
      expect(r.body.linkIndexAck.confirmed).toBe(true);
      expect(r.body.linkIndexAck.waitedMs).toBeGreaterThanOrEqual(0);
      // "completes only AFTER queryable": at response time the edge is
      // synchronously visible via public REST (read-after-write consistency).
      const after = await searchAround(app, fix.linkApiName, { sourcePK: "s-1" });
      console.log("[ack-ADD] after.status/body:", after.status, JSON.stringify(after.body).slice(0, 300));
      expect(after.status).toBe(200);
      const json = JSON.stringify(after.body);
      expect(json.includes("t-1") || (after.body?.totalCount ?? 0) >= 1).toBe(true);
      // the watermark must have advanced to the staged event. NOTE:
      // outbox_seq is a GLOBAL BIGSERIAL across all link types — a fresh
      // link type's first row inherits the current global seq (not 1) —
      // so minOffset must be the row's actual seq (max for this link type
      // post-apply), not `beforeSeq+1`.
      const afterSeq = await maxOutboxSeq(fix.linkApiName);
      expect(afterSeq).toBeGreaterThan(0);
      await expect(
        waitForLinkWatermark({
          scope: { tenantId: "", ontologyId: fix.ontologyId, branchId: fix.branchId },
          linkTypeApiName: fix.linkApiName,
          minOffset: afterSeq,
          timeoutMs: 30_000,
        }),
      ).resolves.toBeUndefined();
    } finally {
      stop();
    }
  }, 240_000);

  it("REMOVE then re-ADD: versioned projection drives the REST contract across the lifecycle", async () => {
    const tag = `ack_rm_${Math.random().toString(36).slice(2, 8)}`;
    const { fix } = await setupDomain(tag);
    const adderApi = await seedLinkAction(fix, "addLink", "adder");
    const removerApi = await seedLinkAction(fix, "removeLink", "remover");
    const app = buildActionApp();
    const stop = startLinkCdcDrainer(400);
    const count = (b: Record<string, unknown>) => (b?.totalCount as number) ?? -1;
    try {
      // ADD
      const a = await applyAction(app, adderApi, { sourcePk: "s-1", targetPk: "t-1" }, fix);
      expect(a.status).toBe(200);
      expect(a.body.linkIndexAck?.confirmed).toBe(true);
      const rAdd = await searchAround(app, fix.linkApiName, {});
      expect(count(rAdd.body)).toBeGreaterThanOrEqual(1);
      // REMOVE (REST emits removeLink only; retraction comes via OSDK v2)
      const rm = await applyAction(app, removerApi, { sourcePk: "s-1", targetPk: "t-1" }, fix);
      expect(rm.status).toBe(200);
      expect(rm.body.linkIndexAck?.confirmed).toBe(true);
      const rRm = await searchAround(app, fix.linkApiName, {});
      expect(count(rRm.body)).toBeLessThanOrEqual(0);
      // re-ADD recreates the edge
      const a2 = await applyAction(app, adderApi, { sourcePk: "s-1", targetPk: "t-1" }, fix);
      expect(a2.status).toBe(200);
      expect(a2.body.linkIndexAck?.confirmed).toBe(true);
      const rRe = await searchAround(app, fix.linkApiName, {});
      expect(count(rRe.body)).toBeGreaterThanOrEqual(1);
    } finally {
      stop();
    }
  }, 240_000);

  it("barrier is NOT fabricated: CH-engine outage → response honestly reports confirmed:false", async () => {
    const tag = `ack_out_${Math.random().toString(36).slice(2, 8)}`;
    const { fix, desc } = await setupDomain(tag);
    const adderApi = await seedLinkAction(fix, "addLink", "adder");
    const app = buildActionApp();
    // Detach the CH ingest engine: drop the MV + Kafka-engine table. The
    // versioned-edge table (what confirmEdgeIndexVisibility probes) stays,
    // but receives no new rows → the barrier cannot confirm on a fresh
    // event. (Mirrors cdc-topology-e2e "engine outage".)
    const tbl = linkTableName(desc);
    await ch().command(`DROP VIEW IF EXISTS ${tbl}__mv`);
    await ch().command(`DROP TABLE IF EXISTS ${tbl}__kafka`);
    const savedTimeout = process.env.LINK_INDEX_ACK_TIMEOUT_MS;
    process.env.LINK_INDEX_ACK_TIMEOUT_MS = "8000";
    const stop = startLinkCdcDrainer(400);
    try {
      const r = await applyAction(app, adderApi, { sourcePk: "s-2", targetPk: "t-2" }, fix);
      console.log("[ack-OUTAGE] status/body:", r.status, JSON.stringify(r.body).slice(0, 500));
      // Committed PG edit + unconfirmed ack ⇒ 202 COMMITTED_INDEX_PENDING —
      // NEVER a client-visible failure (the mutation is durable in PG).
      expect(r.status).toBe(202);
      expect(r.status).not.toBeGreaterThanOrEqual(400);
      expect(r.body.result).toBe("COMMITTED_INDEX_PENDING");
      expect(r.body.executionId).toBeDefined();
      expect(r.body.statusUrl).toBe(`/api/v1/audit/log/${r.body.executionId}`);
      expect(r.body.linkIndexAck).toBeDefined();
      expect(r.body.linkIndexAck.confirmed).toBe(false); // NOT fabricated
      expect(r.body.linkIndexAck.reason).toBe("timeout");
      // and the edge is genuinely absent at completion time
      const after = await searchAround(app, fix.linkApiName, { sourcePK: "s-2" });
      expect(after.status).toBe(200);
      expect((after.body?.totalCount ?? 0)).toBe(0);
    } finally {
      stop();
      process.env.LINK_INDEX_ACK_TIMEOUT_MS = savedTimeout;
    }
  }, 120_000);

  it("ingest outage → DEFERRED; recreate ingest + re-apply resumes the acknowledgement", async () => {
    // The OSv2 lane runs test files in PARALLEL, so this case must NOT
    // pause the shared Kafka broker (that breaks sibling files' CDC).
    // Instead it detaches ONLY this link type's CH ingest engine (DROP
    // MV + kafka-engine table) — scoped, broker-untouched, safe under
    // parallel execution — then recreates it and re-applies the adder to
    // prove the recovery: the deferred verdict flips to confirmed:true.
    const tag = `ack_rsm_${Math.random().toString(36).slice(2, 8)}`;
    const { fix, desc } = await setupDomain(tag);
    const adderApi = await seedLinkAction(fix, "addLink", "adder");
    const app = buildActionApp();
    const savedTimeout = process.env.LINK_INDEX_ACK_TIMEOUT_MS;
    const tbl = linkTableName(desc);
    const stop = startLinkCdcDrainer(400);
    try {
      // --- outage: detach this link type's CH ingest engine only. ---
      process.env.LINK_INDEX_ACK_TIMEOUT_MS = "12000";
      await ch().command(`DROP VIEW IF EXISTS ${tbl}__mv`);
      await ch().command(`DROP TABLE IF EXISTS ${tbl}__kafka`);
      const r1 = await applyAction(app, adderApi, { sourcePk: "s-1", targetPk: "t-1" }, fix);
      console.log("[ack-RECOVER] deferred status/body:", r1.status, JSON.stringify(r1.body).slice(0, 500));
      // Committed PG edit + unconfirmed ack ⇒ 202 COMMITTED_INDEX_PENDING —
      // NEVER a client-visible failure (the mutation is durable in PG).
      expect(r1.status).toBe(202);
      expect(r1.body.result).toBe("COMMITTED_INDEX_PENDING"); // PG/OS durable regardless
      expect(r1.body.executionId).toBeDefined();
      expect(r1.body.statusUrl).toBe(`/api/v1/audit/log/${r1.body.executionId}`);
      expect(r1.body.linkIndexAck).toBeDefined();
      expect(r1.body.linkIndexAck.confirmed).toBe(false); // edge NOT queryable
      expect(r1.body.linkIndexAck.reason).toBe("timeout");
      const during = await searchAround(app, fix.linkApiName, { sourcePK: "s-1" });
      expect((during.body?.totalCount ?? 0)).toBe(0);

      // --- restart: recreate the ingest engine, give the recovery barrier
      // the full window, then re-apply the adder. The first event's kafka
      // message is never re-consumed (the recreated Kafka engine reads from
      // latest), so recovery is proven by a FRESH addLink Action whose
      // barrier confirms once the recreated engine catches up. ---
      await ensureLinkIngestTopology(desc, ch());
      process.env.LINK_INDEX_ACK_TIMEOUT_MS = "90000";
      const r2 = await applyAction(app, adderApi, { sourcePk: "s-1", targetPk: "t-1" }, fix);
      console.log("[ack-RECOVER] resumed status/body:", r2.status, JSON.stringify(r2.body).slice(0, 500));
      expect(r2.status).toBe(200);
      expect(r2.body.linkIndexAck).toBeDefined();
      expect(r2.body.linkIndexAck.confirmed).toBe(true); // edge NOW queryable
      const after = await searchAround(app, fix.linkApiName, { sourcePK: "s-1" });
      console.log("[ack-RECOVER] after.status/body:", after.status, JSON.stringify(after.body).slice(0, 300));
      expect(after.status).toBe(200);
      expect((after.body?.totalCount ?? 0)).toBeGreaterThanOrEqual(1);
    } finally {
      stop();
      process.env.LINK_INDEX_ACK_TIMEOUT_MS = savedTimeout;
    }
  }, 120_000);

  it("idempotency: duplicate retry returns the cached response with exactly one active edge; cross-scope isolation holds", async () => {
    const tag = `ack_idm_${Math.random().toString(36).slice(2, 8)}`;
    const { fix, desc } = await setupDomain(tag);
    const adderApi = await seedLinkAction(fix, "addLink", "adder");
    const app = buildActionApp();
    const stop = startLinkCdcDrainer(400);
    try {
      const idemKey = randomUUID();
      const r1 = await applyAction(app, adderApi, { sourcePk: "s-1", targetPk: "t-1" }, fix, {
        "Idempotency-Key": idemKey,
      });
      expect(r1.status).toBe(200);
      expect(r1.body.linkIndexAck?.confirmed).toBe(true);
      // duplicate retry — same Idempotency-Key
      const r2 = await applyAction(app, adderApi, { sourcePk: "s-1", targetPk: "t-1" }, fix, {
        "Idempotency-Key": idemKey,
      });
      expect(r2.status).toBe(200);
      expect(r2.headers["x-idempotency-cached"]).toBe("true");
      // exactly one active edge in the public REST read
      const after = await searchAround(app, fix.linkApiName, { sourcePK: "s-1" });
      expect((after.body?.totalCount ?? 0)).toBe(1);
      // and exactly one active edge in CH. The versioned table is per
      // link-type (no link_type_api_name column — identity is the table
      // itself), ENGINE=ReplacingMergeTree(event_version) so FINAL gives
      // the collapsed view; for one idempotent ADD it must be exactly 1.
      const activeN = await ch().exec<{ n: number }>(
        `SELECT count() AS n FROM ${linkTableName(desc)} FINAL
         WHERE source_pk = 's-1' AND target_pk = 't-1' AND deleted = 0
         FORMAT JSONEachRow`,
      );
      expect(Number(activeN[0].n)).toBe(1);
      // cross-scope isolation: probes under a DIFFERENT scope see nothing
      const leak = await ch().exec<{ n: number }>(
        `SELECT count() AS n FROM ${linkTableName(desc)}
         WHERE tenant_id = 'OTHER_TENANT' FORMAT JSONEachRow`,
      );
      expect(Number(leak[0].n)).toBe(0);
    } finally {
      stop();
    }
  }, 240_000);
});
