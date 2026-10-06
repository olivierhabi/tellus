// ---------------------------------------------------------------------------
// mergePrefixSql — unit tests for the shared merge-prefix statement builders.
//
// These pin the single-source-of-SQL-text contract: the in-process path and
// the out-of-process CLI path execute the SAME statements, so what is
// asserted here governs both. Covered:
//   * step order and temp-table names (2–8);
//   * single- vs multi-contribution fold shape;
//   * empty-contribution (edits-only) degradation;
//   * quote escaping in paths and literals;
//   * export/attach round-trip shape (CASTs, file names).
// ---------------------------------------------------------------------------

import { describe, expect, it, afterEach } from "vitest";

import {
  buildMergePrefixStatements,
  buildLegacyMergePrefixStatements,
  buildPrefixExportStatements,
  buildPrefixAttachStatements,
  PREFIX_EXPORT_FILES,
} from "../../../src/services/funnel/mergePrefixSql";

afterEach(() => {
  delete process.env.MERGE_NARROW_DEDUP;
});

const CONTRIBS = [
  { datasource_id: "ds-1", owned_properties: ["a"], markings: [] },
  {
    datasource_id: "ds-2",
    owned_properties: ["b"],
    markings: ["m1", "m2"],
  },
];

describe("buildMergePrefixStatements", () => {
  it("emits steps 2–8 in order with the expected temp tables (narrow default)", () => {
    const stmts = buildMergePrefixStatements({
      contributions: CONTRIBS,
      localPaths: ["/tmp/c0.parquet", "/tmp/c1.parquet"],
      editOpsRows: [],
      editPropsRows: [],
    });
    const joined = stmts.join("\n");
    const order = [
      "CREATE OR REPLACE TEMP TABLE contrib_meta",
      "INSERT INTO contrib_meta VALUES",
      "CREATE OR REPLACE TEMP TABLE changes AS",
      "AS rid",
      "CREATE OR REPLACE TEMP TABLE changes_narrow AS",
      "CREATE OR REPLACE TEMP TABLE changes_seq AS",
      "primary_key, rid",
      "DROP TABLE changes_narrow;",
      "CREATE OR REPLACE TEMP TABLE per_pk_last_delete AS",
      "CREATE OR REPLACE TEMP TABLE effective_rows AS",
      "JOIN changes ch",
      "ON ch.rid = c.rid",
      "CREATE OR REPLACE TEMP TABLE source_state AS",
      "DROP TABLE changes_seq;",
      "DROP TABLE per_pk_last_delete;",
      "DROP TABLE effective_rows;",
      "CREATE OR REPLACE TEMP TABLE edit_ops",
      "CREATE OR REPLACE TEMP TABLE edit_props",
      "CREATE OR REPLACE TEMP TABLE edit_bucket AS",
      "CREATE OR REPLACE TEMP TABLE edit_props_latest AS",
    ];
    let idx = -1;
    for (const marker of order) {
      const at = joined.indexOf(marker, idx + 1);
      expect(at, `missing/out-of-order: ${marker}`).toBeGreaterThan(idx);
      idx = at;
    }
    // No PG-touching statements in the prefix: it must stay pure-SQL so it
    // can run in a process with no database handle.
    expect(joined).not.toMatch(/object_instances|COPY \(/);
  });

  it("legacy wide sort runs only under MERGE_NARROW_DEDUP=0", () => {
    process.env.MERGE_NARROW_DEDUP = "0";
    const stmts = buildMergePrefixStatements({
      contributions: CONTRIBS,
      localPaths: ["/tmp/c0.parquet", "/tmp/c1.parquet"],
      editOpsRows: [],
      editPropsRows: [],
    });
    const joined = stmts.join("\n");
    expect(joined).toContain("CREATE OR REPLACE TEMP TABLE changes AS");
    // Wide sort: no rid handle, no narrow table, no join-back.
    expect(joined).not.toContain("AS rid");
    expect(joined).not.toContain("changes_narrow");
    expect(joined).not.toContain("ch.rid = c.rid");
    // And the legacy builder emits the same text (single source check).
    expect(stmts.join("\n")).toBe(
      buildLegacyMergePrefixStatements({
        contributions: CONTRIBS,
        localPaths: ["/tmp/c0.parquet", "/tmp/c1.parquet"],
        editOpsRows: [],
        editPropsRows: [],
      }).join("\n"),
    );
  });

  it("UNION ALL tags each contribution with its fold-order index", () => {
    const stmts = buildMergePrefixStatements({
      contributions: CONTRIBS,
      localPaths: ["/tmp/c0.parquet", "/tmp/c1.parquet"],
      editOpsRows: [],
      editPropsRows: [],
    });
    const changes = stmts.find((s) => s.startsWith("CREATE OR REPLACE TEMP TABLE changes AS"))!;
    expect(changes).toContain("SELECT 0::INTEGER AS contrib_idx");
    expect(changes).toContain("SELECT 1::INTEGER AS contrib_idx");
    expect(changes).toContain("UNION ALL");
    expect(changes).toContain("FROM read_parquet('/tmp/c0.parquet')");
    expect(changes).toContain("FROM read_parquet('/tmp/c1.parquet')");
  });

  it("single contribution uses the 1-level fold; multi uses the 2-level fold", () => {
    const single = buildMergePrefixStatements({
      contributions: [CONTRIBS[0]],
      localPaths: ["/tmp/c0.parquet"],
      editOpsRows: [],
      editPropsRows: [],
    }).join("\n");
    expect(single).toContain("FROM effective_rows GROUP BY primary_key");
    expect(single).not.toContain("per_contrib_props");

    const multi = buildMergePrefixStatements({
      contributions: CONTRIBS,
      localPaths: ["/tmp/c0.parquet", "/tmp/c1.parquet"],
      editOpsRows: [],
      editPropsRows: [],
    }).join("\n");
    expect(multi).toContain("per_contrib_props");
    expect(multi).toContain("GROUP BY primary_key, contrib_idx");
  });

  it("empty contributions degrade to the edits-only path (no INSERT, empty changes DDL)", () => {
    const stmts = buildMergePrefixStatements({
      contributions: [],
      localPaths: [],
      editOpsRows: [
        "('pk1','update','2026-01-01',0)",
      ],
      editPropsRows: [],
    });
    const joined = stmts.join("\n");
    expect(joined).not.toContain("INSERT INTO contrib_meta");
    expect(joined).not.toContain("UNION ALL");
    expect(joined).toContain("CREATE OR REPLACE TEMP TABLE changes (");
    expect(joined).toContain("INSERT INTO edit_ops VALUES ('pk1'");
  });

  it("skips empty INSERTs but keeps the DDLs", () => {
    const stmts = buildMergePrefixStatements({
      contributions: [],
      localPaths: [],
      editOpsRows: [],
      editPropsRows: [],
    });
    const joined = stmts.join("\n");
    expect(joined).not.toContain("INSERT INTO");
    expect(joined).toContain("CREATE OR REPLACE TEMP TABLE edit_ops (");
    expect(joined).toContain("CREATE OR REPLACE TEMP TABLE edit_props (");
  });

  it("doubles single quotes in paths and literals", () => {
    const stmts = buildMergePrefixStatements({
      contributions: [
        { datasource_id: "ds'o", owned_properties: [], markings: ["m'1"] },
      ],
      localPaths: ["/tmp/o'brien.parquet"],
      editOpsRows: [],
      editPropsRows: [],
    });
    const joined = stmts.join("\n");
    expect(joined).toContain("FROM read_parquet('/tmp/o''brien.parquet')");
    expect(joined).toContain("'ds''o'");
    expect(joined).toContain("'m''1'");
    expect(joined).not.toContain("o'brien.parquet')");
  });
});

describe("prefix export/attach", () => {
  it("exports the three prefix tables to the out dir", () => {
    expect([...PREFIX_EXPORT_FILES]).toEqual([
      "source_state.parquet",
      "edit_bucket.parquet",
      "edit_props_latest.parquet",
    ]);
    const stmts = buildPrefixExportStatements("/tmp/cli-1");
    expect(stmts).toHaveLength(3);
    expect(stmts[0]).toContain("FROM source_state");
    expect(stmts[0]).toContain("CAST(properties AS VARCHAR) AS properties");
    expect(stmts[0]).toContain("TO '/tmp/cli-1/source_state.parquet'");
    expect(stmts[1]).toContain("FROM edit_bucket");
    expect(stmts[2]).toContain("FROM edit_props_latest");
  });

  it("attach re-casts properties to JSON and reads the same files", () => {
    const stmts = buildPrefixAttachStatements("/tmp/cli-1");
    expect(stmts).toHaveLength(3);
    expect(stmts[0]).toContain("CREATE OR REPLACE TEMP TABLE source_state AS");
    expect(stmts[0]).toContain("CAST(properties AS JSON) AS properties");
    expect(stmts[0]).toContain(
      "FROM read_parquet('/tmp/cli-1/source_state.parquet')",
    );
    expect(stmts[1]).toContain("CREATE OR REPLACE TEMP TABLE edit_bucket AS");
    expect(stmts[2]).toContain(
      "CREATE OR REPLACE TEMP TABLE edit_props_latest AS",
    );
  });

  it("escapes quotes in the out dir on both sides", () => {
    const exp = buildPrefixExportStatements("/tmp/a'b").join("\n");
    const att = buildPrefixAttachStatements("/tmp/a'b").join("\n");
    expect(exp).toContain("/tmp/a''b/source_state.parquet");
    expect(att).toContain("/tmp/a''b/source_state.parquet");
  });
});
