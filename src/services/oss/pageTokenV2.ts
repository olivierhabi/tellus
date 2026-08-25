// ---------------------------------------------------------------------------
// V2 page tokens — integrity-protected, query-bound (Phase 4)
//
// Unlike the legacy v1 token (base64 JSON, where-hash only), the v2
// token is HMAC-signed and binds:
//   ontology · branch · object-set fingerprint · orderBy ·
//   per-object-type search_after cursors
//
// Any mismatch (tampering, cross-query reuse, cross-tenant replay
// with a different secret) is rejected with a typed v2 error.
// ---------------------------------------------------------------------------

import { createHmac, timingSafeEqual } from "node:crypto";

export class PageTokenError extends Error {
  constructor(
    public readonly errorName: string,
    message: string,
    public readonly parameters: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PageTokenError";
  }
}

const TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function secret(): string {
  // Dev default mirrors other Tellus dev secrets; production MUST
  // set TELLUS_PAGE_TOKEN_SECRET (documented in .env.example).
  return process.env.TELLUS_PAGE_TOKEN_SECRET ?? "tellus-dev-page-token-secret";
}

export interface PageTokenPayloadV2 {
  ontologyRid: string;
  branchRid: string | null;
  fingerprint: string;
  /** Full request/context binding (selection, ordering, snapshot, tenant). */
  requestFingerprint?: string;
  tenant?: string;
  transactionId?: string | null;
  transactionVersion?: number | null;
  scenarioRid?: string | null;
  scenarioVersion?: number | null;
  orderBy: unknown;
  /** per-object-type search_after cursors (single-type sets: one). */
  cursors: Record<string, unknown[]>;
  /** Per-index OpenSearch PIT identifiers for snapshot paging. */
  pitIds?: Record<string, string>;
  created: number;
}

function sign(bodyB64: string): string {
  return createHmac("sha256", secret()).update(bodyB64).digest("base64url");
}

export function createPageTokenV2(payload: Omit<PageTokenPayloadV2, "created">): string {
  const full: PageTokenPayloadV2 = { ...payload, created: Date.now() };
  const bodyB64 = Buffer.from(JSON.stringify(full), "utf8").toString("base64url");
  return `${bodyB64}.${sign(bodyB64)}`;
}

export function decodePageTokenV2(
  token: string,
  expected: {
    ontologyRid: string;
    branchRid: string | null;
    fingerprint: string;
    requestFingerprint?: string;
    tenant?: string;
    transactionId?: string | null;
    transactionVersion?: number | null;
    scenarioRid?: string | null;
    scenarioVersion?: number | null;
  },
): PageTokenPayloadV2 {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) {
    throw new PageTokenError("InvalidPageToken", "Invalid page token format.");
  }
  const bodyB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expectedSig = sign(bodyB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new PageTokenError(
      "InvalidPageToken",
      "Page token failed integrity validation.",
    );
  }
  let payload: PageTokenPayloadV2;
  try {
    payload = JSON.parse(Buffer.from(bodyB64, "base64url").toString("utf8"));
  } catch {
    throw new PageTokenError("InvalidPageToken", "Invalid page token format.");
  }
  if (payload.ontologyRid !== expected.ontologyRid) {
    throw new PageTokenError(
      "InvalidPageToken",
      "Page token was created for a different ontology.",
    );
  }
  if ((payload.branchRid ?? null) !== expected.branchRid) {
    throw new PageTokenError(
      "InvalidPageToken",
      "Page token was created for a different branch.",
    );
  }
  if (payload.fingerprint !== expected.fingerprint) {
    throw new PageTokenError(
      "InvalidPageToken",
      "Page token is from a different object set. Start pagination from the beginning.",
    );
  }
  if (
    expected.requestFingerprint !== undefined &&
    payload.requestFingerprint !== expected.requestFingerprint
  ) {
    throw new PageTokenError(
      "InvalidPageToken",
      "Page token was created for different request options.",
    );
  }
  if (
    expected.transactionVersion !== undefined &&
    (payload.transactionVersion ?? null) !== expected.transactionVersion
  ) {
    throw new PageTokenError(
      "InvalidPageToken",
      "Page token was created for a different transaction version.",
    );
  }
  if (expected.tenant !== undefined && payload.tenant !== expected.tenant) {
    throw new PageTokenError(
      "InvalidPageToken",
      "Page token was created for a different tenant.",
    );
  }
  if (
    expected.transactionId !== undefined &&
    (payload.transactionId ?? null) !== expected.transactionId
  ) {
    throw new PageTokenError(
      "InvalidPageToken",
      "Page token was created for a different transaction.",
    );
  }
  if (
    expected.scenarioVersion !== undefined &&
    (payload.scenarioVersion ?? null) !== expected.scenarioVersion
  ) {
    throw new PageTokenError(
      "InvalidPageToken",
      "Page token was created for a different scenario version.",
    );
  }
  if (
    expected.scenarioRid !== undefined &&
    (payload.scenarioRid ?? null) !== expected.scenarioRid
  ) {
    throw new PageTokenError(
      "InvalidPageToken",
      "Page token was created for a different scenario.",
    );
  }
  if (Date.now() - payload.created > TOKEN_MAX_AGE_MS) {
    throw new PageTokenError(
      "InvalidPageToken",
      "Page token has expired. Start pagination from the beginning.",
    );
  }
  if (!payload.cursors || typeof payload.cursors !== "object") {
    throw new PageTokenError("InvalidPageToken", "Page token missing cursors.");
  }
  return payload;
}
