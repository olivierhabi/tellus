// ---------------------------------------------------------------------------
// Resource-imports validators (B4) — extracted from ./routeHelpers.ts.
//
// validateImportsBody + the stateless content-derived ETag helpers for
// PUT /:rid/resource-imports.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";


// ---------------------------------------------------------------------------
// B4 resource-imports helpers.
// ---------------------------------------------------------------------------

const MAX_IMPORTS = 500;
const API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,254}$/;

/**
 * Stateless ETag for an import set. SHA-256 of the sorted (kind, api_name)
 * lines, truncated to 16 hex chars. Two semantically-equal sets always
 * yield the same etag regardless of insertion order or surrounding columns.
 */
export function computeImportsEtag(
  items: ReadonlyArray<{ kind: string; apiName: string }>,
): string {
  if (items.length === 0) return "empty";
  const sorted = items
    .map((it) => `${it.kind}\t${it.apiName}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(sorted, "utf8").digest("hex").slice(0, 16);
}

/** Parse `W/"<etag>"` or `"<etag>"` into the raw etag, or null if malformed. */
export function parseImportsEtag(s: string): string | null {
  const m = s.match(/^(?:W\/)?"([A-Za-z0-9_-]+|empty)"$/);
  return m ? m[1] : null;
}

// Renamed wire field is `ontologyRid`; the DB column is still `ontology_id`
// for migration compatibility.
export interface ValidatedImportsBody {
  readonly ok: true;
  readonly ontologyRid: string;
  readonly items: ReadonlyArray<{
    readonly kind: "object_type" | "link_type";
    readonly apiName: string;
    readonly rid?: string;
    readonly displayName?: string;
  }>;
}

export interface InvalidImportsBody {
  readonly ok: false;
  readonly parameters: Record<string, unknown>;
}

/**
 * Validate the PUT body. On success returns the normalized payload; on
 * failure returns the `parameters` to attach to the InvalidImportsBody
 * envelope so the FE can tell *which* field is bad.
 */
export function validateImportsBody(
  body: unknown,
): ValidatedImportsBody | InvalidImportsBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, parameters: { reason: "body must be a JSON object" } };
  }
  const b = body as Record<string, unknown>;

  // items
  if (!Array.isArray(b.items)) {
    return { ok: false, parameters: { field: "items", reason: "must be array" } };
  }
  if (b.items.length > MAX_IMPORTS) {
    return {
      ok: false,
      parameters: { field: "items", reason: "too many", max: MAX_IMPORTS },
    };
  }

  // ontologyRid — required when items≠[], optional/null when items=[].
  // Accept legacy `ontologyId` as a deprecated alias so older callers
  // keep working; new callers must send `ontologyRid`.
  const ontologyRidRaw = b.ontologyRid ?? b.ontologyId;
  if (b.items.length > 0) {
    if (typeof ontologyRidRaw !== "string" || ontologyRidRaw.length === 0) {
      return {
        ok: false,
        parameters: { field: "ontologyRid", reason: "required when items≠[]" },
      };
    }
    if (ontologyRidRaw.length > 512) {
      return {
        ok: false,
        parameters: { field: "ontologyRid", reason: "too long" },
      };
    }
  } else if (
    ontologyRidRaw !== null &&
    ontologyRidRaw !== undefined &&
    typeof ontologyRidRaw !== "string"
  ) {
    return {
      ok: false,
      parameters: { field: "ontologyRid", reason: "must be string or null" },
    };
  }

  // items[]
  const seen = new Set<string>();
  const normalized: Array<{
    kind: "object_type" | "link_type";
    apiName: string;
    rid?: string;
    displayName?: string;
  }> = [];
  for (let i = 0; i < b.items.length; i += 1) {
    const raw = b.items[i];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return {
        ok: false,
        parameters: { field: `items[${i}]`, reason: "must be object" },
      };
    }
    const it = raw as Record<string, unknown>;
    const kind = it.kind;
    if (kind !== "object_type" && kind !== "link_type") {
      return {
        ok: false,
        parameters: {
          field: `items[${i}].kind`,
          reason: "must be 'object_type' or 'link_type'",
        },
      };
    }
    const apiName = it.apiName;
    if (typeof apiName !== "string" || !API_NAME_RE.test(apiName)) {
      return {
        ok: false,
        parameters: {
          field: `items[${i}].apiName`,
          reason: "must match /^[A-Za-z][A-Za-z0-9_]{0,254}$/",
        },
      };
    }
    const key = `${kind}\u0000${apiName}`;
    if (seen.has(key)) {
      return {
        ok: false,
        parameters: {
          field: `items[${i}]`,
          reason: "duplicate (kind, apiName) within request",
        },
      };
    }
    seen.add(key);

    const rid = it.rid;
    if (rid !== undefined && rid !== null) {
      if (typeof rid !== "string" || rid.length > 512) {
        return {
          ok: false,
          parameters: {
            field: `items[${i}].rid`,
            reason: "must be string ≤ 512 chars",
          },
        };
      }
    }
    const displayName = it.displayName;
    if (displayName !== undefined && displayName !== null) {
      if (typeof displayName !== "string" || displayName.length > 255) {
        return {
          ok: false,
          parameters: {
            field: `items[${i}].displayName`,
            reason: "must be string ≤ 255 chars",
          },
        };
      }
    }
    normalized.push({
      kind,
      apiName,
      rid: typeof rid === "string" ? rid : undefined,
      displayName: typeof displayName === "string" ? displayName : undefined,
    });
  }

  return {
    ok: true,
    // ontologyRid is "" when items=[] and caller passed null — the column
    // still needs a value but the row never lands. We coerce here for
    // type-narrowing; the route's `items.length === 0 ? null : ontologyRid`
    // gate keeps the response shape honest.
    ontologyRid:
      typeof ontologyRidRaw === "string" ? ontologyRidRaw : "",
    items: normalized,
  };
}
