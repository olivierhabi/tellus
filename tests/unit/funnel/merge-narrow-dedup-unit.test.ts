// ---------------------------------------------------------------------------
// Narrow-key dedup — equivalence tests (old wide sort vs new narrow sort).
//
// What is proven here, on tiny in-process DuckDB (no services):
//   1. On tie-free input (no two rows share a full ordering key), the narrow
//      chain yields ROW-IDENTICAL source_state to the legacy wide chain —
//      including duplicates, DELETE tombstones, the adversarial partial-row
//      accumulation case, multi-contribution folds, NULL operations and
//      markings. The ORDER BY keys are the same, so glob_seq agrees exactly.
//   2. Bucketed (N=3) narrow execution yields identical source_state to
//      unbucketed narrow execution.
//   3. The narrow chain is deterministic run-over-run.
//   4. Full ties (identical contrib/ts/txn/pk) are the documented exception:
//      both paths produce one row per PK with the union of keys, but may
//      disagree on conflicting values — that input was already
//      nondeterministic in the legacy sort. Asserted as key-union, not
//      value-equality.
// ---------------------------------------------------------------------------

import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import duckdb from "duckdb";

import {
  buildMergePrefixStatements,
  buildLegacyMergePrefixStatements,
  buildNarrowBucketStatements,
  buildBucketAssemblyStatement,
  buildBucketExportStatement,
} from "../../../src/services/funnel/mergePrefixSql";
import { runAll, queryAll } from "../../../src/services/duckdb/pool";
import { setFunnelRuntimeOverridesForTesting } from "../../../src/config/funnelRuntime";

afterEach(() => {
  setFunnelRuntimeOverridesForTesting(null);
  delete process.env.MERGE_NARROW_DEDUP;
});

type Conn = Parameters<typeof runAll>[0];

function memConn(): Conn {
  const db = new duckdb.Database(":memory:");
  return db.connect() as unknown as Conn;
}

async function writeParquet(
  dir: string,
  name: string,
  rowsSql: string,
): Promise<string> {
  const fp = path.join(dir, name);
  const conn = memConn();
  await runAll(
    conn,
    `COPY (SELECT * FROM (VALUES ${rowsSql}) AS v(primary_key, operation, properties, source_transaction_id, source_commit_timestamp)) TO '${fp.replace(/'/g, "''")}' (FORMAT PARQUET)`,
  );
  return fp;
}

type SourceStateRow = {
  primary_key: string;
  tombstoned: boolean;
  properties: unknown;
  markings: string[];
  source_datasource_id: string;
  source_transaction_id: string;
};

async function readSourceState(conn: Conn): Promise<SourceStateRow[]> {
  const rows = await queryAll<Record<string, unknown>>(
    conn,
    `SELECT primary_key, tombstoned, CAST(properties AS VARCHAR) AS properties,
            markings, source_datasource_id, source_transaction_id
       FROM source_state ORDER BY primary_key`,
  );
  return rows.map((r) => ({
    primary_key: String(r.primary_key),
    tombstoned: Boolean(r.tombstoned),
    properties: JSON.parse(String(r.properties)),
    markings: (r.markings ?? []) as string[],
    source_datasource_id: String(r.source_datasource_id),
    source_transaction_id: String(r.source_transaction_id),
  }));
}

// Tie-free fixture: no two rows share (contrib, ts, txn, pk).
const CONTRIB_1 = `('K1','INSERT','{"a1":"x","a2":"y"}','t1','2026-01-01T00:00:00Z'),
      ('K1','UPDATE','{"a3":"z"}','t2','2026-01-01T01:00:00Z'),
      ('K2','INSERT','{"b1":"z"}','t1','2026-01-01T00:00:00Z'),
      ('K2','DELETE','{}','t2','2026-01-01T02:00:00Z'),
      ('K2','INSERT','{"b2":"w"}','t3','2026-01-01T03:00:00Z'),
      ('K3','INSERT','{"a1":"1","a2":"2"}','t1','2026-01-01T00:00:00Z'),
      ('K3','DELETE','{}','t2','2026-01-01T01:00:00Z'),
      ('K3','INSERT','{"a1":"1"}','t3','2026-01-01T02:00:00Z'),
      ('K3','UPDATE','{"a2":"2"}','t4','2026-01-01T03:00:00Z'),
      ('K4','INSERT','{"k":"v"}','t1','2026-01-01T00:00:00Z'),
      ('K5',NULL,'{}','t1','2026-01-01T00:00:00Z')`;
const CONTRIB_2 = `('K1','INSERT','{"d1":"q"}','t9','2026-02-01T00:00:00Z'),
      ('K6','INSERT','{"z":"9"}','t9','2026-02-01T00:00:00Z')`;

const CONTRIBS = [
  { datasource_id: "ds-1", owned_properties: [], markings: ["m1"] },
  { datasource_id: "ds-2", owned_properties: [], markings: ["m2"] },
];

async function fixture(): Promise<{ dir: string; paths: string[] }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "narrow-equiv-"));
  return {
    dir,
    paths: [
      await writeParquet(dir, "c1.parquet", CONTRIB_1),
      await writeParquet(dir, "c2.parquet", CONTRIB_2),
    ],
  };
}

describe("narrow vs legacy on tie-free input", () => {
  it("yields row-identical source_state", async () => {
    const { paths } = await fixture();
    const args = {
      contributions: CONTRIBS,
      localPaths: paths,
      editOpsRows: [],
      editPropsRows: [],
    };

    const legacyConn = memConn();
    for (const s of buildLegacyMergePrefixStatements(args)) {
      await runAll(legacyConn, s);
    }
    const legacy = await readSourceState(legacyConn);

    const narrowConn = memConn();
    for (const s of buildMergePrefixStatements(args)) {
      await runAll(narrowConn, s);
    }
    const narrow = await readSourceState(narrowConn);

    expect(narrow.map((r) => r.primary_key)).toEqual(
      legacy.map((r) => r.primary_key),
    );
    expect(narrow).toEqual(legacy);

    // Absolute expectations (not just agreement): accumulation, tombstones,
    // cross-contribution fold, NULL-op tombstone, markings union.
    const byPk = new Map(narrow.map((r) => [r.primary_key, r]));
    expect(byPk.get("K1")!.properties).toEqual({
      a1: "x",
      a2: "y",
      a3: "z",
      d1: "q",
    });
    expect(byPk.get("K1")!.markings).toEqual(["m1", "m2"]);
    expect(byPk.get("K2")!.properties).toEqual({ b2: "w" });
    expect(byPk.get("K2")!.tombstoned).toBe(false);
    // Adversarial partials: INSERT{a1,a2}→DELETE→INSERT{a1}→UPDATE{a2}.
    expect(byPk.get("K3")!.properties).toEqual({ a1: "1", a2: "2" });
    expect(byPk.get("K5")).toMatchObject({ tombstoned: true, properties: {} });
    expect(byPk.get("K6")!.markings).toEqual(["m2"]);
    expect(byPk.get("K6")!.source_datasource_id).toBe("ds-2");
  }, 120_000);

  it("is deterministic run-over-run", async () => {
    const { paths } = await fixture();
    const args = {
      contributions: CONTRIBS,
      localPaths: paths,
      editOpsRows: [],
      editPropsRows: [],
    };
    const run = async () => {
      const conn = memConn();
      for (const s of buildMergePrefixStatements(args)) {
        await runAll(conn, s);
      }
      return readSourceState(conn);
    };
    expect(await run()).toEqual(await run());
  }, 120_000);
});

describe("bucketed vs unbucketed narrow", () => {
  it("N=3 buckets yield identical source_state", async () => {
    const { dir, paths } = await fixture();
    const args = {
      contributions: CONTRIBS,
      localPaths: paths,
      singleContribution: false,
    };

    // Unbucketed narrow reference.
    const refConn = memConn();
    for (const s of buildMergePrefixStatements({
      ...args,
      editOpsRows: [],
      editPropsRows: [],
    })) {
      await runAll(refConn, s);
    }
    const ref = await readSourceState(refConn);

    // Bucketed: per-bucket prefix + COPY + assembly.
    const workConn = memConn();
    const bucketFiles: string[] = [];
    for (const b of [0, 1, 2]) {
      const stmts = buildNarrowBucketStatements({
        ...args,
        bucket: { id: b, count: 3 },
      });
      for (const s of stmts) {
        await runAll(workConn, s);
      }
      const bf = path.join(dir, `b${b}.parquet`);
      await runAll(workConn, `COPY (SELECT * FROM source_state) TO '${bf}' (FORMAT PARQUET)`);
      bucketFiles.push(bf);
      await runAll(
        workConn,
        `DROP TABLE IF EXISTS changes; DROP TABLE IF EXISTS source_state;`,
      );
    }
    // NOTE: the COPY above is the test's stand-in for
    // buildBucketExportStatement (which adds the VARCHAR cast); the export
    // shape itself is pinned in merge-buckets-unit.test.ts.
    await runAll(workConn, buildBucketAssemblyStatement(bucketFiles));
    const bucketed = await readSourceState(workConn);

    expect(bucketed).toEqual(ref);
  }, 120_000);
});

describe("full ties (documented nondeterminism corner)", () => {
  it("both paths emit one row per PK with the union of keys", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "narrow-tie-"));
    // Two UPDATEs, same PK, same ts/txn: a full tie on ordering keys.
    const lp = await writeParquet(
      dir,
      "t.parquet",
      `('T','UPDATE','{"x":"1"}','t1','2026-01-01T00:00:00Z'),
       ('T','UPDATE','{"y":"2"}','t1','2026-01-01T00:00:00Z')`,
    );
    const args = {
      contributions: [
        { datasource_id: "ds-1", owned_properties: [], markings: [] },
      ],
      localPaths: [lp],
      editOpsRows: [],
      editPropsRows: [],
    };
    const run = async (stmts: string[]) => {
      const conn = memConn();
      for (const s of stmts) {
        await runAll(conn, s);
      }
      return readSourceState(conn);
    };
    const legacy = await run(buildLegacyMergePrefixStatements(args));
    const narrow = await run(buildMergePrefixStatements(args));
    for (const rows of [legacy, narrow]) {
      expect(rows).toHaveLength(1);
      expect(rows[0].tombstoned).toBe(false);
      // Union of keys present in SOME order — assert the set, not values.
      expect(Object.keys(rows[0].properties as object).sort()).toEqual([
        "x",
        "y",
      ]);
    }
  }, 120_000);
});
