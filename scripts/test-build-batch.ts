// ---------------------------------------------------------------------------
// Integration test for the multi-job Build (group) read + cancel aggregation.
//
// Inserts two synthetic imports + two synthetic `orchestration_builds` rows that
// share a group_rid (the lead build's rid), then drives the REAL `getBuild` and
// `cancelBuild` handlers (mock req/res) against the live DB, asserting:
//   - getBuild(anyMember) returns ONE Build (rid = lead) with jobs[] for every
//     member, an AGGREGATE status (RUNNING while any job runs), and SUMMED rows.
//   - flipping the running job to succeeded makes the Build SUCCEEDED + sums.
//   - cancelBuild on a terminal Build is idempotent (alreadyTerminal=true).
//   - cancelBuild on a Build with running jobs cancels ALL of them
//     (alreadyTerminal=false) and the Build aggregates to CANCELED.
//   - getBuild(unknown) → 404 BuildNotFound.
//
// Synthetic rows reuse a real connection (discovered from the latest build) and
// are cleaned up at the end (events + imports cascade / are deleted).
//
//   npx tsx scripts/test-build-batch.ts
// ---------------------------------------------------------------------------
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { getBuild, cancelBuild } from "../src/services/connectivity/imports/handlers";
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

async function callGet(buildRid: string): Promise<{ status: number; body: any }> {
  const { res, getStatus, getBody } = makeRes();
  const req = { params: { buildRid }, headers: {} } as unknown as Request;
  let nextErr: unknown = null;
  await getBuild(req, res, ((e?: unknown) => {
    nextErr = e;
  }) as any);
  if (nextErr) throw nextErr;
  return { status: getStatus(), body: getBody() };
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
  const ctx = await pool.query<{ connection_rid: string; tenant: string }>(
    `SELECT connection_rid, tenant FROM orchestration_builds ORDER BY enqueued_at DESC LIMIT 1`,
  );
  if (ctx.rowCount === 0) {
    console.log("[batch] (no builds to borrow a connection from — skipped)");
    return;
  }
  const { connection_rid, tenant } = ctx.rows[0];

  const impA = `ri.magritte.main.extract.${randomUUID()}`;
  const impB = `ri.magritte.main.extract.${randomUUID()}`;
  const lead = `ri.foundry.main.build.${randomUUID()}`; // build 1 = group lead
  const second = `ri.foundry.main.build.${randomUUID()}`; // build 2 = member

  const cleanup = async () => {
    await pool
      .query(`DELETE FROM orchestration_builds WHERE rid = ANY($1)`, [[lead, second]])
      .catch(() => {});
    await pool.query(`DELETE FROM table_imports WHERE rid = ANY($1)`, [[impA, impB]]).catch(() => {});
  };

  try {
    // Two real imports so the build->import JOIN resolves.
    const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
    await pool.query(
      `INSERT INTO table_imports(rid, connection_rid, dataset_rid, display_name, config, created_by)
       VALUES ($1,$2,$3,'alpha_raw',$4::jsonb,$8),
              ($5,$2,$6,'beta_raw',$7::jsonb,$8)`,
      [
        impA,
        connection_rid,
        `ri.foundry.main.dataset.${randomUUID()}`,
        JSON.stringify({ mode: "snapshot", table: "alpha", schema: "public" }),
        impB,
        `ri.foundry.main.dataset.${randomUUID()}`,
        JSON.stringify({ mode: "snapshot", table: "beta", schema: "public" }),
        ZERO_UUID,
      ],
    );

    // Build group: lead succeeded (10 rows), member still running. group_rid is
    // the lead's rid for BOTH members.
    await pool.query(
      `INSERT INTO orchestration_builds(rid, import_rid, connection_rid, tenant, actor, kind, status, group_rid, payload, egress, started_at, ended_at, rows_written)
       VALUES ($1,$2,$3,$4,'tester','foundryWorker','succeeded',$1,'{}'::jsonb,'{}'::jsonb, now(), now(), 10)`,
      [lead, impA, connection_rid, tenant ?? "default"],
    );
    await pool.query(
      `INSERT INTO orchestration_builds(rid, import_rid, connection_rid, tenant, actor, kind, status, group_rid, payload, egress, started_at)
       VALUES ($1,$2,$3,$4,'tester','foundryWorker','running',$5,'{}'::jsonb,'{}'::jsonb, now())`,
      [second, impB, connection_rid, tenant ?? "default", lead],
    );
    console.log(`\n[batch] group lead=${lead}  member=${second}`);

    // --- read the group from EITHER member rid ------------------------------
    const g1 = await callGet(lead);
    assert(g1.status === 200, `getBuild(lead) 200 (got ${g1.status})`);
    assert(g1.body?.rid === lead, `top-level rid is the lead/group rid`);
    assert(Array.isArray(g1.body?.jobs) && g1.body.jobs.length === 2, `jobs[] has both members (got ${g1.body?.jobs?.length})`);
    assert(g1.body?.status === "RUNNING", `aggregate status RUNNING while a job runs (got ${g1.body?.status})`);
    assert(g1.body?.rowsWritten === 10, `rowsWritten summed across jobs (got ${g1.body?.rowsWritten})`);
    assert(g1.body?.endedAt == null, `endedAt null until every job ends`);

    const g2 = await callGet(second);
    assert(g2.body?.rid === second, `getBuild(member) echoes the requested rid`);
    assert(g2.body?.jobs?.length === 2, `getBuild(member) still returns the full group jobs[]`);
    const g2JobRids = (g2.body.jobs as any[]).map((j) => j.rid).sort();
    assert(
      JSON.stringify(g2JobRids) === JSON.stringify([lead, second].sort()),
      `getBuild(member) jobs[] are the same group members`,
    );

    const tables = (g1.body.jobs as any[]).map((j) => j.import?.table).sort();
    assert(JSON.stringify(tables) === JSON.stringify(["alpha", "beta"]), `each job carries its own table (${tables.join(",")})`);

    // --- finishing the running job makes the Build SUCCEEDED + re-sums -------
    await pool.query(
      `UPDATE orchestration_builds SET status='succeeded', ended_at=now(), rows_written=5 WHERE rid=$1`,
      [second],
    );
    const g3 = await callGet(lead);
    assert(g3.body?.status === "SUCCEEDED", `Build SUCCEEDED once all jobs succeed (got ${g3.body?.status})`);
    assert(g3.body?.rowsWritten === 15, `rowsWritten re-summed to 15 (got ${g3.body?.rowsWritten})`);
    assert(g3.body?.endedAt != null, `endedAt set once every job ended`);

    // --- cancel on a fully-terminal Build is idempotent ---------------------
    const c1 = await callCancel(lead);
    assert(c1.body?.alreadyTerminal === true, `cancel on finished Build → alreadyTerminal=true`);
    assert(c1.body?.status === "SUCCEEDED", `cancel preserves the terminal status (got ${c1.body?.status})`);

    // --- cancel-all: flip both to running, cancel the group -----------------
    await pool.query(`UPDATE orchestration_builds SET status='running', ended_at=NULL WHERE rid = ANY($1)`, [[lead, second]]);
    const c2 = await callCancel(second); // cancel via the NON-lead member rid
    assert(c2.body?.alreadyTerminal === false, `cancel with running jobs → alreadyTerminal=false`);
    assert(c2.body?.status === "CANCELED", `Build aggregates to CANCELED (got ${c2.body?.status})`);
    const after = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM orchestration_builds WHERE rid = ANY($1) AND status='cancelled'`,
      [[lead, second]],
    );
    assert(Number(after.rows[0].n) === 2, `BOTH jobs were cancelled in the DB (got ${after.rows[0].n})`);
    const evts = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM orchestration_build_events WHERE build_rid = ANY($1) AND kind='cancelled'`,
      [[lead, second]],
    );
    assert(Number(evts.rows[0].n) === 2, `a cancelled event was appended per job (got ${evts.rows[0].n})`);

    // --- unknown rid → 404 --------------------------------------------------
    const g404 = await callGet("ri.foundry.main.build.00000000-0000-0000-0000-000000000000");
    assert(g404.status === 404, `getBuild(unknown) → 404 (got ${g404.status})`);

    console.log(`\nAll assertions passed.\n`);
  } finally {
    await cleanup();
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
