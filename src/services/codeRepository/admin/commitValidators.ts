// ---------------------------------------------------------------------------
// Commit validators (B2-C-12) — extracted from ./routeHelpers.ts.
//
// validateCommitBody + parseShaIfMatch + payload caps for
// POST /:rid/branches/:branch/commits.
// ---------------------------------------------------------------------------

import { validateRelativePath } from "../stemma/path";


// ---------------------------------------------------------------------------
// Commit-route helpers (B2-C-12).
// ---------------------------------------------------------------------------

/**
 * Parse an `If-Match` header value as a 40-char SHA-1. Accepts strong
 * (`"abcdef..."`) or weak (`W/"abcdef..."`) form per RFC 7232. Anything
 * else (digits, integer ETags from PATCH /:rid, malformed quotes, wrong
 * length) returns `null`.
 *
 * Kept separate from `parseEtag` (which parses the integer-shaped
 * resource-version ETag used by the metadata routes) because conflating
 * the two would let a client sneak a `W/"7"` past the commit-route fence
 * and into the adapter, where `7 !== <40-char head>` would 412 — but
 * with a less-helpful "not a SHA" reason. Failing fast at the route is
 * clearer and cheaper.
 */
export function parseShaIfMatch(s: string): string | null {
  const m = s.match(/^(?:W\/)?"([0-9a-f]{40})"$/i);
  if (!m) return null;
  return m[1].toLowerCase();
}

/** Per F4 spec: max 1 MiB total commit payload to keep tx latency bounded. */
export const COMMIT_MAX_TOTAL_BYTES = 1 * 1024 * 1024;
/** Cap commit size by file count so a pathological client can't OOM us. */
export const COMMIT_MAX_FILE_CHANGES = 500;
/** Cap commit message length (longer messages signal abuse, not user intent). */
export const COMMIT_MAX_MESSAGE_BYTES = 4 * 1024;

export interface ValidatedCommitBody {
  message: string;
  /** Upserts (add + modify), translated to StemmaCommitFile shape. */
  files: ReadonlyArray<{
    path: string;
    content: Uint8Array;
    mode: "100644" | "100755";
  }>;
  deletePaths: ReadonlyArray<string>;
}

/**
 * Validate the POST /commits body. Returns either a normalized payload
 * ready to hand to the adapter, or a structured error envelope reason.
 *
 * Tight validation here means the adapter never sees malformed paths,
 * negative-length contents, or duplicate fileChange entries — failure
 * modes downstream get strictly easier to reason about.
 */
export function validateCommitBody(
  body: unknown,
):
  | { kind: "ok" } & ValidatedCommitBody
  | {
      kind: "invalid";
      errorName:
        | "CodeRepos:InvalidSettings"
        | "CodeRepos:EmptyChangeSet"
        | "CodeRepos:InvalidPath";
      parameters: Record<string, unknown>;
    } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      kind: "invalid",
      errorName: "CodeRepos:InvalidSettings",
      parameters: { reason: "body must be a JSON object" },
    };
  }
  const b = body as Record<string, unknown>;

  const message = typeof b.message === "string" ? b.message : "";
  if (message.length === 0) {
    return {
      kind: "invalid",
      errorName: "CodeRepos:InvalidSettings",
      parameters: { field: "message", reason: "required" },
    };
  }
  if (Buffer.byteLength(message, "utf8") > COMMIT_MAX_MESSAGE_BYTES) {
    return {
      kind: "invalid",
      errorName: "CodeRepos:InvalidSettings",
      parameters: { field: "message", reason: "too long", maxBytes: COMMIT_MAX_MESSAGE_BYTES },
    };
  }

  const fileChanges = b.fileChanges;
  if (!Array.isArray(fileChanges)) {
    return {
      kind: "invalid",
      errorName: "CodeRepos:InvalidSettings",
      parameters: { field: "fileChanges", reason: "must be an array" },
    };
  }
  if (fileChanges.length === 0) {
    return {
      kind: "invalid",
      errorName: "CodeRepos:EmptyChangeSet",
      parameters: { reason: "fileChanges is empty" },
    };
  }
  if (fileChanges.length > COMMIT_MAX_FILE_CHANGES) {
    return {
      kind: "invalid",
      errorName: "CodeRepos:InvalidSettings",
      parameters: { field: "fileChanges", reason: "too many", max: COMMIT_MAX_FILE_CHANGES },
    };
  }

  const seenPaths = new Set<string>();
  const upserts: Array<{ path: string; content: Uint8Array; mode: "100644" | "100755" }> = [];
  const deletes: string[] = [];
  let totalBytes = 0;

  for (let i = 0; i < fileChanges.length; i++) {
    const c = fileChanges[i];
    if (typeof c !== "object" || c === null || Array.isArray(c)) {
      return {
        kind: "invalid",
        errorName: "CodeRepos:InvalidSettings",
        parameters: { field: `fileChanges[${i}]`, reason: "must be an object" },
      };
    }
    const cc = c as Record<string, unknown>;
    const path = typeof cc.path === "string" ? cc.path : "";
    const op = typeof cc.op === "string" ? cc.op : "";

    const pathV = validateRelativePath(path);
    if (!pathV.ok) {
      return {
        kind: "invalid",
        errorName: "CodeRepos:InvalidPath",
        parameters: { index: i, path, reason: pathV.reason },
      };
    }
    const normalizedPath = pathV.value.normalized;
    if (normalizedPath === "") {
      return {
        kind: "invalid",
        errorName: "CodeRepos:InvalidPath",
        parameters: { index: i, reason: "empty after normalization" },
      };
    }
    if (seenPaths.has(normalizedPath)) {
      return {
        kind: "invalid",
        errorName: "CodeRepos:InvalidSettings",
        parameters: {
          field: `fileChanges[${i}].path`,
          reason: "duplicate path in same commit",
          path: normalizedPath,
        },
      };
    }
    seenPaths.add(normalizedPath);

    if (op !== "add" && op !== "modify" && op !== "delete") {
      return {
        kind: "invalid",
        errorName: "CodeRepos:InvalidSettings",
        parameters: {
          field: `fileChanges[${i}].op`,
          reason: 'must be "add" | "modify" | "delete"',
          got: op,
        },
      };
    }

    if (op === "delete") {
      if (cc.contentBase64 !== undefined) {
        return {
          kind: "invalid",
          errorName: "CodeRepos:InvalidSettings",
          parameters: {
            field: `fileChanges[${i}].contentBase64`,
            reason: "must be omitted when op=delete",
          },
        };
      }
      deletes.push(normalizedPath);
      continue;
    }

    // op === "add" | "modify" — contentBase64 required.
    if (typeof cc.contentBase64 !== "string") {
      return {
        kind: "invalid",
        errorName: "CodeRepos:InvalidSettings",
        parameters: {
          field: `fileChanges[${i}].contentBase64`,
          reason: "required for add/modify",
        },
      };
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(cc.contentBase64, "base64");
      // Buffer.from with mode "base64" silently drops invalid chars; round-trip
      // and compare lengths to detect malformed input. (`Buffer.from(x, 'base64')
      // .toString('base64')` re-canonicalizes; we check decoded length instead
      // to catch over-padded inputs.)
      const reencoded = buf.toString("base64").replace(/=+$/, "");
      const supplied = cc.contentBase64.replace(/=+$/, "").replace(/\s+/g, "");
      if (reencoded !== supplied) {
        return {
          kind: "invalid",
          errorName: "CodeRepos:InvalidSettings",
          parameters: {
            field: `fileChanges[${i}].contentBase64`,
            reason: "not valid base64",
          },
        };
      }
    } catch {
      return {
        kind: "invalid",
        errorName: "CodeRepos:InvalidSettings",
        parameters: {
          field: `fileChanges[${i}].contentBase64`,
          reason: "not valid base64",
        },
      };
    }
    const mode = cc.mode === "100755" ? "100755" : "100644";
    totalBytes += buf.byteLength;
    if (totalBytes > COMMIT_MAX_TOTAL_BYTES) {
      return {
        kind: "invalid",
        errorName: "CodeRepos:InvalidSettings",
        parameters: {
          field: "fileChanges",
          reason: "total payload exceeds limit",
          maxBytes: COMMIT_MAX_TOTAL_BYTES,
        },
      };
    }
    upserts.push({
      path: normalizedPath,
      content: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      mode,
    });
  }

  return {
    kind: "ok",
    message,
    files: upserts,
    deletePaths: deletes,
  };
}
