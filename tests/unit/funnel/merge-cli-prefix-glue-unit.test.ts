// ---------------------------------------------------------------------------
// Cross-process glue test for the out-of-process merge prefix.
//
// This is the test that proves the isolation boundary actually works: the
// prefix SQL is executed by a DuckDB engine in a DIFFERENT OS process (a stub
// that runs the stdin script through the same-version binding via db.exec),
// the prefix outputs cross back as parquet files, and the in-process side
// re-attaches them as temp tables with identical content.
//
// Tiny data only (7 rows): pk A gets INSERT{a1} then UPDATE{a2} (partial-row
// accumulation must yield {a1,a2}); pk B gets INSERT then DELETE (tombstoned);
// pk C gets a single INSERT plus a user edit. The stub needs the repo's
// duckdb binding, resolved via NODE_PATH (pnpm symlinks node_modules/duckdb).
// ---------------------------------------------------------------------------

import { describe, expect, it, afterEach, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import duckdb from "duckdb";

import { runMergePrefixOutOfProcess } from "../../../src/services/funnel/mergeStage";
import { queryAll } from "../../../src/services/duckdb/pool";

let engineStub = "";

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duckdb-engine-stub-"));
  engineStub = path.join(dir, "engine.cjs");
  // A stand-in for the DuckDB CLI: run the whole stdin script with db.exec
  // in THIS process (a different OS process from the test), exit 0/1.
  fs.writeFileSync(
    engineStub,
    `const duckdb = require("duckdb");
let body = "";
process.stdin.on("data", (c) => (body += c));
process.stdin.on("end", () => {
  const db = new duckdb.Database(":memory:");
  db.exec(body, (err) => {
    if (err) { process.stderr.write("ENGINE ERROR: " + err.message + "\\n"); process.exit(1); }
    process.exit(0);
  });
});
process.stdin.resume();
`,
  );
});

afterEach(() => {
  delete process.env.NODE_PATH;
});

async function changelogParquet(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glue-changelog-"));
  const fp = path.join(dir, "c.parquet");
  const db = new duckdb.Database(":memory:");
  const conn = db.connect();
  const run = (sql: string) =>
    new Promise<void>((res, rej) =>
      conn.run(sql, (e: Error | null) => (e ? rej(e) : res())),
    );
  await run(`CREATE TABLE chg AS SELECT * FROM (VALUES
      ('A','INSERT','{"a1":"x"}','t1','2026-01-01T00:00:00Z'),
      ('A','UPDATE','{"a2":"y"}','t2','2026-01-01T01:00:00Z'),
      ('B','INSERT','{"b1":"z"}','t1','2026-01-01T00:00:00Z'),
      ('B','DELETE','{}','t2','2026-01-01T02:00:00Z'),
      ('C','INSERT','{"c1":"w"}','t1','2026-01-01T00:00:00Z')
    ) AS v(primary_key, operation, properties, source_transaction_id, source_commit_timestamp)`);
  await run(`COPY chg TO '${fp.replace(/'/g, "''")}' (FORMAT PARQUET)`);
  return fp;
}

describe("runMergePrefixOutOfProcess (cross-process glue)", () => {
  it("prefix outputs computed out of process attach with identical content", async () => {
    const parquetPath = await changelogParquet();
    // vitest runs with cwd = repo root; pnpm symlinks node_modules/duckdb.
    process.env.NODE_PATH = path.resolve(process.cwd(), "node_modules");

    const db = new duckdb.Database(":memory:");
    const conn = db.connect() as unknown as Parameters<
      typeof queryAll
    >[0];

    const before = new Set(
      fs
        .readdirSync(os.tmpdir())
        .filter((f) => f.startsWith("merge-cli-")),
    );

    await runMergePrefixOutOfProcess(
      {
        ontologyId: "00000000-0000-0000-0000-000000000001",
        objectTypeApiName: "GlueTest",
        contributions: [],
        pendingEdits: [],
        editStrategy: "user_edit_wins",
        mergedTableId: "00000000-0000-0000-0000-000000000000",
        mergedOutputFileLocation: "s3://x/y.parquet",
      } as unknown as Parameters<typeof runMergePrefixOutOfProcess>[0],
      {
        contributions: [
          { datasource_id: "ds-1", owned_properties: [], markings: [] },
        ],
        localPaths: [parquetPath],
        editOpsRows: [`('C','update','2026-06-01T00:00:00Z',0)`],
        editPropsRows: [`('C','c1','"edited"','2026-06-01T00:00:00Z',0)`],
      },
      conn,
      // No real DuckDB CLI in the unit lane: a stub engine that runs the
      // stdin script in a separate OS process via the same-version binding.
      { command: [process.execPath, engineStub] },
    );

    // source_state: A accumulated {a1,a2}, B tombstoned with '{}', C live.
    const states = await queryAll<{
      primary_key: string;
      tombstoned: boolean;
      properties: string;
    }>(
      conn,
      `SELECT primary_key, tombstoned, CAST(properties AS VARCHAR) AS properties
         FROM source_state ORDER BY primary_key`,
    );
    expect(states.map((r) => r.primary_key)).toEqual(["A", "B", "C"]);
    const byPk = new Map(states.map((r) => [r.primary_key, r]));
    expect(JSON.parse(String(byPk.get("A")!.properties))).toEqual({
      a1: "x",
      a2: "y",
    });
    expect(byPk.get("A")!.tombstoned).toBe(false);
    expect(byPk.get("B")!.tombstoned).toBe(true);
    expect(String(byPk.get("B")!.properties)).toBe("{}");
    expect(byPk.get("C")!.tombstoned).toBe(false);

    // Edit tables crossed the boundary too.
    const bucket = await queryAll<{ primary_key: string; edit_op: string }>(
      conn,
      `SELECT primary_key, edit_op FROM edit_bucket`,
    );
    expect(bucket).toEqual([{ primary_key: "C", edit_op: "update" }]);
    const latest = await queryAll<{
      primary_key: string;
      prop: string;
      value: string;
    }>(conn, `SELECT primary_key, prop, value FROM edit_props_latest`);
    expect(latest).toEqual([{ primary_key: "C", prop: "c1", value: '"edited"' }]);

    // The CLI work dir is deleted after a successful attach.
    const after = new Set(
      fs
        .readdirSync(os.tmpdir())
        .filter((f) => f.startsWith("merge-cli-")),
    );
    expect([...after].filter((d) => !before.has(d))).toEqual([]);
  }, 120_000);
});
