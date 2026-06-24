// ---------------------------------------------------------------------------
// Code Repositories — Weak-ETag helpers (W/"<resource_version>") per spec §1.4
//
// Contract IDs:
//   G-C-17  etag = W/"<resource_version>"
//   G-C-18  PUT/PATCH/DELETE require If-Match; missing or stale → 412 + StaleEtag
//   G-C-19  resource_version is a monotonically increasing integer per row
//
// Distinct from src/middleware/etag.ts which uses STRONG ETags ("v17"). The
// Code Repositories surface uses WEAK ETags per the spec line:
//
//   "ETag is W/"<resource_version>" where resource_version is a monotonically
//    increasing integer per row."
// ---------------------------------------------------------------------------

/** Format a `resource_version` as a weak ETag: `W/"17"`. */
export function formatWeakEtag(version: number): string {
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`formatWeakEtag: version must be a non-negative integer, got ${version}`);
  }
  return `W/"${version}"`;
}

/** Parse a weak ETag back to a number, or null if malformed. */
export function parseWeakEtag(header: string | undefined | null): number | null {
  if (typeof header !== "string") return null;
  const m = header.match(/^W\/"(\d+)"$/);
  return m ? Number.parseInt(m[1], 10) : null;
}

/** Result of an If-Match check. */
export type IfMatchResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "missing" | "malformed" | "stale" };

/**
 * Pure check: given the If-Match header value (or undefined) and the current
 * row's `resource_version`, return whether the precondition holds. Routes
 * call this and translate the failure to `<Service>:StaleEtag` (412).
 */
export function checkIfMatch(
  header: string | undefined,
  currentVersion: number
): IfMatchResult {
  if (header === undefined || header === null || header === "") {
    return { ok: false, reason: "missing" };
  }
  const expected = parseWeakEtag(header);
  if (expected === null) return { ok: false, reason: "malformed" };
  if (expected !== currentVersion) return { ok: false, reason: "stale" };
  return { ok: true };
}
