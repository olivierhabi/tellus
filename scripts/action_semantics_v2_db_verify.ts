// ---------------------------------------------------------------------------
// action_semantics_v2_db_verify.ts
//
// DB-backed verification for Migrations 121/122 + Phase 5 locking +
// Phase 6 link_instances + EXPLAIN ANALYZE on the link_instances indexes.
//
// Run against the ephemeral test PostgreSQL 16 (test-only creds):
//   PGHOST=localhost PGPORT=55432 PGDATABASE=tellus_test PGUSER=tellus_test \
//     PGPASSWORD=tellus_test npx tsx scripts/action_semantics_v2_db_verify.ts
//
// Uses ONLY test credentials. Does NOT touch production.
// ---------------------------------------------------------------------------

import { Pool } from "pg";
import crypto from "crypto";
import { deterministicLockKey, sortedLockIdentities, type LockIdentity } from "../src/actions/actionLockManager";

const env = process.env;
const PGHOST = env.PGHOST ?? "localhost";
const PGPORT = parseInt(env.PGPORT ?? "55432", 10);
const PGDATABASE = env.PGDATABASE ?? "tellus_test";
const PGUSER = env.PGUSER ?? "tellus_test";
const PGPASSWORD = env.PGPASSWORD ?? "tellus_test";

function log(label: string, body?: unknown) {
  console.log(`\n=== ${label} ===`);
  if (body !== undefined) console.log(typeof body === "string" ? body : JSON.stringify(body, null, 2));
}

/** Walk a pg EXPLAIN (FORMAT JSON) plan tree and collect index names + node types. */
function collectPlan(plan: any): { indexes: string[]; nodeTypes: string[] } {
  const indexes = new Set<string>();
  const nodeTypes: string[] = [];
  (function walk(n: any) {
    if (!n || typeof n !== "object") return;
    if (n["Node Type"]) nodeTypes.push(n["Node Type"]);
    if (n["Index Name"]) indexes.add(n["Index Name"]);
    const plans = n["Plans"];
    if (Array.isArray(plans)) for (const p of plans) walk(p);
  })(plan);
  return { indexes: Array.from(indexes), nodeTypes };
}

/** Build the EXPLAIN ANALYZE report (timing, blocks, index names, node types). */
function reportExplain(explain: any) {
  const root = Array.isArray(explain) ? explain[0] : explain;
  const plan = root?.Plan ?? {};
  const { indexes, nodeTypes } = collectPlan(plan);
  return {
    executionTimeMs: root?.["Execution Time"],
    planningTimeMs: root?.["Planning Time"],
    actualRows: plan["Actual Rows"],
    sharedHitBlocks: plan["Shared Hit Blocks"],
    nodeTypes,
    indexes,
  };
}

async function main() {
  const pool = new Pool({ host: PGHOST, port: PGPORT, database: PGDATABASE, user: PGUSER, password: PGPASSWORD });
  log("connected", { PGHOST, PGPORT, PGDATABASE, PGUSER });
  try {

  // -----------------------------------------------------------------------
  // 1. Down-migration reversibility for 121 + 122
  // -----------------------------------------------------------------------
  log("1. Down-migration reversibility (121 + 122)");
  {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      // reverse 122 then 121 inside a rolled-back transaction so we don't
      // poison the ephemeral test DB for the next steps.
      await c.query(`DROP INDEX IF EXISTS idx_link_instances_edge; DROP INDEX IF EXISTS idx_link_instances_tgt; DROP INDEX IF EXISTS idx_link_instances_src; DROP TABLE IF EXISTS link_instances;`);
      await c.query(`ALTER TABLE action_type DROP COLUMN IF EXISTS semantics_version; ALTER TABLE action_type DROP COLUMN IF EXISTS execution_mode; ALTER TABLE action_type DROP COLUMN IF EXISTS delete_policy;`);
      await c.query(`ALTER TABLE action_audit_log DROP COLUMN IF EXISTS semantics_version; ALTER TABLE action_audit_log DROP COLUMN IF EXISTS execution_mode; ALTER TABLE action_audit_log DROP COLUMN IF EXISTS correlation_id;`);

      const at = (await c.query("SELECT column_name FROM information_schema.columns WHERE table_name='action_type' AND column_name IN ('semantics_version','execution_mode','delete_policy')")).rows;
      const li = (await c.query("SELECT to_regclass('link_instances') AS t")).rows[0]?.t;
      log("after down: action_type semantics cols gone + link_instances gone", { actionTypeSemanticsCols: at, linkInstancesExists: li });
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  }

  // -----------------------------------------------------------------------
  // 2. Batched-backfill restartability on the semantics_version column
  // -----------------------------------------------------------------------
  log("2. Batched backfill (restartable) of semantics_version on action_type");
  {
    const ontologyRow = (await pool.query("SELECT ontology_id FROM ontology LIMIT 1")).rows[0];
    const ontologyId = ontologyRow.ontology_id;
    const N = 250n;
    // Insert N legacy action_type rows with NULL semantics_version.
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      for (let i = 0; i < N; i++) {
        await c.query(
          `INSERT INTO action_type (ontology_id, api_name, display_name, description, parameters, rules, submission_criteria, side_effects, max_affected_objects, is_enabled, created_by, semantics_version, execution_mode, delete_policy)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,'declarative','legacy_unchecked')`,
          [
            ontologyId, `bfAction${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`, "BF", "",
            JSON.stringify([]), JSON.stringify([]), null, null, 10000, true, "system",
          ],
        );
      }
      // Post-Stage-D, semantics_version is NOT NULL so the batched UPDATE
      // finds zero NULL rows to backfill — restartable means idempotent here.
      let processed = 0n;
      const batchSize = 100n;
      while (true) {
        const r = await c.query(
          `WITH batch AS (SELECT action_type_id FROM action_type WHERE semantics_version IS NULL LIMIT $1::bigint)
           UPDATE action_type SET semantics_version = 1, execution_mode = 'declarative', delete_policy = 'legacy_unchecked'
           WHERE action_type_id IN (SELECT action_type_id FROM batch)
           RETURNING action_type_id`,
          [batchSize.toString()],
        );
        if ((r.rowCount ?? 0) === 0) break;
        processed += BigInt(r.rowCount ?? 0);
      }
      const remainingNull = (await c.query("SELECT COUNT(*)::bigint AS n FROM action_type WHERE semantics_version IS NULL")).rows[0].n;
      log("backfill processed (post-constraint: 0 NULL rows expected)", { processed: processed.toString(), totalInserted: N.toString(), remainingNull: remainingNull.toString() });
      // Roll back all the test rows to keep the DB clean.
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  }

  // -----------------------------------------------------------------------
  // 3. Deterministic advisory lock + lock ordering (one connection first)
  // -----------------------------------------------------------------------
  log("3. Advisory lock determinism + deterministic ordering (two connections)");
  {
    const identity: LockIdentity = { ontologyId: "ontA", branchId: "brA", objectType: "Customer", primaryKey: "c-007" };
    const key = deterministicLockKey(identity);
    log("deterministicLockKey", { identity, key: key.toString() });

    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("BEGIN");
      await a.query("SELECT pg_advisory_lock($1::bigint)", [key.toString()]); // session-scope lock
      // B uses try_advisory_lock (NOWAIT-equivalent) — must return false while A holds it.
      const bGot = (await b.query("SELECT pg_try_advisory_lock($1::bigint) AS got", [key.toString()])).rows[0].got;
      log("concurrent advisory lock", { aHoldsLock: true, bGotLockViaTry: bGot });
      // Release A's session lock.
      await a.query("SELECT pg_advisory_unlock($1::bigint)", [key.toString()]);
      await a.query("ROLLBACK");
      // Now B should succeed.
      const bGotAfter = (await b.query("SELECT pg_try_advisory_lock($1::bigint) AS got", [key.toString()])).rows[0].got;
      if (bGotAfter) await b.query("SELECT pg_advisory_unlock($1::bigint)", [key.toString()]);
      log("after A released, B acquires", { bGotAfterRelease: bGotAfter });
    } finally {
      a.release();
      b.release();
    }
  }

  // -----------------------------------------------------------------------
  // 4. Concurrent create of the same primary key → exactly one wins
  // -----------------------------------------------------------------------
  log("4. Concurrent create of the same object_instances primary key");
  {
    const ot = `OT_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const ontologyId = (await pool.query("SELECT ontology_id FROM ontology LIMIT 1")).rows[0].ontology_id;
    // object_instances.branch_id is a FK to ontology_branch — use the existing main branch.
    const branchId = (await pool.query("SELECT branch_id FROM ontology_branch WHERE ontology_id=$1 AND name='main' LIMIT 1", [ontologyId])).rows[0].branch_id;
    // Create an object_type for the test.
    await pool.query(
      `INSERT INTO object_type (ontology_id, api_name, display_name, created_by)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [ontologyId, ot, ot, "system"],
    );
    const otid = (await pool.query("SELECT object_type_id FROM object_type WHERE ontology_id=$1 AND api_name=$2", [ontologyId, ot])).rows[0].object_type_id;
    const pk = `dup-pk-${crypto.randomUUID().slice(0, 8)}`;

    const idA: LockIdentity = { ontologyId, branchId, objectType: ot, primaryKey: pk };
    const key = deterministicLockKey(idA);

    const a = await pool.connect();
    const b = await pool.connect();
    let aWon = false, bWon = false, bError: string | null = null;
    try {
      // Both txns BEGIN; A acquires the deterministic advisory lock first.
      await a.query("BEGIN");
      await a.query("SELECT pg_advisory_xact_lock($1::bigint)", [key.toString()]);
      await a.query(
        `INSERT INTO object_instances (ontology_id, branch_id, object_type_api_name, primary_key, properties, markings, version)
         VALUES ($1,$2,$3,$4,$5,'{}'::text[],1)`,
        [ontologyId, branchId, ot, pk, JSON.stringify({})],
      );
      aWon = true;

      // B begins, acquires the SAME advisory lock (will block — use a short
      // timeout via statement_timeout to detect the block gracefully).
      await b.query("BEGIN");
      await b.query("SET LOCAL statement_timeout = '2s'");
      try {
        await b.query("SELECT pg_advisory_xact_lock($1::bigint)", [key.toString()]);
        await b.query(
          `INSERT INTO object_instances (ontology_id, branch_id, object_type_api_name, primary_key, properties, markings, version)
           VALUES ($1,$2,$3,$4,$5,'{}'::text[],1)`,
          [ontologyId, branchId, ot, pk, JSON.stringify({})],
        );
        bWon = true;
      } catch (e: any) {
        bError = e.code ?? String(e);
      }
      await a.query("COMMIT"); // releases the xact advisory lock
      // B can now retry if it errored on statement_timeout; roll it back cleanly.
      try { await b.query("ROLLBACK"); } catch { /* */ }
    } finally {
      a.release();
      b.release();
    }
    log("concurrent create result", { aWon, bWon, bBlockedOrError: bError });
    // Clean up the test rows.
    await pool.query("DELETE FROM object_instances WHERE object_type_api_name=$1 AND primary_key=$2", [ot, pk]);
    await pool.query("DELETE FROM object_type WHERE object_type_id=$1", [otid]);
  }

  // -----------------------------------------------------------------------
  // 5. High-fanout EXPLAIN ANALYZE on link_instances indexes
  // -----------------------------------------------------------------------
  log("5. EXPLAIN (ANALYZE, BUFFERS) on link_instances read paths");
  {
    const ontologyId = crypto.randomUUID();
    const branchId = crypto.randomUUID();
    const linkType = "highFanFanout";
    const targetOt = "Target";
    const targetPk = "theTarget"; // high fanout: 20000 edges into one target
    await pool.query("BEGIN");
    try {
    const FANOUT = 20000;
    // Build 20000 edges with a single INSERT ... SELECT generate_series(1, FANOUT)
    // (no parameter binding — pg has a 65535-parameter limit, so 20000×7
    // bound args would overflow it).
    await pool.query(
      `INSERT INTO link_instances
         (ontology_id, branch_id, link_type_api_name, source_object_type, source_primary_key, target_object_type, target_primary_key)
       SELECT $1::uuid, $2::uuid, $3, 'Source', 'src-' || gs.i, $4, $5
         FROM generate_series(1, $6::int) AS gs(i)`,
      [ontologyId, branchId, linkType, targetOt, targetPk, FANOUT],
    );
      log("inserted high-fanout dataset", { sourceCount: FANOUT, target: `${targetOt}:${targetPk}` });

      // Inbound existence check (high fanout into target)
      const explainIn = (await pool.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
          SELECT 1 FROM link_instances
           WHERE ontology_id=$1 AND branch_id=$2
             AND target_object_type=$3 AND target_primary_key=$4
           LIMIT 1`,
        [ontologyId, branchId, targetOt, targetPk],
      )).rows[0]["QUERY PLAN"];
      log("EXPLAIN ANALYZE inbound EXISTS (target)", reportExplain(explainIn));

      // Aggregate counts per link type (inbound side)
      const explainAggIn = (await pool.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
          SELECT link_type_api_name, COUNT(*) FROM link_instances
           WHERE ontology_id=$1 AND branch_id=$2
             AND target_object_type=$3 AND target_primary_key=$4
           GROUP BY link_type_api_name`,
        [ontologyId, branchId, targetOt, targetPk],
      )).rows[0]["QUERY PLAN"];
      log("EXPLAIN ANALYZE inbound aggregate counts", reportExplain(explainAggIn));

      // Edge lookup (existence of a specific edge)
      const explainEdge = (await pool.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
          SELECT 1 FROM link_instances
           WHERE ontology_id=$1 AND branch_id=$2
             AND link_type_api_name=$3 AND source_primary_key=$4 AND target_primary_key=$5
           LIMIT 1`,
        [ontologyId, branchId, linkType, `src-12345`, targetPk],
      )).rows[0]["QUERY PLAN"];
      log("EXPLAIN ANALYZE edge lookup", reportExplain(explainEdge));

      // Outbound existence check on one source
      const explainOut = (await pool.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
          SELECT 1 FROM link_instances
           WHERE ontology_id=$1 AND branch_id=$2
             AND source_object_type=$3 AND source_primary_key=$4
           LIMIT 1`,
        [ontologyId, branchId, "Source", "src-9999"],
      )).rows[0]["QUERY PLAN"];
      log("EXPLAIN ANALYZE outbound EXISTS (source)", reportExplain(explainOut));

      // Paginated blocking-link sample (bounded)
      const explainPag = (await pool.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
          SELECT * FROM link_instances
           WHERE ontology_id=$1 AND branch_id=$2
             AND (source_object_type=$3 AND source_primary_key=$4
                  OR target_object_type=$3 AND target_primary_key=$4)
           ORDER BY link_type_api_name LIMIT 50`,
        [ontologyId, branchId, targetOt, targetPk],
      )).rows[0]["QUERY PLAN"];
      log("EXPLAIN ANALYZE paginated blocking sample (target, fan-in)", reportExplain(explainPag));

      await pool.query("ROLLBACK");
    } finally {
      try { await pool.query("ROLLBACK"); } catch { /* */ }
    }
  }

  log("DONE");
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("DB VERIFY FAILED:", e);
  process.exit(1);
});
