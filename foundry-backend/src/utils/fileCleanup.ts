import * as fs from 'fs';
import * as path from 'path';

/**
 * Safely deletes a file at the given path.
 * Logs a warning instead of throwing if the file doesn't exist or deletion fails.
 */
export async function deleteFile(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`Failed to delete file ${filePath}:`, error);
    }
  }
}

/**
 * Safely deletes multiple files.
 */
export async function deleteFiles(filePaths: string[]): Promise<void> {
  await Promise.all(filePaths.map(deleteFile));
}

/**
 * Ensures a directory exists, creating it recursively if needed.
 */
export async function ensureDirectory(dirPath: string): Promise<void> {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

/**
 * Generates a unique filename with the original extension preserved.
 */
export function generateUniqueFilename(
  originalName: string,
  prefix = ''
): string {
  const ext = path.extname(originalName);
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}${timestamp}_${random}${ext}`;
}
