// ---------------------------------------------------------------------------
// Connectivity ETag + If-Match helpers (Tellus PG Connectivity spec v2 §20).
//
// Distinct from src/middleware/etag.ts because:
//   - Spec mandates WEAK ETag format `W/"<version>"` (etag.ts emits strong "v17").
//   - Spec mandates the Tellus error envelope with errorName
//     `Tellus:Connectivity:ResourceVersionMismatch` / `:IfMatchRequired`,
//     not OntologyError's `CONCURRENT_EDIT_CONFLICT` / `PRECONDITION_REQUIRED`.
//
// The existing etag.ts predates the connectivity service and is consumed by
// ontology-shaped routes that rely on its specific error type. Co-evolving
// would force a sweep of those routes; that is out of scope for B1. Aligning
// here to the connectivity spec is the contradiction-resolution path per
// agent prompt §3.2. Documented in tasks/postgres-connection/DEVIATIONS.md (D9).
//
// Reads: handler calls `setConnectivityEtag(res, version)` before sending the body.
// Mutating: handler calls `requireConnectivityIfMatch(req, version)` which throws
// TellusError mapped to 409 ResourceVersionMismatch / 412 IfMatchRequired if the
// header is absent or mismatched. The OCC database UPDATE provides the
// authoritative race resolution; this middleware short-circuits the obvious cases
// before the round-trip.
// ---------------------------------------------------------------------------

import type { Request, Response } from "express";
import {
  IfMatchRequired,
  ResourceVersionMismatch,
} from "../lib/errors/connectivity.errors";
import { TellusError } from "../lib/errors/envelope";

export function etagFor(version: number | bigint | string): string {
  return `W/"${version}"`;
}

/** Set the ETag response header. Use BEFORE res.json(...) / res.send(...). */
export function setConnectivityEtag(
  res: Response,
  version: number | bigint | string,
): void {
  res.setHeader("ETag", etagFor(version));
}

/**
 * Extract the version int from an If-Match header. Returns:
 *   - { kind: 'missing' }    when the header is absent
 *   - { kind: 'malformed' }  when present but not parseable
 *   - { kind: 'value', version: number }  on success
 *
 * Accepts both weak (`W/"7"`) and strong (`"7"`) forms; emission is always weak.
 */
export function parseConnectivityIfMatch(
  req: Request,
):
  | { kind: "missing" }
  | { kind: "malformed" }
  | { kind: "value"; version: number } {
  const raw = req.headers["if-match"];
  if (raw === undefined) return { kind: "missing" };
  if (typeof raw !== "string") return { kind: "malformed" };
  const m = raw.match(/^(?:W\/)?"(\d+)"$/);
  if (!m) return { kind: "malformed" };
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 0) return { kind: "malformed" };
  return { kind: "value", version: n };
}

/**
 * Throws TellusError when If-Match is absent or does not match `currentVersion`.
 * Returns the parsed expected version on success so handlers can pass it into
 * the OCC UPDATE clause.
 */
export function requireConnectivityIfMatch(
  req: Request,
  currentVersion: number,
): number {
  const parsed = parseConnectivityIfMatch(req);
  if (parsed.kind === "missing") {
    throw new TellusError(IfMatchRequired, {
      required: true,
      header: "If-Match",
    });
  }
  if (parsed.kind === "malformed") {
    throw new TellusError(IfMatchRequired, {
      reason: "malformed",
      expectedFormat: 'W/"<integer>"',
    });
  }
  if (parsed.version !== currentVersion) {
    throw new TellusError(ResourceVersionMismatch, {
      provided: parsed.version,
      current: currentVersion,
    });
  }
  return parsed.version;
}

/**
 * Convenience alias used by handlers that only want the *expected* version
 * (the OCC UPDATE will do the authoritative compare). Throws on missing /
 * malformed If-Match. Returns the parsed integer.
 */
export function parseIfMatch(req: Request): number {
  const parsed = parseConnectivityIfMatch(req);
  if (parsed.kind === "missing") {
    throw new TellusError(IfMatchRequired, {
      required: true,
      header: "If-Match",
    });
  }
  if (parsed.kind === "malformed") {
    throw new TellusError(IfMatchRequired, {
      reason: "malformed",
      expectedFormat: 'W/"<integer>"',
    });
  }
  return parsed.version;
}

/** Alias for setConnectivityEtag — used by handlers preferring the shorter name. */
export const emitEtag = setConnectivityEtag;
