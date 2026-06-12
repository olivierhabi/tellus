// ---------------------------------------------------------------------------
// Integration test for the cancel-build handler.
//
// Builds finish in milliseconds in dev, so a real in-flight cancel is racy.
// Instead this inserts a SYNTHETIC `running` build row and drives the REAL
// `cancelBuild` handler (mock req/res) against the live DB, asserting:
//   - a running build transitions to `cancelled`, a `cancelled` event is
//     appended, and the response is { status: CANCELED, alreadyTerminal: false }
//   - cancelling again is idempotent → { alreadyTerminal: true }
//   - cancelling an unknown rid → 404 BuildNotFound
//
// The synthetic row reuses a real import/connection rid (discovered from the
// latest build) and is cleaned up at the end (events cascade).
//
//   npx tsx scripts/test-build-cancel.ts
// ---------------------------------------------------------------------------
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { cancelBuild } from "../src/services/connectivity/imports/handlers";
import { shutdownBus } from "../src/services/orchestration/build-event-bus";
import pool from "../src/db";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`  ✓ ${msg}`);
}

function makeRes(): { res: Response; getStatus: () => number; getBody: () => any } {
  let status = 200;
  let body: any = null;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: any) {
      body = payload;
      return this;
    },
    set() {
      return this;
    },
  } as unknown as Response;
  return { res, getStatus: () => status, getBody: () => body };
}

async function callCancel(buildRid: string): Promise<{ status: number; body: any }> {
  const { res, getStatus, getBody } = makeRes();
  const req = { params: { buildRid }, headers: {} } as unknown as Request;
  let nextErr: unknown = null;
  await cancelBuild(req, res, ((e?: unknown) => {
    nextErr = e;
  }) as any);
  if (nextErr) throw nextErr;
  return { status: getStatus(), body: getBody() };
}

async function main() {
  // Reuse a real import/connection to satisfy the rid CHECK constraints.
  const ctx = await pool.query<{ import_rid: string; connection_rid: string; tenant: string }>(
    `SELECT import_rid, connection_rid, tenant
       FROM orchestration_builds
      ORDER BY enqueued_at DESC LIMIT 1`,
  );
  if (ctx.rowCount === 0) {
    console.log("[cancel] (no builds in DB to borrow context from — skipped)");
    return;
  }
  const { import_rid, connection_rid, tenant } = ctx.rows[0];
  const buildRid = `ri.foundry.main.build.${randomUUID()}`;

  await pool.query(
    `INSERT INTO orchestration_builds(rid, import_rid, connection_rid, tenant, actor, kind, status, payload, egress, started_at)
     VALUES ($1,$2,$3,$4,'tester','foundryWorker','running','{}'::jsonb,'{}'::jsonb, now())`,
    [buildRid, import_rid, connection_rid, tenant ?? "default"],
  );
  console.log(`\n[cancel] synthetic running build ${buildRid}`);

  try {
    // --- cancel a running build ---------------------------------------------
    const c1 = await callCancel(buildRid);
    assert(c1.status === 200, `cancel returns 200 (got ${c1.status})`);
    assert(c1.body?.status === "CANCELED", `response status CANCELED (got ${c1.body?.status})`);
    assert(c1.body?.rawStatus === "cancelled", `rawStatus cancelled (got ${c1.body?.rawStatus})`);
    assert(c1.body?.alreadyTerminal === false, "alreadyTerminal=false on first cancel");

    const row = await pool.query<{ status: string; ended_at: Date | null }>(
      `SELECT status, ended_at FROM orchestration_builds WHERE rid=$1`,
      [buildRid],
    );
    assert(row.rows[0]?.status === "cancelled", `DB status now 'cancelled' (got ${row.rows[0]?.status})`);
    assert(row.rows[0]?.ended_at != null, "ended_at set");

    const ev = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM orchestration_build_events WHERE build_rid=$1 AND kind='cancelled'`,
      [buildRid],
    );
    assert(Number(ev.rows[0]?.n) >= 1, `a 'cancelled' event was appended (got ${ev.rows[0]?.n})`);

    // --- idempotent re-cancel ------------------------------------------------
    const c2 = await callCancel(buildRid);
    assert(c2.status === 200, `re-cancel returns 200 (got ${c2.status})`);
    assert(c2.body?.alreadyTerminal === true, "alreadyTerminal=true on re-cancel");
    assert(c2.body?.status === "CANCELED", "re-cancel still reports CANCELED");

    // --- unknown rid → 404 ---------------------------------------------------
    const c3 = await callCancel("ri.foundry.main.build.00000000-0000-0000-0000-000000000000");
    assert(c3.status === 404, `unknown build → 404 (got ${c3.status})`);
    assert(
      c3.body?.errorName === "Tellus:Connectivity:BuildNotFound",
      `404 envelope is BuildNotFound (got ${c3.body?.errorName})`,
    );

    console.log(`\nAll assertions passed.\n`);
  } finally {
    // Clean up the synthetic row (events cascade on delete).
    await pool.query(`DELETE FROM orchestration_builds WHERE rid=$1`, [buildRid]).catch(() => {});
  }
}

main()
  .catch((e) => {
    console.error("FAILED:", e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdownBus().catch(() => {});
    await pool.end().catch(() => {});
  });
