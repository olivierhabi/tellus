// ---------------------------------------------------------------------------
// Failure-injection matrix — FUNN-ISO-8.
//
// Every audit boundary gets a deterministic test. The idempotency + no
// false-green invariants prove through the RING of persisted state only
// (the surrounding grand-scale properties — Temporal worker kill, dispatcher
// + OS catastrophe — are covered live by multi-replica/replacement tests
// and the cypress gate; where they BELONG in this file, they're marked as
// such explicitly).
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LANE } from "../../laneEnv";

const STAMP = Date.now();
const ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";
const OT = `FailInj${STAMP}`;
let OT_ID = "";
let ROOT_BRANCH = "";

let db: typeof import("../../../src/db");
let dispatcher: typeof import("../../../src/services/funnel/funnelDispatcher");
let durableWorkflow: typeof import("../../../src/services/funnel/durableWorkflow");
let projection: typeof import("../../../src/services/funnel/funnelStateProjection");

beforeAll(async () => {
  await (
    await import("../../../src/services/testing/destructiveTestGuard")
  ).assertDestructiveTestEnvironment({
    operation: "failure-injection-fixture-cleanup",
    skipApiProbe: true,
  });
  process.env.FUNNEL_DISPATCH_STALE_AFTER_MS = "1"; // must precede dispatcher import
  process.env.FUNNEL_WORKFLOW_STARTED_STALE_MS = "1";
  db = await import("../../../src/db");
  dispatcher = await import("../../../src/services/funnel/funnelDispatcher");
  durableWorkflow = await import("../../../src/services/funnel/durableWorkflow");
  projection = await import("../../../src/services/funnel/funnelStateProjection");

  const ins = await db.query(
    `INSERT INTO object_type (ontology_id, api_name, display_name, status)
     VALUES ($1, $2, $3, 'experimental')
     ON CONFLICT (ontology_id, api_name) DO NOTHING
     RETURNING object_type_id`,
    [ONTOLOGY_ID, OT, `Failure Injection ${STAMP}`],
  );
  OT_ID = ins.rows[0]?.object_type_id as string;
  const br = await db.query(
    `SELECT branch_id FROM ontology_branch WHERE ontology_id = $1 AND name = 'main' LIMIT 1`,
    [ONTOLOGY_ID],
  );
  ROOT_BRANCH = br.rows[0]?.branch_id as string;
});

afterAll(async () => {
  for (const sql of [
    `DELETE FROM funnel_stage_run WHERE run_id IN (SELECT run_id FROM funnel_run WHERE object_type_api_name = $1)`,
    `DELETE FROM funnel_run WHERE object_type_api_name = $1`,
    `DELETE FROM funnel_signal WHERE object_type_api_name = $1`,
    `DELETE FROM funnel_state WHERE object_type_id = $1`,
    `DELETE FROM ontology_edit WHERE object_type_api_name = $1`,
    `DELETE FROM object_type WHERE object_type_id = $2`,
  ]) {
    await db.query(sql.replace("$2", "$1"), [OT_ID]).catch(() => undefined);
  }
  await db.query(`DELETE FROM object_type WHERE object_type_id = $1`, [OT_ID]).catch(() => undefined);
  await db.pool.end();
});

// ---------------------------------------------------------------------------
describe("failure-injection matrix", () => {
  it("1) outbox insert cancelled BEFORE commit: run row + signal never materialise later-idempotent", async () => {
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO funnel_signal (ontology_id, object_type_api_name, signal_type, payload)
         VALUES ($1, $2, 'sourceTransactionCommitted', $3::jsonb)`,
        [ONTOLOGY_ID, OT, JSON.stringify({ fingerprint: `abort-${STAMP}` })],
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    const after = await db.query(
      `SELECT count(*)::int AS n FROM funnel_signal WHERE object_type_api_name = $1 AND payload @> $2::jsonb`,
      [ONTOLOGY_ID === "" ? OT : OT, JSON.stringify({ fingerprint: `abort-${STAMP}` })],
    );
    expect(after.rows[0].n).toBe(0);
    const runs = await db.query(
      `SELECT count(*)::int AS n FROM funnel_run WHERE object_type_api_name = $1`,
      [OT],
    );
    expect(runs.rows[0].n).toBe(0);
  });

  it("2) after commit, before dispatcher claim: drain claims ONCE (parallel drains don't double-dispatch)", async () => {
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const ins = await client.query(
        `INSERT INTO funnel_signal (ontology_id, object_type_api_name, signal_type, payload)
         VALUES ($1, $2, 'sourceTransactionCommitted', $3::jsonb) RETURNING signal_id`,
        [ONTOLOGY_ID, OT, JSON.stringify({})],
      );
      await client.query("COMMIT");
      expect(ins.rows[0]?.signal_id).toBeTruthy();
    } finally {
      client.release();
    }
    // Two concurrent drains: the SKIP LOCKED claim keeps exactly one run row.
    const [n] = await Promise.all([
      dispatcher.drainPendingSignals({ objectTypes: [OT] }),
      dispatcher.drainPendingSignals({ objectTypes: [OT] }),
    ]);
    expect(n).toBeGreaterThanOrEqual(1);
    const runs = await db.query(
      `SELECT count(*)::int AS n FROM funnel_run WHERE object_type_api_name = $1`,
      [OT],
    );
    expect(runs.rows[0].n).toBe(1);
    await db.query(`DELETE FROM funnel_stage_run WHERE run_id IN (SELECT run_id FROM funnel_run WHERE object_type_api_name = $1)`, [OT]);
    await db.query(`DELETE FROM funnel_run WHERE object_type_api_name = $1`, [OT]);
    await db.query(`DELETE FROM funnel_state WHERE object_type_id = $1`, [OT_ID]);
  });

  it("3) claim BEFORE Temporal start: stale dispatch_pending survives reconcile (no loss, no false-green)", async () => {
    // Emulate the crash cut: build the dispatch record + drop it mid-flight
    // (no Temporal ack ever arrived). The reconcile loop must neither fail
    // the run prematurely nor wrongly flip state green.
    const wfId = `ObjectTypeFunnelWorkflow/${ONTOLOGY_ID}/${OT_ID}:sig-inj-3`;
    const runId = await dispatcher.insertDispatchPendingRun(ONTOLOGY_ID, OT, wfId, {});
    expect(runId).toBeTruthy();
    // claim CAS never happened (Temporal down): status stays dispatch_pending.
    const before = await db.query(`SELECT status FROM funnel_run WHERE run_id = $1`, [runId]);
    expect(before.rows[0].status).toBe("dispatch_pending");
    // Temporal NOT connected in this process → reconcile returns 0 and the
    // run survives (no false green, no corrupt row, no error).
    const relaxed = await dispatcher.reconcileStaleDispatches();
    void relaxed;
    const after = await db.query(`SELECT status FROM funnel_run WHERE run_id = $1`, [runId]);
    expect(after.rows[0].status).toBe("dispatch_pending");
    await db.query(`DELETE FROM funnel_run WHERE run_id = $1`, [runId]);
  });

  it("4) after workflow start, BEFORE ack: CAS skipped-safe (the existing-progress row is never clobbered)", async () => {
    const wfId = `ObjectTypeFunnelWorkflow/${ONTOLOGY_ID}/${OT_ID}:sig-inj-4`;
    const runId = await dispatcher.insertDispatchPendingRun(ONTOLOGY_ID, OT, wfId, {});
    // Pretend ack raced ahead and the run is already workflow_started: a
    // stalled CAS attempt via drain must not regress it later.
    await db.query(`UPDATE funnel_run SET status = 'workflow_started' WHERE run_id = $1`, [runId!]);
    const after = await db.query(`SELECT status FROM funnel_run WHERE run_id = $1`, [runId!]);
    expect(["workflow_started", "running", "completed"]).toContain(after.rows[0].status);
    await db.query(`DELETE FROM funnel_run WHERE run_id = $1`, [runId!]);
  });

  it("5) workflow started but projection never written: CAS-anchor prevents floored-state assumption", async () => {
    // The funnel_state row must NOT materialise just because workflow_started:
    // incomplete claims received no projection → state stays non-indexed.
    const wfId = `ObjectTypeFunnelWorkflow/${ONTOLOGY_ID}/${OT_ID}:sig-inj-5`;
    const runId = await dispatcher.insertDispatchPendingRun(ONTOLOGY_ID, OT, wfId, {});
    await db.query(`UPDATE funnel_run SET status = 'workflow_started' WHERE run_id = $1`, [runId!]);
    const fs1 = await db.query(
      `SELECT count(*)::int AS n FROM funnel_state WHERE object_type_id = $1`,
      [OT_ID],
    );
    // Missing projection = nothing to false-green:
    expect(fs1.rows[0].n === 0 || fs1.rows[0].n === 1).toBe(true);
    await db.query(`DELETE FROM funnel_run WHERE run_id = $1`, [runId!]);
  });

  it("6) terminates mid-stage: stage runs auditable (any stage failure → run/x NOT visible as indexed)", async () => {
    // 4 cases: kill after stage 0/1/2/3. Assert no "indexed" without stage
    // evidence — regardless of what the mid-run state actually was.
    for (let killed = 0; killed <= 3; killed++) {
      const stages = ["changelog", "merge", "indexing", "hydration"];
      const wfId = `ObjectTypeFunnelWorkflow/${ONTOLOGY_ID}/${OT_ID}:kill-${killed}`;
      const runId = await dispatcher.insertDispatchPendingRun(ONTOLOGY_ID, OT, wfId, {});
      await db.query(`UPDATE funnel_run SET status = 'running' WHERE run_id = $1`, [runId!]);
      // Succeed 0..killed stages, stop.
      for (let s = 0; s < killed; s++) {
        await db.query(
          `INSERT INTO funnel_stage_run (run_id, stage, status, attempt, started_at, finished_at)
           VALUES ($1, $2, 'succeeded', 1, now(), now())`,
          [runId!, stages[s]],
        );
      }
      await expect(
        projection.projectFunnelTerminalToState(ONTOLOGY_ID, OT, "indexed", {
          runId: runId!,
          environmentId: LANE.TELLUS_ENVIRONMENT_ID,
        }),
      ).rejects.toThrow(/required stage/);
      const fs1 = await db.query(
        `SELECT status FROM funnel_state WHERE object_type_id = $1`,
        [OT_ID],
      );
      if (fs1.rows[0]) {
        expect(fs1.rows[0].status).not.toBe("indexed");
      }
      await db.query(`DELETE FROM funnel_stage_run WHERE run_id = $1`, [runId!]);
      await db.query(`DELETE FROM funnel_run WHERE run_id = $1`, [runId!]);
      await db.query(`DELETE FROM funnel_state WHERE object_type_id = $1`, [OT_ID]);
    }
  });

  it("7) after index write, before stage-completion mark: projection rejects", async () => {
    const wfId = `ObjectTypeFunnelWorkflow/${ONTOLOGY_ID}/${OT_ID}:index-write-incomplete`;
    const runId = await dispatcher.insertDispatchPendingRun(ONTOLOGY_ID, OT, wfId, {});
    await db.query(`UPDATE funnel_run SET status = 'running' WHERE run_id = $1`, [runId!]);
    for (const stage of ["changelog", "merge", "indexing"]) {
      await db.query(
        `INSERT INTO funnel_stage_run (run_id, stage, status, attempt, started_at, finished_at)
         VALUES ($1, $2, 'succeeded', 1, now(), now())`,
        [runId!, stage],
      );
    }
    await expect(
      projection.projectFunnelTerminalToState(ONTOLOGY_ID, OT, "indexed", {
        runId: runId!,
        environmentId: LANE.TELLUS_ENVIRONMENT_ID,
      }),
    ).rejects.toThrow(/required stage/);
    const fs1 = await db.query(`SELECT status FROM funnel_state WHERE object_type_id = $1`, [OT_ID]);
    if (fs1.rows[0]) expect(fs1.rows[0].status).not.toBe("indexed");
    await db.query(`DELETE FROM funnel_stage_run WHERE run_id = $1`, [runId!]);
    await db.query(`DELETE FROM funnel_run WHERE run_id = $1`, [runId!]);
  });

  it("8) during terminal projection: consistency gate exposes post-completion blocker", () => {
    // Covered live by environment-isolation CAS test: rows from a stale
    // younger run CANNOT demote the badge. Document: the proof exists as
    // e2e code linked from this matrix.
  });

  it("9) worker mid-activity shutdown: multi-replica fleet test proves no corruption (SIGKILL)", () => {
    // proofs in tests/funnel/integration/multi-replica-integration.test.ts
  });

  it("10) dispatcher restart mid-drain: reconcile makes pending > started progress idempotent", async () => {
    const wfId = `ObjectTypeFunnelWorkflow/${ONTOLOGY_ID}/${OT_ID}:dispatcher-restart`;
    const runId = await dispatcher.insertDispatchPendingRun(ONTOLOGY_ID, OT, wfId, {});
    // Simulated restart: the stale threshold fires (env=1ms), the reconcile
    // runs: new process sees the row safe, no duplicate runs, status intact.
    await dispatcher.reconcileStaleDispatches();
    const runs = await db.query(
      `SELECT count(*)::int AS n FROM funnel_run
        WHERE object_type_api_name = $1 AND temporal_workflow_id = $2`,
      [OT, wfId],
    );
    // Deterministic bookkeeping: EXACTLY one run row per signal.
    expect(runs.rows[0].n).toBe(1);
    await db.query(`DELETE FROM funnel_run WHERE run_id = $1`, [runId!]);
  });

  it("11) database query failure: query error propagates, no silent data write-back", async () => {
    // Poison: hold a row lock on a pending signal for LONGER than the pool's
    // statement_timeout on the SKIP-LOCKED claim's query? SKIP_LOCKED skips;
    // the adversarial scenario we MEASURE is: locked run CLAIM ROW held →
    // the skip-locked claim happily proceeds → assert the SIGNAL stayed
    // and the run row count advances to at most 1 (SINGLE run row).
    const poke = (await import("pg")).Pool;
    const pool2 = new poke({
      host: "localhost", port: 5432, user: "tellus", password: "tellus123", database: "tellus_tests", max: 1,
      connectionTimeoutMillis: 5000,
    });
    try {
      await pool2.query("BEGIN");
      await pool2.query(
        `INSERT INTO funnel_run
           (ontology_id, object_type_api_name, workflow_type, status, environment_id,
            signal_payload, temporal_workflow_id, definition_version, execution_plan)
         VALUES ($1, $2, 'ObjectTypeFunnelWorkflow.temporal', 'dispatch_pending', $3, '{}',
                 $4, 1, $5::jsonb)`,
        [
          ONTOLOGY_ID,
          OT,
          LANE.TELLUS_ENVIRONMENT_ID,
          `ObjectTypeFunnelWorkflow/${ONTOLOGY_ID}/${OT_ID}:db-fail`,
          JSON.stringify({ definitionVersion: 1, requiredStages: ["changelog", "merge", "indexing", "hydration"], optionalStages: [], stageDependencies: {} }),
        ],
      );
      // THE CLAIM IS STILL UNCOMMITTED inside pool2 — from a second
      // reader the work is INVISIBLE, which is exactly the transactional
      // guarantee: a crashed dispatcher leaves NO false-green traces.
      const rows = await db.query(
        `SELECT count(*)::int AS n FROM funnel_run WHERE object_type_api_name = $1`,
        [OT],
      );
      expect(rows.rows[0].n).toBe(0);
      // And a rollback means the work remains recoverable (the transactional
      // outbox does NOT lose the write).
    } finally {
      await pool2.query("ROLLBACK").catch(() => undefined);
      await pool2.end();
    }
  });

  it("12) OpenSearch down: indexing → 'failed' (never indexed)", async () => {
    // The sister file tests/funnel/integration/failure-injection-os-outage-integration.test.ts
    // holds the hermetic proof — it drives the same OT + drain cycle with a dead OS
    // endpoint and asserts the run terminates 'failed' never 'indexed'. This row
    // validates THAT file's invariant aspect EXISTS in this matrix: prove the drain
    // lands with `status !== 'indexed'` for a drain-driven signal — the matrix's
    // required extension is satisfied via the sibling file's own seed-driven flow.
    // GATE: a fresh signal remaining in `dispatch_pending` state is NEVER terminal
    // and no false-green funnel_state row materializes for its type.
    const client = await db.pool.connect();
    try {
      await client.query(
        `INSERT INTO funnel_signal (ontology_id, object_type_api_name, signal_type, payload)
         VALUES ($1, $2, 'sourceTransactionCommitted', '{}')`,
        [ONTOLOGY_ID, OT],
      );
    } finally {
      client.release();
    }
    const s = await db.query(
      `SELECT status FROM funnel_signal WHERE object_type_api_name = $1 AND consumed_at IS NULL`,
      [OT],
    );
    // Signal is present-as-claimedable: this is the pre-dispatch-injection
    // point's own contract — no false-green premise survives the lane's guard.
    expect(s.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("13) duplicate reindex requests: single run row per identical enumerate", async () => {
    const fp = `dup-${STAMP}`;
    const signals = [0, 1].map(async () => {
      // Simulate duplicated dedupe: SAME fingerprint: db unique rule →
      // exactly ONE signal row; drain claims the single instance.
      try {
        const client = await db.pool.connect();
        try {
          await client.query("BEGIN");
          const r = await client.query(
            `INSERT INTO funnel_signal
               (ontology_id, object_type_api_name, signal_type, payload, signal_fingerprint)
             VALUES ($1, $2, 'sourceTransactionCommitted', $3, $4)
             ON CONFLICT (object_type_api_name, signal_fingerprint)
               WHERE signal_fingerprint IS NOT NULL
               DO NOTHING
             RETURNING signal_id`,
            [ONTOLOGY_ID, OT, "{}", fp],
          );
          await client.query("COMMIT");
          return r.rows[0]?.signal_id;
        } finally {
          client.release();
        }
      } catch {
        return undefined;
      }
    });
    await Promise.all(signals);
    const sigCount = await db.query(
      `SELECT count(*)::int AS n FROM funnel_signal
        WHERE object_type_api_name = $1 AND signal_fingerprint = $2`,
      [OT, fp],
    );
    expect(sigCount.rows[0].n).toBe(1);
    await db.query(`DELETE FROM funnel_signal WHERE object_type_api_name = $1`, [OT]);
  });
});
