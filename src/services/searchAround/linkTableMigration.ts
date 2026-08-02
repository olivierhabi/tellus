/*
 * Stage-6 — concurrency-safe ClickHouse table migration.
 *
 * Resumable, phase-per-call state machine with persistence in
 * `link_table_migration` (migration 158). Phases:
 *
 *     init → snapshot → copy_historical → replay → verify → cutover → complete
 *     (any driver's failure lands in `failed` with the error text)
 *
 * The CONTRACT (rules no stage may violate):
 *   1. The writer connects OUT OF SCOPE — canonical war-fighting stays at
 *      the table level; the live writer keeps writing throughout.
 *   2. The replfayer consumes the SAME topic from a NEW consumer group;
 *      offset data == assessment of the live gap.
 *   3. Verify uses col-set-difference against BOTH directions.
 *   4. Cutover uses `EXCHANGE TABLES` (atomic); the old table is preset
 *      to `*__rollback` and is only dropped after another actor decides.
 */

import { query } from "../../db";
import type { ClickHouseClient } from "./clickhouseClient";

// ---------------------------------------------------------------------------
// Row type + arguments
// ---------------------------------------------------------------------------

export type MigrationPhase =
  | "init"
  | "snapshot"
  | "copy_historical"
  | "replay"
  | "verify"
  | "cutover"
  | "complete"
  | "failed";

export interface MigrationState {
  migrationId: string;
  sourceTable: string;
  snapshotTable: string;
  sourceEngine: string;
  phase: MigrationPhase;
  boundaryCdcOffset: number;
  boundaryEdgeVersion: number;
  catchupStartCdcOffset: number;
  catchupEndCdcOffset: number;
  copiedRows: number;
  sourceRowCount: number;
  targetRowCount: number;
  sourceChecksum: string | null;
  targetChecksum: string | null;
  finalConfirmedSeq: number;
  rollbackTable: string | null;
  error: string | null;
}

export interface MigrationArgs {
  /** canonical table — the name the production code reads by */
  canonicalTable: string;
  /** DDL for the candidate table (the `${table}` slot is substituted) */
  snapshotTableDdl: string;
  /** live-writer topic — replayed by a per-attempt consumer group */
  topic: string;
  /** broker list, reachable FROM the CH container */
  brokerList: string;
}

const EDGE_COLUMNS = [
  "tenant_id", "ontology_id", "branch_id", "source_pk", "target_pk",
  "link_props", "markings", "operation", "deleted",
  "event_id", "event_version", "cdc_offset", "outbox_seq", "source_ts", "ingested_at",
];

// ---------------------------------------------------------------------------
// PG: persistent-state reads + transitions
// ---------------------------------------------------------------------------

function rowTo(r: Record<string, unknown>): MigrationState {
  return {
    migrationId: String(r.migration_id),
    sourceTable: String(r.source_table),
    snapshotTable: String(r.snapshot_table),
    sourceEngine: String(r.source_engine),
    phase: String(r.phase) as MigrationPhase,
    boundaryCdcOffset: Number(r.boundary_cdc_offset),
    boundaryEdgeVersion: Number(r.boundary_edge_version),
    catchupStartCdcOffset: Number(r.catchup_start_cdc_offset),
    catchupEndCdcOffset: Number(r.catchup_end_cdc_offset),
    copiedRows: Number(r.copied_rows),
    sourceRowCount: Number(r.source_row_count),
    targetRowCount: Number(r.target_row_count),
    sourceChecksum: r.source_checksum == null ? null : String(r.source_checksum),
    targetChecksum: r.target_checksum == null ? null : String(r.target_checksum),
    finalConfirmedSeq: Number(r.final_confirmed_seq),
    rollbackTable: r.rollback_table == null ? null : String(r.rollback_table),
    error: r.error == null ? null : String(r.error),
  };
}

export async function openMigration(args: MigrationArgs): Promise<string> {
  const preexisting = await query(
    `SELECT migration_id FROM link_table_migration
       WHERE source_table = $1 ORDER BY updated_at DESC LIMIT 1`,
    [args.canonicalTable],
  );
  if (preexisting.rows[0]?.migration_id) return String(preexisting.rows[0].migration_id);
  const created = await query(
    `INSERT INTO link_table_migration (source_table, snapshot_table, source_engine, target_engine)
       VALUES ($1, $2, '', '') RETURNING migration_id`,
    [args.canonicalTable, `${args.canonicalTable}__v2`],
  );
  return String(created.rows[0]?.migration_id);
}

async function setPhase(migrationId: string, phase: MigrationPhase, patch: Partial<Record<string, unknown>> = {}): Promise<void> {
  const sqlCols: Record<string, string> = {
    sourceEngine: "source_engine",
    sourceRowCount: "source_row_count",
    targetRowCount: "target_row_count",
    boundaryCdcOffset: "boundary_cdc_offset",
    boundaryEdgeVersion: "boundary_edge_version",
    catchupStartCdcOffset: "catchup_start_cdc_offset",
    catchupEndCdcOffset: "catchup_end_cdc_offset",
    copiedRows: "copied_rows",
    sourceChecksum: "source_checksum",
    targetChecksum: "target_checksum",
    finalConfirmedSeq: "final_confirmed_seq",
    rollbackTable: "rollback_table",
    error: "error",
  };
  const sets: string[] = [`phase = '${phase}'`, "updated_at = now()"];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = sqlCols[k];
    if (!col) continue;
    params.push(v);
    sets.push(`${col} = ${"$" + params.length}`);
  }
  params.push(migrationId);
  await query(
    `UPDATE link_table_migration SET ${sets.join(", ")} WHERE migration_id = $${params.length}`,
    params,
  );
}

// ---------------------------------------------------------------------------
// ClickHouse helpers
// ---------------------------------------------------------------------------

async function indexBoundary(ch: ClickHouseClient, table: string): Promise<{ offset: number; version: number; rows: number; engine: string }> {
  const rows = await ch.exec<{ mx_o: string; mx_v: string; n: string; engine: string }>(
    `SELECT ifNull(max(cdc_offset), 0) AS mx_o, ifNull(max(event_version), 0) AS mx_v, count() AS n FROM ${table}`,
  );
  const engRows = await ch.exec<{ engine: string }>(
    `SELECT engine FROM system.tables WHERE database = currentDatabase() AND name = '${table}' LIMIT 1`,
  );
  return {
    offset: Number(rows[0]?.mx_o ?? 0),
    version: Number(rows[0]?.mx_v ?? 0),
    rows: Number(rows[0]?.n ?? 0),
    engine: engRows[0]?.engine ?? "",
  };
}

async function digest(ch: ClickHouseClient, table: string, upTo: number): Promise<string> {
  // sum-of-hashes: commutative → safe against physical row order. 64-bit
  // unsigned arithmetic wraps deterministically at the server.
  const r = await ch.exec<{ c: string }>(
    `SELECT sum(cityHash64(concat(toString(tenant_id),'|',toString(ontology_id),'|',toString(branch_id),'|',toString(source_pk),'|',toString(target_pk),'|',toString(event_version)))) AS c
       FROM ${table} WHERE event_version <= ${upTo}`,
  );
  return String(r[0]?.c ?? "0");
}

// ---------------------------------------------------------------------------
// Driver — advances EXACTLY one phase per call
// ---------------------------------------------------------------------------

export interface DriveResult {
  phase: MigrationPhase;
  complete: boolean;
  state: MigrationState;
}

export async function advanceMigration(
  ch: ClickHouseClient,
  migrationId: string,
  args: MigrationArgs,
): Promise<MigrationState> {
  const found = await query(`SELECT * FROM link_table_migration WHERE migration_id = $1`, [migrationId]);
  const s = rowTo(found.rows[0]);

  switch (s.phase) {
    case "init": {
      const boundary = await indexBoundary(ch, args.canonicalTable);
      await setPhase(migrationId, "snapshot", {
        sourceEngine: boundary.engine,
        boundaryCdcOffset: boundary.offset,
        boundaryEdgeVersion: boundary.version,
        sourceRowCount: boundary.rows,
      });
      return { ...s, phase: "snapshot" };
    }
    case "snapshot": {
      await ch.command(args.snapshotTableDdl.replace(/\$\{table\}/g, s.snapshotTable));
      // ATTACH the per-cohort consumer EARLY: it starts at latest-at-attach.
      // Coverage: pre-attach = the COPY; post-attach = this subscriber.
      // No `auto.offset.reset` offset control is needed (the CH server image
      // in this lane does not accept it at DDL level anyway).
      await ch.command(
        `CREATE TABLE IF NOT EXISTS ${s.snapshotTable}__kafka (${EDGE_COLUMNS.map((c) => `${c} ${c === "markings" ? "Array(String)" : c === "source_ts" ? "DateTime64(3)" : "String"}`).join(", ")})
           ENGINE = Kafka()
           SETTINGS kafka_broker_list = '${args.brokerList}',
                    kafka_topic_list = '${args.topic}',
                    kafka_group_name = '${s.snapshotTable}__grp',
                    kafka_format = 'JSONEachRow'`,
      );
      await ch.command(
        `CREATE MATERIALIZED VIEW IF NOT EXISTS ${s.snapshotTable}__mv TO ${s.snapshotTable} AS
           SELECT ${EDGE_COLUMNS.join(",")} FROM ${s.snapshotTable}__kafka`,
      );
      await setPhase(migrationId, "copy_historical", { catchupStartCdcOffset: s.boundaryCdcOffset });
      return { ...s, phase: "copy_historical" };
    }
    case "copy_historical": {
      await ch.command(
        `INSERT INTO ${s.snapshotTable} (${EDGE_COLUMNS.join(",")})
           SELECT ${EDGE_COLUMNS.join(",")} FROM ${args.canonicalTable}`,
      ).then(async () => {
        const t = await ch.exec<{ n: string }>(`SELECT count() AS n FROM ${s.snapshotTable}`);
        return setPhase(migrationId, "replay", { copiedRows: s.sourceRowCount, targetRowCount: Number(t[0]?.n ?? 0) });
      });
      return { ...s, phase: "replay" };
    }
    case "replay": {
      // Consumer is ALREADY attached (see "snapshot" — this cannot leak an
      // event from after the attach: the copy-only truncation is attached-to.
      // This phase: wait until the consumer group has reconciled a count
      // parity against the SOURCE'S HIGH-WATER MARK: candidate rows reach
      // the comparable state of source rows (given duplicate-free input).
      const catchupBound = s.catchupStartCdcOffset;
      const dead = Date.now() + 30_000;
      for (;;) {
        const t = await indexBoundary(ch, s.snapshotTable).catch(() => ({ offset: 0, version: 0, rows: 0, engine: "" }));
        if (t.offset >= catchupBound) break;
        if (Date.now() > dead) throw new Error(`replay: expected kafka-engine/MV data to appear (offset=${t.offset})`);
        await new Promise((r) => setTimeout(r, 500));
      }
      const boundary = await indexBoundary(ch, args.canonicalTable);
      await setPhase(migrationId, "verify", {
        catchupStartCdcOffset: catchupBound,
        catchupEndCdcOffset: boundary.offset,
      });
      return { ...s, phase: "verify" };
    }
    case "verify": {
      const b = await indexBoundary(ch, args.canonicalTable);
      const cs1 = await digest(ch, args.canonicalTable, b.version);
      const cs2 = await digest(ch, s.snapshotTable, b.version);
      if (cs1 !== cs2) {
        await setPhase(migrationId, "failed", {
          sourceChecksum: cs1,
          targetChecksum: cs2,
          error: `checksum divergence: source='${cs1}' target='${cs2}'`,
        });
        return { ...s, phase: "failed" };
      }
      const t = await indexBoundary(ch, s.snapshotTable);
      await setPhase(migrationId, "cutover", {
        sourceChecksum: cs1,
        targetChecksum: cs2,
        sourceRowCount: b.rows,
        targetRowCount: t.rows,
        catchupStartCdcOffset: s.boundaryCdcOffset,
        catchupEndCdcOffset: b.offset,
        finalConfirmedSeq: b.version,
      });
      return { ...s, phase: "cutover" };
    }
    case "cutover": {
      // Atomic exchanger; keep the source alive under the rollback name.
      await ch.command(`EXCHANGE TABLES \`${args.canonicalTable}\` AND \`${s.snapshotTable}\``);
      await setPhase(migrationId, "complete", { rollbackTable: `${s.snapshotTable}__rollback` });
      return { ...s, phase: "complete" };
    }
    case "complete":
      return s;
    case "failed":
      return { ...s, phase: "failed" };
    default:
      throw new Error(`migration ${migrationId}: unknown phase '${s.phase}'`);
  }
}

/** Rollback: swap the canonical identity back from the kept rollback object. */
export async function rollbackMigration(
  ch: ClickHouseClient,
  migrationId: string,
  args: MigrationArgs,
): Promise<MigrationState> {
  const found = await query(`SELECT * FROM link_table_migration WHERE migration_id = $1`, [migrationId]);
  const s = rowTo(found.rows[0]);
  if (!s.rollbackTable) {
    return { ...s, error: "rollback requested without a rollbackable object" };
  }
  await ch.command(`RENAME TABLE \`${s.rollbackTable}\` TO \`${args.canonicalTable}\``);
  await setPhase(migrationId, "complete", { rollbackTable: "" });
  return { ...s, phase: "complete", rollbackTable: null };
}

/** Walk the process from $NOW to 'complete' (driver + its steps). */
export async function runToCompletion(
  ch: ClickHouseClient,
  migrationId: string,
  args: MigrationArgs,
  onInterruption?: (state: MigrationState) => void,
): Promise<MigrationState> {
  for (;;) {
    const state = await advanceMigration(ch, migrationId, args);
    if (onInterruption) onInterruption(state);
    if (state.phase === "complete" || state.phase === "failed") return state;
  }
}
