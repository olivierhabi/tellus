import { Knex } from 'knex';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { AppError } from '@/utils/AppError';
import { scheduleParseJob } from '@/jobs/parseDatasetJob';

const execFileAsync = promisify(execFile);

/** Maximum uncompressed size (1GB) — ZIP bomb protection */
const MAX_UNCOMPRESSED_SIZE = 1024 * 1024 * 1024;

/** Allowed CSV-like extensions */
const ALLOWED_EXTENSIONS = new Set(['.csv', '.tsv', '.txt']);

interface ZipUploadResult {
  created: string[];
  skipped: string[];
  errors: Array<{ file: string; reason: string }>;
  foldersCreated: string[];
}

export class ZipUploadService {
  constructor(private knex: Knex) {}

  /**
   * Process a ZIP archive upload: extract, walk directories, create folders and datasets.
   */
  async processZipUpload(
    projectId: string,
    folderId: string,
    ownerId: string,
    file: Express.Multer.File
  ): Promise<ZipUploadResult> {
    const result: ZipUploadResult = {
      created: [],
      skipped: [],
      errors: [],
      foldersCreated: [],
    };

    // Create a unique temp directory for extraction
    const tempDir = path.join(
      path.dirname(file.path),
      `zip_extract_${crypto.randomBytes(8).toString('hex')}`
    );

    try {
      // Step 1: Validate ZIP size before extraction (ZIP bomb protection)
      await this.validateZipSize(file.path);

      // Step 2: Extract to temp directory
      await fs.promises.mkdir(tempDir, { recursive: true });
      await this.extractZip(file.path, tempDir);

      // Step 3: Walk extracted directory and process files
      await this.walkAndProcess(
        tempDir,
        tempDir,
        projectId,
        folderId,
        ownerId,
        result
      );

      return result;
    } finally {
      // Clean up temp directory
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {
        // Ignore cleanup errors
      });

      // Clean up the original ZIP file
      await fs.promises.unlink(file.path).catch(() => {
        // Ignore cleanup errors
      });
    }
  }

  /**
   * Validate ZIP file size to protect against ZIP bombs.
   * Uses `unzip -l` to check total uncompressed size.
   */
  private async validateZipSize(zipPath: string): Promise<void> {
    try {
      const { stdout } = await execFileAsync('unzip', ['-l', zipPath]);
      // The last line of `unzip -l` output contains total bytes
      const lines = stdout.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      const match = lastLine.match(/^\s*(\d+)/);

      if (match) {
        const totalSize = parseInt(match[1], 10);
        if (totalSize > MAX_UNCOMPRESSED_SIZE) {
          throw new AppError(
            `ZIP file uncompressed size (${Math.round(totalSize / 1024 / 1024)}MB) exceeds the 1GB limit`,
            413,
            'ZIP_TOO_LARGE'
          );
        }
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        'Failed to inspect ZIP file. Ensure it is a valid ZIP archive.',
        400,
        'INVALID_ZIP'
      );
    }
  }

  /**
   * Extract ZIP file to a target directory using system `unzip`.
   */
  private async extractZip(zipPath: string, targetDir: string): Promise<void> {
    try {
      await execFileAsync('unzip', ['-o', '-d', targetDir, zipPath]);
    } catch {
      throw new AppError(
        'Failed to extract ZIP file. Ensure it is a valid ZIP archive.',
        400,
        'ZIP_EXTRACTION_FAILED'
      );
    }
  }

  /**
   * Recursively walk extracted directories, creating subfolders and processing CSV files.
   */
  private async walkAndProcess(
    currentDir: string,
    rootDir: string,
    projectId: string,
    parentFolderId: string,
    ownerId: string,
    result: ZipUploadResult
  ): Promise<void> {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      // Path traversal protection: ensure resolved path is within rootDir
      const resolved = path.resolve(fullPath);
      if (!resolved.startsWith(path.resolve(rootDir))) {
        result.errors.push({
          file: entry.name,
          reason: 'Path traversal detected — skipped',
        });
        continue;
      }

      // Skip hidden files/directories
      if (entry.name.startsWith('.')) {
        result.skipped.push(entry.name);
        continue;
      }

      if (entry.isDirectory()) {
        // Create a subfolder in the database
        try {
          const [folder] = await this.knex('folders')
            .insert({
              name: entry.name,
              parent_folder_id: parentFolderId,
              project_id: projectId,
            })
            .returning('*');

          result.foldersCreated.push(entry.name);

          // Recurse into the subfolder
          await this.walkAndProcess(
            fullPath,
            rootDir,
            projectId,
            folder.id,
            ownerId,
            result
          );
        } catch (error) {
          // Handle duplicate folder names
          if ((error as { code?: string }).code === '23505') {
            // Unique constraint violation — folder already exists, find it and recurse
            const existingFolder = await this.knex('folders')
              .where({
                name: entry.name,
                parent_folder_id: parentFolderId,
                project_id: projectId,
              })
              .first();

            if (existingFolder) {
              await this.walkAndProcess(
                fullPath,
                rootDir,
                projectId,
                existingFolder.id,
                ownerId,
                result
              );
            }
          } else {
            result.errors.push({
              file: entry.name,
              reason: `Failed to create folder: ${(error as Error).message}`,
            });
          }
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();

        if (!ALLOWED_EXTENSIONS.has(ext)) {
          result.skipped.push(entry.name);
          continue;
        }

        try {
          // Copy file to the uploads directory with a unique name
          const uploadDir = path.dirname(fullPath);
          const uniqueName = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
          const destPath = path.join(uploadDir, uniqueName);
          await fs.promises.copyFile(fullPath, destPath);

          // Get file stats
          const fileStat = await fs.promises.stat(destPath);

          // Insert dataset record
          const [dataset] = await this.knex('datasets')
            .insert({
              name: entry.name,
              folder_id: parentFolderId,
              file_path: destPath,
              original_filename: entry.name,
              mime_type: ext === '.tsv' ? 'text/tab-separated-values' : 'text/csv',
              file_size_bytes: fileStat.size,
              status: 'pending',
            })
            .returning('*');

          result.created.push(entry.name);

          // Schedule parsing job
          scheduleParseJob(dataset.id as string);
        } catch (error) {
          result.errors.push({
            file: entry.name,
            reason: `Failed to process file: ${(error as Error).message}`,
          });
        }
      }
    }
  }
}
