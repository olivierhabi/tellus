// ---------------------------------------------------------------------------
// Integration test for the job-tracker "build details" endpoint.
//
// Exercises the REAL `getBuild` handler against the live dev DB (mock req/res,
// no HTTP/auth) and asserts the response envelope the build-details page
// consumes:
//   - a real build resolves with a Foundry-normalised status + the resource it
//     materialises (import display name / dataset rid / table coordinates), the
//     owning connection, and the append-only event log.
//   - an unknown build rid sends the BuildNotFound (404) envelope.
//
// The build rid is discovered from the DB (not hardcoded) so the test stays
// valid as data changes. Exit non-zero on any failed assertion so it can gate
// CI.
//
//   npx tsx scripts/test-build-details.ts
// ---------------------------------------------------------------------------
import type { Request, Response } from "express";
import { getBuild } from "../src/services/connectivity/imports/handlers";
import pool from "../src/db";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`  ✓ ${msg}`);
}

/** Minimal Express res double capturing status + json body. */
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

async function callGetBuild(buildRid: string): Promise<{ status: number; body: any }> {
  const { res, getStatus, getBody } = makeRes();
  const req = { params: { buildRid } } as unknown as Request;
  let nextErr: unknown = null;
  await getBuild(req, res, ((e?: unknown) => {
    nextErr = e;
  }) as any);
  if (nextErr) throw nextErr;
  return { status: getStatus(), body: getBody() };
}

const FOUNDRY_STATUSES = new Set(["RUNNING", "SUCCEEDED", "FAILED", "CANCELED"]);

async function pickBuildRid(): Promise<string | null> {
  const { rows } = await pool.query<{ rid: string }>(
    `SELECT b.rid
       FROM orchestration_builds b
       JOIN table_imports ti ON ti.rid = b.import_rid
      ORDER BY b.enqueued_at DESC
      LIMIT 1`,
  );
  return rows[0]?.rid ?? null;
}

async function main() {
  // --- happy path: a real build resolves with its resource + events ---------
  const buildRid = await pickBuildRid();
  if (buildRid) {
    console.log(`\n[build] ${buildRid}`);
    const { status, body } = await callGetBuild(buildRid);
    assert(status === 200, `resolves 200 (got ${status})`);
    assert(body?.rid === buildRid, "echoes the build rid");
    assert(FOUNDRY_STATUSES.has(body?.status), `status is a Foundry enum value (got ${body?.status})`);
    assert(typeof body?.rawStatus === "string" && body.rawStatus.length > 0, `rawStatus preserved (${body?.rawStatus})`);
    assert(body?.import && typeof body.import.rid === "string" && body.import.rid.startsWith("ri.magritte.main."), `import.rid is a magritte rid (${body?.import?.rid})`);
    assert(typeof body?.import?.displayName === "string", "import.displayName present");
    assert(typeof body?.import?.datasetRid === "string" && body.import.datasetRid.startsWith("ri.foundry.main.dataset."), `import.datasetRid is a dataset rid (${body?.import?.datasetRid})`);
    assert(body?.connection && typeof body.connection.rid === "string", "connection.rid present");
    assert(Array.isArray(body?.events), "events is an array");
    // Timing/counts fields are present (nullable but defined keys).
    assert("startedAt" in body && "endedAt" in body && "rowsWritten" in body, "timing/count fields are defined");
    // Timestamps are canonical ISO 8601 (so `new Date()` works in every browser).
    const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
    assert(ISO_RE.test(body.enqueuedAt), `enqueuedAt is ISO 8601 (${body.enqueuedAt})`);
    if (body.startedAt) assert(ISO_RE.test(body.startedAt), `startedAt is ISO 8601 (${body.startedAt})`);
    if (body.events[0]) assert(ISO_RE.test(body.events[0].ts), `event ts is ISO 8601 (${body.events[0].ts})`);
    console.log(`    → status=${body.status} rows=${body.rowsWritten ?? "—"} events=${body.events.length}`);
  } else {
    console.log("\n[build] (no builds in DB — run a sync first; happy-path skipped)");
  }

  // --- unknown build rid → 404 BuildNotFound --------------------------------
  console.log(`\n[not-found]`);
  const bogus = await callGetBuild("ri.orchestration.main.build.00000000-0000-0000-0000-000000000000");
  assert(bogus.status === 404, `unknown build rid → 404 (got ${bogus.status})`);
  assert(
    bogus.body?.errorName === "Tellus:Connectivity:BuildNotFound",
    `404 envelope is BuildNotFound (got ${bogus.body?.errorName})`,
  );

  console.log(`\nAll assertions passed.\n`);
}

main()
  .catch((e) => {
    console.error("FAILED:", e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
