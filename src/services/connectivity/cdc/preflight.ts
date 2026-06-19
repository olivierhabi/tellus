// ---------------------------------------------------------------------------
// B7 — CDC preflight (spec §B7 line 349, 359).
//
// Single route POST /connections/:rid/cdc/preflight runs the v1 SQL probes
// against the target PG and returns a per-check pass/fail map. Each failing
// check ships exact fix-SQL the operator can paste into psql.
// ---------------------------------------------------------------------------

import { getPool } from "../connectors/postgresql/pool";
import type { PreflightResultT } from "./contracts";

export async function runPreflight(connectionRid: string): Promise<PreflightResultT> {
  const pool = await getPool(connectionRid);
  const checks: PreflightResultT["checks"] = [];

  // wal_level=logical
  const walLevel = await pool.query<{ wal_level: string }>(
    `SHOW wal_level`,
  );
  checks.push({
    name: "wal_level",
    ok: walLevel.rows[0]?.wal_level === "logical",
    observed: walLevel.rows[0]?.wal_level,
    expected: "logical",
    fixSql:
      walLevel.rows[0]?.wal_level === "logical"
        ? undefined
        : `ALTER SYSTEM SET wal_level = 'logical'; -- requires restart`,
  });

  // max_replication_slots >= 1
  const slots = await pool.query<{ max_replication_slots: string }>(
    `SHOW max_replication_slots`,
  );
  const slotsN = Number(slots.rows[0]?.max_replication_slots ?? 0);
  checks.push({
    name: "max_replication_slots",
    ok: slotsN >= 1,
    observed: String(slotsN),
    expected: ">= 1",
    fixSql:
      slotsN >= 1
        ? undefined
        : `ALTER SYSTEM SET max_replication_slots = 10; -- requires restart`,
  });

  // max_wal_senders >= 1
  const senders = await pool.query<{ max_wal_senders: string }>(
    `SHOW max_wal_senders`,
  );
  const sendersN = Number(senders.rows[0]?.max_wal_senders ?? 0);
  checks.push({
    name: "max_wal_senders",
    ok: sendersN >= 1,
    observed: String(sendersN),
    expected: ">= 1",
    fixSql:
      sendersN >= 1
        ? undefined
        : `ALTER SYSTEM SET max_wal_senders = 10; -- requires restart`,
  });

  // current user has REPLICATION
  const repl = await pool.query<{ rolreplication: boolean }>(
    `SELECT rolreplication FROM pg_roles WHERE rolname = current_user`,
  );
  const hasRepl = repl.rows[0]?.rolreplication === true;
  checks.push({
    name: "role_replication",
    ok: hasRepl,
    observed: String(hasRepl),
    expected: "true",
    fixSql: hasRepl
      ? undefined
      : `ALTER ROLE ${escapeIdent("CURRENT_USER")} REPLICATION;`,
  });

  // CREATE privilege on database (required for CREATE PUBLICATION)
  const createPriv = await pool.query<{ has: boolean }>(
    `SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS has`,
  );
  const hasCreate = createPriv.rows[0]?.has === true;
  checks.push({
    name: "database_create_priv",
    ok: hasCreate,
    observed: String(hasCreate),
    expected: "true",
    fixSql: hasCreate
      ? undefined
      : `GRANT CREATE ON DATABASE current_database() TO CURRENT_USER;`,
  });

  const ok = checks.every((c) => c.ok);
  return { ok, checks };
}

function escapeIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}
