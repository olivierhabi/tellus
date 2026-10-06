// ---------------------------------------------------------------------------
// mergePrefixSql — statement builders for merge steps 2–8.
//
// These build the PURE-SQL prefix of the DuckDB k-way merge (contrib_meta →
// changes → changes_seq → per_pk_last_delete → effective_rows → source_state
// → edit temp tables). The text is identical to what mergeChangesSQL used to
// inline; it is factored out so two executors can run it:
//
//   * in-process (today's path): statements executed one-by-one via runAll;
//   * out-of-process (FUNNEL_MERGE_OUT_OF_PROCESS=1): concatenated with the
//     CLI settings preamble plus the export COPYs, run by mergeCliRunner in
//     a separate DuckDB CLI process, then re-attached in-process via the
//     attach statements.
//
// Single source of SQL text: changing a statement here changes both paths.
// The export/attach pair is the isolation boundary — source_state,
// edit_bucket and edit_props_latest cross it as parquet files with explicit
// CASTs on both sides so types round-trip exactly (JSON is exported as
// VARCHAR and re-cast to JSON on attach; BOOLEAN/VARCHAR/VARCHAR[] survive
// parquet natively).
// ---------------------------------------------------------------------------

export interface PrefixContribution {
  datasource_id: string;
  owned_properties: string[];
  markings: string[];
}

/** Single-quote-doubling raw-SQL escape (same convention as runAll/queryAll). */
function sqlStr(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}
/** Build a VARCHAR[] literal from a JS string[] (empty → ARRAY[]::VARCHAR[]). */
function sqlVarcharArray(arr: string[]): string {
  if (arr.length === 0) return "ARRAY[]::VARCHAR[]";
  return `ARRAY[${arr.map(sqlStr).join(",")}]::VARCHAR[]`;
}

function escPath(p: string): string {
  return p.replace(/'/g, "''");
}

/** Step 2: contrib_meta (per-contribution constants; contrib_markings =
 *  c.markings since the changelog parquet carries NO markings column). */
export function buildContribMetaStatements(
  contributions: PrefixContribution[],
): string[] {
  const out = [
    `CREATE OR REPLACE TEMP TABLE contrib_meta (
        contrib_idx INTEGER, datasource_id VARCHAR,
        owned_properties VARCHAR[], contrib_markings VARCHAR[]
      )`,
  ];
  const metaVals = contributions
    .map(
      (c, i) =>
        `(${i},${sqlStr(c.datasource_id)},${sqlVarcharArray(
          c.owned_properties,
        )},${sqlVarcharArray(c.markings)})`,
    )
    .join(",");
  if (metaVals) {
    out.push(`INSERT INTO contrib_meta VALUES ${metaVals}`);
  }
  return out;
}

/** Step 3: changes — UNION ALL of every contribution's changelog parquet,
 *  tagged with contrib_idx (0-based, = fold order). localPaths[i] is the
 *  downloaded parquet for contributions[i]. */
export function buildChangesStatement(
  contributions: PrefixContribution[],
  localPaths: string[],
): string {
  const arms = contributions.map((_, i) => {
    const lp = escPath(localPaths[i]);
    return `SELECT ${i}::INTEGER AS contrib_idx,
        primary_key::VARCHAR AS primary_key,
        operation::VARCHAR AS operation,
        properties::VARCHAR AS properties,
        source_transaction_id::VARCHAR AS source_transaction_id,
        source_commit_timestamp::VARCHAR AS source_commit_timestamp
      FROM read_parquet('${lp}')`;
  });
  if (arms.length > 0) {
    return `CREATE OR REPLACE TEMP TABLE changes AS ${arms.join(" UNION ALL ")}`;
  }
  // No contributions (e.g. an OT with pending edits but no backing
  // datasource yet) — create an empty `changes` table so the downstream
  // CTEs degrade to empty (merged_result = edits-only path).
  return `CREATE OR REPLACE TEMP TABLE changes (
          contrib_idx INTEGER, primary_key VARCHAR, operation VARCHAR,
          properties VARCHAR, source_transaction_id VARCHAR,
          source_commit_timestamp VARCHAR
        )`;
}

// Step 4: changes_seq — glob_seq = total fold order. The PRIMARY key is
// contrib_idx (contributions-array order = OUTER fold loop); secondary keys
// reconstruct per-contribution transaction order. We deliberately do NOT
// rely on read_parquet file order (Phase 0's dedup writes the parquet
// pk-SORTED on disk, NOT transaction-sorted) — the explicit ORDER BY is
// what makes a multi-row-per-PK contribution fold correctly.
export function buildChangesSeqStatements(): string[] {
  return [
    `CREATE OR REPLACE TEMP TABLE changes_seq AS
      SELECT *, CAST(row_number() OVER (
        ORDER BY contrib_idx, source_commit_timestamp,
                 source_transaction_id, primary_key
      ) AS BIGINT) AS glob_seq FROM changes`,
    // changes_seq holds glob_seq; the bare `changes` table is no longer
    // referenced (per_pk_last_delete, effective_rows, source_state all read
    // changes_seq). DROP it now to free ~1GB of pinned-in-memory temp-table
    // pages — without this, `changes`+`changes_seq`+`effective_rows`+
    // `source_state` coexist during source_state creation and OOM at 4GB
    // (DuckDB does NOT spill materialized TEMP tables while a query that
    // references their siblings runs, so the coexisting set is the peak).
    `DROP TABLE changes;`,
  ];
}

// Step 5: per_pk_last_delete — the high-water DELETE mark per PK.
export function buildPerPkLastDeleteStatement(): string {
  return `CREATE OR REPLACE TEMP TABLE per_pk_last_delete AS
      SELECT primary_key,
        COALESCE(max(glob_seq) FILTER (WHERE operation = 'DELETE'), -1) AS last_del_seq
      FROM changes_seq GROUP BY primary_key`;
}

// Step 6: effective_rows — ALL non-DELETE rows STRICTLY AFTER the last
// DELETE. We do NOT keep only the last row per (PK, contribution) — the JS
// spec (mergeChanges:248-272) ACCUMULATES partial post-DELETE rows: each
// INSERT/UPDATE does `next.properties = { ...prior.properties }` then
// overlays THIS row's owned_properties, so earlier partial rows' keys
// carry forward. Keeping only the last row would DROP those earlier
// keys (DATA LOSS — verified by the tombstone-then-untombstone-partial
// adversarial case: INSERT{a1,a2}→DELETE→INSERT{a1}→UPDATE{a2} must
// yield {a1,a2}, not {a2}). The accumulation happens in eff_props below.
export function buildEffectiveRowsStatement(): string {
  return `CREATE OR REPLACE TEMP TABLE effective_rows AS
      SELECT c.primary_key, c.contrib_idx, cm.datasource_id, c.properties,
             c.source_transaction_id, c.source_commit_timestamp, c.glob_seq
      FROM changes_seq c
      JOIN per_pk_last_delete d ON d.primary_key = c.primary_key
      JOIN contrib_meta cm      ON cm.contrib_idx = c.contrib_idx
      WHERE c.operation <> 'DELETE' AND c.glob_seq > d.last_del_seq`;
}

// Step 7: source_state — per-PK overlay. `eff_props` ACCUMULATES the
// post-DELETE non-DELETE rows per (PK, contribution) in glob_seq order
// (json_merge_patch fold = the JS `{...prior.properties}` carry-forward
// + per-owned-property overlay; column-wise MDO means no key conflict
// across contributions). The fast path (count=1 → first(properties))
// skips the per-PK JSON fold for the common deduped-1-row-per-PK case;
// the fold engages for multi-row-per-PK contributions — WITHOUT it the
// SQL would drop earlier partial rows (data loss). For >1 contribution a
// 2-level fold: inner per (PK, contribution) accumulate, outer
// cross-contribution merge (in contrib_idx = fold order).
export function buildSourceStateStatements(
  singleContribution: boolean,
): string[] {
  const contribFold = (expr: string) =>
    `CASE WHEN count(*) = 1
        THEN first(${expr})
        ELSE list_reduce(
          list_prepend('{}'::JSON, list(${expr} ORDER BY glob_seq)),
          (acc, p) -> json_merge_patch(acc, p))
       END`;
  const effPropsCte = singleContribution
    ? `eff_props AS (
          SELECT primary_key, ${contribFold("properties::JSON")} AS properties
          FROM effective_rows GROUP BY primary_key
        )`
    : `eff_props AS (
          SELECT primary_key,
            list_reduce(
              list_prepend('{}'::JSON,
                list(per_contrib_props ORDER BY contrib_idx)),
              (acc, p) -> json_merge_patch(acc, p)
            ) AS properties
          FROM (
            SELECT primary_key, contrib_idx,
              ${contribFold("properties::JSON")} AS per_contrib_props
            FROM effective_rows GROUP BY primary_key, contrib_idx
          ) pc
          GROUP BY primary_key
        )`;
  return [
    `CREATE OR REPLACE TEMP TABLE source_state AS
      WITH src_info AS (
        SELECT c.primary_key,
          first(cm.datasource_id ORDER BY c.glob_seq DESC)           AS source_datasource_id,
          first(c.source_transaction_id ORDER BY c.glob_seq DESC)     AS source_transaction_id,
          first(c.source_commit_timestamp ORDER BY c.glob_seq DESC)   AS source_timestamp
        FROM changes_seq c
        JOIN contrib_meta cm ON cm.contrib_idx = c.contrib_idx
        GROUP BY c.primary_key
      ),
      ${effPropsCte},
      eff_pks AS (SELECT DISTINCT primary_key FROM effective_rows),
      src_markings AS (
        SELECT c.primary_key,
          COALESCE(
            array_sort(array_agg(DISTINCT trim(m))
              FILTER (WHERE m IS NOT NULL AND trim(m) <> '')),
            ARRAY[]::VARCHAR[]
          ) AS markings
        FROM changes_seq c
        JOIN contrib_meta cm ON cm.contrib_idx = c.contrib_idx
        LEFT JOIN unnest(cm.contrib_markings) AS t(m) ON true
        GROUP BY c.primary_key
      )
      SELECT s.primary_key, s.source_datasource_id, s.source_transaction_id,
             s.source_timestamp,
             (ep.primary_key IS NULL) AS tombstoned,
             COALESCE(epp.properties, '{}'::JSON) AS properties,
             mk.markings
      FROM src_info s
      LEFT JOIN eff_pks   ep  ON ep.primary_key  = s.primary_key
      LEFT JOIN eff_props epp ON epp.primary_key = s.primary_key
      LEFT JOIN src_markings mk ON mk.primary_key = s.primary_key`,
    // source_state is materialized from changes_seq + effective_rows; neither
    // is referenced again (edit_* come from JS arrays; the existing-block COPY
    // reads source_state + edit_bucket; merged_result reads source_state +
    // edit_bucket + edit_props_latest). DROP them now so the existing-block +
    // merged_result stages don't carry ~2GB of dead pinned temp-table pages.
    `DROP TABLE changes_seq;`,
    `DROP TABLE per_pk_last_delete;`,
    `DROP TABLE effective_rows;`,
  ];
}

// Step 8: edits temp tables. edit_ops: one row per edit; edit_props: one row
// per non-delete edit × property. Depends only on the JS pendingEdits array
// (no DuckDB temp table). edit_seq = pendingEdits input-array index.
export function buildEditStatements(
  editOpsRows: string[],
  editPropsRows: string[],
): string[] {
  const out = [
    `CREATE OR REPLACE TEMP TABLE edit_ops (
        primary_key VARCHAR, operation VARCHAR, created_at VARCHAR, edit_seq INTEGER
      )`,
  ];
  if (editOpsRows.length > 0) {
    out.push(`INSERT INTO edit_ops VALUES ${editOpsRows.join(",")}`);
  }
  out.push(
    `CREATE OR REPLACE TEMP TABLE edit_props (
        primary_key VARCHAR, prop VARCHAR, value VARCHAR, created_at VARCHAR, edit_seq INTEGER
      )`,
  );
  if (editPropsRows.length > 0) {
    out.push(`INSERT INTO edit_props VALUES ${editPropsRows.join(",")}`);
  }
  out.push(
    `CREATE OR REPLACE TEMP TABLE edit_bucket AS
      SELECT primary_key,
        first(operation ORDER BY created_at DESC, edit_seq ASC) AS edit_op
      FROM edit_ops GROUP BY primary_key`,
    `CREATE OR REPLACE TEMP TABLE edit_props_latest AS
      WITH x AS (
        SELECT primary_key, prop, value, created_at,
          row_number() OVER (PARTITION BY primary_key, prop ORDER BY edit_seq DESC) AS rn
        FROM edit_props
      )
      SELECT primary_key, prop, value, created_at FROM x WHERE rn = 1`,
  );
  return out;
}

/** Full prefix in execution order (steps 2–8). `localPaths[i]` is the
 *  downloaded changelog parquet for contributions[i]. */
export function buildMergePrefixStatements(args: {
  contributions: PrefixContribution[];
  localPaths: string[];
  editOpsRows: string[];
  editPropsRows: string[];
}): string[] {
  return [
    ...buildContribMetaStatements(args.contributions),
    buildChangesStatement(args.contributions, args.localPaths),
    ...buildChangesSeqStatements(),
    buildPerPkLastDeleteStatement(),
    buildEffectiveRowsStatement(),
    ...buildSourceStateStatements(args.contributions.length === 1),
    ...buildEditStatements(args.editOpsRows, args.editPropsRows),
  ];
}

export const PREFIX_EXPORT_FILES = [
  "source_state.parquet",
  "edit_bucket.parquet",
  "edit_props_latest.parquet",
] as const;

/** COPY the prefix outputs across the process boundary. Explicit CASTs so
 *  types round-trip exactly (JSON has no parquet logical type — it crosses
 *  as VARCHAR and is re-cast on attach). */
export function buildPrefixExportStatements(outDir: string): string[] {
  const q = (f: string) => escPath(`${outDir}/${f}`);
  return [
    `COPY (SELECT primary_key, source_datasource_id, source_transaction_id,
                  source_timestamp, tombstoned,
                  CAST(properties AS VARCHAR) AS properties, markings
           FROM source_state) TO '${q("source_state.parquet")}' (FORMAT PARQUET)`,
    `COPY (SELECT primary_key, edit_op FROM edit_bucket)
           TO '${q("edit_bucket.parquet")}' (FORMAT PARQUET)`,
    `COPY (SELECT primary_key, prop, value, created_at FROM edit_props_latest)
           TO '${q("edit_props_latest.parquet")}' (FORMAT PARQUET)`,
  ];
}

/** Re-attach the prefix outputs in-process. CASTs mirror the export side;
 *  the resulting temp tables are schema-identical to the in-process path's. */
export function buildPrefixAttachStatements(outDir: string): string[] {
  const q = (f: string) => escPath(`${outDir}/${f}`);
  return [
    `CREATE OR REPLACE TEMP TABLE source_state AS
     SELECT primary_key, source_datasource_id, source_transaction_id,
            source_timestamp, tombstoned,
            CAST(properties AS JSON) AS properties, markings
     FROM read_parquet('${q("source_state.parquet")}')`,
    `CREATE OR REPLACE TEMP TABLE edit_bucket AS
     SELECT primary_key, edit_op
     FROM read_parquet('${q("edit_bucket.parquet")}')`,
    `CREATE OR REPLACE TEMP TABLE edit_props_latest AS
     SELECT primary_key, prop, value, created_at
     FROM read_parquet('${q("edit_props_latest.parquet")}')`,
  ];
}
