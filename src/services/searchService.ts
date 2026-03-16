import { Knex } from 'knex';

export class SearchService {
  constructor(private knex: Knex) {}

  async search(params: { q: string; type?: string; projectId?: string; page: number; limit: number; ownerId: string }) {
    const { q, type, projectId, page, limit, ownerId } = params;
    const offset = (page - 1) * limit;

    if (!q || q.trim() === '') {
      const projects = await this.knex('projects').where({ owner_id: ownerId }).orderBy('updated_at', 'desc').limit(limit);
      return { results: projects.map((p: Record<string, unknown>) => ({ ...p, resourceType: 'project' })), meta: { page, limit, total: projects.length } };
    }

    const searchTerm = q.trim();
    // Escape LIKE special characters to prevent wildcard injection
    const escapedTerm = searchTerm.replace(/[\\%_]/g, '\\$&');
    const ilikeTerm = `%${escapedTerm}%`;
    const results: Record<string, unknown>[] = [];

    if (!type || type === 'project') {
      const projects = await this.knex('projects').where({ owner_id: ownerId }).where('name', 'ilike', ilikeTerm).orderBy('updated_at', 'desc');
      results.push(...projects.map((p: Record<string, unknown>) => ({ ...p, resourceType: 'project' })));
    }

    if (!type || type === 'folder') {
      let folderQuery = this.knex('folders').join('projects', 'folders.project_id', 'projects.id').where('projects.owner_id', ownerId).where('folders.name', 'ilike', ilikeTerm).select('folders.*');
      if (projectId) folderQuery = folderQuery.where('folders.project_id', projectId);
      const folders = await folderQuery.orderBy('folders.updated_at', 'desc');
      results.push(...folders.map((f: Record<string, unknown>) => ({ ...f, resourceType: 'folder' })));
    }

    if (!type || type === 'dataset') {
      let datasetQuery = this.knex('foundry_datasets').join('folders', 'foundry_datasets.folder_id', 'folders.id').join('projects', 'folders.project_id', 'projects.id').where('projects.owner_id', ownerId).where('foundry_datasets.name', 'ilike', ilikeTerm).select('foundry_datasets.*');
      if (projectId) datasetQuery = datasetQuery.where('folders.project_id', projectId);
      const datasets = await datasetQuery.orderBy('foundry_datasets.updated_at', 'desc');
      results.push(...datasets.map((d: Record<string, unknown>) => ({ ...d, resourceType: 'dataset' })));
    }

    const total = results.length;
    const paged = results.slice(offset, offset + limit);
    return { results: paged, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async suggest(q: string, ownerId: string): Promise<{ name: string; type: string }[]> {
    if (!q || q.trim().length === 0) return [];
    const prefix = `${q.trim()}%`;
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
