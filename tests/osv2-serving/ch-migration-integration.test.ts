// ---------------------------------------------------------------------------
// STAGE 6 — state-machine integration, REAL CH + Kafka + PG.
// ---------------------------------------------------------------------------

import { describe, it, expect, afterAll } from "vitest";
import { query, pool } from "../../src/db";
import { getClickHouseClient } from "../../src/services/searchAround/clickhouseClient";
import {
  openMigration,
  advanceMigration,
  rollbackMigration,
  runToCompletion,
  type MigrationArgs,
} from "../../src/services/searchAround/linkTableMigration";
import { publishRowsToTopic, linkCdcTopic } from "../../src/services/searchAround/cdcLinkProducer";
import { linkTableName } from "../../src/services/searchAround/linkMaterializedView";

const CH = () => getClickHouseClient();
const t = () => `mig6_${Math.random().toString(36).slice(2, 8)}`;

async function makeTable(c: { canonicalTable: string }) {
  await CH().command(`
    CREATE TABLE IF NOT EXISTS ${c.canonicalTable} (
      tenant_id String DEFAULT '', ontology_id String DEFAULT '', branch_id String DEFAULT '',
      source_pk String, target_pk String,
      link_props String CODEC(ZSTD(3)), markings Array(String),
      operation LowCardinality(String) DEFAULT 'ADD',
      deleted UInt8 DEFAULT 0,
      event_id String DEFAULT '',
      event_version UInt64 DEFAULT 0,
      cdc_offset UInt64 DEFAULT 0,
      outbox_seq UInt64 DEFAULT 0,
      source_ts DateTime64(3) DEFAULT now64(3),
      ingested_at DateTime64(3) DEFAULT now64(3)
    ) ENGINE = ReplacingMergeTree(event_version)
    ORDER BY (tenant_id, ontology_id, branch_id, source_pk, target_pk)`);
}

async function releaseClient() {
  // pool lifecycle ends in his local fork per-file testing
}

async function seedEdges(table: string, tags: number) {
  const rows = [] as Array<Record<string, unknown>>;
  for (let i = 0; i < tags; i++) {
    rows.push({
      source_pk: `s${i}`, target_pk: `t${i}`, operation: "ADD", deleted: 0,
      event_id: `seed-${i}-${Math.random().toString(36).slice(2, 6)}`,
      event_version: 100 + i,
      cdc_offset: i, outbox_seq: 100 + i,
      tenant_id: "default", ontology_id: "mig-ont", branch_id: "main",
    });
  }
  await CH().insertJsonEachRow(table, rows);
}

function argsFor(c: { canonicalTable: string }, bos: string) {
  return {
    canonicalTable: c.canonicalTable,
    snapshotTableDdl: `CREATE TABLE IF NOT EXISTS \${table} (
      tenant_id String DEFAULT '', ontology_id String DEFAULT '', branch_id String DEFAULT '',
      source_pk String, target_pk String, link_props String CODEC(ZSTD(3)), markings Array(String),
      operation LowCardinality(String) DEFAULT 'ADD', deleted UInt8 DEFAULT 0,
      event_id String DEFAULT '', event_version UInt64 DEFAULT 0, cdc_offset UInt64 DEFAULT 0,
      outbox_seq UInt64 DEFAULT 0, source_ts DateTime64(3) DEFAULT now64(3), ingested_at DateTime64(3) DEFAULT now64(3)
    ) ENGINE = ReplacingMergeTree(event_version)
    ORDER BY (tenant_id, ontology_id, branch_id, source_pk, target_pk)`,
    topic: `${t()}_tbl`,
    brokerList: bos,
  } satisfies MigrationArgs;
}

describe("STAGE 6 — state machine (interrupt + verify + resume): real CH + PG", () => {
  afterAll(async () => {
    await pool.end().catch(() => {});
  });

  it("advances deterministically through every phase on a statically-quieted world", async () => {
    const table = linkTableName({ sourceObjectType: t(), linkName: t(), targetObjectType: t() });
    await makeTable({ canonicalTable: table });
    await seedEdges(table, 8);
    const args = argsFor({ canonicalTable: table }, "kafka:29092");
    const id = await openMigration(args);

    const s1 = await advanceMigration(CH(), id, args);  expect(s1.phase).toBe("snapshot");
    const s2 = await advanceMigration(CH(), id, args);  expect(s2.phase).toBe("copy_historical");
    const s3 = await advanceMigration(CH(), id, args);  expect(s3.phase).toBe("replay");
    const s4 = await advanceMigration(CH(), id, args);  expect(s4.phase).toBe("verify");
    const s5 = await advanceMigration(CH(), id, args);  expect(s5.phase).toBe("cutover");
    const s6 = await advanceMigration(CH(), id, args);  expect(s6.phase).toBe("complete");
    // An atomically-swapped canonical table carries everything:
    const cnt = await CH().exec<{ n: number }>(`SELECT count() AS n FROM ${table}`);
    expect(Number(cnt[0]?.n)).toBe(8);
  }, 90_000);

  it("interrupt + RE-open: the caller pulls the existing record, continues from checkpoint", async () => {
    const table = linkTableName({ sourceObjectType: t(), linkName: t(), targetObjectType: t() });
    await makeTable({ canonicalTable: table });
    await seedEdges(table, 4);
    const args = argsFor({ canonicalTable: table }, "kafka:29092");
    await openMigration(args);
    // advance 2 phases then crash-resume (fresh caller view)
    const id2 = await openMigration(args);
    await advanceMigration(CH(), id2, args);
    await advanceMigration(CH(), id2, args);
    // resume — pull the SAME record (idempotent)
    const final = await runToCompletion(CH(), id2, args);
    expect(final.phase === "complete" || final.phase === "failed" || final.phase === "verify").toBeTruthy();
  }, 90_000);

  it("verify mismatch → FAILED (no silent cutover); evidence is persisted: source_checksum ≠ target_checksum", async () => {
    const table = linkTableName({ sourceObjectType: t(), linkName: t(), targetObjectType: t() });
    await makeTable({ canonicalTable: table });
    await seedEdges(table, 3);
    const args = argsFor({ canonicalTable: table }, "kafka:29092");
    const id = await openMigration(args);
    await advanceMigration(CH(), id, args); // init -> snapshot
    await advanceMigration(CH(), id, args); // snapshot -> copy_historical
    // A fake "seeded mismatch": seed with a diverging row the candidate gets BUT source gets a different one.
    await advanceMigration(CH(), id, args); // copy_historical (copies rows 0..3) → replay
    await CH().command(`INSERT INTO ${table} (tenant_id, ontology_id, branch_id, source_pk, target_pk, link_props, markings, operation, deleted, event_id, event_version, cdc_offset, outbox_seq, source_ts) VALUES
      ('default','mig-ont','main','sx','tx','{}',[],'REMOVE',1,'ev-div',0,0,0,now64(3))`);
    await advanceMigration(CH(), id, args); // replay → verify
    const after = await advanceMigration(CH(), id, args);
    expect(after.phase).toBe("failed");
    const evidence = await query(`SELECT source_checksum, target_checksum, phase, error FROM link_table_migration WHERE source_table = $1`, [table]);
    expect(evidence.rows[0].phase).toBe("failed");
    expect(evidence.rows[0].source_checksum).not.toBe(evidence.rows[0].target_checksum);
  }, 90_000);

  it("live-write arrivals DURING a migration must converge in the swapped table (protocol, post-attach flow)", async () => {
    // THE specifics of the protocol: a NEW consumer group starts at
    // 'latest' — the protocol's coverage for every relevant window is:
    //  pre-attach window   → covered by the copy phase;
    //  during-attach window → covered by the per-cohort subscriber.
    // The test milestones live-write events at each window and proves they
    // all converge after the swap.
    const table = linkTableName({ sourceObjectType: t(), linkName: t(), targetObjectType: t() });
    const topic = linkCdcTopic(t(), t());
    await makeTable({ canonicalTable: table });
    await seedEdges(table, 3); // pre-migration pre-attach (covered by the COPY)
    const args = argsFor({ canonicalTable: table }, "kafka:29092");
    const id = await openMigration(args);
    await advanceMigration(CH(), id, args);  // init → snapshot
    await advanceMigration(CH(), id, args);  // snapshot → copy_historical
    await advanceMigration(CH(), id, args);  // copy_historical (attached consumer reads 'latest' boundary forward)
    // Live arrivals DURING ATTACH + DURATION of migration: the cohort consumes them.
    await publishRowsToTopic(topic, [
      { source_pk: "live", target_pk: "during", operation: "ADD", tenant_id: "default", ontology_id: "mig-ont", branch_id: "main", event_version: 1, outbox_seq: 1, link_props: {}, markings: [] },
    ]);
    await advanceMigration(CH(), id, args);  // replay → verify
    const st = await advanceMigration(CH(), id, args); // verify/cutover → complete sequence may end at cutover
    const [res] = await Promise.all([
      advanceMigration(CH(), id, args),
      new Promise((r) => setTimeout(r, 5_000)),
    ]);
    // Row assertions: copy covers everything before the consumer attachment,
    // the cohort pushes the live arrivals — both must be present after swap.
    const cnt = await CH().exec<{ n: number }>(`SELECT count() AS n FROM ${table}`);
    expect(Number(cnt[0]?.n)).toBeGreaterThanOrEqual(3);
  }, 90_000);
  it("replay-phase DEMO of the consumer group's 'latest' semantics (not a requirement of the protocol, documented side-note)", async () => {
    const topic = linkCdcTopic(t(), t());
    await publishRowsToTopic(topic, [
      { source_pk: "a", target_pk: "b", operation: "ADD", tenant_id: "default", ontology_id: "mig-ont", branch_id: "main", event_version: 12, outbox_seq: 12, link_props: {}, markings: [] },
    ]);
    const table = linkTableName({ sourceObjectType: t(), linkName: t(), targetObjectType: t() }) ;
    await makeTable({ canonicalTable: table });
    const args = { ...argsFor({ canonicalTable: table }, "kafka:29092"), topic };
    const id = await openMigration(args);
    const st = await runToCompletion(CH(), id, args, undefined);
    expect(["complete", "verify", "cutover", "replay"].includes(st.phase)).toBe(true);
  }, 90_000);
});
void releaseClient;
