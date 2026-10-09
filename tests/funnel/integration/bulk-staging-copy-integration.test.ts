// ---------------------------------------------------------------------------
// Bulk staging load (DuckDB CSV export + COPY FROM STDIN) — REAL database.
//
// The merge tail now loads staging Foundry-style: DuckDB renders the merged
// parquet as a PG-ready CSV in one pass and copyStagingCsv streams it in with
// chunked `COPY … FROM STDIN`. These cases pin:
//   * byte-for-byte parity with the row path (parseJsonColumn /
//     parseJsonArrayColumn / asUuidOrNull + stageMergeRows) on hostile values:
//     quotes, commas, backslashes, newlines, unicode, '' vs NULL, invalid
//     JSON, non-object properties, non-uuid provenance, empty-string key;
//   * the result is identical for every COPY chunk size (1, 2, 1000) and
//     progress is reported per chunk;
//   * the stats query returns exact rows / max key / downgrade count;
//   * a COPY failure mid-load leaves the connection usable and rolls back.
//
// Every case runs on ONE client inside BEGIN … ROLLBACK with a throwaway
// ontology, so the shared database is never altered.
// ---------------------------------------------------------------------------

import { LANE } from "../../laneEnv";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

void LANE;

type PoolClient = import("pg").PoolClient;

let db: typeof import("../../../src/db");
let staging: typeof import("../../../src/services/funnel/mergeStaging");
let branch: typeof import("../../../src/services/branchContext");
let store: typeof import("../../../src/services/funnel/funnelParquetStore");
let duck: typeof import("../../../src/services/duckdb/pool");

const OT = "BulkStagingCopy";
const UUID_A = "11111111-2222-4333-8444-555555555555";
const UUID_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

type TailRow = {
  primary_key: string;
  properties: string | null;
  markings: string | null;
  operation: string | null;
  source_datasource_id: string;
  source_transaction_id: string;
};

// Merged-tail parquet rows exactly as mergeStage writes them (all VARCHAR,
// JSON text, '' for null provenance) — plus values the writer should never
// produce, to pin the defensive fallbacks.
const ROWS: TailRow[] = [
  { primary_key: "", properties: '{"empty_key":true}', markings: "[]", operation: "upsert", source_datasource_id: "", source_transaction_id: "" },
  { primary_key: "a,comma", properties: '{"s":"x, \\"quoted\\", y","n":1.5,"b":false,"z":null}', markings: '["M1","M2"]', operation: "upsert", source_datasource_id: UUID_A, source_transaction_id: UUID_B },
  { primary_key: 'b"quote', properties: '{"nl":"line1\\nline2","tab":"\\t","bs":"c:\\\\dir"}', markings: '["has\\"quote","back\\\\slash","comma,{brace}"]', operation: "upsert", source_datasource_id: "not-a-uuid", source_transaction_id: UUID_B },
  { primary_key: "c\nnewline-key", properties: '{"unicode":"héllo ✓ 日本 🚀"}', markings: '["NULL", ""]', operation: "upsert", source_datasource_id: UUID_A, source_transaction_id: "" },
  { primary_key: "d-delete", properties: "{}", markings: '["keep"]', operation: "delete", source_datasource_id: "", source_transaction_id: "nope" },
  { primary_key: "e-invalid-json", properties: "{not json", markings: "[broken", operation: "weird-op", source_datasource_id: "", source_transaction_id: "" },
  { primary_key: "f-non-object", properties: "[1,2,3]", markings: '{"a":1}', operation: null, source_datasource_id: "", source_transaction_id: "" },
  { primary_key: "g-null-json", properties: null, markings: null, operation: "upsert", source_datasource_id: "", source_transaction_id: "" },
  { primary_key: "h-nested", properties: '{"o":{"deep":[1,{"x":"y"}]},"big":12345678901234567890}', markings: '["a", null, 7]', operation: "upsert", source_datasource_id: UUID_A.toUpperCase(), source_transaction_id: "" },
];

let dir: string;
let parquetPath: string;

beforeAll(async () => {
  db = await import("../../../src/db");
  staging = await import("../../../src/services/funnel/mergeStaging");
  branch = await import("../../../src/services/branchContext");
  store = await import("../../../src/services/funnel/funnelParquetStore");
  duck = await import("../../../src/services/duckdb/pool");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bulk-staging-"));
  parquetPath = path.join(dir, "tail.parquet");
  const ndjson = path.join(dir, "rows.ndjson");
  fs.writeFileSync(ndjson, ROWS.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const conn = await duck.acquireConnection({ skipHttpfs: true });
  try {
    const cols = store.MERGED_PARQUET_COLUMNS.map((c) => `'${c.name}': 'VARCHAR'`).join(", ");
    await duck.runAll(
      conn,
      `COPY (SELECT * FROM read_json('${ndjson}', format='newline_delimited', columns={${cols}}) ORDER BY primary_key)
         TO '${parquetPath}' (FORMAT PARQUET)`,
    );
  } finally {
    duck.releaseConnection(conn);
  }
});

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

async function inRolledBackTxn(fn: (c: PoolClient, ontologyId: string) => Promise<void>) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const ontologyId = crypto.randomUUID();
    await client.query(`INSERT INTO ontology (ontology_id, display_name) VALUES ($1, $2)`, [
      ontologyId,
      `bulk-staging-${ontologyId}`,
    ]);
    await client.query(
      `INSERT INTO ontology_branch (branch_id, ontology_id, name) VALUES ($1, $2, 'main')`,
      [branch.deriveMainBranchId(ontologyId), ontologyId],
    );
    await fn(client, ontologyId);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

function scopeOf(ontologyId: string) {
  return { ontologyId, objectTypeApiName: OT, stagingRunId: crypto.randomUUID() };
}

async function bulkLoad(
  c: PoolClient,
  scope: ReturnType<typeof scopeOf>,
  opts?: import("../../../src/services/funnel/mergeStaging").StagingChunkOptions,
): Promise<number> {
  const csv = path.join(dir, `${scope.stagingRunId}.csv`);
  const conn = await duck.acquireConnection({ skipHttpfs: true });
  try {
    await duck.runAll(conn, staging.buildStagingCsvExportSql(scope, parquetPath, csv));
  } finally {
    duck.releaseConnection(conn);
  }
  try {
    return await staging.copyStagingCsv(c, csv, opts);
  } finally {
    fs.rmSync(csv, { force: true });
  }
}

// The row path exactly as mergeStage's keyset loop builds StagedRowInput.
async function rowLoad(c: PoolClient, scope: ReturnType<typeof scopeOf>): Promise<void> {
  await staging.stageMergeRows(
    c,
    scope,
    ROWS.map((row) => ({
      ontology_id: scope.ontologyId,
      object_type_api_name: OT,
      primary_key: String(row.primary_key),
      operation: row.operation === "delete" ? "delete" : "upsert",
      properties: store.parseJsonColumn(row.properties),
      markings: store.parseJsonArrayColumn(row.markings),
      source_datasource_id: String(row.source_datasource_id ?? "") || null,
      source_transaction_id: String(row.source_transaction_id ?? "") || null,
    })),
  );
}

async function staged(c: PoolClient, runId: string) {
  const r = await c.query(
    `SELECT ontology_id, branch_id, object_type_api_name, primary_key, operation,
            properties::text AS properties, markings, source_datasource_id::text AS ds,
            source_transaction_id::text AS tx
       FROM merge_staging_instances WHERE staging_run_id = $1 ORDER BY primary_key COLLATE "C"`,
    [runId],
  );
  return r.rows;
}

describe("bulk staging copy (DuckDB CSV -> COPY FROM STDIN)", () => {
  it("stages exactly what the row path stages, for hostile values", async () => {
    await inRolledBackTxn(async (c, ont) => {
      const rowScope = scopeOf(ont);
      const bulkScope = scopeOf(ont);
      await rowLoad(c, rowScope);
      const copied = await bulkLoad(c, bulkScope);
      expect(copied).toBe(ROWS.length);
      const want = await staged(c, rowScope.stagingRunId);
      const got = await staged(c, bulkScope.stagingRunId);
      expect(got).toHaveLength(ROWS.length);
      // One intended difference: the row path round-trips properties through
      // JSON.parse/JSON.stringify, so integers beyond 2^53 lose digits. The
      // bulk path hands PG the merged JSON text verbatim and keeps them.
      const big = (rows: typeof got) => rows.find((r) => r.primary_key === "h-nested")!.properties as string;
      expect(big(got)).toContain("12345678901234567890");
      expect(big(want)).toContain("12345678901234567000");
      const sansBig = (rows: typeof got) =>
        rows.map((r) => (r.primary_key === "h-nested" ? { ...r, properties: "<checked above>" } : r));
      expect(sansBig(got)).toEqual(sansBig(want));
      // Spot-check the tricky ones explicitly.
      const by = new Map(got.map((r) => [r.primary_key, r]));
      expect(by.has("")).toBe(true);
      expect(by.has("c\nnewline-key")).toBe(true);
      expect(by.get('b"quote')!.markings).toEqual(['has"quote', "back\\slash", "comma,{brace}"]);
      expect(by.get('b"quote')!.ds).toBeNull(); // non-uuid downgraded
      expect(by.get("e-invalid-json")!.properties).toBe("{}");
      expect(by.get("e-invalid-json")!.operation).toBe("upsert");
      expect(by.get("d-delete")!.operation).toBe("delete");
      expect(by.get("h-nested")!.markings).toEqual(["a", null, "7"]);
    });
  });

  it("is identical for every COPY chunk size and reports progress per chunk", async () => {
    await inRolledBackTxn(async (c, ont) => {
      let baseline: unknown[] | null = null;
      for (const chunkRows of [1, 2, 1000]) {
        const scope = scopeOf(ont);
        const progress: number[] = [];
        const copied = await bulkLoad(c, scope, {
          chunkRows,
          onProgress: (p) => {
            expect(p.phase).toBe("stage");
            progress.push(p.rowsDone);
          },
        });
        expect(copied).toBe(ROWS.length);
        expect(progress).toHaveLength(Math.ceil(ROWS.length / chunkRows));
        expect(progress[progress.length - 1]).toBe(ROWS.length);
        const rows = (await staged(c, scope.stagingRunId)).map(({ primary_key, properties, markings, ds, tx, operation }) => ({
          primary_key, properties, markings, ds, tx, operation,
        }));
        if (baseline === null) baseline = rows;
        else expect(rows).toEqual(baseline);
      }
    });
  });

  it("stats query returns exact rows, max key and downgrade count", async () => {
    const conn = await duck.acquireConnection({ skipHttpfs: true });
    try {
      const [s] = await duck.queryAll<{ rows: string; max_pk: string; downgraded: string; downgrade_sample: string }>(
        conn,
        staging.buildStagingParquetStatsSql(parquetPath),
      );
      expect(Number(s.rows)).toBe(ROWS.length);
      expect(s.max_pk).toBe([...ROWS.map((r) => r.primary_key)].sort()[ROWS.length - 1]);
      // b"quote (ds), d-delete (tx); uppercase uuid is a valid uuid
      expect(Number(s.downgraded)).toBe(2);
      expect(["not-a-uuid", "nope"]).toContain(s.downgrade_sample);
    } finally {
      duck.releaseConnection(conn);
    }
  });

  it("a COPY failure leaves the connection usable and rolls back staging", async () => {
    await inRolledBackTxn(async (c, ont) => {
      const scope = scopeOf(ont);
      const bad = path.join(dir, "bad.csv");
      const ok = (k: string) =>
        `${scope.stagingRunId},${ont},${branch.deriveMainBranchId(ont)},${OT},${k},upsert,{},{},,\n`;
      fs.writeFileSync(bad, ok("x1") + ok("x2") + `${scope.stagingRunId},${ont},${branch.deriveMainBranchId(ont)},${OT},x3,upsert,"{not json",{},,\n`);
      await c.query("SAVEPOINT s");
      await expect(staging.copyStagingCsv(c, bad, { chunkRows: 1 })).rejects.toThrow(/json/i);
      await c.query("ROLLBACK TO SAVEPOINT s");
      const r = await c.query(`SELECT count(*)::int AS n FROM merge_staging_instances WHERE staging_run_id = $1`, [
        scope.stagingRunId,
      ]);
      expect(r.rows[0].n).toBe(0);
      fs.rmSync(bad, { force: true });
    });
  });
});
