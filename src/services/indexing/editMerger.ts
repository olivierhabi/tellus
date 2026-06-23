// ---------------------------------------------------------------------------
// Edit Merger
//
// Merges user edits (from the `ontology_edit` table, created by the Action
// execution engine) with datasource data during reindexing.
//
// In Palantir's Object Storage V2, user edits take precedence over
// datasource data. When a reindex occurs, the Funnel merges the latest
// datasource data with any pending user edits — and user edits win for any
// property where both the datasource and a user edit provide a value for
// the same primary key.
//
// Why "user edits win" matters: A tax auditor uses an Action to change a
// taxpayer's risk score from "low" to "high". That night, the datasource is
// refreshed from the e-tax system, which still has risk score "low". Without
// edit precedence, the auditor's change would be silently overwritten.
// Palantir's architecture ensures user edits survive reindexes.
// ---------------------------------------------------------------------------

import { query } from "../../db";
import type { QueryResult } from "pg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single edit record from the `ontology_edit` table. */
export interface EditRecord {
  edit_id: string;
  object_type_api_name: string;
  primary_key: string;
  operation: "create" | "update" | "delete";
  property_values: Record<string, unknown> | null;
  executed_by: string | null;
  executed_at: string;
  indexed: boolean;
}

/** Stats returned alongside the merged documents. */
export interface MergeStats {
  totalDatasourceDocuments: number;
  editsApplied: number;
  updateEdits: number;
  deleteEdits: number;
  createEdits: number;
  finalDocumentCount: number;
}

/** The result of mergeEditsWithDatasource(). */
export interface MergeResult {
  mergedDocuments: Array<Record<string, unknown>>;
  stats: MergeStats;
}

/**
 * Query function signature — matches db.query() but allows injection
 * for testing without a live PostgreSQL connection.
 */
export type QueryFn = (
  text: string,
  values?: unknown[]
) => Promise<QueryResult>;

/** Options for mergeEditsWithDatasource(). */
export interface MergeOptions {
  /** Injected query function. Defaults to the real db.query(). */
  queryFn?: QueryFn;
}

// ---------------------------------------------------------------------------
// mergeEditsWithDatasource()
// ---------------------------------------------------------------------------

/**
 * Merge user edits with datasource documents. User edits always win over
 * datasource values for the same primary key.
 *
 * @param documents          - Transformed documents from the batch builder
 *                             (Task 9). Each has `__pk` and all property
 *                             values from the datasource.
 * @param objectTypeApiName  - The object type API name, used to query the
 *                             edit store.
 * @param options            - Optional configuration (e.g. injected queryFn).
 * @returns A MergeResult with the final document array and stats.
 */
export async function mergeEditsWithDatasource(
  documents: Array<Record<string, unknown>>,
  objectTypeApiName: string,
  options?: MergeOptions
): Promise<MergeResult> {
  const qfn = options?.queryFn ?? query;

  // -----------------------------------------------------------------------
  // 1. Query un-indexed edits for this object type
  // -----------------------------------------------------------------------
  const unindexedResult = await qfn(
    `SELECT * FROM ontology_edit
     WHERE object_type_api_name = $1 AND indexed = false
     ORDER BY executed_at ASC`,
    [objectTypeApiName]
  );

  // -----------------------------------------------------------------------
  // 2. Query all previously indexed create/update edits (they must still
  //    win over a re-uploaded datasource that may contain original values),
  //    PLUS any delete that is already indexed=true. Without the delete
  //    clause, a forceRecreateIndex would re-read the datasource and silently
  //    resurrect an object the user previously deleted (indexed=false deletes
  //    are already caught by `unindexedResult` above; this closes the gap for
  //    deletes that a prior run already marked indexed). buildEditMap keeps
  //    the latest executed_at per PK and the delete branch below drops them.
  // -----------------------------------------------------------------------
  const persistentResult = await qfn(
    `SELECT * FROM ontology_edit
     WHERE object_type_api_name = $1
       AND (operation IN ('update', 'create')
            OR (operation = 'delete' AND indexed = true))
     ORDER BY executed_at ASC`,
    [objectTypeApiName]
  );

  // -----------------------------------------------------------------------
  // 3. Combine and deduplicate — latest executed_at wins per PK
  // -----------------------------------------------------------------------
  const editMap = buildEditMap(
    unindexedResult.rows as EditRecord[],
    persistentResult.rows as EditRecord[]
  );

  // -----------------------------------------------------------------------
  // 4. Iterate through datasource documents and apply edits
  // -----------------------------------------------------------------------
  const mergedDocuments: Array<Record<string, unknown>> = [];
  const processedPKs = new Set<string>();
  const processedEditIds = new Set<string>();

  let updateEdits = 0;
  let deleteEdits = 0;

  for (const doc of documents) {
    const pk = String(doc.__pk);
    processedPKs.add(pk);

    const edit = editMap.get(pk);

    if (!edit) {
      // No edit for this PK — keep datasource document as-is
      mergedDocuments.push(doc);
      continue;
    }

    processedEditIds.add(edit.edit_id);

    if (edit.operation === "delete") {
      // Delete edit: remove this document from the batch entirely
      deleteEdits++;
      continue;
    }

    if (edit.operation === "update") {
      // Update edit: merge edit property_values into the document
      const merged = applyUpdateEdit(doc, edit);
      mergedDocuments.push(merged);
      updateEdits++;
      continue;
    }

    // For "create" edits that have a matching datasource row, treat
    // like an update — the edit values win
    if (edit.operation === "create") {
      const merged = applyUpdateEdit(doc, edit);
      mergedDocuments.push(merged);
      updateEdits++;
      continue;
    }

    // Fallback: keep the document as-is (should not reach here)
    mergedDocuments.push(doc);
  }

  // -----------------------------------------------------------------------
  // 4b. Check for "create" edits with no matching datasource row
  // -----------------------------------------------------------------------
  let createEdits = 0;

  for (const [pk, edit] of editMap) {
    if (processedPKs.has(pk)) continue;
    if (edit.operation !== "create") continue;

    // Action-created object with no datasource backing
    const newDoc = buildCreateDocument(pk, objectTypeApiName, edit);
    mergedDocuments.push(newDoc);
    processedEditIds.add(edit.edit_id);
    createEdits++;
  }

  // -----------------------------------------------------------------------
  // 5. Mark all processed edits as indexed
  // -----------------------------------------------------------------------
  const editIdsToMark = Array.from(processedEditIds);
  if (editIdsToMark.length > 0) {
    await qfn(
      `UPDATE ontology_edit SET indexed = true, indexed_at = now()
       WHERE edit_id = ANY($1)`,
      [editIdsToMark]
    );
  }

  // -----------------------------------------------------------------------
  // 6. Return merged result
  // -----------------------------------------------------------------------
  const editsApplied = updateEdits + deleteEdits + createEdits;

  return {
    mergedDocuments,
    stats: {
      totalDatasourceDocuments: documents.length,
      editsApplied,
      updateEdits,
      deleteEdits,
      createEdits,
      finalDocumentCount: mergedDocuments.length,
    },
  };
}

// ---------------------------------------------------------------------------
// buildEditMap()
// ---------------------------------------------------------------------------

/**
 * Combine two arrays of edit records into a deduplicated Map keyed by
 * primary_key. If multiple edits exist for the same PK, the one with the
 * latest `executed_at` wins.
 */
function buildEditMap(
  unindexed: EditRecord[],
  persistent: EditRecord[]
): Map<string, EditRecord> {
  const map = new Map<string, EditRecord>();

  // Process persistent edits first (older), then unindexed (newer).
  // This way, if there's overlap, the unindexed entry wins on timestamp.
  const combined = [...persistent, ...unindexed];

  // Deduplicate by edit_id first to avoid comparing the same row twice
  const byEditId = new Map<string, EditRecord>();
  for (const edit of combined) {
    byEditId.set(edit.edit_id, edit);
  }

  // Now build the PK map — latest executed_at wins
  for (const edit of byEditId.values()) {
    const pk = edit.primary_key;
    const existing = map.get(pk);

    if (!existing) {
      map.set(pk, edit);
      continue;
    }

    // Compare timestamps — latest wins
    const existingTime = new Date(existing.executed_at).getTime();
    const editTime = new Date(edit.executed_at).getTime();

    if (editTime >= existingTime) {
      map.set(pk, edit);
    }
  }

  return map;
}

// ---------------------------------------------------------------------------
// applyUpdateEdit()
// ---------------------------------------------------------------------------

/**
 * Merge an edit's property_values into a datasource document. Edit values
 * overwrite datasource values; properties NOT in the edit are left as-is.
 *
 * Also updates system fields: __editedBy, __lastModified, __version.
 */
function applyUpdateEdit(
  doc: Record<string, unknown>,
  edit: EditRecord
): Record<string, unknown> {
  const merged = { ...doc };

  // Overlay edit property values
  if (edit.property_values) {
    for (const [key, value] of Object.entries(edit.property_values)) {
      merged[key] = value;
    }
  }

  // Update system fields
  merged.__editedBy = edit.executed_by;
  merged.__lastModified = edit.executed_at;

  // Increment __version
  const currentVersion =
    typeof merged.__version === "number" ? merged.__version : 0;
  merged.__version = currentVersion + 1;

  return merged;
}

// ---------------------------------------------------------------------------
// buildCreateDocument()
// ---------------------------------------------------------------------------

/**
 * Build a new document from a "create" edit that has no matching datasource
 * row. This is an Action-created object with no datasource backing.
 */
function buildCreateDocument(
  pk: string,
  objectTypeApiName: string,
  edit: EditRecord
): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    __pk: pk,
    __objectType: objectTypeApiName,
    __lastModified: edit.executed_at,
    __version: 1,
    __editedBy: edit.executed_by,
    __datasourceVersion: null,
  };

  // Spread edit property values into the document
  if (edit.property_values) {
    for (const [key, value] of Object.entries(edit.property_values)) {
      doc[key] = value;
    }
  }

  return doc;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { mergeEditsWithDatasource };

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/services/indexing/editMerger.ts)
// ---------------------------------------------------------------------------

export async function runSelfTests(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) {
      passed++;
    } else {
      /* v8 ignore next 2 */
      failed++;
      console.error(`  FAIL: ${label}`);
    }
  }

  console.log("Running editMerger self-tests...\n");

  // =======================================================================
  // Mock query function factory
  // =======================================================================

  /**
   * Create a mock queryFn that returns predefined rows for the two
   * edit queries and tracks the UPDATE call for marking edits indexed.
   */
  function createMockQueryFn(
    unindexedEdits: EditRecord[],
    persistentEdits: EditRecord[]
  ): {
    queryFn: QueryFn;
    markedEditIds: string[][];
  } {
    const markedEditIds: string[][] = [];
    let callCount = 0;

    const queryFn: QueryFn = async (
      text: string,
      values?: unknown[]
    ): Promise<QueryResult> => {
      // First call: un-indexed edits
      if (text.includes("indexed = false")) {
        callCount++;
        return { rows: unindexedEdits, rowCount: unindexedEdits.length } as unknown as QueryResult;
      }

      // Second call: persistent create/update edits
      if (text.includes("operation IN")) {
        callCount++;
        return { rows: persistentEdits, rowCount: persistentEdits.length } as unknown as QueryResult;
      }

      // Third call: UPDATE to mark edits as indexed
      if (text.includes("UPDATE ontology_edit")) {
        if (values && Array.isArray(values[0])) {
          markedEditIds.push(values[0] as string[]);
        }
        return { rows: [], rowCount: 0 } as unknown as QueryResult;
      }

      return { rows: [], rowCount: 0 } as unknown as QueryResult;
    };

    return { queryFn, markedEditIds };
  }

  // =======================================================================
  // Test fixtures
  // =======================================================================

  function makeDoc(
    pk: string,
    props: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      __pk: pk,
      __objectType: "Taxpayer",
      __lastModified: "2025-01-01T00:00:00.000Z",
      __version: 1,
      __editedBy: null,
      __datasourceVersion: "txn-001",
      taxId: pk,
      name: `Name for ${pk}`,
      riskScore: "low",
      ...props,
    };
  }

  function makeEdit(
    editId: string,
    pk: string,
    operation: "create" | "update" | "delete",
    propertyValues: Record<string, unknown> | null,
    executedBy: string,
    executedAt: string,
    indexed: boolean = false
  ): EditRecord {
    return {
      edit_id: editId,
      object_type_api_name: "Taxpayer",
      primary_key: pk,
      operation,
      property_values: propertyValues,
      executed_by: executedBy,
      executed_at: executedAt,
      indexed,
    };
  }

  // =======================================================================
  // Test 1: No edits — documents pass through unchanged
  // =======================================================================
  {
    const docs = [makeDoc("TP-001"), makeDoc("TP-002"), makeDoc("TP-003")];
    const { queryFn } = createMockQueryFn([], []);

    const result = await mergeEditsWithDatasource(docs, "Taxpayer", { queryFn });

    assert(result.mergedDocuments.length === 3, "no edits: 3 documents");
    assert(result.stats.totalDatasourceDocuments === 3, "no edits: totalDatasourceDocuments");
    assert(result.stats.editsApplied === 0, "no edits: editsApplied 0");
    assert(result.stats.updateEdits === 0, "no edits: updateEdits 0");
    assert(result.stats.deleteEdits === 0, "no edits: deleteEdits 0");
    assert(result.stats.createEdits === 0, "no edits: createEdits 0");
    assert(result.stats.finalDocumentCount === 3, "no edits: finalDocumentCount 3");
    assert(result.mergedDocuments[0].__pk === "TP-001", "no edits: doc 0 preserved");
  }

  // =======================================================================
  // Test 2: Update edits — user values override datasource values
  // =======================================================================
  {
    const docs = [
      makeDoc("TP-001", { riskScore: "low", name: "Alice" }),
      makeDoc("TP-002", { riskScore: "medium", name: "Bob" }),
      makeDoc("TP-003", { riskScore: "low", name: "Charlie" }),
    ];

    const edits: EditRecord[] = [
      makeEdit("ed-1", "TP-001", "update", { riskScore: "high" }, "auditor1", "2025-06-15T10:00:00.000Z"),
      makeEdit("ed-2", "TP-003", "update", { riskScore: "critical", name: "Charlie Updated" }, "auditor2", "2025-06-15T11:00:00.000Z"),
    ];

    const { queryFn, markedEditIds } = createMockQueryFn(edits, []);
    const result = await mergeEditsWithDatasource(docs, "Taxpayer", { queryFn });

    assert(result.mergedDocuments.length === 3, "update: 3 documents");
    assert(result.stats.updateEdits === 2, "update: 2 updateEdits");
    assert(result.stats.editsApplied === 2, "update: 2 editsApplied");

    const tp001 = result.mergedDocuments.find((d) => d.__pk === "TP-001")!;
    assert(tp001.riskScore === "high", "update: TP-001 riskScore overridden to high");
    assert(tp001.name === "Alice", "update: TP-001 name preserved (not in edit)");
    assert(tp001.__editedBy === "auditor1", "update: TP-001 __editedBy set");
    assert(tp001.__lastModified === "2025-06-15T10:00:00.000Z", "update: TP-001 __lastModified set");
    assert(tp001.__version === 2, "update: TP-001 __version incremented to 2");

    const tp002 = result.mergedDocuments.find((d) => d.__pk === "TP-002")!;
    assert(tp002.riskScore === "medium", "update: TP-002 unchanged");
    assert(tp002.__editedBy === null, "update: TP-002 __editedBy still null");

    const tp003 = result.mergedDocuments.find((d) => d.__pk === "TP-003")!;
    assert(tp003.riskScore === "critical", "update: TP-003 riskScore overridden");
    assert(tp003.name === "Charlie Updated", "update: TP-003 name overridden");

    // Edit IDs should be marked as indexed
    assert(markedEditIds.length === 1, "update: one UPDATE call made");
    assert(
      markedEditIds[0].includes("ed-1") && markedEditIds[0].includes("ed-2"),
      "update: both edit IDs marked"
    );
  }

  // =======================================================================
  // Test 3: Delete edit — removes document from batch
  // =======================================================================
  {
    const docs = [
      makeDoc("TP-001"),
      makeDoc("TP-002"),
      makeDoc("TP-003"),
    ];

    const edits: EditRecord[] = [
      makeEdit("ed-del-1", "TP-002", "delete", null, "admin", "2025-06-15T12:00:00.000Z"),
    ];

    const { queryFn } = createMockQueryFn(edits, []);
    const result = await mergeEditsWithDatasource(docs, "Taxpayer", { queryFn });

    assert(result.mergedDocuments.length === 2, "delete: 2 documents");
    assert(result.stats.deleteEdits === 1, "delete: 1 deleteEdit");
    assert(result.stats.finalDocumentCount === 2, "delete: finalDocumentCount 2");

    const pks = result.mergedDocuments.map((d) => d.__pk);
    assert(!pks.includes("TP-002"), "delete: TP-002 removed");
    assert(pks.includes("TP-001"), "delete: TP-001 kept");
    assert(pks.includes("TP-003"), "delete: TP-003 kept");
  }

  // =======================================================================
  // Test 4: Create edit (no matching datasource row) — new document added
  // =======================================================================
  {
    const docs = [makeDoc("TP-001"), makeDoc("TP-002")];

    const edits: EditRecord[] = [
      makeEdit(
        "ed-create-1",
        "TP-NEW",
        "create",
        { taxId: "TP-NEW", name: "New Taxpayer", riskScore: "high" },
        "operator1",
        "2025-06-15T14:00:00.000Z"
      ),
    ];

    const { queryFn } = createMockQueryFn(edits, []);
    const result = await mergeEditsWithDatasource(docs, "Taxpayer", { queryFn });

    assert(result.mergedDocuments.length === 3, "create: 3 documents (2 + 1 new)");
    assert(result.stats.createEdits === 1, "create: 1 createEdit");
    assert(result.stats.finalDocumentCount === 3, "create: finalDocumentCount 3");

    const newDoc = result.mergedDocuments.find((d) => d.__pk === "TP-NEW")!;
    assert(newDoc !== undefined, "create: TP-NEW exists");
    assert(newDoc.name === "New Taxpayer", "create: name from edit");
    assert(newDoc.riskScore === "high", "create: riskScore from edit");
    assert(newDoc.__objectType === "Taxpayer", "create: __objectType set");
    assert(newDoc.__editedBy === "operator1", "create: __editedBy set");
    assert(newDoc.__version === 1, "create: __version is 1");
    assert(newDoc.__datasourceVersion === null, "create: __datasourceVersion null");
  }

  // =======================================================================
  // Test 5: Combined scenario — update, delete, and create together
  // =======================================================================
  {
    const docs: Array<Record<string, unknown>> = [];
    for (let i = 1; i <= 10; i++) {
      docs.push(
        makeDoc(`TP-${String(i).padStart(3, "0")}`, {
          riskScore: "low",
          name: `Taxpayer ${i}`,
        })
      );
    }

    const edits: EditRecord[] = [
      // Update 2 existing
      makeEdit("ed-u1", "TP-003", "update", { riskScore: "high" }, "auditor1", "2025-06-15T10:00:00.000Z"),
      makeEdit("ed-u2", "TP-007", "update", { riskScore: "critical" }, "auditor2", "2025-06-15T10:30:00.000Z"),
      // Delete 1 existing
      makeEdit("ed-d1", "TP-005", "delete", null, "admin", "2025-06-15T11:00:00.000Z"),
      // Create 1 new
      makeEdit("ed-c1", "TP-NEW-1", "create", { taxId: "TP-NEW-1", name: "Created via Action", riskScore: "medium" }, "operator1", "2025-06-15T12:00:00.000Z"),
    ];

    const { queryFn, markedEditIds } = createMockQueryFn(edits, []);
    const result = await mergeEditsWithDatasource(docs, "Taxpayer", { queryFn });

    // 10 datasource - 1 delete + 1 create = 10 final
    assert(
      result.stats.finalDocumentCount === 10,
      `combined: finalDocumentCount 10 (got ${result.stats.finalDocumentCount})`
    );
    assert(result.stats.totalDatasourceDocuments === 10, "combined: totalDatasourceDocuments 10");
    assert(result.stats.updateEdits === 2, "combined: 2 updateEdits");
    assert(result.stats.deleteEdits === 1, "combined: 1 deleteEdit");
    assert(result.stats.createEdits === 1, "combined: 1 createEdit");
    assert(result.stats.editsApplied === 4, "combined: 4 editsApplied");

    // Verify updates
    const tp003 = result.mergedDocuments.find((d) => d.__pk === "TP-003")!;
    assert(tp003.riskScore === "high", "combined: TP-003 updated");
    assert(tp003.name === "Taxpayer 3", "combined: TP-003 name preserved");

    const tp007 = result.mergedDocuments.find((d) => d.__pk === "TP-007")!;
    assert(tp007.riskScore === "critical", "combined: TP-007 updated");

    // Verify delete
    assert(
      !result.mergedDocuments.some((d) => d.__pk === "TP-005"),
      "combined: TP-005 deleted"
    );

    // Verify create
    const newDoc = result.mergedDocuments.find((d) => d.__pk === "TP-NEW-1")!;
    assert(newDoc.name === "Created via Action", "combined: created doc name");

    // Verify all 4 edit IDs were marked
    assert(markedEditIds.length === 1, "combined: one UPDATE call");
    assert(markedEditIds[0].length === 4, "combined: 4 edit IDs marked");
  }

  // =======================================================================
  // Test 6: Duplicate edits for same PK — latest executed_at wins
  // =======================================================================
  {
    const docs = [makeDoc("TP-001", { riskScore: "low" })];

    const edits: EditRecord[] = [
      makeEdit("ed-old", "TP-001", "update", { riskScore: "medium" }, "auditor1", "2025-06-14T10:00:00.000Z"),
      makeEdit("ed-new", "TP-001", "update", { riskScore: "critical" }, "auditor2", "2025-06-15T10:00:00.000Z"),
    ];

    const { queryFn } = createMockQueryFn(edits, []);
    const result = await mergeEditsWithDatasource(docs, "Taxpayer", { queryFn });

    const tp001 = result.mergedDocuments.find((d) => d.__pk === "TP-001")!;
    assert(tp001.riskScore === "critical", "dedup: latest edit wins (critical, not medium)");
    assert(tp001.__editedBy === "auditor2", "dedup: latest auditor wins");
  }

  // =======================================================================
  // Test 7: Overlapping rows between unindexed and persistent queries
  // =======================================================================
  {
    const docs = [makeDoc("TP-001", { riskScore: "low" })];

    const edit = makeEdit("ed-overlap", "TP-001", "update", { riskScore: "high" }, "auditor1", "2025-06-15T10:00:00.000Z");
    // Same edit appears in both queries (overlap)
    const unindexed = [edit];
    const persistent = [{ ...edit, indexed: true }];

    const { queryFn } = createMockQueryFn(unindexed, persistent);
    const result = await mergeEditsWithDatasource(docs, "Taxpayer", { queryFn });

    assert(result.stats.updateEdits === 1, "overlap: exactly 1 update (not double-counted)");
    assert(result.mergedDocuments.length === 1, "overlap: 1 document");

    const tp001 = result.mergedDocuments.find((d) => d.__pk === "TP-001")!;
    assert(tp001.riskScore === "high", "overlap: edit applied");
  }

  // =======================================================================
  // Test 8: Create edit with matching datasource row — treated as update
  // =======================================================================
  {
    const docs = [makeDoc("TP-001", { riskScore: "low", name: "Original" })];

    const edits: EditRecord[] = [
      makeEdit(
        "ed-create-existing",
        "TP-001",
        "create",
        { riskScore: "high", name: "Overridden by create" },
        "operator1",
        "2025-06-15T10:00:00.000Z"
      ),
    ];

    const { queryFn } = createMockQueryFn(edits, []);
    const result = await mergeEditsWithDatasource(docs, "Taxpayer", { queryFn });

    // Create edit for existing PK → treated as update (edit values win)
    assert(result.stats.updateEdits === 1, "create-existing: counted as update");
    assert(result.stats.createEdits === 0, "create-existing: 0 creates");
    assert(result.mergedDocuments.length === 1, "create-existing: 1 document");

    const tp001 = result.mergedDocuments.find((d) => d.__pk === "TP-001")!;
    assert(tp001.riskScore === "high", "create-existing: riskScore overridden");
    assert(tp001.name === "Overridden by create", "create-existing: name overridden");
  }

  // =======================================================================
  // Test 9: Empty documents array with create edits
  // =======================================================================
  {
    const edits: EditRecord[] = [
      makeEdit(
        "ed-c1",
        "TP-NEW",
        "create",
        { taxId: "TP-NEW", name: "Brand New" },
        "operator",
        "2025-06-15T10:00:00.000Z"
      ),
    ];

    const { queryFn } = createMockQueryFn(edits, []);
    const result = await mergeEditsWithDatasource([], "Taxpayer", { queryFn });

    assert(result.stats.totalDatasourceDocuments === 0, "empty+create: 0 datasource docs");
    assert(result.stats.createEdits === 1, "empty+create: 1 create");
    assert(result.stats.finalDocumentCount === 1, "empty+create: 1 final doc");
    assert(result.mergedDocuments[0].__pk === "TP-NEW", "empty+create: PK is TP-NEW");
    assert(result.mergedDocuments[0].name === "Brand New", "empty+create: name set");
  }

  // =======================================================================
  // Test 10: __version increments correctly for already-versioned docs
  // =======================================================================
  {
    const docs = [
      makeDoc("TP-001", { riskScore: "low" }),
    ];
    // Simulate a document that was previously edited (already at version 3)
    docs[0].__version = 3;

    const edits: EditRecord[] = [
      makeEdit("ed-v", "TP-001", "update", { riskScore: "high" }, "auditor1", "2025-06-15T10:00:00.000Z"),
    ];

    const { queryFn } = createMockQueryFn(edits, []);
    const result = await mergeEditsWithDatasource(docs, "Taxpayer", { queryFn });

    const tp001 = result.mergedDocuments.find((d) => d.__pk === "TP-001")!;
    assert(tp001.__version === 4, "version: incremented from 3 to 4");
  }

  // =======================================================================
  // Test 11: Delete edit for PK not in datasource — silently ignored
  // =======================================================================
  {
    const docs = [makeDoc("TP-001")];

    const edits: EditRecord[] = [
      makeEdit("ed-del-ghost", "TP-NONEXISTENT", "delete", null, "admin", "2025-06-15T10:00:00.000Z"),
    ];

    const { queryFn } = createMockQueryFn(edits, []);
    const result = await mergeEditsWithDatasource(docs, "Taxpayer", { queryFn });

    assert(result.mergedDocuments.length === 1, "ghost delete: 1 document (no change)");
    assert(result.stats.deleteEdits === 0, "ghost delete: 0 deleteEdits (PK not in datasource)");
    assert(result.stats.editsApplied === 0, "ghost delete: 0 editsApplied");
  }

  // =======================================================================
  // Test 12: Edit with null property_values — only system fields updated
  // =======================================================================
  {
    const docs = [makeDoc("TP-001", { riskScore: "low", name: "Alice" })];

    const edits: EditRecord[] = [
      makeEdit("ed-null-props", "TP-001", "update", null, "auditor1", "2025-06-15T10:00:00.000Z"),
    ];

    const { queryFn } = createMockQueryFn(edits, []);
    const result = await mergeEditsWithDatasource(docs, "Taxpayer", { queryFn });

    const tp001 = result.mergedDocuments.find((d) => d.__pk === "TP-001")!;
    assert(tp001.riskScore === "low", "null props: riskScore unchanged");
    assert(tp001.name === "Alice", "null props: name unchanged");
    assert(tp001.__editedBy === "auditor1", "null props: __editedBy updated");
    assert(tp001.__version === 2, "null props: __version incremented");
    assert(result.stats.updateEdits === 1, "null props: counted as update");
  }

  // =======================================================================
  // Test 13: Persistent edits re-applied after datasource re-upload
  // =======================================================================
  {
    // Simulate: auditor changed riskScore to "high" yesterday (indexed=true).
    // Today the datasource is re-uploaded with the original "low" value.
    // The persistent edit should still win.
    const docs = [makeDoc("TP-001", { riskScore: "low" })];

    const unindexed: EditRecord[] = []; // No new un-indexed edits
    const persistent: EditRecord[] = [
      makeEdit("ed-persistent", "TP-001", "update", { riskScore: "high" }, "auditor1", "2025-06-15T10:00:00.000Z", true),
    ];

    const { queryFn } = createMockQueryFn(unindexed, persistent);
    const result = await mergeEditsWithDatasource(docs, "Taxpayer", { queryFn });

    const tp001 = result.mergedDocuments.find((d) => d.__pk === "TP-001")!;
    assert(tp001.riskScore === "high", "persistent: edit still wins over re-uploaded datasource");
    assert(tp001.__editedBy === "auditor1", "persistent: __editedBy from persistent edit");
    assert(result.stats.updateEdits === 1, "persistent: 1 update applied");
  }

  // =======================================================================
  // Test 14: No processed edits → no UPDATE query fired
  // =======================================================================
  {
    // Delete edit for PK not in datasource + no create edits = no edits applied
    const docs = [makeDoc("TP-001")];

    const edits: EditRecord[] = [
      makeEdit("ed-ghost", "TP-GHOST", "delete", null, "admin", "2025-06-15T10:00:00.000Z"),
    ];

    const { queryFn, markedEditIds } = createMockQueryFn(edits, []);
    const result = await mergeEditsWithDatasource(docs, "Taxpayer", { queryFn });

    assert(markedEditIds.length === 0, "no-op: no UPDATE call made (no edits applied)");
    assert(result.stats.editsApplied === 0, "no-op: 0 editsApplied");
  }

  // =======================================================================
  // Test 15: Large batch — performance check
  // =======================================================================
  {
    const docs: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 10000; i++) {
      docs.push(makeDoc(`TP-${i}`, { riskScore: "low" }));
    }

    // 100 update edits, 10 delete edits, 5 create edits
    const edits: EditRecord[] = [];
    for (let i = 0; i < 100; i++) {
      edits.push(
        makeEdit(`ed-u-${i}`, `TP-${i * 50}`, "update", { riskScore: "high" }, "auditor", `2025-06-15T10:${String(i).padStart(2, "0")}:00.000Z`)
      );
    }
    for (let i = 0; i < 10; i++) {
      edits.push(
        makeEdit(`ed-d-${i}`, `TP-${i * 1000 + 999}`, "delete", null, "admin", `2025-06-15T11:${String(i).padStart(2, "0")}:00.000Z`)
      );
    }
    for (let i = 0; i < 5; i++) {
      edits.push(
        makeEdit(`ed-c-${i}`, `TP-NEW-${i}`, "create", { taxId: `TP-NEW-${i}`, name: `New ${i}` }, "operator", `2025-06-15T12:${String(i).padStart(2, "0")}:00.000Z`)
      );
    }

    const { queryFn } = createMockQueryFn(edits, []);
    const start = Date.now();
    const result = await mergeEditsWithDatasource(docs, "Taxpayer", { queryFn });
    const elapsed = Date.now() - start;

    // Some update PKs may overlap with delete PKs, so count carefully
    assert(result.stats.totalDatasourceDocuments === 10000, "perf: 10k datasource docs");
    assert(result.stats.createEdits === 5, "perf: 5 creates");
    assert(elapsed < 2000, `perf: 10k docs + 115 edits in ${elapsed}ms (< 2000ms)`);
    console.log(`  (10k docs + 115 edits merged in ${elapsed}ms)`);
  }

  // =======================================================================
  // Test 16: Delete edit wins over earlier update for same PK
  // =======================================================================
  {
    const docs = [makeDoc("TP-001", { riskScore: "low" })];

    const edits: EditRecord[] = [
      makeEdit("ed-upd", "TP-001", "update", { riskScore: "high" }, "auditor1", "2025-06-14T10:00:00.000Z"),
      makeEdit("ed-del", "TP-001", "delete", null, "admin", "2025-06-15T10:00:00.000Z"),
    ];

    const { queryFn } = createMockQueryFn(edits, []);
    const result = await mergeEditsWithDatasource(docs, "Taxpayer", { queryFn });

    assert(result.mergedDocuments.length === 0, "del-wins: 0 documents (delete supersedes update)");
    assert(result.stats.deleteEdits === 1, "del-wins: 1 deleteEdit");
    assert(result.stats.updateEdits === 0, "del-wins: 0 updateEdits");
  }

  // =======================================================================
  // Test 17: Update edit with __version missing from document
  // =======================================================================
  {
    const doc: Record<string, unknown> = {
      __pk: "TP-001",
      __objectType: "Taxpayer",
      __lastModified: "2025-01-01T00:00:00.000Z",
      // __version intentionally missing
      __editedBy: null,
      riskScore: "low",
    };

    const edits: EditRecord[] = [
      makeEdit("ed-no-ver", "TP-001", "update", { riskScore: "high" }, "auditor1", "2025-06-15T10:00:00.000Z"),
    ];

    const { queryFn } = createMockQueryFn(edits, []);
    const result = await mergeEditsWithDatasource([doc], "Taxpayer", { queryFn });

    const merged = result.mergedDocuments[0];
    assert(merged.__version === 1, "no-version: initialized to 1");
    assert(merged.riskScore === "high", "no-version: riskScore updated");
  }

  // =======================================================================
  // Summary
  // =======================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll editMerger tests passed");
  } else {
    /* v8 ignore next */
    process.exit(1);
  }
}

/* v8 ignore start */
if (require.main === module) {
  runSelfTests();
}
/* v8 ignore stop */
