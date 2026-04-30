import { Knex } from 'knex';

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
    const allBindings: unknown[] = [];

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

  async suggest(q: string, ownerId: string): Promise<{ name: string; type: string }[]> {
    if (!q || q.trim().length === 0) return [];
    // Escape LIKE special characters to prevent wildcard injection
    const escapedPrefix = q.trim().replace(/[\\%_]/g, '\\$&');
    const prefix = `${escapedPrefix}%`;
    const suggestions: { name: string; type: string }[] = [];

    const projects = await this.knex('projects').where({ owner_id: ownerId }).whereRaw("name ILIKE ? ESCAPE '\\'", [prefix]).select('name').limit(10);
    suggestions.push(...projects.map((p: Record<string, unknown>) => ({ name: p.name as string, type: 'project' })));

    if (suggestions.length < 10) {
      const folders = await this.knex('folders').join('projects', 'folders.project_id', 'projects.id').where('projects.owner_id', ownerId).whereRaw("folders.name ILIKE ? ESCAPE '\\'", [prefix]).select('folders.name').limit(10 - suggestions.length);
      suggestions.push(...folders.map((f: Record<string, unknown>) => ({ name: f.name as string, type: 'folder' })));
    }

    if (suggestions.length < 10) {
      const datasets = await this.knex('foundry_datasets').join('folders', 'foundry_datasets.folder_id', 'folders.id').join('projects', 'folders.project_id', 'projects.id').where('projects.owner_id', ownerId).whereRaw("foundry_datasets.name ILIKE ? ESCAPE '\\'", [prefix]).select('foundry_datasets.name').limit(10 - suggestions.length);
      suggestions.push(...datasets.map((d: Record<string, unknown>) => ({ name: d.name as string, type: 'dataset' })));
    }

    return suggestions.slice(0, 10);
  }
}
