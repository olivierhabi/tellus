// ---------------------------------------------------------------------------
// writeRowsToParquetStream — all-VARCHAR bulk path (NDJSON spool + one
// DuckDB COPY). Pins value parity with the generic SQL-literal path
// (null / undefined / "" -> NULL, everything else String(v)), order, exact
// row count, the empty-input contract, and rows wider than DuckDB's 16 MiB
// default JSON object limit. Real DuckDB.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { writeRowsToParquetStream } from "../../../src/services/pipelines/parquetWriter";
import { acquireConnection, queryAll, releaseConnection } from "../../../src/services/duckdb/pool";

const COLS = [
  { name: "primary_key", type: "string" },
  { name: "properties", type: "string" },
  { name: "weird col 'q'", type: "string" },
];

async function* gen<T>(rows: T[]) {
  for (const r of rows) yield r as Record<string, unknown>;
}

async function readBack(p: string) {
  const conn = await acquireConnection({ skipHttpfs: true });
  try {
    return await queryAll<Record<string, string | null>>(
      conn,
      `SELECT * FROM read_parquet('${p.replace(/'/g, "''")}')`,
    );
  } finally {
    releaseConnection(conn);
  }
}

describe("writeRowsToParquetStream — VARCHAR bulk path", () => {
  it("preserves order, values and NULL semantics", async () => {
    const rows = [
      { primary_key: "a", properties: '{"x":"1, \\"q\\""}', "weird col 'q'": "line1\nline2" },
      { primary_key: "b", properties: "", "weird col 'q'": null },
      { primary_key: "c", properties: undefined, "weird col 'q'": 42 },
      { primary_key: "d", properties: "héllo ✓ 🚀 \u0001", "weird col 'q'": true },
      { primary_key: "e" }, // missing columns -> NULL
    ];
    const r = await writeRowsToParquetStream({ columns: COLS, rows: gen(rows) });
    expect(r).not.toBeNull();
    try {
      expect(r!.rowCountExact).toBe(rows.length);
      expect(r!.columnLogicalTypes.map((c) => c.name)).toEqual(
        expect.arrayContaining(COLS.map((c) => c.name)),
      );
      const back = await readBack(r!.localPath);
      expect(back).toEqual([
        { primary_key: "a", properties: '{"x":"1, \\"q\\""}', "weird col 'q'": "line1\nline2" },
        { primary_key: "b", properties: null, "weird col 'q'": null },
        { primary_key: "c", properties: null, "weird col 'q'": "42" },
        { primary_key: "d", properties: "héllo ✓ 🚀 \u0001", "weird col 'q'": "true" },
        { primary_key: "e", properties: null, "weird col 'q'": null },
      ]);
    } finally {
      fs.rmSync(r!.localPath, { force: true });
    }
  });

  it("returns null for an empty source", async () => {
    expect(await writeRowsToParquetStream({ columns: COLS, rows: gen([]) })).toBeNull();
  });

  it("handles a row wider than DuckDB's 16 MiB JSON object default", async () => {
    const wide = "w".repeat(17 * 1024 * 1024);
    const r = await writeRowsToParquetStream({
      columns: COLS.slice(0, 2),
      rows: gen([{ primary_key: "big", properties: wide }, { primary_key: "small", properties: "s" }]),
    });
    try {
      expect(r!.rowCountExact).toBe(2);
      const conn = await acquireConnection({ skipHttpfs: true });
      try {
        const [x] = await queryAll<{ n: number | bigint }>(
          conn,
          `SELECT length(properties) AS n FROM read_parquet('${r!.localPath}') WHERE primary_key = 'big'`,
        );
        expect(Number(x.n)).toBe(wide.length);
      } finally {
        releaseConnection(conn);
      }
    } finally {
      if (r) fs.rmSync(r.localPath, { force: true });
    }
  }, 60_000);

  it("still uses the generic typed path when a column is not VARCHAR", async () => {
    const r = await writeRowsToParquetStream({
      columns: [
        { name: "id", type: "integer" },
        { name: "s", type: "string" },
      ],
      rows: gen([{ id: "7", s: "x" }]),
    });
    try {
      expect(r!.columnLogicalTypes.find((c) => c.name === "id")!.logicalType).toMatch(/INT64/);
      const back = await readBack(r!.localPath);
      expect(Number(back[0].id)).toBe(7);
    } finally {
      if (r) fs.rmSync(r.localPath, { force: true });
    }
  });
});
