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

    // Use a UNION ALL query to count and paginate at the database level
    const subqueries: Knex.Raw[] = [];

    if (!type || type === 'project') {
      subqueries.push(this.knex.raw(
        `SELECT id, name, 'project' AS "resourceType", updated_at FROM projects WHERE owner_id = ? AND name ILIKE ?`,
        [ownerId, ilikeTerm]
      ));
    }

    if (!type || type === 'folder') {
      const folderBindings: unknown[] = [ownerId, ilikeTerm];
      let folderWhere = '';
      if (projectId) {
        folderWhere = ' AND folders.project_id = ?';
        folderBindings.push(projectId);
      }
      subqueries.push(this.knex.raw(
        `SELECT folders.id, folders.name, 'folder' AS "resourceType", folders.updated_at FROM folders JOIN projects ON folders.project_id = projects.id WHERE projects.owner_id = ? AND folders.name ILIKE ?${folderWhere}`,
        folderBindings
      ));
    }

    if (!type || type === 'dataset') {
      const dsBindings: unknown[] = [ownerId, ilikeTerm];
      let dsWhere = '';
      if (projectId) {
        dsWhere = ' AND folders.project_id = ?';
        dsBindings.push(projectId);
      }
      subqueries.push(this.knex.raw(
        `SELECT foundry_datasets.id, foundry_datasets.name, 'dataset' AS "resourceType", foundry_datasets.updated_at FROM foundry_datasets JOIN folders ON foundry_datasets.folder_id = folders.id JOIN projects ON folders.project_id = projects.id WHERE projects.owner_id = ? AND foundry_datasets.name ILIKE ?${dsWhere}`,
        dsBindings
      ));
    }

    if (subqueries.length === 0) {
      return { results: [], meta: { page, limit, total: 0, totalPages: 0 } };
    }

    const unionSql = subqueries.map((sq) => `(${sq.toQuery()})`).join(' UNION ALL ');

    // Get total count
    const countResult = await this.knex.raw(`SELECT COUNT(*) AS cnt FROM (${unionSql}) AS search_results`);
    const total = Number(countResult.rows[0]?.cnt ?? 0);

    // Get paginated results
    const dataResult = await this.knex.raw(
      `SELECT * FROM (${unionSql}) AS search_results ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );

    const results = dataResult.rows as Record<string, unknown>[];
    return { results, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async suggest(q: string, ownerId: string): Promise<{ name: string; type: string }[]> {
    if (!q || q.trim().length === 0) return [];
    // Escape LIKE special characters to prevent wildcard injection
    const escapedPrefix = q.trim().replace(/[\\%_]/g, '\\$&');
    const prefix = `${escapedPrefix}%`;
    const suggestions: { name: string; type: string }[] = [];

    const projects = await this.knex('projects').where({ owner_id: ownerId }).where('name', 'ilike', prefix).select('name').limit(10);
    suggestions.push(...projects.map((p: Record<string, unknown>) => ({ name: p.name as string, type: 'project' })));

    if (suggestions.length < 10) {
      const folders = await this.knex('folders').join('projects', 'folders.project_id', 'projects.id').where('projects.owner_id', ownerId).where('folders.name', 'ilike', prefix).select('folders.name').limit(10 - suggestions.length);
      suggestions.push(...folders.map((f: Record<string, unknown>) => ({ name: f.name as string, type: 'folder' })));
    }

    if (suggestions.length < 10) {
      const datasets = await this.knex('foundry_datasets').join('folders', 'foundry_datasets.folder_id', 'folders.id').join('projects', 'folders.project_id', 'projects.id').where('projects.owner_id', ownerId).where('foundry_datasets.name', 'ilike', prefix).select('foundry_datasets.name').limit(10 - suggestions.length);
      suggestions.push(...datasets.map((d: Record<string, unknown>) => ({ name: d.name as string, type: 'dataset' })));
    }

    return suggestions.slice(0, 10);
  }
}
