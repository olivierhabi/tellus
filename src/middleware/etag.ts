// ---------------------------------------------------------------------------
// ETag / If-Match — optimistic concurrency helpers
// ---------------------------------------------------------------------------
// Spec: Ontology Platform tasks.md §2.3 "Optimistic Concurrency"
//
//   GET  /api/v1/.../flight -> ETag: "v17"
//   PUT  /api/v1/.../flight  If-Match: "v17" -> 200 OK, ETag: "v18"
//   PUT  /api/v1/.../flight  If-Match: "v17" -> 409 CONCURRENT_EDIT_CONFLICT
//
// These helpers keep the contract enforcement on the route handlers themselves
// (no global express-etag override — that would produce weak ETags from the
// response body which aren't meaningful for our MVCC semantics).
// ---------------------------------------------------------------------------

import { Request, Response } from "express";
import { OntologyError } from "../utils/queryErrors";

/** Format a version integer as a strong ETag: `"v17"`. */
export function formatEtag(version: number | string | null | undefined): string {
  if (version === null || version === undefined) return '"v0"';
  return `"v${version}"`;
}

/** Parse a strong ETag back into a numeric version, or null if malformed. */
export function parseEtag(header: string | undefined | null): number | null {
  if (!header) return null;
  const m = header.match(/^W?\/?"v(\d+)"$/);
  return m ? parseInt(m[1], 10) : null;
}

/** Set the `ETag` response header from a numeric version. */
export function setEtag(res: Response, version: number | string): void {
  res.setHeader("ETag", formatEtag(version));
}

/**
 * Enforce the `If-Match` header against a current resource version. Throws
 * a 409 CONCURRENT_EDIT_CONFLICT if the header is present and stale, and a
 * 428 PRECONDITION_REQUIRED if `required` is true and the header is absent.
 *
 * Most mutable endpoints should call this at the top of the PUT/PATCH handler
 * *after* fetching the current row but *before* applying changes.
 */
export function requireIfMatch(
  req: Request,
  currentVersion: number,
  options: { required?: boolean } = {}
): void {
  const header =
    (req.headers["if-match"] as string | undefined) ||
    (req.body && typeof req.body === "object"
      ? ((req.body as Record<string, unknown>)._etag as string | undefined)
      : undefined);

  if (!header) {
    if (options.required) {
      throw new OntologyError(
        "If-Match header is required on mutable requests.",
        "PRECONDITION_REQUIRED",
        428,
        { currentVersion }
      );
    }
    return;
  }

  const expected = parseEtag(header);
  if (expected === null) {
    throw new OntologyError(
      "If-Match header is malformed. Expected format: \"v<n>\".",
      "INVALID_PARAMETER",
      400,
      { header }
    );
  }
  if (expected !== currentVersion) {
    throw new OntologyError(
      `Stale version ${expected} (current ${currentVersion}).`,
      "CONCURRENT_EDIT_CONFLICT",
      409,
      { expected, current: currentVersion }
    );
  }
}
