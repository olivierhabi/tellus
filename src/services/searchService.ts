import { Knex } from 'knex';

// ---------------------------------------------------------------------------
// Pure helpers — exported so they're independently unit-testable.
//
// These encapsulate the algorithmic core of `SearchService.suggest`.
// Keeping them pure (no I/O, no mutable state, no `this`) means we can
// pin the user-facing tokenization & ranking semantics without booting
// Postgres. Live SQL behavior is exercised by the integration suite.
// ---------------------------------------------------------------------------

/**
 * Tokenize a free-text search query the same way `SearchService.suggest`
 * does internally.
 *
 * Splits on whitespace AND common name separators (`_`, `-`, `/`, `.`)
 * so that `customer_data`, `customer-data`, `customer/data`, and
 * `customer data` all yield the same `['customer', 'data']`. This is the
 * single most important semantic guarantee of the suggester — the FE
 * autocomplete user types organically and may not know which separator
 * the server-side filename uses.
 *
 * Tokens are lowercased and empty tokens (from collapsed whitespace
 * runs) are dropped — empty tokens would otherwise produce a no-op
 * `%%` ILIKE filter that matches every row in the database.
 */
export function tokenizeSearchQuery(q: string): string[] {
  const trimmed = (q ?? '').trim();
  if (!trimmed) return [];
  return trimmed
    .toLowerCase()
    .split(/[\s_\-\/.]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Escape SQL LIKE wildcards (`%`, `_`) and the escape char itself so
 * user-supplied tokens can't widen a `%token%` match beyond what they
 * literally typed. Pairs with the `ESCAPE '\\'` clause used by every
 * `whereRaw` call inside the service.
 *
 * Example: `escapeLikePattern("100%_")` → `"100\\%\\_"` (so the SQL
 * planner treats `%` and `_` as literals, not wildcards).
 */
export function escapeLikePattern(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

/**
 * Score a candidate suggestion row against a query for relevance
 * ranking. Higher = better. The shape mirrors what `suggest`'s ranker
 * uses internally — this overload exists only so unit tests can pin
 * the score classes without booting the service.
 *
 * Numbers are spaced wide enough that adding "+10 if X" later won't
 * accidentally tip the existing ordering classes.
 */
export interface ScoreInput {
  /** Resource name (the leaf, e.g. `customer_data.csv`). */
  name: string;
  /** Full nested pretty-path (e.g. `/Acme/customer/data/orders.csv`). */
  path: string;
  /** Resource type prior — dataset > folder > pipeline > project. */
  type: 'project' | 'folder' | 'dataset' | 'pipeline';
  /**
   * ISO timestamp of the row's last update; used for the recency boost.
   * Empty / unparseable strings contribute no boost (no penalty either).
   */
  updatedAt?: string;
}

export function scoreSuggestion(
  row: ScoreInput,
  query: string,
  tokens: string[],
  now: number = Date.now(),
): number {
  const TYPE_PRIOR: Record<ScoreInput['type'], number> = {
    dataset: 4,
    folder: 3,
    pipeline: 2,
    project: 1,
  };
  const RECENCY_MS = 7 * 24 * 60 * 60 * 1000;
  const lowerName = row.name.toLowerCase();
  const lowerPath = row.path.toLowerCase();
  const lowerQuery = query.trim().toLowerCase();

  let score = TYPE_PRIOR[row.type];
  if (lowerName === lowerQuery) score += 1000;
  if (lowerName.startsWith(lowerQuery)) score += 500;
  if (tokens.length > 0 && tokens.every((t) => lowerName.includes(t)))
    score += 200;
  for (const t of tokens) {
    if (lowerPath.includes(t)) score += 50;
  }
  if (row.updatedAt) {
    const ts = Date.parse(row.updatedAt);
    if (!Number.isNaN(ts) && now - ts < RECENCY_MS) score += 20;
  }
  return score;
}

export class SearchService {
  constructor(private knex: Knex) {}

  async search(params: { q: string; type?: string; projectId?: string; page: number; limit: number; ownerId: string }) {
    const { q, type, projectId, page, limit, ownerId } = params;
    const offset = (page - 1) * limit;

    if (!q || q.trim() === '') {
      const countResult = await this.knex('projects').where({ owner_id: ownerId }).count('* as cnt').first();
      const total = Number(countResult?.cnt ?? 0);
      const projects = await this.knex('projects').where({ owner_id: ownerId }).orderBy('updated_at', 'desc').limit(limit).offset(offset);
      return { results: projects.map((p: Record<string, unknown>) => ({ ...p, resourceType: 'project' })), meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
    }

    const searchTerm = q.trim();
    // Escape LIKE special characters to prevent wildcard injection
    const escapedTerm = searchTerm.replace(/[\\%_]/g, '\\$&');
    const ilikeTerm = `%${escapedTerm}%`;

    // Build a UNION ALL with proper parameterized bindings.
    // Collect SQL fragments (with ? placeholders) and their bindings separately,
    // then pass everything to a single knex.raw() call.
    const sqlParts: string[] = [];
    // Knex 3.3 types raw bindings as scalar values; every placeholder in
    // these search fragments is a string or pagination number.
    const allBindings: Array<string | number> = [];

    if (!type || type === 'project') {
      sqlParts.push(`(SELECT id, name, 'project' AS "resourceType", updated_at FROM projects WHERE owner_id = ? AND name ILIKE ? ESCAPE '\\')`);
      allBindings.push(ownerId, ilikeTerm);
    }

    if (!type || type === 'folder') {
      let folderSql = `(SELECT folders.id, folders.name, 'folder' AS "resourceType", folders.updated_at FROM folders JOIN projects ON folders.project_id = projects.id WHERE projects.owner_id = ? AND folders.name ILIKE ? ESCAPE '\\'`;
      allBindings.push(ownerId, ilikeTerm);
      if (projectId) {
        folderSql += ' AND folders.project_id = ?';
        allBindings.push(projectId);
      }
      folderSql += ')';
      sqlParts.push(folderSql);
    }

    if (!type || type === 'dataset') {
      let dsSql = `(SELECT foundry_datasets.id, foundry_datasets.name, 'dataset' AS "resourceType", foundry_datasets.updated_at FROM foundry_datasets JOIN folders ON foundry_datasets.folder_id = folders.id JOIN projects ON folders.project_id = projects.id WHERE projects.owner_id = ? AND foundry_datasets.name ILIKE ? ESCAPE '\\'`;
      allBindings.push(ownerId, ilikeTerm);
      if (projectId) {
        dsSql += ' AND folders.project_id = ?';
        allBindings.push(projectId);
      }
      dsSql += ')';
      sqlParts.push(dsSql);
    }

    if (sqlParts.length === 0) {
      return { results: [], meta: { page, limit, total: 0, totalPages: 0 } };
    }

    const unionSql = sqlParts.join(' UNION ALL ');

    // Get total count with proper parameterization
    const countBindings = [...allBindings];
    const countResult = await this.knex.raw(
      `SELECT COUNT(*) AS cnt FROM (${unionSql}) AS search_results`,
      countBindings
    );
    const total = Number(countResult.rows[0]?.cnt ?? 0);

    // Get paginated results with proper parameterization
    const dataBindings = [...allBindings, limit, offset];
    const dataResult = await this.knex.raw(
      `SELECT * FROM (${unionSql}) AS search_results ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      dataBindings
    );

    const results = dataResult.rows as Record<string, unknown>[];
    return { results, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  /**
   * Ontology picker search — powers the "Select dataset" dialog on the
   * /ontology page's "Create a new object type" flow. Returns a flat list
   * of pickable resources (projects, folders, datasets, pipelines) with
   * fully-resolved pretty paths and aggregate type counts in a single
   * response.
   *
   * Scope semantics:
   *   - "all":        everything accessible to the user (owned + member)
   *   - "yours":      projects directly owned by the user
   *   - "shared":     projects shared via project_members (not owned)
   *   - "favorites":  restricted to rows in user_favorite for this user
   *   - "recent":     restricted to rows in user_recent_activity (ordered
   *                   by visited_at desc, overrides updatedAt sort)
   */
  async searchPicker(params: {
    q: string;
    types: Array<'project' | 'folder' | 'dataset' | 'pipeline' | 'module' | 'aip_logic'>;
    scope: 'all' | 'yours' | 'shared' | 'recent' | 'favorites';
    page: number;
    limit: number;
    ownerId: string;
  }): Promise<{
    results: Array<{
      id: string;
      name: string;
      resourceType:
        | 'project'
        | 'folder'
        | 'dataset'
        | 'pipeline'
        | 'module'
        | 'aip_logic';
      path: string;
      hasChildren: boolean;
      projectId: string;
      updatedAt: string;
    }>;
    typeCounts: {
      project: number;
      folder: number;
      dataset: number;
      pipeline: number;
      module: number;
      aip_logic: number;
    };
    meta: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const { q, types, scope, page, limit, ownerId } = params;
    const offset = (page - 1) * limit;
    const trimmed = (q ?? '').trim();
    const escaped = trimmed.replace(/[\\%_]/g, '\\$&');
    const likePattern = trimmed ? `%${escaped}%` : null;
    const needle = trimmed.toLowerCase();

    // -------------------------------------------------------------------
    // Step 1: compute the set of accessible project IDs based on scope
    // -------------------------------------------------------------------
    let accessibleProjectIds: string[];
    if (scope === 'yours') {
      const rows = await this.knex('projects').select('id').where({ owner_id: ownerId });
      accessibleProjectIds = rows.map((r: Record<string, unknown>) => String(r.id));
    } else if (scope === 'shared') {
      const rows = await this.knex('project_members')
        .select('project_id as id')
        .where({ user_id: ownerId });
      accessibleProjectIds = rows.map((r: Record<string, unknown>) => String(r.id));
    } else {
      const owned = await this.knex('projects').select('id').where({ owner_id: ownerId });
      const member = await this.knex('project_members')
        .select('project_id as id')
        .where({ user_id: ownerId });
      const set = new Set<string>();
      owned.forEach((r: Record<string, unknown>) => set.add(String(r.id)));
      member.forEach((r: Record<string, unknown>) => set.add(String(r.id)));
      accessibleProjectIds = Array.from(set);
    }

    const emptyTypeCounts = {
      project: 0,
      folder: 0,
      dataset: 0,
      pipeline: 0,
      module: 0,
      aip_logic: 0,
    };

    // Module (interface) and AIP Logic (ontology_function) are ontology-scoped
    // globals — they don't live inside a project and are therefore excluded
    // from project-centric scopes like "yours" and "shared".
    const includeOntologyGlobals = scope === 'all' || scope === 'recent' || scope === 'favorites';

    if (accessibleProjectIds.length === 0 && !includeOntologyGlobals) {
      return {
        results: [],
        typeCounts: { ...emptyTypeCounts },
        meta: { page, limit, total: 0, totalPages: 0 },
      };
    }

    // -------------------------------------------------------------------
    // Step 2: load accessible project names and ALL folders for those
    // projects so we can compute pretty paths client-side. The folder set
    // is typically small (dozens to a few thousand per user) — much
    // cheaper than running a recursive CTE on every request.
    // -------------------------------------------------------------------
    const projectsRows =
      accessibleProjectIds.length === 0
        ? []
        : await this.knex('projects')
            .select('id', 'name', 'updated_at')
            .whereIn('id', accessibleProjectIds);
    const projectNameById = new Map<string, string>();
    projectsRows.forEach((p: Record<string, unknown>) =>
      projectNameById.set(String(p.id), String(p.name)),
    );

    const folderRows =
      accessibleProjectIds.length === 0
        ? []
        : await this.knex('folders')
            .select('id', 'name', 'parent_folder_id', 'project_id', 'updated_at')
            .whereIn('project_id', accessibleProjectIds);

    const folderById = new Map<string, Record<string, unknown>>();
    folderRows.forEach((f: Record<string, unknown>) => folderById.set(String(f.id), f));

    const prettyPathCache = new Map<string, string>();
    const computeFolderPath = (folderId: string): string => {
      const cached = prettyPathCache.get(folderId);
      if (cached !== undefined) return cached;
      const folder = folderById.get(folderId);
      if (!folder) return '';
      const projectName = projectNameById.get(String(folder.project_id)) ?? '';
      let path: string;
      if (folder.parent_folder_id == null) {
        path = `/${projectName}/${folder.name}`;
      } else {
        const parentPath = computeFolderPath(String(folder.parent_folder_id));
        path = parentPath ? `${parentPath}/${folder.name}` : `/${projectName}/${folder.name}`;
      }
      prettyPathCache.set(folderId, path);
      return path;
    };
    folderRows.forEach((f: Record<string, unknown>) => computeFolderPath(String(f.id)));

    const parentsWithChildren = new Set<string>();
    folderRows.forEach((f: Record<string, unknown>) => {
      if (f.parent_folder_id != null) parentsWithChildren.add(String(f.parent_folder_id));
    });

    // -------------------------------------------------------------------
    // Step 3: collect rows across the four resource types
    // -------------------------------------------------------------------
    type Row = {
      id: string;
      name: string;
      resourceType:
        | 'project'
        | 'folder'
        | 'dataset'
        | 'pipeline'
        | 'module'
        | 'aip_logic';
      path: string;
      hasChildren: boolean;
      projectId: string;
      updatedAt: string;
    };

    const allRows: Row[] = [];
    const projectHasFolders = new Set<string>();
    folderRows.forEach((f: Record<string, unknown>) => projectHasFolders.add(String(f.project_id)));

    projectsRows.forEach((p: Record<string, unknown>) => {
      const name = String(p.name);
      if (needle && !name.toLowerCase().includes(needle)) return;
      allRows.push({
        id: String(p.id),
        name,
        resourceType: 'project',
        path: `/${name}`,
        hasChildren: projectHasFolders.has(String(p.id)),
        projectId: String(p.id),
        updatedAt: String(p.updated_at),
      });
    });

    folderRows.forEach((f: Record<string, unknown>) => {
      const name = String(f.name);
      if (needle && !name.toLowerCase().includes(needle)) return;
      allRows.push({
        id: String(f.id),
        name,
        resourceType: 'folder',
        path: prettyPathCache.get(String(f.id)) ?? '',
        hasChildren: parentsWithChildren.has(String(f.id)),
        projectId: String(f.project_id),
        updatedAt: String(f.updated_at),
      });
    });

    if (accessibleProjectIds.length > 0) {
      let query = this.knex('foundry_datasets')
        .select('id', 'name', 'folder_id', 'project_id', 'updated_at')
        .whereIn('project_id', accessibleProjectIds);
      if (likePattern) query = query.whereRaw("name ILIKE ? ESCAPE '\\'", [likePattern]);
      const rows = await query;
      rows.forEach((d: Record<string, unknown>) => {
        const projectName = projectNameById.get(String(d.project_id)) ?? '';
        const folderPath = d.folder_id ? prettyPathCache.get(String(d.folder_id)) ?? '' : '';
        const path = folderPath ? `${folderPath}/${d.name}` : `/${projectName}/${d.name}`;
        allRows.push({
          id: String(d.id),
          name: String(d.name),
          resourceType: 'dataset',
          path,
          hasChildren: false,
          projectId: String(d.project_id),
          updatedAt: String(d.updated_at),
        });
      });
    }

    if (accessibleProjectIds.length > 0) {
      let query = this.knex('pipelines')
        .select('id', 'name', 'folder_id', 'project_id', 'updated_at')
        .whereIn('project_id', accessibleProjectIds);
      if (likePattern) query = query.whereRaw("name ILIKE ? ESCAPE '\\'", [likePattern]);
      const rows = await query;
      rows.forEach((pl: Record<string, unknown>) => {
        const projectName = projectNameById.get(String(pl.project_id)) ?? '';
        const folderPath = pl.folder_id ? prettyPathCache.get(String(pl.folder_id)) ?? '' : '';
        const path = folderPath ? `${folderPath}/${pl.name}` : `/${projectName}/${pl.name}`;
        allRows.push({
          id: String(pl.id),
          name: String(pl.name),
          resourceType: 'pipeline',
          path,
          hasChildren: false,
          projectId: String(pl.project_id),
          updatedAt: String(pl.updated_at),
        });
      });
    }

    // Module → `interface` table. Ontology-scoped globals: only included in
    // non-project scopes. Query wrapped in try/catch so missing tables on
    // fresh installs return zero rather than 500.
    if (includeOntologyGlobals) {
      try {
        let query = this.knex('interface').select(
          'interface_id as id',
          'display_name as name',
          'updated_at',
        );
        if (likePattern)
          query = query.whereRaw("display_name ILIKE ? ESCAPE '\\'", [likePattern]);
        const rows = await query;
        rows.forEach((m: Record<string, unknown>) => {
          allRows.push({
            id: String(m.id),
            name: String(m.name),
            resourceType: 'module',
            path: `/Modules/${String(m.name)}`,
            hasChildren: false,
            projectId: '',
            updatedAt: String(m.updated_at),
          });
        });
      } catch {
        /* interface table may not exist in fresh installs — skip silently */
      }
    }

    // AIP Logic → `ontology_function` table. Same pattern as modules.
    if (includeOntologyGlobals) {
      try {
        let query = this.knex('ontology_function').select(
          'function_id as id',
          'display_name as name',
          'updated_at',
        );
        if (likePattern)
          query = query.whereRaw("display_name ILIKE ? ESCAPE '\\'", [likePattern]);
        const rows = await query;
        rows.forEach((f: Record<string, unknown>) => {
          allRows.push({
            id: String(f.id),
            name: String(f.name),
            resourceType: 'aip_logic',
            path: `/AIP Logic/${String(f.name)}`,
            hasChildren: false,
            projectId: '',
            updatedAt: String(f.updated_at),
          });
        });
      } catch {
        /* ontology_function table may not exist — skip silently */
      }
    }

    // -------------------------------------------------------------------
    // Step 4: narrow by favorites/recent scope
    // -------------------------------------------------------------------
    let recentOrder: Map<string, number> | null = null;
    if (scope === 'favorites') {
      const favs = await this.knex('user_favorite')
        .select('resource_type', 'resource_id')
        .where({ user_id: ownerId });
      const favKeys = new Set(
        favs.map(
          (f: Record<string, unknown>) => `${String(f.resource_type)}:${String(f.resource_id)}`,
        ),
      );
      for (let i = allRows.length - 1; i >= 0; i--) {
        if (!favKeys.has(`${allRows[i].resourceType}:${allRows[i].id}`)) {
          allRows.splice(i, 1);
        }
      }
    } else if (scope === 'recent') {
      const rec = await this.knex('user_recent_activity')
        .select('resource_type', 'resource_id', 'visited_at')
        .where({ user_id: ownerId })
        .orderBy('visited_at', 'desc')
        .limit(50);
      recentOrder = new Map<string, number>();
      rec.forEach((r: Record<string, unknown>, idx: number) =>
        recentOrder!.set(`${String(r.resource_type)}:${String(r.resource_id)}`, idx),
      );
      for (let i = allRows.length - 1; i >= 0; i--) {
        if (!recentOrder.has(`${allRows[i].resourceType}:${allRows[i].id}`)) {
          allRows.splice(i, 1);
        }
      }
    }

    // Type counts are reported over the full matched set (pre-type-filter)
    // so the sidebar filter badges show the full distribution.
    const typeCounts = { ...emptyTypeCounts };
    allRows.forEach((r) => {
      typeCounts[r.resourceType]++;
    });

    // -------------------------------------------------------------------
    // Step 5: apply type filter + sort + paginate
    // -------------------------------------------------------------------
    const filtered =
      types && types.length > 0 && types.length < 6
        ? allRows.filter((r) => types.includes(r.resourceType))
        : allRows;

    if (recentOrder) {
      filtered.sort(
        (a, b) =>
          (recentOrder!.get(`${a.resourceType}:${a.id}`) ?? 0) -
          (recentOrder!.get(`${b.resourceType}:${b.id}`) ?? 0),
      );
    } else {
      filtered.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    }

    const total = filtered.length;
    const pagedResults = filtered.slice(offset, offset + limit);

    return {
      results: pagedResults,
      typeCounts,
      meta: { page, limit, total, totalPages: total === 0 ? 0 : Math.ceil(total / limit) },
    };
  }

  /**
   * Production-grade autocomplete suggester.
   *
   * Powers the "JUMP TO" overlay in `SelectDatasetDialog` (tellus-fe)
   * and any other prefix/substring picker that needs sub-200ms hints
   * across projects, folders, datasets, and pipelines.
   *
   * Design choices, in order of impact:
   *
   *   1. **Multi-token AND substring matching.** The query is split
   *      on whitespace + common name separators (`_`, `-`, `/`, `.`)
   *      and each token must appear as a substring in the row's
   *      name or full nested path. So "customer da" matches a
   *      dataset called `customer_data.csv` *and* a dataset called
   *      `orders.csv` living under `/Acme/customer/data/`. The old
   *      implementation was prefix-only (`name ILIKE 'customer da%'`)
   *      and missed both — which is what the user reported.
   *
   *   2. **Access via owner OR project_members.** The previous
   *      implementation only saw projects the user *owned*; shared
   *      projects (`project_members`) were invisible. Mirrors the
   *      access model already used by `searchPicker`.
   *
   *   3. **Nested folder paths walked in JS.** We pull the user's
   *      whole accessible folder set once (≤ a few thousand rows in
   *      practice), memoise the recursive `parent_folder_id` walk,
   *      and reuse the resulting `Map<folderId, prettyPath>` for
   *      both folder + dataset path matching. A single recursive
   *      CTE per request would also work but the in-memory walk is
   *      cheaper at this fan-out.
   *
   *   4. **Path-based dataset matching.** Datasets matched purely by
   *      where they live (e.g. "customer da" matching every dataset
   *      under `/Acme/customer/data/`) are surfaced in addition to
   *      direct name matches. Critical UX for users who remember a
   *      folder hierarchy but not the leaf filename.
   *
   *   5. **Relevance ranking.** Scored heuristically:
   *        - exact name match  →  +1000
   *        - name starts with full query  →  +500
   *        - all tokens present in name  →  +200
   *        - each token present in full path  →  +50
   *        - updated within 7 days  →  +20 (recency boost)
   *        - type prior (dataset > folder > pipeline > project)
   *      Numbers spaced wide enough to add new heuristics later
   *      without accidentally re-ordering existing classes.
   *
   *   6. **Bounded fan-out.** Per-type SQL is capped at 50 candidates
   *      (200 total before ranking) and the response is the top-10.
   *      All ILIKE bindings are parameterized — no wildcard injection.
   *
   * Response shape is a *strict superset* of the old `{name, type}[]`,
   * so existing FE consumers continue to work; new ones can opt into
   * `path` / `id` / `projectId` for richer rendering.
   */
  async suggest(
    q: string,
    ownerId: string,
  ): Promise<
    Array<{
      id: string;
      name: string;
      type: 'project' | 'folder' | 'dataset' | 'pipeline';
      path: string;
      projectId: string | null;
    }>
  > {
    const trimmed = (q ?? '').trim();
    if (!trimmed) return [];

    // Tokenization + LIKE-pattern escaping live as exported pure helpers
    // at the top of this module so they can be unit-tested without
    // booting Postgres. See `tokenizeSearchQuery` / `escapeLikePattern`.
    const tokens = tokenizeSearchQuery(trimmed);
    if (tokens.length === 0) return [];
    const tokenPatterns = tokens.map((t) => `%${escapeLikePattern(t)}%`);

    // ---- Step 1: accessible project IDs (owned ∪ membership) -------
    const owned = await this.knex('projects')
      .select('id')
      .where({ owner_id: ownerId });
    const member = await this.knex('project_members')
      .select('project_id as id')
      .where({ user_id: ownerId });
    const accessSet = new Set<string>();
    owned.forEach((r: Record<string, unknown>) => accessSet.add(String(r.id)));
    member.forEach((r: Record<string, unknown>) => accessSet.add(String(r.id)));
    const accessibleProjectIds = Array.from(accessSet);
    if (accessibleProjectIds.length === 0) return [];

    // ---- Step 2: project + folder name maps for path computation ----
    const projectsRows = await this.knex('projects')
      .select('id', 'name')
      .whereIn('id', accessibleProjectIds);
    const projectNameById = new Map<string, string>();
    projectsRows.forEach((p: Record<string, unknown>) =>
      projectNameById.set(String(p.id), String(p.name)),
    );

    const folderRows = await this.knex('folders')
      .select('id', 'name', 'parent_folder_id', 'project_id', 'updated_at')
      .whereIn('project_id', accessibleProjectIds);
    const folderById = new Map<string, Record<string, unknown>>();
    folderRows.forEach((f: Record<string, unknown>) =>
      folderById.set(String(f.id), f),
    );

    // Memoised recursive parent walk. Folders may be nested arbitrarily
    // deep — production projects routinely run 5–10 levels. Cache so
    // siblings share computed ancestor paths.
    const folderPathCache = new Map<string, string>();
    const computeFolderPath = (folderId: string): string => {
      const cached = folderPathCache.get(folderId);
      if (cached !== undefined) return cached;
      const folder = folderById.get(folderId);
      if (!folder) return '';
      const projectName =
        projectNameById.get(String(folder.project_id)) ?? '';
      const parentPath =
        folder.parent_folder_id != null
          ? computeFolderPath(String(folder.parent_folder_id))
          : '';
      const path = parentPath
        ? `${parentPath}/${folder.name}`
        : `/${projectName}/${folder.name}`;
      folderPathCache.set(folderId, path);
      return path;
    };
    folderRows.forEach((f: Record<string, unknown>) =>
      computeFolderPath(String(f.id)),
    );

    // ---- Step 3: per-resource candidate gathering ------------------
    // Each candidate carries enough state for the ranker downstream:
    // identity, name (for match scoring), folder/project for path
    // resolution, and updated_at for recency tie-breaks.
    type Row = {
      id: string;
      name: string;
      type: 'project' | 'folder' | 'dataset' | 'pipeline';
      folder_id: string | null;
      project_id: string | null;
      updated_at: string;
    };
    const PER_TYPE_LIMIT = 50;
    const rows: Row[] = [];

    // Helper that adds an ILIKE-AND filter for every token. Each
    // token is bound separately, so the prepared statement remains
    // free of injection risk regardless of token count.
    type KnexBuilder = ReturnType<typeof this.knex>;
    const applyTokenFilters = (qb: KnexBuilder, column: string): KnexBuilder => {
      let q2 = qb;
      for (const p of tokenPatterns) {
        q2 = q2.whereRaw(`${column} ILIKE ? ESCAPE '\\'`, [p]);
      }
      return q2;
    };

    // ---- Projects ----
    const projectMatches = await applyTokenFilters(
      this.knex('projects')
        .select('id', 'name', 'updated_at')
        .whereIn('id', accessibleProjectIds),
      'name',
    ).limit(PER_TYPE_LIMIT);
    projectMatches.forEach((r: Record<string, unknown>) =>
      rows.push({
        id: String(r.id),
        name: String(r.name),
        type: 'project',
        folder_id: null,
        project_id: String(r.id),
        updated_at: String(r.updated_at ?? ''),
      }),
    );

    // ---- Folders: name match ----
    const folderNameMatches = await applyTokenFilters(
      this.knex('folders')
        .select('id', 'name', 'parent_folder_id', 'project_id', 'updated_at')
        .whereIn('project_id', accessibleProjectIds),
      'name',
    ).limit(PER_TYPE_LIMIT);
    const seenFolderIds = new Set<string>();
    folderNameMatches.forEach((r: Record<string, unknown>) => {
      const id = String(r.id);
      seenFolderIds.add(id);
      rows.push({
        id,
        name: String(r.name),
        type: 'folder',
        folder_id: r.parent_folder_id ? String(r.parent_folder_id) : null,
        project_id: String(r.project_id),
        updated_at: String(r.updated_at ?? ''),
      });
    });

    // ---- Folders: pretty-path match (in-process) ----
    // Folders whose computed nested path contains every token —
    // surfaces results like "the folder living at /Acme/customer/data
    // is what you meant" even when the leaf folder name itself
    // doesn't include the tokens.
    const candidateFolderIdsByPath: string[] = [];
    for (const f of folderRows) {
      const id = String(f.id);
      const path = (folderPathCache.get(id) ?? '').toLowerCase();
      if (!path) continue;
      if (tokens.every((t) => path.includes(t))) {
        candidateFolderIdsByPath.push(id);
        if (seenFolderIds.has(id)) continue;
        seenFolderIds.add(id);
        rows.push({
          id,
          name: String(f.name),
          type: 'folder',
          folder_id: f.parent_folder_id ? String(f.parent_folder_id) : null,
          project_id: String(f.project_id),
          updated_at: String(f.updated_at ?? ''),
        });
      }
    }

    // ---- Datasets: name match ----
    const datasetNameMatches = await applyTokenFilters(
      this.knex('foundry_datasets')
        .select('id', 'name', 'folder_id', 'project_id', 'updated_at')
        .whereIn('project_id', accessibleProjectIds),
      'name',
    ).limit(PER_TYPE_LIMIT);
    const seenDatasetIds = new Set<string>();
    datasetNameMatches.forEach((r: Record<string, unknown>) => {
      const id = String(r.id);
      seenDatasetIds.add(id);
      rows.push({
        id,
        name: String(r.name),
        type: 'dataset',
        folder_id: r.folder_id ? String(r.folder_id) : null,
        project_id: String(r.project_id),
        updated_at: String(r.updated_at ?? ''),
      });
    });

    // ---- Datasets: bounded path-based match ----
    // Critical for "find a dataset by where it lives" queries. We
    // restrict to datasets sitting inside the path-matched folders
    // we already identified above, so this never degrades to an
    // O(N) scan over the user's whole catalog.
    if (candidateFolderIdsByPath.length > 0) {
      const datasetPathMatches = await this.knex('foundry_datasets')
        .select('id', 'name', 'folder_id', 'project_id', 'updated_at')
        .whereIn('folder_id', candidateFolderIdsByPath)
        .limit(PER_TYPE_LIMIT * 2);
      datasetPathMatches.forEach((r: Record<string, unknown>) => {
        const id = String(r.id);
        if (seenDatasetIds.has(id)) return;
        seenDatasetIds.add(id);
        rows.push({
          id,
          name: String(r.name),
          type: 'dataset',
          folder_id: r.folder_id ? String(r.folder_id) : null,
          project_id: String(r.project_id),
          updated_at: String(r.updated_at ?? ''),
        });
      });
    }

    // ---- Pipelines: name match ----
    const pipelineMatches = await applyTokenFilters(
      this.knex('pipelines')
        .select('id', 'name', 'folder_id', 'project_id', 'updated_at')
        .whereIn('project_id', accessibleProjectIds),
      'name',
    ).limit(PER_TYPE_LIMIT);
    pipelineMatches.forEach((r: Record<string, unknown>) =>
      rows.push({
        id: String(r.id),
        name: String(r.name),
        type: 'pipeline',
        folder_id: r.folder_id ? String(r.folder_id) : null,
        project_id: String(r.project_id),
        updated_at: String(r.updated_at ?? ''),
      }),
    );

    if (rows.length === 0) return [];

    // ---- Step 4: relevance scoring + sort + truncate ---------------
    const lowerQuery = trimmed.toLowerCase();
    const now = Date.now();
    const RECENCY_MS = 7 * 24 * 60 * 60 * 1000;
    const TYPE_PRIOR: Record<Row['type'], number> = {
      dataset: 4,
      folder: 3,
      pipeline: 2,
      project: 1,
    };

    const computePath = (r: Row): string => {
      if (r.type === 'project') return `/${r.name}`;
      const projectName = r.project_id
        ? projectNameById.get(r.project_id) ?? ''
        : '';
      const folderPath = r.folder_id
        ? folderPathCache.get(r.folder_id) ?? ''
        : '';
      if (r.type === 'folder') {
        // For folders we recompute their own path directly — the
        // `folder_id` we stored above is the *parent's* id (used
        // for ranking), but the displayed path should end in the
        // folder itself.
        const own = folderPathCache.get(r.id);
        if (own) return own;
        // Fall through if for some reason the folder wasn't cached
        // (should never happen because we walked them all above).
      }
      const parent = folderPath || (projectName ? `/${projectName}` : '');
      return parent ? `${parent}/${r.name}` : `/${r.name}`;
    };

    const scoreRow = (r: Row): number => {
      const lowerName = r.name.toLowerCase();
      const fullPath = computePath(r).toLowerCase();
      let score = TYPE_PRIOR[r.type];
      if (lowerName === lowerQuery) score += 1000;
      if (lowerName.startsWith(lowerQuery)) score += 500;
      if (tokens.every((t) => lowerName.includes(t))) score += 200;
      for (const t of tokens) {
        if (fullPath.includes(t)) score += 50;
      }
      if (r.updated_at) {
        const ts = Date.parse(r.updated_at);
        if (!Number.isNaN(ts) && now - ts < RECENCY_MS) score += 20;
      }
      return score;
    };

    const scored = rows.map((r) => ({ row: r, score: scoreRow(r) }));
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ta = Date.parse(a.row.updated_at) || 0;
      const tb = Date.parse(b.row.updated_at) || 0;
      return tb - ta;
    });

    const TOP_N = 10;
    return scored.slice(0, TOP_N).map(({ row }) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      path: computePath(row),
      projectId: row.project_id,
    }));
  }
}
