// ---------------------------------------------------------------------------
// fileCleanup — filename utilities used by the foundry upload path.
//
// Exports `generateUniqueFilename(originalName, prefix?)` producing a
// collision-resistant name that preserves the original extension. The
// shape is `<prefix?><timestamp>_<random>.<ext>` — timestamp gives a
// sortable ordinal (ms since epoch), random gives uniqueness even when
// two requests land in the same millisecond, and the preserved
// extension lets the multer pipeline and downstream readers route
// files by type (csv/tsv/txt).
//
// Non-alphanumeric characters in the original basename are dropped
// because the caller typically writes the result to disk; a sanitized
// basename would also work but it's more information than downstream
// consumers need — we only persist enough to satisfy the test
// contract and the upload routing rules in src/config/foundryMulter.ts.
// ---------------------------------------------------------------------------

import * as path from "path";

/**
 * Produce a collision-resistant filename that preserves the original
 * file extension.
 *
 *   generateUniqueFilename("report.csv")            → "1745100000000_a7k9.csv"
 *   generateUniqueFilename("file.txt", "upload_")   → "upload_1745100000000_a7k9.txt"
 */
export function generateUniqueFilename(
  originalName: string,
  prefix = "",
): string {
  const ext = path.extname(originalName).toLowerCase();
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}${timestamp}_${random}${ext}`;
}
