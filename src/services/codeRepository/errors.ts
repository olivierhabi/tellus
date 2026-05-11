// ---------------------------------------------------------------------------
// B2 — Code Repository Service error envelopes.
//
// Six error names mandated by spec §B2 lines 306-313:
//   - CodeRepos:NameConflict          (409, FAILED_PRECONDITION)  B2-C-30
//   - CodeRepos:TemplateNotFound      (404, NOT_FOUND)            B2-C-31
//   - CodeRepos:TemplateInitFailed    (500, INTERNAL)             B2-C-32
//   - CodeRepos:ParentFolderNotFound  (404, NOT_FOUND)            B2-C-33
//   - CodeRepos:InvalidSettings       (400, INVALID_ARGUMENT)     B2-C-34
//   - CodeRepos:RepositoryArchived    (412, FAILED_PRECONDITION)  B2-C-35
//
// Plus the standard cross-cutting envelopes (each task may surface them):
//   - CodeRepos:RepositoryNotFound    (404, NOT_FOUND)            G-C-09
//   - CodeRepos:Unauthenticated       (401, UNAUTHENTICATED)      G-C-08
//   - CodeRepos:PermissionDenied      (403, PERMISSION_DENIED)    G-C-09
//   - CodeRepos:Internal              (500, INTERNAL)             G-C-13
//
// Every envelope conforms to §1.3 (errorCode, errorName, errorInstanceId,
// parameters?). All builders are pure — no I/O, no logging.
// ---------------------------------------------------------------------------

import {
  ERROR_CODES,
  buildEnvelope,
  type ErrorEnvelope,
  type ErrorCode,
} from "../codeRepos/contracts/errors";

// ---------------------------------------------------------------------------
// Error catalog: errorName → (httpStatus, errorCode).
// ---------------------------------------------------------------------------

export const CODE_REPOS_ERROR_STATUS: Readonly<
  Record<string, { readonly status: number; readonly errorCode: ErrorCode }>
> = Object.freeze({
  "CodeRepos:NameConflict": {
    status: 409,
    errorCode: ERROR_CODES.FAILED_PRECONDITION,
  },
  "CodeRepos:TemplateNotFound": {
    status: 404,
    errorCode: ERROR_CODES.NOT_FOUND,
  },
  "CodeRepos:TemplateInitFailed": {
    status: 500,
    errorCode: ERROR_CODES.INTERNAL,
  },
  "CodeRepos:ParentFolderNotFound": {
    status: 404,
    errorCode: ERROR_CODES.NOT_FOUND,
  },
  "CodeRepos:InvalidSettings": {
    status: 400,
    errorCode: ERROR_CODES.INVALID_ARGUMENT,
  },
  "CodeRepos:RepositoryArchived": {
    status: 412,
    errorCode: ERROR_CODES.FAILED_PRECONDITION,
  },
  "CodeRepos:RepositoryNotFound": {
    status: 404,
    errorCode: ERROR_CODES.NOT_FOUND,
  },
  "CodeRepos:Unauthenticated": {
    status: 401,
    errorCode: ERROR_CODES.UNAUTHENTICATED,
  },
  "CodeRepos:PermissionDenied": {
    status: 403,
    errorCode: ERROR_CODES.PERMISSION_DENIED,
  },
  "CodeRepos:Internal": {
    status: 500,
    errorCode: ERROR_CODES.INTERNAL,
  },
  // -------------------------------------------------------------------------
  // B2-C-10 / B2-C-11 read-path error names. Strict per route brief:
  // path-validation rejections are 400 INVALID_ARGUMENT; missing branch is
  // a 404 NOT_FOUND; missing file is 404 NOT_FOUND; "path is a tree, not a
  // blob" is also 404 with a distinct errorName so the client can branch
  // on `errorName === "CodeRepos:InvalidPathType"` rather than guess.
  // RateLimited maps to 429 RESOURCE_EXHAUSTED so dashboards joining on
  // errorCode group it with the existing `429` cohort.
  // -------------------------------------------------------------------------
  "CodeRepos:InvalidPath": {
    status: 400,
    errorCode: ERROR_CODES.INVALID_ARGUMENT,
  },
  "CodeRepos:InvalidDepth": {
    status: 400,
    errorCode: ERROR_CODES.INVALID_ARGUMENT,
  },
  "CodeRepos:BranchNotFound": {
    status: 404,
    errorCode: ERROR_CODES.NOT_FOUND,
  },
  "CodeRepos:FileNotFound": {
    status: 404,
    errorCode: ERROR_CODES.NOT_FOUND,
  },
  "CodeRepos:InvalidPathType": {
    status: 404,
    errorCode: ERROR_CODES.NOT_FOUND,
  },
  "CodeRepos:RateLimited": {
    status: 429,
    errorCode: ERROR_CODES.RESOURCE_EXHAUSTED,
  },
  // -------------------------------------------------------------------------
  // F4 commit-route error names (B2-C-12 commit endpoint).
  //
  // StaleRefHead — the client's `If-Match: <parentSha>` does not equal the
  // branch's current HEAD (per F4 spec line 957: "parentSha must equal
  // current HEAD"). 412 mirrors the rest of the optimistic-concurrency
  // family. The errorName is distinguishable so the IDE can route to F4's
  // "rebase prompt" UX rather than the generic settings-mismatch flow.
  //
  // EmptyChangeSet — POST /commits with `fileChanges: []`. 400 because the
  // request is shape-valid but semantically meaningless; we refuse rather
  // than silently fast-forward an empty commit (which would just rotate
  // the SHA without changing tree state — confusing for both users and
  // downstream branch-cache consumers).
  //
  // CommitFailed — Stemma adapter returned `transient`. 502 because the
  // failure is upstream of the route; bucketing it apart from 500 lets
  // dashboards distinguish adapter-induced failures from in-process bugs.
  // -------------------------------------------------------------------------
  "CodeRepos:StaleRefHead": {
    status: 412,
    errorCode: ERROR_CODES.FAILED_PRECONDITION,
  },
  "CodeRepos:EmptyChangeSet": {
    status: 400,
    errorCode: ERROR_CODES.INVALID_ARGUMENT,
  },
  "CodeRepos:CommitFailed": {
    status: 502,
    errorCode: ERROR_CODES.INTERNAL,
  },
});

export type CodeReposErrorName = keyof typeof CODE_REPOS_ERROR_STATUS;

// ---------------------------------------------------------------------------
// Builders.
// ---------------------------------------------------------------------------

/**
 * Build a CodeRepos error envelope. The errorName must be in the catalog;
 * a typo is a TypeScript compile error.
 *
 * `parameters` is sanitized by `buildEnvelope` (§1.3): no secrets, max 4 KB
 * canonical-JSON, no nested envelopes.
 */
export function codeReposError(
  errorName: CodeReposErrorName,
  parameters?: Record<string, unknown>,
  errorInstanceId?: string,
): {
  status: number;
  envelope: ErrorEnvelope;
} {
  const cat = CODE_REPOS_ERROR_STATUS[errorName];
  return {
    status: cat.status,
    envelope: buildEnvelope({
      errorName,
      errorCode: cat.errorCode,
      parameters,
      errorInstanceId,
    }),
  };
}

/**
 * Convenience: assert an arbitrary string is a known CodeRepos error name.
 * Useful at boundaries (test fixtures, audit deserialization).
 */
export function isCodeReposErrorName(s: string): s is CodeReposErrorName {
  return Object.prototype.hasOwnProperty.call(CODE_REPOS_ERROR_STATUS, s);
}

/**
 * The complete enumerated error name list:
 *   - 6 spec-mandated B2-C-30..35
 *   - 4 cross-cutting (G-C-08/09/13)
 *   - 6 read-path B2-C-10/11 (InvalidPath, InvalidDepth, BranchNotFound,
 *     FileNotFound, InvalidPathType, RateLimited)
 *   - 3 commit-route B2-C-12 (StaleRefHead, EmptyChangeSet, CommitFailed)
 * Useful for `it.each(...)` test patterns.
 */
export const CODE_REPOS_ERROR_NAMES: readonly CodeReposErrorName[] =
  Object.freeze(
    Object.keys(CODE_REPOS_ERROR_STATUS) as readonly CodeReposErrorName[],
  );
