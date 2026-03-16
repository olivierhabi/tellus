import { Knex } from 'knex';
import { LRUCache } from 'lru-cache';
import { AppError } from '../utils/foundryAppError';

interface BreadcrumbSegment {
  id: string;
  name: string;
  type: string;
  url: string;
}

export class BreadcrumbService {
  private cache: LRUCache<string, BreadcrumbSegment[]>;

  constructor(private knex: Knex) {
    this.cache = new LRUCache<string, BreadcrumbSegment[]>({
      max: 1000,
      ttl: 60 * 1000,
    });
  }

  async getBreadcrumb(type: string, id: string, includeChildren = false) {
    const cacheKey = `${type}:${id}:${includeChildren}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return { breadcrumb: cached, children: null };

    let breadcrumb: BreadcrumbSegment[] = [];
    let children = null;

    if (type === 'project') {
      const project = await this.knex('projects').where({ id }).first();
      if (!project) throw new AppError('Project not found', 404, 'NOT_FOUND');
      breadcrumb = [{ id: project.id, name: project.name, type: 'project', url: `/projects/${project.id}` }];
      if (includeChildren) {
        const folders = await this.knex('folders').where({ project_id: id }).whereNull('parent_folder_id').orderBy('name');
        children = { folders, datasets: [] };
      }
    } else if (type === 'folder') {
      const folder = await this.knex('folders').where({ id }).first();
      if (!folder) throw new AppError('Folder not found', 404, 'NOT_FOUND');
      const project = await this.knex('projects').where({ id: folder.project_id }).first();
      if (!project) throw new AppError('Project not found', 404, 'NOT_FOUND');

      const ancestors = await this.knex.raw(
        `SELECT id, name FROM folders WHERE project_id = ? AND path @> (SELECT path FROM folders WHERE id = ?) ORDER BY depth ASC`,
        [folder.project_id, id]
      );

      breadcrumb = [
        { id: project.id, name: project.name, type: 'project', url: `/projects/${project.id}` },
        ...ancestors.rows.map((a: Record<string, unknown>) => ({
          id: a.id as string,
          name: a.name as string,
          type: 'folder',
          url: `/projects/${project.id}/folders/${a.id}`,
        })),
      ];

      if (includeChildren) {
        const [childFolders, childDatasets] = await Promise.all([
          this.knex('folders').where({ parent_folder_id: id }).orderBy('name'),
          this.knex('foundry_datasets').where({ folder_id: id }).orderBy('name'),
        ]);
        children = { folders: childFolders, datasets: childDatasets };
      }
    } else if (type === 'dataset') {
      const dataset = await this.knex('foundry_datasets').where({ id }).first();
      if (!dataset) throw new AppError('Dataset not found', 404, 'NOT_FOUND');
      const folder = await this.knex('folders').where({ id: dataset.folder_id }).first();
      if (!folder) throw new AppError('Folder not found', 404, 'NOT_FOUND');
      const project = await this.knex('projects').where({ id: folder.project_id }).first();
      if (!project) throw new AppError('Project not found', 404, 'NOT_FOUND');

      const ancestors = await this.knex.raw(
        `SELECT id, name FROM folders WHERE project_id = ? AND path @> (SELECT path FROM folders WHERE id = ?) ORDER BY depth ASC`,
        [folder.project_id, dataset.folder_id]
      );

      breadcrumb = [
        { id: project.id, name: project.name, type: 'project', url: `/projects/${project.id}` },
        ...ancestors.rows.map((a: Record<string, unknown>) => ({
          id: a.id as string,
          name: a.name as string,
          type: 'folder',
          url: `/projects/${project.id}/folders/${a.id}`,
        })),
        { id: dataset.id, name: dataset.name, type: 'dataset', url: `/datasets/${dataset.id}` },
      ];
    } else {
      throw new AppError('Invalid resource type. Use: project, folder, or dataset', 400, 'VALIDATION_ERROR');
    }

    this.cache.set(cacheKey, breadcrumb);
    return { breadcrumb, children };
  }

  invalidateCache(): void {
    this.cache.clear();
  }
}
