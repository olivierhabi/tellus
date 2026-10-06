// ---------------------------------------------------------------------------
// Fast path — unit tests.
//
// The fast path skips the dedup sort when a single contribution provably
// holds distinct non-null, non-empty PKs. Pinned here:
//   * the kill switch (default ON) and the pass/fail predicate matrix,
//     including fail-safe on missing counts;
//   * the fast source_state statement shape (tombstone predicate, COALESCE,
//     markings computed in SQL, escaping);
//   * EQUIVALENCE: on unique-PK input, the fast build yields byte-identical
//     source_state to the general prefix (steps 2–8) — tombstoned DELETEs,
//     NULL-properties coercion, and markings included. Tiny in-process
//     DuckDB, no services.
// ---------------------------------------------------------------------------

import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import duckdb from "duckdb";

import {
  buildFastSourceStateStatement,
  buildMergePrefixStatements,
  isFastPathEnabled,
  isFastPathPrecheckPass,
} from "../../../src/services/funnel/mergePrefixSql";
import { queryAll, runAll } from "../../../src/services/duckdb/pool";

afterEach(() => {
  delete process.env.MERGE_FAST_PATH;
});

describe("isFastPathEnabled", () => {
  it("defaults ON; only explicit 0 disables", () => {
    delete process.env.MERGE_FAST_PATH;
    expect(isFastPathEnabled()).toBe(true);
    process.env.MERGE_FAST_PATH = "0";
    expect(isFastPathEnabled()).toBe(false);
    process.env.MERGE_FAST_PATH = "1";
    expect(isFastPathEnabled()).toBe(true);
    process.env.MERGE_FAST_PATH = "junk";
    expect(isFastPathEnabled()).toBe(true);
  });
});

describe("isFastPathPrecheckPass", () => {
  it("passes on unique non-null PKs, including the empty input", () => {
    expect(
      isFastPathPrecheckPass({ total: 5, distinctPk: 5, nullPk: 0, emptyPk: 0 }),
    ).toBe(true);
    expect(
      isFastPathPrecheckPass({ total: 0, distinctPk: 0, nullPk: 0, emptyPk: 0 }),
    ).toBe(true);
  });

  it("fails on duplicates, nulls, empties — and on missing counts", () => {
    expect(
      isFastPathPrecheckPass({ total: 5, distinctPk: 4, nullPk: 0, emptyPk: 0 }),
    ).toBe(false);
    expect(
      isFastPathPrecheckPass({ total: 5, distinctPk: 5, nullPk: 1, emptyPk: 0 }),
    ).toBe(false);
    expect(
      isFastPathPrecheckPass({ total: 5, distinctPk: 5, nullPk: 0, emptyPk: 2 }),
    ).toBe(false);
    // Missing/unparseable counts (mapped to -1 by the caller) fail safe:
    // an unknown input must take the general path.
    expect(
      isFastPathPrecheckPass({ total: -1, distinctPk: -1, nullPk: -1, emptyPk: -1 }),
    ).toBe(false);
  });
});

describe("buildFastSourceStateStatement", () => {
  it("mirrors the general tombstone/properties semantics", () => {
    const sql = buildFastSourceStateStatement("/tmp/c.parquet", "ds-1", []);
    expect(sql).toContain("CREATE OR REPLACE TEMP TABLE source_state AS");
    expect(sql).toContain("FROM read_parquet('/tmp/c.parquet')");
    expect(sql).toContain("'ds-1' AS source_datasource_id");
    // NULL operation counts as deleted — `<> 'DELETE'` is not TRUE for NULL.
    expect(sql).toContain("(operation = 'DELETE' OR operation IS NULL)");
    expect(sql).toContain("'{}'::JSON");
    // Markings use the same trim/distinct/sort expression as src_markings,
    // computed in SQL so no JS collation can diverge.
    expect(sql).toContain("array_sort(array_agg(DISTINCT trim(m))");
    expect(sql).toContain("FILTER (WHERE m IS NOT NULL AND trim(m) <> '')");
  });

  it("escapes quotes in paths, ids and markings", () => {
    const sql = buildFastSourceStateStatement(
      "/tmp/o'b.parquet",
      "ds'o",
      ["m'1"],
    );
    expect(sql).toContain("FROM read_parquet('/tmp/o''b.parquet')");
    expect(sql).toContain("'ds''o' AS source_datasource_id");
    expect(sql).toContain("'m''1'");
  });
});

type SourceStateRow = {
  primary_key: string;
  source_datasource_id: string;
  source_transaction_id: string;
  source_timestamp: string;
  tombstoned: boolean;
  properties: string;
  markings: string[];
};

async function writeParquet(
  rowsSql: string,
): Promise<{ dir: string; file: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastpath-"));
  const file = path.join(dir, "c.parquet");
  const db = new duckdb.Database(":memory:");
  const conn = db.connect() as unknown as Parameters<typeof runAll>[0];
  await runAll(
    conn,
    `COPY (SELECT * FROM (VALUES ${rowsSql}) AS v(primary_key, operation, properties, source_transaction_id, source_commit_timestamp)) TO '${file.replace(/'/g, "''")}' (FORMAT PARQUET)`,
  );
  return { dir, file };
}

async function readSourceState(
  file: string,
  build: (lp: string) => string[],
): Promise<SourceStateRow[]> {
  const db = new duckdb.Database(":memory:");
  const conn = db.connect() as unknown as Parameters<typeof runAll>[0];
  for (const stmt of build(file)) {
    await runAll(conn, stmt);
  }
  const rows = await queryAll<Record<string, unknown>>(
    conn,
    `SELECT primary_key, source_datasource_id, source_transaction_id,
            source_timestamp, tombstoned,
            CAST(properties AS VARCHAR) AS properties,
            markings
       FROM source_state ORDER BY primary_key`,
  );
  return rows.map((r) => ({
    primary_key: String(r.primary_key),
    source_datasource_id: String(r.source_datasource_id),
    source_transaction_id: String(r.source_transaction_id),
    source_timestamp: String(r.source_timestamp),
    tombstoned: Boolean(r.tombstoned),
    properties: String(r.properties),
    markings: r.markings as string[],
  }));
}

const FIXTURE_ROWS = `('A','INSERT','{"a1":"x"}','t1','2026-01-01T00:00:00Z'),
      ('B','INSERT',NULL,'t1','2026-01-01T00:00:00Z'),
      ('C','DELETE','{}','t2','2026-01-01T02:00:00Z'),
      ('D','INSERT','{"d1":"w"}','t1','2026-01-01T00:00:00Z')`;

describe("equivalence: fast build vs general prefix on unique-PK input", () => {
  it("yields identical source_state, including tombstones, NULL props and markings", async () => {
    const { file } = await writeParquet(FIXTURE_ROWS);
    const markings = [" m1 ", "m1", "", "m2"];
    const general = await readSourceState(
      file,
      (lp) => [
        ...buildMergePrefixStatements({
          contributions: [
            { datasource_id: "ds-1", owned_properties: [], markings },
          ],
          localPaths: [lp],
          editOpsRows: [],
          editPropsRows: [],
        }),
      ],
    );
    const fast = await readSourceState(file, (lp) => [
      buildFastSourceStateStatement(lp, "ds-1", markings),
    ]);
    // Same PKs, same tombstones, same properties (parsed — key order is not
    // significant), same markings, same source ids.
    expect(fast.map((r) => r.primary_key)).toEqual(
      general.map((r) => r.primary_key),
    );
    for (const g of general) {
      const f = fast.find((r) => r.primary_key === g.primary_key)!;
      expect(f, `pk ${g.primary_key}`).toBeDefined();
      expect(f.tombstoned).toBe(g.tombstoned);
      expect(JSON.parse(f.properties)).toEqual(JSON.parse(g.properties));
      expect(f.markings).toEqual(g.markings);
      expect(f.source_datasource_id).toBe(g.source_datasource_id);
      expect(f.source_transaction_id).toBe(g.source_transaction_id);
      expect(f.source_timestamp).toBe(g.source_timestamp);
    }
    // And the absolute values, not just agreement: DELETE tombstoned with
    // '{}', NULL properties coerced to '{}', markings trimmed/deduped.
    const byPk = new Map(fast.map((r) => [r.primary_key, r]));
    expect(byPk.get("C")).toMatchObject({ tombstoned: true });
    expect(JSON.parse(byPk.get("C")!.properties)).toEqual({});
    expect(JSON.parse(byPk.get("B")!.properties)).toEqual({});
    expect(JSON.parse(byPk.get("A")!.properties)).toEqual({ a1: "x" });
    expect(byPk.get("A")!.markings).toEqual(["m1", "m2"]);
  }, 120_000);
});
