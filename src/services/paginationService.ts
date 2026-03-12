// ---------------------------------------------------------------------------
// Pagination Service
//
// Cursor-based pagination using OpenSearch's search_after. The page token
// is a base64-encoded JSON object containing sort values, object type,
// sort order, a hash of the where clause, and creation timestamp.
// ---------------------------------------------------------------------------

import crypto from "crypto";
import { resolveProperty } from "./propertyResolver";
import { appError } from "../utils/appError";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PageTokenPayload {
  sort: unknown[];
  objectType: string;
  orderBy: Array<{ field: string; direction: string }>;
  where: string;
  created: number;
}

// ---------------------------------------------------------------------------
// Token encoding / decoding
// ---------------------------------------------------------------------------

function hashWhere(where: unknown): string {
  const str = where ? JSON.stringify(where) : "";
  return crypto.createHash("sha256").update(str).digest("hex").slice(0, 16);
}

/**
 * Create an opaque page token from the last document's sort values.
 */
export function createPageToken(
  sortValues: unknown[],
  orderBy: Array<{ field: string; direction: string }>,
  objectTypeApiName: string,
  whereClause: unknown
): string {
  const payload: PageTokenPayload = {
    sort: sortValues,
    objectType: objectTypeApiName,
    orderBy,
    where: hashWhere(whereClause),
    created: Date.now(),
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

/**
 * Decode and validate a page token.
 */
export function decodePageToken(
  token: string,
  objectTypeApiName: string,
  whereClause?: unknown
): PageTokenPayload {
  let payload: PageTokenPayload;
  try {
    const json = Buffer.from(token, "base64").toString("utf-8");
    payload = JSON.parse(json);
  } catch {
    throw appError("INVALID_PAGE_TOKEN", "Invalid page token format.");
  }

  if (!payload.sort || !Array.isArray(payload.sort)) {
    throw appError("INVALID_PAGE_TOKEN", "Page token missing sort values.");
  }

  if (payload.objectType !== objectTypeApiName) {
    throw appError(
      "INVALID_PAGE_TOKEN",
      `Page token was created for object type '${payload.objectType}' but is being used with '${objectTypeApiName}'. Page tokens cannot be used across different object types.`
    );
  }

  // Check token age (24 hour max)
  if (payload.created && Date.now() - payload.created > 24 * 60 * 60 * 1000) {
    throw appError("INVALID_PAGE_TOKEN", "Page token has expired. Please start pagination from the beginning.");
  }

  // Check where clause hash
  if (whereClause !== undefined && payload.where) {
    const currentHash = hashWhere(whereClause);
    if (currentHash !== payload.where) {
      throw appError(
        "INVALID_PAGE_TOKEN",
        "Page token is from a different query. Please start pagination from the beginning without a pageToken."
      );
    }
  }

  return payload;
}

/**
 * Build the search_after array for OpenSearch from a decoded page token.
 */
export function buildSearchAfterClause(decodedToken: PageTokenPayload): unknown[] {
  return decodedToken.sort;
}

/**
 * Build OpenSearch sort clause from orderBy fields.
 * Always appends __pk as tiebreaker.
 */
export async function buildSortClause(
  orderBy: Array<{ field: string; direction: string }> | undefined,
  objectTypeApiName: string
): Promise<Array<Record<string, unknown>>> {
  const sorts: Array<Record<string, unknown>> = [];

  if (orderBy && orderBy.length > 0) {
    for (const item of orderBy) {
      const meta = await resolveProperty(objectTypeApiName, item.field);
      const effective = meta.baseType.endsWith("_array")
        ? meta.baseType.replace("_array", "")
        : meta.baseType;
      const sortField =
        effective === "string" ? meta.opensearchKeywordField : meta.opensearchField;
      sorts.push({ [sortField]: { order: item.direction } });
    }
  }

  // Tiebreaker
  const hasPk = sorts.some((s) => "__pk" in s);
  if (!hasPk) {
    sorts.push({ __pk: { order: "asc" } });
  }

  return sorts;
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

if (require.main === module) {
  (async () => {
    let passed = 0;
    let failed = 0;

    function assert(condition: boolean, label: string) {
      if (condition) { passed++; console.log(`  PASS  ${label}`); }
      else { failed++; console.log(`  FAIL  ${label}`); }
    }

    console.log("=== PaginationService self-test ===");

    // Create and decode a token
    const token = createPageToken(
      [145000, "EMP-042"],
      [{ field: "salary", direction: "desc" }],
      "Employee",
      { type: "eq", field: "dept", value: "Eng" }
    );
    assert(typeof token === "string" && token.length > 0, "Token is non-empty string");

    const decoded = decodePageToken(token, "Employee", { type: "eq", field: "dept", value: "Eng" });
    assert(decoded.sort[0] === 145000, "Sort value 0 preserved");
    assert(decoded.sort[1] === "EMP-042", "Sort value 1 preserved");
    assert(decoded.objectType === "Employee", "Object type preserved");
    assert(decoded.orderBy.length === 1, "OrderBy preserved");

    // Wrong object type
    try {
      decodePageToken(token, "Company");
      assert(false, "Wrong object type should throw");
    } catch (err: any) {
      assert(err.message.includes("Page token was created for"), "Wrong OT error message");
    }

    // Wrong where clause
    try {
      decodePageToken(token, "Employee", { type: "eq", field: "dept", value: "Sales" });
      assert(false, "Wrong where should throw");
    } catch (err: any) {
      assert(err.message.includes("different query"), "Wrong where error message");
    }

    // buildSearchAfterClause
    const sa = buildSearchAfterClause(decoded);
    assert(Array.isArray(sa) && sa.length === 2, "search_after has 2 elements");

    // Sort clause defaults
    const defaultSort = await buildSortClause(undefined, "Any");
    assert(defaultSort.length === 1 && "__pk" in defaultSort[0], "Default sort is __pk asc");

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  })();
}
