// ---------------------------------------------------------------------------
// Pure SQL composition for the `GET /v1/projects/:projectId/trashed` route.
//
// Why this is a separate module:
//   * The route handler in `routes/projectWorkspace.ts` was the only
//     caller of the original inline SQL builder. Inlining made the
//     scope-semantics decision invisible to unit tests; a regression
//     to the wrong-rid filter would have shipped silently again.
//   * Extracting to a pure function gives us a 30-line unit-test
//     surface that pins the exact predicate shape under both branches
//     (no parentRid → project-wide; parentRid set → folder-scoped).
//   * Zero runtime overhead — the route imports and forwards args.
//
// Negative tests (do these break if you remove guards?):
//   * Re-introduce `parent_folder_rid = ri.compass.main.folder.<projectId>`
//     in the no-parentRid branch → "default branch returns ALL trashed
//     rows in the project (no parent filter)" test fails.
//   * Drop the `r.trash_status <> 'NOT_TRASHED'` filter → "filters out
//     NOT_TRASHED rows" test fails.
//   * Change ORDER BY direction → "orders by trashed_at DESC" test fails.
// ---------------------------------------------------------------------------

export interface BuildTrashedQueryInput {
  projectId: string;
  parentRid?: string | null;
  pageSize: number;
}

export interface BuildTrashedQueryOutput {
  sql: string;
  params: unknown[];
}

/**
 * Build the SQL + params for listing trashed rows in a project.
 *
 * Scope semantics:
 *   * No `parentRid`  → project-level Trash. Returns every trashed row
 *                       belonging to this project, regardless of folder
 *                       depth. Foundry-faithful: "everything I deleted
 *                       in this project."
 *   * `parentRid` set → folder-scoped Trash. Returns rows whose
 *                       immediate parent is that folder.
 *
 * The previous in-route implementation defaulted to filtering
 * `parent_folder_rid = ri.compass.main.folder.<projectId>` which never
 * matched a real row (the resources table stores project-root parents
 * as `ri.compass.main.project.<projectId>`, not as a folder rid).
 * That bug is regression-tested in trashedQuery-unit.test.ts.
 */
export function buildTrashedQuery(input: BuildTrashedQueryInput): BuildTrashedQueryOutput {
  const { projectId, parentRid, pageSize } = input;
  const projectRid = `ri.compass.main.project.${projectId}`;

  const params: unknown[] = [projectRid];
  let where = "(r.project_rid = $1 OR r.rid = $1)";

  if (parentRid) {
    params.push(parentRid);
    where += ` AND r.parent_folder_rid = $${params.length}`;
  }
  // No `else` branch: project-level Trash imposes no parent filter.

  where += " AND r.trash_status <> 'NOT_TRASHED'";
  params.push(pageSize);

  const sql = `
        SELECT r.rid, r.display_name, r.type, r.trash_status, r.trashed_at,
               r.trashed_by, r.retention_until, r.parent_folder_rid,
               r.created_at, r.updated_at,
               u.email AS trashed_by_email
        FROM resources r
        LEFT JOIN users u ON u.id = r.trashed_by
        WHERE ${where}
        ORDER BY r.trashed_at DESC NULLS LAST, r.rid DESC
        LIMIT $${params.length}`;

  return { sql, params };
}
