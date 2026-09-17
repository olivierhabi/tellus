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
  // -------------------------------------------------------------------------
  // B4 resource-imports route names (B4-C-10/11).
  //
  // InvalidImportsBody — PUT body is shape-valid JSON but fails semantic
  // validation (duplicate (kind, apiName), missing ontologyId, item count
  // beyond MAX_IMPORTS, etc.). 400 INVALID_ARGUMENT.
  //
  // StaleImportsState — If-Match ETag does not equal the current
  // content-derived ETag for the repository's import set. 412.
  // -------------------------------------------------------------------------
  "CodeRepos:InvalidImportsBody": {
    status: 400,
    errorCode: ERROR_CODES.INVALID_ARGUMENT,
  },
  "CodeRepos:StaleImportsState": {
    status: 412,
    errorCode: ERROR_CODES.FAILED_PRECONDITION,
  },
  // -------------------------------------------------------------------------
  // Function invoke (working-tree live-preview) error names. Backstop the
  // Live Preview tab in F7 / FunctionBrowser. B9 Live Preview Execution
  // Service is still BLOCKED; this set covers the sandboxed working-tree
  // executor we run inside the admin process today.
  //
  // FunctionNotFound — :apiName does not resolve to a working-tree source
  // file on the requested branch. 404 keeps it distinguishable from
  // BranchNotFound (the branch exists but has no function with that name).
  //
  // RuntimeNotSupported — file extension we cannot execute in the sandbox
  // (e.g. `.py` requires a Python runtime we do not host). 400 because the
  // client picked an executable; we surface the constraint rather than
  // silently no-op.
  //
  // FunctionCompileError — TS transpile or sandbox compile threw. 422
  // because the request is well-formed but the user's source code is not.
  //
  // FunctionRuntimeError — sandboxed invocation returned status="error".
  // The user's function threw at runtime; surface the error message and
  // logs so the IDE can render them.
  //
  // FunctionTimeout — sandboxed invocation exceeded `FUNCTION_TIMEOUT_MS`.
  // 504 because we want dashboards to alert separately from runtime errors.
  // -------------------------------------------------------------------------
  "CodeRepos:FunctionNotFound": {
    status: 404,
    errorCode: ERROR_CODES.NOT_FOUND,
  },
  "CodeRepos:RuntimeNotSupported": {
    status: 400,
    errorCode: ERROR_CODES.INVALID_ARGUMENT,
  },
  "CodeRepos:FunctionCompileError": {
    status: 422,
    errorCode: ERROR_CODES.INVALID_ARGUMENT,
  },
  // FunctionSourceRejected — source contains a sandbox escape probe pattern
  // (defense-in-depth scan; the runtime realm boundary already blocks the
  // escape class — this makes naive probes fail loudly at preview time). 422
  "CodeRepos:FunctionSourceRejected": {
    status: 422,
    errorCode: ERROR_CODES.INVALID_ARGUMENT,
  },
  "CodeRepos:FunctionRuntimeError": {
    status: 422,
    errorCode: ERROR_CODES.INVALID_ARGUMENT,
  },
  "CodeRepos:FunctionTimeout": {
    status: 504,
    errorCode: ERROR_CODES.INTERNAL,
  },
  // PublishedArtifactMissing — a function_version row is AVAILABLE but its
  // content-addressed bundle is absent from object storage (e.g. the object
  // store was rebuilt while Postgres metadata survived). 500 INTERNAL: the
  // inconsistency is server-side, not caller-caused. The `parameters.reason`
  // tells the user how to recover (republish). Individual missing versions
  // are skipped during resolution; this fires only when NO AVAILABLE version
  // of the function could be resolved.
  "CodeRepos:PublishedArtifactMissing": {
    status: 500,
    errorCode: ERROR_CODES.INTERNAL,
  },
  // -------------------------------------------------------------------------
  // InvalidArgumentBody — body.args is present but not a plain object.
  // The invoke contract is `{apiName, branch?, args?}` and `args` must be a
  // JSON-shaped object. A scalar or null surfaces as 422 (semantically:
  // body parsed fine but a field is logically invalid) so the IDE can tell
  // the user what's wrong with their input, instead of bubbling a sandbox
  // runtime error from `JSON.stringify(42)` later in the pipeline.
  // -------------------------------------------------------------------------
  "CodeRepos:InvalidArgumentBody": {
    status: 422,
    errorCode: ERROR_CODES.INVALID_ARGUMENT,
  },
  // -------------------------------------------------------------------------
  // Optimistic-concurrency on metadata mutations (PATCH/DELETE/PUT settings).
  //
  // PreconditionFailed — the client's `If-Match: W/"<resource_version>"` did
  // not equal the row's current resource_version (someone else mutated the
  // repo first). 412 per RFC 7232 §3.1 — distinct from InvalidSettings (400)
  // so a client can tell "your input was bad" apart from "you raced and lost"
  // and re-GET to obtain the fresh ETag. (Fixes parity defect CR-11b.)
  // -------------------------------------------------------------------------
  "CodeRepos:PreconditionFailed": {
    status: 412,
    errorCode: ERROR_CODES.FAILED_PRECONDITION,
  },
  // -------------------------------------------------------------------------
  // Tag & Release (repo → functions registry publish).
  //
  // NoFunctionsToPublish — the release tree has no discoverable functions
  // under src/functions/. 400 — releasing nothing is a client error.
  //
  // BackwardIncompatible — the new version drops a function that the prior
  // version exported (a breaking change) without a major-version bump. 409,
  // mirroring Foundry's pre-publish backward-compatibility check.
  //
  // VersionConflict — the (repo, branch, semver) already exists with a
  // different artifact (immutability). 409.
  //
  // ReleaseCompileError — a function file failed to transpile during the
  // build. 422 — the source is well-formed JSON-wise but not buildable.
  // -------------------------------------------------------------------------
  "CodeRepos:NoFunctionsToPublish": {
    status: 400,
    errorCode: ERROR_CODES.INVALID_ARGUMENT,
  },
  "CodeRepos:BackwardIncompatible": {
    status: 409,
    errorCode: ERROR_CODES.CONFLICT,
  },
  "CodeRepos:VersionConflict": {
    status: 409,
    errorCode: ERROR_CODES.CONFLICT,
  },
  // RunAlreadyActive — a functions-publish run is already QUEUED or
  // RUNNING for this (repository, branch); the client must wait for
  // it or cancel it before tagging another release. 409, mirroring
  // the Jemma:RunAlreadyActive retrigger contract.
  "CodeRepos:RunAlreadyActive": {
    status: 409,
    errorCode: ERROR_CODES.CONFLICT,
  },
  "CodeRepos:ReleaseCompileError": {
    status: 422,
    errorCode: ERROR_CODES.INVALID_ARGUMENT,
  },
  // -------------------------------------------------------------------------
  // Branch lifecycle (create/delete).
  //
  // BranchExists — POST /:rid/branches with a name that already exists. 409.
  // CannotModifyDefaultBranch — DELETE of the repo's default branch. 412 —
  //   the default branch is structurally required and cannot be removed.
  // -------------------------------------------------------------------------
  "CodeRepos:BranchExists": {
    status: 409,
    errorCode: ERROR_CODES.CONFLICT,
  },
  "CodeRepos:CannotModifyDefaultBranch": {
    status: 412,
    errorCode: ERROR_CODES.FAILED_PRECONDITION,
  },
  // -------------------------------------------------------------------------
  // Uncommitted drafts (104). Per-user, per-branch, pre-commit file drafts
  // (the Code Assistant propose_file flow + Monaco dirty buffers), persisted
  // backend-side so they survive across browsers — but NOT a git commit.
  //
  // DraftTooLarge — a single draft's content (or base_content snapshot)
  // exceeds the per-file 5 MiB cap. 413 RESOURCE_EXHAUSTED so the client can
  // tell "your file is too big" apart from a shape error.
  //
  // DraftLimitExceeded — a single PUT carries more than MAX_DRAFTS entries.
  // 400 — the request is shape-valid but semantically over the limit.
  // -------------------------------------------------------------------------
  "CodeRepos:DraftTooLarge": {
    status: 413,
    errorCode: ERROR_CODES.RESOURCE_EXHAUSTED,
  },
  "CodeRepos:DraftLimitExceeded": {
    status: 400,
    errorCode: ERROR_CODES.INVALID_ARGUMENT,
  },
  // -------------------------------------------------------------------------
  // Chat sessions (126). Per-user, per-repo persistent transcripts for the
  // Code Assistant panel. Errors mirror the drafts family:
  //
  // ChatSessionNotFound — GET/PUT/DELETE on a sessionId that does not exist
  // OR exists but belongs to a different principal (IDOR-as-404). 404.
  //
  // ChatSessionTooLarge — the request body (a session + its messages) exceeds
  // the soft cap; a single message's content exceeds the per-message cap; OR
  // the serialized metadata blob exceeds the per-message metadata cap. 413
  // RESOURCE_EXHAUSTED so the client can tell "your transcript is too big"
  // apart from a shape error.
  //
  // ChatSessionLimitExceeded — a user already has MAX_SESSIONS_PER_REPO saved
  // for this repo. 400 — the request is shape-valid but semantically over the
  // per-repo cap.
  // -------------------------------------------------------------------------
  "CodeRepos:ChatSessionNotFound": {
    status: 404,
    errorCode: ERROR_CODES.NOT_FOUND,
  },
  "CodeRepos:ChatSessionTooLarge": {
    status: 413,
    errorCode: ERROR_CODES.RESOURCE_EXHAUSTED,
  },
  "CodeRepos:ChatSessionLimitExceeded": {
    status: 400,
    errorCode: ERROR_CODES.INVALID_ARGUMENT,
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
 *   - 2 imports-route B4-C-10/11 (InvalidImportsBody, StaleImportsState)
 *   - 5 function-invoke (FunctionNotFound, RuntimeNotSupported,
 *     FunctionCompileError, FunctionRuntimeError, FunctionTimeout)
 * Useful for `it.each(...)` test patterns.
 */
export const CODE_REPOS_ERROR_NAMES: readonly CodeReposErrorName[] =
  Object.freeze(
    Object.keys(CODE_REPOS_ERROR_STATUS) as readonly CodeReposErrorName[],
  );
