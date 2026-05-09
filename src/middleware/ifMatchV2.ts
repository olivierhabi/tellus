// ---------------------------------------------------------------------------
// If-Match — Foundry-faithful 412/428 variant for /api/v2/filesystem/* endpoints
// ---------------------------------------------------------------------------
// Contracts: tasks/files-projects/contracts.md (B3-C-20..24).
//
// The legacy `src/middleware/etag.ts` returns 409 CONCURRENT_EDIT_CONFLICT to
// match the Ontology Platform contract. Foundry's Filesystem v2 returns
// 412 PRECONDITION_FAILED, so v2 endpoints use this module instead. Both
// helpers share the same etag formatting (`"v<n>"`).
// ---------------------------------------------------------------------------

import type { Request, Response } from "express";
import { OntologyError } from "../utils/queryErrors";
import { v2EtagMismatchTotal } from "../metrics/filesystemV2";

const ETAG_PATTERN = /^W?\/?"v(\d+)"$/;

/** Format a version integer as a strong ETag. */
export function formatV2Etag(version: number): string {
  return `"v${version}"`;
}

/** Parse a strong ETag into its numeric version, or null on malformed input. */
export function parseV2Etag(header: string | undefined | null): number | null {
  if (!header) return null;
  const m = header.match(ETAG_PATTERN);
  return m ? Number(m[1]) : null;
}

/** Set the `ETag` header from a numeric version. */
export function setV2Etag(res: Response, version: number): void {
  res.setHeader("ETag", formatV2Etag(version));
}

/**
 * Foundry-faithful If-Match enforcement.
 *
 * Behavior matrix (B3-C-20..24):
 *   header missing           → 428 PRECONDITION_REQUIRED
 *   header malformed         → 400 INVALID_ARGUMENT
 *   header version != current → 412 PRECONDITION_FAILED (with {expected, actual})
 *   header version == current → returns silently
 *
 * @param endpoint  Endpoint label for the etag-mismatch metric.
 */
export function requireIfMatchV2(
  req: Request,
  currentEtag: number,
  endpoint: string,
): void {
  const header = req.headers["if-match"] as string | undefined;
  if (!header) {
    throw new OntologyError(
      "If-Match header is required on this mutation.",
      "PRECONDITION_REQUIRED",
      428,
      { currentEtag },
    );
  }
  const expected = parseV2Etag(header);
  if (expected === null) {
    throw new OntologyError(
      'If-Match header is malformed; expected `"v<n>"`.',
      "INVALID_ARGUMENT",
      400,
      { received: header },
    );
  }
  if (expected !== currentEtag) {
    v2EtagMismatchTotal.labels({ endpoint }).inc();
    throw new OntologyError(
      `ETag mismatch: client expected v${expected}, current is v${currentEtag}.`,
      "PRECONDITION_FAILED",
      412,
      { expected, actual: currentEtag },
    );
  }
}
