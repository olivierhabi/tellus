// ---------------------------------------------------------------------------
// B7 — Logical replication slot + publication lifecycle (spec §B7 line 350).
//
// Algorithm:
//   create  -> CREATE_REPLICATION_SLOT <slot> LOGICAL pgoutput
//              + CREATE PUBLICATION <pub> FOR TABLE ... (or FOR ALL TABLES)
//   attach  -> verify slot exists + is not in use; capture restart_lsn
//   teardown-> DROP PUBLICATION + DROP_REPLICATION_SLOT
//   monitor -> read pg_replication_slots row + emit lag metric
//
// All SQL parameterized; identifiers validated via SAFE_IDENT regex from
// contracts.
// ---------------------------------------------------------------------------

import { getPool } from "../connectors/postgresql/pool";

export interface SlotState {
  slotName: string;
  publicationName: string;
  exists: boolean;
  active: boolean;
  /** Bytes between current WAL position and slot's confirmed flush. */
  lagBytes: number | null;
  restartLsn: string | null;
  confirmedFlushLsn: string | null;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(s: string): string {
  if (!IDENT.test(s)) throw new Error(`invalid identifier: ${s}`);
  return `"${s}"`;
}

export async function getState(
  connectionRid: string,
  slotName: string,
  publicationName: string,
): Promise<SlotState> {
  const pool = await getPool(connectionRid);
  const r = await pool.query<{
    slot_name: string | null;
    active: boolean | null;
    restart_lsn: string | null;
    confirmed_flush_lsn: string | null;
    lag_bytes: string | null;
  }>(
    `SELECT s.slot_name,
            s.active,
            s.restart_lsn::text,
            s.confirmed_flush_lsn::text,
            pg_wal_lsn_diff(pg_current_wal_lsn(), s.confirmed_flush_lsn)::text AS lag_bytes
       FROM pg_replication_slots s
      WHERE s.slot_name = $1`,
    [slotName],
  );
  const row = r.rows[0];
  return {
    slotName,
    publicationName,
    exists: !!row,
    active: row?.active === true,
    restartLsn: row?.restart_lsn ?? null,
    confirmedFlushLsn: row?.confirmed_flush_lsn ?? null,
    lagBytes: row?.lag_bytes != null ? Number(row.lag_bytes) : null,
  };
}

export async function ensureCreated(
  connectionRid: string,
  args: {
    slotName: string;
    publicationName: string;
    tables: Array<{ schema: string; table: string }>;
    publicationAutocreate: "disabled" | "filtered" | "all_tables";
  },
): Promise<void> {
  const pool = await getPool(connectionRid);

  // Publication first (so the slot starts capturing as soon as it's created).
  const pubExists = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_publication WHERE pubname = $1
     ) AS exists`,
    [args.publicationName],
  );
  if (!pubExists.rows[0].exists) {
    if (args.publicationAutocreate === "disabled") {
      throw new Error(
        `publication "${args.publicationName}" does not exist and publication.autocreate.mode=disabled (spec parity)`,
      );
    }
    if (args.publicationAutocreate === "all_tables") {
      await pool.query(
        `CREATE PUBLICATION ${ident(args.publicationName)} FOR ALL TABLES`,
      );
    } else {
      // filtered
      const tbls = args.tables
        .map((t) => `${ident(t.schema)}.${ident(t.table)}`)
        .join(", ");
      if (!tbls) {
        throw new Error(
          `publication.autocreate.mode=filtered requires non-empty config.tables`,
        );
      }
      await pool.query(
        `CREATE PUBLICATION ${ident(args.publicationName)} FOR TABLE ${tbls}`,
      );
    }
  }

  const slotState = await getState(
    connectionRid,
    args.slotName,
    args.publicationName,
  );
  if (!slotState.exists) {
    // pg_create_logical_replication_slot is a function — safe to call from
    // a normal connection (no need for replication protocol).
    await pool.query(
      `SELECT * FROM pg_create_logical_replication_slot($1, 'pgoutput')`,
      [args.slotName],
    );
  }
}

export async function teardown(
  connectionRid: string,
  args: { slotName: string; publicationName: string },
): Promise<void> {
  const pool = await getPool(connectionRid);
  await pool
    .query(`SELECT pg_drop_replication_slot($1)`, [args.slotName])
    .catch(() => undefined);
  await pool
    .query(`DROP PUBLICATION IF EXISTS ${ident(args.publicationName)}`)
    .catch(() => undefined);
}
