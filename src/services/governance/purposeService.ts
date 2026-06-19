// ---------------------------------------------------------------------------
// Purpose service — FOUNDRY-GAPS §8 (purpose-based access control).
//
// Foundry-style: access to GOVERNED data is gated by a DECLARED purpose.
// A purpose is an ontology-scoped object (access_purpose) listing the
// read-audit categories it may exercise; principals are attached via
// purpose_grant (user|group, soft-revoked). The purposeGate middleware
// calls checkPurpose() and, on success, the declared purpose api_name is
// stamped into the read-audit row (see src/middleware/purposeGate.ts +
// src/middleware/readAudit.ts).
//
// Decision logic is split out as a PURE function (evaluatePurpose) so unit
// tests exercise every denial reason without a database.
// ---------------------------------------------------------------------------

import { query } from "../../db";
import { AppError } from "../../utils/foundryAppError";
import type { ReadCategory } from "../../middleware/readAudit";

// ---------------------------------------------------------------------------
// Typed error codes (all 403 — the caller IS authenticated; what is missing
// is a valid declared purpose, which is an authorization concern).
// ---------------------------------------------------------------------------
export const PURPOSE_REQUIRED = "PURPOSE_REQUIRED";
export const PURPOSE_UNKNOWN = "PURPOSE_UNKNOWN";
export const PURPOSE_NOT_GRANTED = "PURPOSE_NOT_GRANTED";
export const PURPOSE_EXPIRED = "PURPOSE_EXPIRED";
export const PURPOSE_CATEGORY_DENIED = "PURPOSE_CATEGORY_DENIED";

export type PurposeDenialCode =
  | typeof PURPOSE_REQUIRED
  | typeof PURPOSE_UNKNOWN
  | typeof PURPOSE_NOT_GRANTED
  | typeof PURPOSE_EXPIRED
  | typeof PURPOSE_CATEGORY_DENIED;

export function purposeError(code: PurposeDenialCode, message: string): AppError {
  return new AppError(message, 403, code);
}

export const VALID_CATEGORIES: ReadCategory[] = [
  "object.read",
  "object.search",
  "object.search_around",
  "object.traverse",
  "link.list",
];

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------
export interface AccessPurposeRow {
  id: string;
  ontology_id: string;
  api_name: string;
  display_name: string;
  description: string | null;
  allowed_categories: string[];
  expires_at: string | Date | null;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
  archived_at: string | Date | null;
}

export interface PurposeGrantRow {
  id: string;
  purpose_id: string;
  principal_id: string;
  principal_type: "user" | "group";
  granted_by: string;
  granted_at: string | Date;
  revoked_at: string | Date | null;
}

export interface CheckPurposeInput {
  principalId: string;
  groups: string[];
  purposeApiName: string | null | undefined;
  category: ReadCategory;
  ontologyId: string;
}

export interface PurposeDecision {
  allowed: boolean;
  /** Denial code when allowed=false; undefined when allowed. */
  code?: PurposeDenialCode;
  reason: string;
  /** The matched purpose (allowed=true only) — what the audit row records. */
  purpose?: { id: string; apiName: string };
}

// ---------------------------------------------------------------------------
// Pure decision core — no I/O. `purpose` is the access_purpose row (or null
// when no row matched the api_name in this ontology); `activeGrants` are the
// caller's UNREVOKED grants on that purpose.
// ---------------------------------------------------------------------------
export function evaluatePurpose(args: {
  purposeApiName: string | null | undefined;
  purpose: AccessPurposeRow | null;
  activeGrants: Pick<PurposeGrantRow, "principal_id" | "principal_type">[];
  category: ReadCategory;
  now?: Date;
}): PurposeDecision {
  const { purposeApiName, purpose, activeGrants, category } = args;
  const now = args.now ?? new Date();

  if (!purposeApiName || purposeApiName.trim() === "") {
    return {
      allowed: false,
      code: PURPOSE_REQUIRED,
      reason:
        "This resource is governed: declare a purpose via the X-Tellus-Purpose header.",
    };
  }

  if (!purpose || purpose.archived_at !== null) {
    return {
      allowed: false,
      code: PURPOSE_UNKNOWN,
      reason: `Purpose '${purposeApiName}' does not exist (or is archived) in this ontology.`,
    };
  }

  if (purpose.expires_at !== null && new Date(purpose.expires_at) <= now) {
    return {
      allowed: false,
      code: PURPOSE_EXPIRED,
      reason: `Purpose '${purposeApiName}' expired at ${new Date(purpose.expires_at).toISOString()}.`,
    };
  }

  if (activeGrants.length === 0) {
    return {
      allowed: false,
      code: PURPOSE_NOT_GRANTED,
      reason: `You hold no active grant on purpose '${purposeApiName}'.`,
    };
  }

  if (!purpose.allowed_categories.includes(category)) {
    return {
      allowed: false,
      code: PURPOSE_CATEGORY_DENIED,
      reason: `Purpose '${purposeApiName}' does not authorize category '${category}'.`,
    };
  }

  return {
    allowed: true,
    reason: "ok",
    purpose: { id: purpose.id, apiName: purpose.api_name },
  };
}

// ---------------------------------------------------------------------------
// checkPurpose — DB-backed wrapper around evaluatePurpose.
// ---------------------------------------------------------------------------
export async function checkPurpose(input: CheckPurposeInput): Promise<PurposeDecision> {
  const { principalId, groups, purposeApiName, category, ontologyId } = input;

  // Header absent → no lookups needed.
  if (!purposeApiName || purposeApiName.trim() === "") {
    return evaluatePurpose({ purposeApiName, purpose: null, activeGrants: [], category });
  }

  const purposeRes = await query(
    `SELECT * FROM access_purpose
      WHERE ontology_id = $1 AND api_name = $2 AND archived_at IS NULL`,
    [ontologyId, purposeApiName]
  );
  const purpose = (purposeRes.rows[0] as AccessPurposeRow | undefined) ?? null;

  let activeGrants: PurposeGrantRow[] = [];
  if (purpose) {
    const grantRes = await query(
      `SELECT * FROM purpose_grant
        WHERE purpose_id = $1
          AND revoked_at IS NULL
          AND (
            (principal_type = 'user'  AND principal_id = $2)
            OR (principal_type = 'group' AND principal_id = ANY($3::text[]))
          )`,
      [purpose.id, principalId, groups]
    );
    activeGrants = grantRes.rows as PurposeGrantRow[];
  }

  return evaluatePurpose({ purposeApiName, purpose, activeGrants, category });
}

// ---------------------------------------------------------------------------
// CRUD — purposes
// ---------------------------------------------------------------------------
export interface CreatePurposeInput {
  ontologyId: string;
  apiName: string;
  displayName: string;
  description?: string | null;
  allowedCategories?: string[];
  expiresAt?: string | null;
  createdBy: string;
}

export function validateCategories(categories: unknown): string | null {
  if (!Array.isArray(categories)) return "allowedCategories must be an array.";
  for (const c of categories) {
    if (!VALID_CATEGORIES.includes(c as ReadCategory)) {
      return `'${String(c)}' is not a read-audit category. Valid: ${VALID_CATEGORIES.join(", ")}.`;
    }
  }
  return null;
}

export async function createPurpose(input: CreatePurposeInput): Promise<AccessPurposeRow> {
  const categories = input.allowedCategories ?? [];
  const invalid = validateCategories(categories);
  if (invalid) throw new AppError(invalid, 400, "VALIDATION_ERROR");

  const existing = await query(
    `SELECT id FROM access_purpose WHERE ontology_id = $1 AND api_name = $2`,
    [input.ontologyId, input.apiName]
  );
  if ((existing.rowCount ?? 0) > 0) {
    throw new AppError(
      `Purpose '${input.apiName}' already exists in this ontology.`,
      409,
      "API_NAME_CONFLICT"
    );
  }

  const res = await query(
    `INSERT INTO access_purpose
       (ontology_id, api_name, display_name, description, allowed_categories, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.ontologyId,
      input.apiName,
      input.displayName,
      input.description ?? null,
      categories,
      input.expiresAt ?? null,
      input.createdBy,
    ]
  );
  return res.rows[0] as AccessPurposeRow;
}

export async function listPurposes(ontologyId: string): Promise<AccessPurposeRow[]> {
  const res = await query(
    `SELECT * FROM access_purpose
      WHERE ontology_id = $1 AND archived_at IS NULL
      ORDER BY created_at ASC`,
    [ontologyId]
  );
  return res.rows as AccessPurposeRow[];
}

export async function getPurpose(
  ontologyId: string,
  apiName: string
): Promise<AccessPurposeRow | null> {
  const res = await query(
    `SELECT * FROM access_purpose
      WHERE ontology_id = $1 AND api_name = $2 AND archived_at IS NULL`,
    [ontologyId, apiName]
  );
  return (res.rows[0] as AccessPurposeRow | undefined) ?? null;
}

export async function updatePurpose(
  ontologyId: string,
  apiName: string,
  patch: {
    displayName?: string;
    description?: string | null;
    allowedCategories?: string[];
    expiresAt?: string | null;
  }
): Promise<AccessPurposeRow | null> {
  if (patch.allowedCategories !== undefined) {
    const invalid = validateCategories(patch.allowedCategories);
    if (invalid) throw new AppError(invalid, 400, "VALIDATION_ERROR");
  }
  const res = await query(
    `UPDATE access_purpose SET
       display_name       = COALESCE($3, display_name),
       description        = CASE WHEN $4 THEN $5 ELSE description END,
       allowed_categories = COALESCE($6, allowed_categories),
       expires_at         = CASE WHEN $7 THEN $8::timestamptz ELSE expires_at END,
       updated_at         = now()
     WHERE ontology_id = $1 AND api_name = $2 AND archived_at IS NULL
     RETURNING *`,
    [
      ontologyId,
      apiName,
      patch.displayName ?? null,
      patch.description !== undefined,
      patch.description ?? null,
      patch.allowedCategories ?? null,
      patch.expiresAt !== undefined,
      patch.expiresAt ?? null,
    ]
  );
  return (res.rows[0] as AccessPurposeRow | undefined) ?? null;
}

/** Soft-archive: the purpose stops authorizing, but history is preserved. */
export async function archivePurpose(
  ontologyId: string,
  apiName: string
): Promise<boolean> {
  const res = await query(
    `UPDATE access_purpose SET archived_at = now(), updated_at = now()
      WHERE ontology_id = $1 AND api_name = $2 AND archived_at IS NULL`,
    [ontologyId, apiName]
  );
  return (res.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------
export async function grantPurpose(args: {
  purposeId: string;
  principalId: string;
  principalType: "user" | "group";
  grantedBy: string;
}): Promise<PurposeGrantRow> {
  if (args.principalType !== "user" && args.principalType !== "group") {
    throw new AppError(
      "principalType must be 'user' or 'group'.",
      400,
      "VALIDATION_ERROR"
    );
  }
  const res = await query(
    `INSERT INTO purpose_grant (purpose_id, principal_id, principal_type, granted_by)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [args.purposeId, args.principalId, args.principalType, args.grantedBy]
  );
  return res.rows[0] as PurposeGrantRow;
}

export async function listGrants(purposeId: string): Promise<PurposeGrantRow[]> {
  const res = await query(
    `SELECT * FROM purpose_grant
      WHERE purpose_id = $1 AND revoked_at IS NULL
      ORDER BY granted_at ASC`,
    [purposeId]
  );
  return res.rows as PurposeGrantRow[];
}

/** Soft-revoke a grant. Returns false when the grant was not active. */
export async function revokeGrant(purposeId: string, grantId: string): Promise<boolean> {
  const res = await query(
    `UPDATE purpose_grant SET revoked_at = now()
      WHERE id = $1 AND purpose_id = $2 AND revoked_at IS NULL`,
    [grantId, purposeId]
  );
  return (res.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Governed check — is this object type purpose-governed?
// ---------------------------------------------------------------------------
export async function isObjectTypeGoverned(
  ontologyId: string,
  objectTypeApiName: string
): Promise<boolean> {
  const res = await query(
    `SELECT governed_purpose_required FROM object_type
      WHERE ontology_id = $1 AND api_name = $2`,
    [ontologyId, objectTypeApiName]
  );
  return res.rows[0]?.governed_purpose_required === true;
}
