// ---------------------------------------------------------------------------
// Shared helpers for the code-repository admin routers.
//
// Extracted from admin/routes.ts (god-file breakup): the error-envelope
// sender, principal helpers, ETag/SHA parsers, branch-name grammar, the
// B4 resource-imports validators, the B2-C-12 commit validators, the
// create/patch body validators, the repo row projector, the functions
// listing signature normalizers, and the invoke-path ObjectSet unwrapper.
//
// All pure except `sendError` (writes the Express response). No DB, no
// adapters — unit-testable in isolation.
// ---------------------------------------------------------------------------

import type { Response } from "express";
import { createHash } from "node:crypto";
import { ERROR_CODES } from "../../codeRepos/contracts/errors";
import { isStructurallyRid } from "../../codeRepos/contracts/rid";
import { validateRelativePath } from "../stemma/path";
import { inspectTypeScriptV2Function } from "../../functionsPublish/service";
import type { FunctionType } from "../../functions/canonicalSignature";
import type { OntologySnapshot } from "../../functions/ontologyRuntime";

/** Wire shape for a function's input signature on the functions listing —
 * normalized from EITHER the publish-time manifest
 * (`manifest.signatures`, recorded by the functionsPublish worker) or a
 * live TS-AST inspection of the working-tree source (same canonical model —
 * functions/canonicalSignature.ts). `null` means "couldn't derive"
 * (unannotated params, legacy layout) → the FE falls back to the JSON tab.
 */
export interface ListingSignature {
  readonly parameters: ReadonlyArray<{
    readonly name: string;
    readonly position: number;
    readonly type: string;
    readonly typeModel: FunctionType;
    readonly optional: boolean;
    readonly hasDefault: boolean;
  }>;
  readonly output: string | null;
}

/** Defensive normalization of a persisted manifest signature record. */
export function toWireSignature(raw: unknown): ListingSignature | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as { parameters?: unknown; output?: unknown };
  if (!Array.isArray(rec.parameters)) return null;
  const parameters = rec.parameters
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p, i) => ({
      name: String(p.name ?? ""),
      position: typeof p.position === "number" ? p.position : i,
      type: String(p.type ?? ""),
      typeModel: (p.typeModel && typeof p.typeModel === "object"
        ? p.typeModel
        : { kind: "unsupported", typeText: String(p.type ?? "") }) as FunctionType,
      optional: Boolean(p.optional),
      hasDefault: Boolean(p.hasDefault),
    }));
  return {
    parameters,
    output: typeof rec.output === "string" ? rec.output : null,
  };
}

/** Derive the wire signature from live TypeScript source. Fail-open: any
 * shape that inspectTypeScriptV2Function rejects (no default export,
 * unannotated types) yields null so the FE shows its JSON-tab fallback
 * instead of a half-correct form. */
export function deriveSignatureFromSource(path: string, source: string): ListingSignature | null {
  try {
    const sig = inspectTypeScriptV2Function(path, source);
    return toWireSignature(sig);
  } catch {
    return null;
  }
}

/**
 * Unwrap a returned ObjectSet to its row array for the wire. Duck-typed (the
 * ObjectSet class is private to ontologyRuntime and worker results lose their
 * prototype crossing postMessage): the canonical serialized shape is exactly
 * `{ rows: Object[] }` — a genuine user value with that single-key shape is
 * not a supported return type risk (Palantir never uses `rows`; their object
 * collections are `data`-shaped).
 */
export function unwrapObjectSetRows(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const rec = v as Record<string, unknown>;
    if (Object.keys(rec).length === 1 && Array.isArray(rec.rows)) return rec.rows;
  }
  return v;
}

// Loose semver comparator used by the read aggregator at GET
// /:rid/functions. Splits on `.` and `-`, compares numeric parts numerically,
// non-numeric parts lexicographically. Sufficient for "pick the highest
// version" — B8's own ordering for plain MAJOR.MINOR.PATCH agrees. Pre-release
// strings (`-alpha.1`) sort lower than the same release without the suffix.
export function compareSemverLoose(a: string, b: string): number {
  const splitVersion = (v: string): readonly (number | string)[] => {
    const [release, pre] = v.split("-", 2);
    const releaseParts = release.split(".").map((p) => {
      const n = Number(p);
      return Number.isInteger(n) && p === String(n) ? n : p;
    });
    if (pre === undefined) return releaseParts;
    const preParts = pre.split(".").map((p) => {
      const n = Number(p);
      return Number.isInteger(n) && p === String(n) ? n : p;
    });
    return [...releaseParts, "-", ...preParts];
  };
  const aParts = splitVersion(a);
  const bParts = splitVersion(b);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const ap = aParts[i];
    const bp = bParts[i];
    // A release version is HIGHER than a pre-release of the same release.
    if (ap === undefined) return bp === "-" ? 1 : -1;
    if (bp === undefined) return ap === "-" ? -1 : 1;
    if (typeof ap === "number" && typeof bp === "number") {
      if (ap !== bp) return ap - bp;
    } else if (typeof ap === "string" && typeof bp === "string") {
      if (ap !== bp) return ap < bp ? -1 : 1;
    } else {
      // Numeric segment sorts higher than string segment at the same index.
      return typeof ap === "number" ? 1 : -1;
    }
  }
  return 0;
}

export function sendError(
  res: Response,
  err: { status: number; envelope: unknown },
): void {
  res.status(err.status).json(err.envelope);
}

export function isUuidV4(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

export function derivePrincipalSubUuid(userId: string): string {
  // Deterministic v4-shaped UUID for non-Keycloak principals (PAT, test mode).
  // Stable mapping: same userId -> same UUID across processes/restarts.
  // Layout: sha256(userId) hex, slice 32 hex digits, force version=4 and
  // variant=8|9|a|b at the spec-defined positions.
  const h = createHash("sha256").update(`code-repos:principal:${userId}`).digest("hex");
  const seg1 = h.slice(0, 8);
  const seg2 = h.slice(8, 12);
  const seg3 = "4" + h.slice(13, 16);
  const variantNibble = (parseInt(h[16], 16) & 0x3) | 0x8;
  const seg4 = variantNibble.toString(16) + h.slice(17, 20);
  const seg5 = h.slice(20, 32);
  return `${seg1}-${seg2}-${seg3}-${seg4}-${seg5}`;
}

function parseEtag(s: string): number {
  // Accept W/"NN" or "NN".
  const m = s.match(/^(?:W\/)?"(\d+)"$/);
  if (!m) return Number.NaN;
  return parseInt(m[1], 10);
}

/**
 * Parse an `If-Match` resource-version ETag, returning `null` when the header
 * is present but unparseable (e.g. a bare token like `not-a-version`). Routes
 * must short-circuit to 400 on `null` BEFORE binding the value into a SQL
 * `bigint` parameter — otherwise `NaN` reaches Postgres and crashes the query
 * with "invalid input syntax for type bigint" (500). Fixes parity defect CR-11d.
 */
export function parseVersionEtagOrNull(s: string): number | null {
  const n = parseEtag(s);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * §G-C-13 branchName grammar — matches the PATCH /:rid validator. We want
 * to reject obviously bad inputs (NUL byte, empty string, leading dash,
 * `..`, `@{`, `\`) at the route layer BEFORE we hit the adapter — so the
 * adapter never sees pathological branch names.
 */
export function isLegalBranchName(s: unknown): s is string {
  if (typeof s !== "string") return false;
  if (s.length === 0 || s.length > 255) return false;
  if (!/^[a-zA-Z0-9._/-]{1,255}$/.test(s)) return false;
  if (s.startsWith("-") || s.startsWith("/")) return false;
  if (s.endsWith(".lock")) return false;
  if (s.includes("..") || s.includes("@{") || s.includes("\\")) return false;
  return true;
}

/** Wall-clock seconds since `t0`, where `t0 = process.hrtime.bigint()`. */
export function elapsedSeconds(t0: bigint): number {
  return Number(process.hrtime.bigint() - t0) / 1e9;
}

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

export interface RepoRow {
  rid: string;
  display_name: string;
  parent_folder_rid: string;
  project_rid: string;
  template_id: string;
  template_version: string;
  default_branch: string;
  settings_json: Record<string, unknown>;
  state: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  resource_version: number;
}

export function repoToResponse(row: RepoRow): Record<string, unknown> {
  return {
    rid: row.rid,
    displayName: row.display_name,
    parentFolderRid: row.parent_folder_rid,
    projectRid: row.project_rid,
    templateId: row.template_id,
    templateVersion: row.template_version,
    defaultBranch: row.default_branch,
    settings: row.settings_json,
    state: row.state,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resourceVersion: Number(row.resource_version),
  };
}

export interface ValidatedCreateBody {
  displayName: string;
  parentFolderRid: string;
  templateId: string;
  templateVersion: string;
  defaultBranch: string;
}

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

export interface CreateRepoBody {
  displayName?: unknown;
  parentFolderRid?: unknown;
  templateId?: unknown;
  templateVersion?: unknown;
  defaultBranch?: unknown;
}

export interface PatchRepoBody {
  displayName?: unknown;
  defaultBranch?: unknown;
}

export function validateCreateBody(
  body: CreateRepoBody,
):
  | { kind: "ok"; body: ValidatedCreateBody }
  | { kind: "invalid"; parameters: Record<string, unknown> } {
  if (typeof body.displayName !== "string" || body.displayName.length === 0 || body.displayName.length > 255) {
    return { kind: "invalid", parameters: { field: "displayName" } };
  }
  if (typeof body.parentFolderRid !== "string" || !isStructurallyRid(body.parentFolderRid)) {
    return { kind: "invalid", parameters: { field: "parentFolderRid" } };
  }
  if (typeof body.templateId !== "string" || body.templateId.length === 0) {
    return { kind: "invalid", parameters: { field: "templateId" } };
  }
  if (typeof body.templateVersion !== "string" || body.templateVersion.length === 0) {
    return { kind: "invalid", parameters: { field: "templateVersion" } };
  }
  const defaultBranch =
    typeof body.defaultBranch === "string" && body.defaultBranch.length > 0
      ? body.defaultBranch
      : "main";
  if (!/^[a-zA-Z0-9._/-]{1,255}$/.test(defaultBranch)) {
    return { kind: "invalid", parameters: { field: "defaultBranch" } };
  }
  // Suppress unused error code warning by exporting.
  void ERROR_CODES;
  return {
    kind: "ok",
    body: {
      displayName: body.displayName,
      parentFolderRid: body.parentFolderRid,
      templateId: body.templateId,
      templateVersion: body.templateVersion,
      defaultBranch,
    },
  };
}
