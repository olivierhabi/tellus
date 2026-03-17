import { Knex } from 'knex';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { AppError } from '../utils/foundryAppError';
import { scheduleParseJob } from '../jobs/parseDatasetJob';
import { buildObjectKey, uploadObject } from './storageService';

const execFileAsync = promisify(execFile);
const MAX_UNCOMPRESSED_SIZE = 1024 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.csv', '.tsv', '.txt']);

interface ZipUploadResult {
  created: string[];
  skipped: string[];
  errors: Array<{ file: string; reason: string }>;
  foldersCreated: string[];
}

export class ZipUploadService {
  constructor(private knex: Knex) {}

  async processZipUpload(projectId: string, folderId: string, ownerId: string, file: Express.Multer.File): Promise<ZipUploadResult> {
    const result: ZipUploadResult = { created: [], skipped: [], errors: [], foldersCreated: [] };
    const tempDir = path.join(path.dirname(file.path), `zip_extract_${crypto.randomBytes(8).toString('hex')}`);

    try {
      await this.validateZipSize(file.path);
      await fs.promises.mkdir(tempDir, { recursive: true });
      await this.extractZip(file.path, tempDir);
      await this.walkAndProcess(tempDir, tempDir, projectId, folderId, ownerId, result);
      return result;
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      await fs.promises.unlink(file.path).catch(() => {});
    }
  }

  private async validateZipSize(zipPath: string): Promise<void> {
    try {
      const { stdout } = await execFileAsync('unzip', ['-l', zipPath]);
      const lines = stdout.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      const match = lastLine.match(/^\s*(\d+)/);
      if (match) {
        const totalSize = parseInt(match[1], 10);
        if (totalSize > MAX_UNCOMPRESSED_SIZE) throw new AppError(`ZIP file uncompressed size (${Math.round(totalSize / 1024 / 1024)}MB) exceeds the 1GB limit`, 413, 'ZIP_TOO_LARGE');
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('Failed to inspect ZIP file. Ensure it is a valid ZIP archive.', 400, 'INVALID_ZIP');
    }
  }

  private async extractZip(zipPath: string, targetDir: string): Promise<void> {
    try { await execFileAsync('unzip', ['-o', '-d', targetDir, zipPath]); }
    catch { throw new AppError('Failed to extract ZIP file. Ensure it is a valid ZIP archive.', 400, 'ZIP_EXTRACTION_FAILED'); }
  }

  private async walkAndProcess(currentDir: string, rootDir: string, projectId: string, parentFolderId: string, ownerId: string, result: ZipUploadResult): Promise<void> {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const resolved = path.resolve(fullPath);
      if (!resolved.startsWith(path.resolve(rootDir))) { result.errors.push({ file: entry.name, reason: 'Path traversal detected — skipped' }); continue; }
      if (entry.name.startsWith('.')) { result.skipped.push(entry.name); continue; }

      if (entry.isDirectory()) {
        try {
          const [folder] = await this.knex('folders').insert({ name: entry.name, parent_folder_id: parentFolderId, project_id: projectId }).returning('*');
          result.foldersCreated.push(entry.name);
          await this.walkAndProcess(fullPath, rootDir, projectId, folder.id, ownerId, result);
        } catch (error) {
          if ((error as { code?: string }).code === '23505') {
            const existingFolder = await this.knex('folders').where({ name: entry.name, parent_folder_id: parentFolderId, project_id: projectId }).first();
            if (existingFolder) await this.walkAndProcess(fullPath, rootDir, projectId, existingFolder.id, ownerId, result);
          } else {
            result.errors.push({ file: entry.name, reason: `Failed to create folder: ${(error as Error).message}` });
          }
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!ALLOWED_EXTENSIONS.has(ext)) { result.skipped.push(entry.name); continue; }

        try {
          // Read extracted file from temp dir and upload to S3
          const fileBuffer = await fs.promises.readFile(fullPath);
          const uniqueName = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${entry.name}`;
          const objectKey = buildObjectKey(projectId, parentFolderId, uniqueName);
          const mimeType = ext === '.tsv' ? 'text/tab-separated-values' : 'text/csv';

          await uploadObject(objectKey, fileBuffer, mimeType, {
            'original-filename': entry.name,
            'project-id': projectId,
            'folder-id': parentFolderId,
            'owner-id': ownerId,
          });

          const [dataset] = await this.knex('foundry_datasets')
            .insert({ name: entry.name, folder_id: parentFolderId, file_path: objectKey, original_filename: entry.name, mime_type: mimeType, file_size_bytes: fileBuffer.length, status: 'pending' })
            .returning('*');
          result.created.push(entry.name);
          scheduleParseJob(dataset.id as string);
        } catch (error) {
          result.errors.push({ file: entry.name, reason: `Failed to process file: ${(error as Error).message}` });
        }
      }
    }
  }
}
