import { Knex } from 'knex';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { AppError } from '../utils/foundryAppError';

export interface DuplicateGroup {
  contentHash: string;
  fileCount: number;
  datasets: Array<{ id: string; name: string; folderId: string; fileSizeBytes: number; createdAt: string }>;
}

export class HashService {
  constructor(private knex: Knex) {}

  async computeFileHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => { hash.update(chunk); });
      stream.on('end', () => { resolve(hash.digest('hex')); });
      stream.on('error', (err) => { reject(err); });
    });
  }

  async findDuplicates(projectId: string): Promise<DuplicateGroup[]> {
    const project = await this.knex('projects').where({ id: projectId }).first();
    if (!project) throw new AppError('Project not found', 404, 'NOT_FOUND');

    const duplicateRows = await this.knex.raw(
      `SELECT d.content_hash, d.id, d.name, d.folder_id, d.file_size_bytes, d.created_at FROM foundry_datasets d INNER JOIN folders f ON d.folder_id = f.id WHERE f.project_id = ? AND d.content_hash IS NOT NULL AND d.content_hash IN (SELECT d2.content_hash FROM foundry_datasets d2 INNER JOIN folders f2 ON d2.folder_id = f2.id WHERE f2.project_id = ? AND d2.content_hash IS NOT NULL GROUP BY d2.content_hash HAVING COUNT(*) > 1) ORDER BY d.content_hash, d.created_at ASC`,
      [projectId, projectId]
    );

    const groups = new Map<string, DuplicateGroup>();
    for (const row of duplicateRows.rows) {
      const hash = row.content_hash as string;
      if (!groups.has(hash)) { groups.set(hash, { contentHash: hash, fileCount: 0, datasets: [] }); }
      const group = groups.get(hash)!;
      group.datasets.push({ id: row.id, name: row.name, folderId: row.folder_id, fileSizeBytes: row.file_size_bytes, createdAt: row.created_at });
      group.fileCount = group.datasets.length;
    }
    return Array.from(groups.values());
  }

  async hashDataset(datasetId: string): Promise<string> {
    const dataset = await this.knex('foundry_datasets').where({ id: datasetId }).first();
    if (!dataset) throw new AppError('Dataset not found', 404, 'NOT_FOUND');
    const hash = await this.computeFileHash(dataset.file_path);
    await this.knex('foundry_datasets').where({ id: datasetId }).update({ content_hash: hash });
    return hash;
  }

  async deduplicateDataset(datasetId: string): Promise<{ isDuplicate: boolean; originalId?: string; hash: string }> {
    const dataset = await this.knex('foundry_datasets').where({ id: datasetId }).first();
    if (!dataset) throw new AppError('Dataset not found', 404, 'NOT_FOUND');

    let hash = dataset.content_hash;
    if (!hash) {
      hash = await this.computeFileHash(dataset.file_path);
      await this.knex('foundry_datasets').where({ id: datasetId }).update({ content_hash: hash });
    }

    const folder = await this.knex('folders').where({ id: dataset.folder_id }).first();
    if (!folder) throw new AppError('Dataset folder not found', 404, 'NOT_FOUND');

    const duplicate = await this.knex('datasets as d')
      .join('folders as f', 'd.folder_id', 'f.id')
      .where('f.project_id', folder.project_id)
      .where('d.content_hash', hash)
      .whereNot('d.id', datasetId)
      .orderBy('d.created_at', 'asc')
      .select('d.id')
      .first();

    return { isDuplicate: !!duplicate, originalId: duplicate?.id, hash };
  }
}
