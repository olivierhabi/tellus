// Quiver ETag (G-03). Reuses the workshop's RFC 8785-subset canonicalizer
// rather than duplicating it (single source of truth for canonical JSON).
//
// ETag scheme: W/"<sha256-hex of canonical(rowSnapshot)>".
// Truncation to 16 hex chars is permitted at presentation time; storage
// keeps the full digest for forensic traceability (D-08).

import { createHash } from "node:crypto";
import { canonicalizeJson } from "../workshop/etag";

export { canonicalizeJson };

export interface AnalysisRowSnapshot {
  rid: string;
  parentFolderRid: string;
  displayName: string;
  description: string | null;
  documentBlobUri: string | null;
  documentInline: unknown | null;
  currentVersion: number;
  isDeleted: boolean;
  deletedAt: string | null;
  updatedAt: string;
  markings: string[];
}

export function computeAnalysisEtag(snap: AnalysisRowSnapshot): string {
  const canonical = canonicalizeJson(snap);
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `W/"${digest}"`;
}

/**
 * Generic ETag-over-canonical-JSON helper used by the OT engine when
 * recomputing an analysis ETag after submitInstructions. Same shape as
 * computeAnalysisEtag but accepts any sortable payload — used internally
 * after applying instructions to the (cards, canvases, parameters, version)
 * tuple. Same SHA-256 + W/"..." envelope as the row ETag.
 */
export function computeEtagOf(payload: unknown): string {
  const canonical = canonicalizeJson(payload as any);
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `W/"${digest}"`;
}

export function stripWeakPrefix(etag: string): string {
  return etag.startsWith("W/") ? etag.slice(2) : etag;
}

export function etagsMatch(a: string, b: string): boolean {
  return stripWeakPrefix(a).replace(/"/g, "") ===
    stripWeakPrefix(b).replace(/"/g, "");
}
