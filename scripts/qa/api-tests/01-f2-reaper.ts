// F2 — Webhook execution reaper + idempotent completion (API + repository test).
//
// Verifies the F2 fix against the real running backend + real DB:
//   1. Uses an existing webhook (created by prior test runs) to insert a
//      'queued' execution directly via the repository — simulating a process
//      death BEFORE the external request was sent.
//   2. Calls reapOrphanedExecutions(0) — staleAfterMs=0 means everything in
//      queued/running is stale. Verifies the execution is marked 'failed'
//      with error_code='ORPHANED'.
//   3. Calls completeExecution on the reaped execution — verifies it's a
//      no-op (idempotent: the WHERE status IN ('queued','running') guard
//      prevents clobbering a terminal row).
//   4. Also verifies the reaper does NOT touch terminal ('succeeded')
//      executions.
//
// This is a hybrid test: API login (real Keycloak) + direct repository calls
// (the reaper is a repository function, not an HTTP endpoint). The
// repository calls run against the same live DB the backend uses.

import { getApiContext, assert } from "./harness.js";
import { pool } from "../../../src/db.js";
import {
  createExecution,
  reapOrphanedExecutions,
  completeExecution,
  getExecution,
  markExecutionRunning,
} from "../../../src/services/connectivity/webhooks/repository.js";
import { randomUUID } from "node:crypto";

async function main(): Promise<void> {
  // 0. Log in via the real backend (proves the system is live + authed).
  const ctx = await getApiContext("admin");
  console.log(`[F2] logged in as ${ctx.username}`);

  // 1. Find an existing webhook to attach the test execution to.
  const wh = await pool.query(
    "SELECT rid, tenant, current_version FROM connectivity_webhook WHERE archived_at IS NULL LIMIT 1",
  );
  if (wh.rows.length === 0) {
    console.log("[F2] SKIP — no webhooks exist in the DB; create one first");
    return;
  }
  const webhookRid = wh.rows[0].rid as string;
  const tenant = wh.rows[0].tenant as string;
  const webhookVersion = Number(wh.rows[0].current_version);
  console.log(`[F2] using webhook ${webhookRid} v${webhookVersion}`);

  // 2. Insert a 'queued' execution — simulates a process death right after
  //    createExecution committed but before markExecutionRunning ran.
  const { execution: orphan } = await createExecution({
    tenant,
    webhookRid,
    webhookVersion,
    kind: "production",
    correlationId: randomUUID(),
    idempotencyKeyHash: randomUUID(),
    triggeredBy: ctx.username,
    inputSummary: { test: "f2-reaper" },
  });
  assert(orphan.status === "queued", `orphan should start queued, got ${orphan.status}`);
  console.log(`[F2] created orphan execution ${orphan.rid} (status=${orphan.status})`);

  // 3. Insert a 'succeeded' execution to verify the reaper spares terminal rows.
  const { execution: terminal } = await createExecution({
    tenant,
    webhookRid,
    webhookVersion,
    kind: "test",
    correlationId: randomUUID(),
    idempotencyKeyHash: randomUUID(),
    triggeredBy: ctx.username,
    inputSummary: { test: "f2-terminal" },
  });
  await markRunningAndComplete(terminal.rid);
  console.log(`[F2] created terminal execution ${terminal.rid} (status=succeeded)`);

  // 4. Run the reaper with staleAfterMs=0 — everything queued/running is stale.
  const reaped = await reapOrphanedExecutions(0);
  assert(reaped >= 1, `reaper should reap >=1 execution, got ${reaped}`);
  console.log(`[F2] reaper reaped ${reaped} execution(s)`);

  // 5. Verify the orphan is now 'failed' with 'ORPHANED'.
  const reapedOrphan = await getExecution(orphan.rid, tenant);
  assert(
    reapedOrphan.status === "failed",
    `orphan should be 'failed' after reaping, got '${reapedOrphan.status}'`,
  );
  assert(
    reapedOrphan.errorCode === "ORPHANED",
    `error_code should be 'ORPHANED', got '${reapedOrphan.errorCode}'`,
  );
  assert(
    reapedOrphan.completedAt !== null,
    "completed_at should be set after reaping",
  );
  console.log(
    `[F2] orphan reaped: status=${reapedOrphan.status} errorCode=${reapedOrphan.errorCode} completedAt=${reapedOrphan.completedAt}`,
  );

  // 6. Verify the terminal execution was NOT reaped.
  const terminalAfter = await getExecution(terminal.rid, tenant);
  assert(
    terminalAfter.status === "succeeded",
    `terminal should stay 'succeeded', got '${terminalAfter.status}'`,
  );
  console.log(`[F2] terminal spared: status=${terminalAfter.status}`);

  // 7. Idempotent completeExecution — calling complete on the already-
  //    terminal orphan must be a no-op (the WHERE status IN ('queued','running')
  //    guard prevents the UPDATE from matching).
  await completeExecution({
    executionRid: orphan.rid,
    status: "succeeded",
    outputSummary: { late: "completion-attempt" },
    durationMs: 100,
  });
  const afterLateComplete = await getExecution(orphan.rid, tenant);
  assert(
    afterLateComplete.status === "failed",
    `late complete must not clobber terminal row; expected 'failed', got '${afterLateComplete.status}'`,
  );
  assert(
    afterLateComplete.errorCode === "ORPHANED",
    `late complete must not overwrite error_code; expected 'ORPHANED', got '${afterLateComplete.errorCode}'`,
  );
  console.log(
    `[F2] idempotent complete: late call was a no-op (status stays ${afterLateComplete.status}/${afterLateComplete.errorCode})`,
  );

  console.log("[F2] ALL ASSERTIONS PASSED");
}

async function markRunningAndComplete(rid: string): Promise<void> {
  await markExecutionRunning(rid);
  await completeExecution({
    executionRid: rid,
    status: "succeeded",
    outputSummary: { test: "terminal" },
    durationMs: 10,
  });
}

main().catch((e) => {
  console.error("[F2] FAILED:", e);
  process.exit(1);
});
