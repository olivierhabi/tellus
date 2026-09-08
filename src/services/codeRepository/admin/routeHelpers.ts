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
