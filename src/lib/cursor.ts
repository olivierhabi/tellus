// ---------------------------------------------------------------------------
// Cursor pagination — opaque base64 of {lastUpdatedAt, lastRid}
// ---------------------------------------------------------------------------
// Contracts: tasks/files-projects/contracts.md (B3-C-40..42).
//
// Tokens are not signed (the contract is opaque-not-tamper-proof). Decoding
// validates structure; the actual cursor key (updated_at, rid) is what the
// query uses for the keyset filter.
// ---------------------------------------------------------------------------

import { OntologyError } from "../utils/queryErrors";
import { isRid, type Rid } from "./rid";

export interface PageCursor {
  /** ISO-8601 timestamp of the last row returned in the previous page. */
  lastUpdatedAt: string;
  /** RID of the last row returned in the previous page (tie-breaker). */
  lastRid: Rid;
}

/** Encode a cursor as opaque base64. */
export function encodeCursor(cursor: PageCursor): string {
  const json = JSON.stringify({
    t: cursor.lastUpdatedAt,
    r: cursor.lastRid,
  });
  return Buffer.from(json, "utf8").toString("base64url");
}

/**
 * Decode an opaque page token.
 *
 * @throws OntologyError(INVALID_PAGE_TOKEN) on any malformed input.
 */
export function decodeCursor(token: string | undefined): PageCursor | null {
  if (!token || token.length === 0) return null;
  let raw: string;
  try {
    raw = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    throw new OntologyError("Page token is not valid base64url.", "INVALID_PAGE_TOKEN", 400, {
      token,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OntologyError("Page token does not decode to JSON.", "INVALID_PAGE_TOKEN", 400, {});
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new OntologyError("Page token must decode to an object.", "INVALID_PAGE_TOKEN", 400, {});
  }
  const obj = parsed as { t?: unknown; r?: unknown };
  if (typeof obj.t !== "string" || typeof obj.r !== "string") {
    throw new OntologyError(
      "Page token missing required fields {t,r}.",
      "INVALID_PAGE_TOKEN",
      400,
      {},
    );
  }
  // ISO-8601 timestamp validation
  const ts = new Date(obj.t);
  if (Number.isNaN(ts.getTime())) {
    throw new OntologyError("Page token timestamp is not ISO-8601.", "INVALID_PAGE_TOKEN", 400, {});
  }
  if (!isRid(obj.r)) {
    throw new OntologyError("Page token RID is malformed.", "INVALID_PAGE_TOKEN", 400, {});
  }
  return { lastUpdatedAt: obj.t, lastRid: obj.r };
}

/**
 * Validate `pageSize` query parameter.
 *
 * @throws OntologyError(INVALID_ARGUMENT) on out-of-range or non-numeric input.
 */
export function validatePageSize(input: unknown, defaultValue = 100): number {
  if (input === undefined || input === null || input === "") return defaultValue;
  const n = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new OntologyError(
      "pageSize must be an integer.",
      "INVALID_ARGUMENT",
      400,
      { received: String(input) },
    );
  }
  if (n < 1 || n > 1000) {
    throw new OntologyError(
      "pageSize must be in 1..1000.",
      "INVALID_ARGUMENT",
      400,
      { received: n },
    );
  }
  return n;
}
