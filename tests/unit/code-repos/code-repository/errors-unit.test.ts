// ---------------------------------------------------------------------------
// B2 — CodeRepos error envelopes unit tests.
//
// Spec contracts proven:
//   B2-C-30  CodeRepos:NameConflict          → 409, FAILED_PRECONDITION
//   B2-C-31  CodeRepos:TemplateNotFound      → 404, NOT_FOUND
//   B2-C-32  CodeRepos:TemplateInitFailed    → 500, INTERNAL
//   B2-C-33  CodeRepos:ParentFolderNotFound  → 404, NOT_FOUND
//   B2-C-34  CodeRepos:InvalidSettings       → 400, INVALID_ARGUMENT
//   B2-C-35  CodeRepos:RepositoryArchived    → 412, FAILED_PRECONDITION
//   G-C-12  envelope shape (errorName, errorCode, errorInstanceId, parameters?)
//   G-C-15  envelope errorName matches §1.6 regex
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  CODE_REPOS_ERROR_NAMES,
  CODE_REPOS_ERROR_STATUS,
  codeReposError,
  isCodeReposErrorName,
  type CodeReposErrorName,
} from "../../../../src/services/codeRepository/errors";
import {
  ERROR_CODES,
  ERROR_NAME_REGEX,
} from "../../../../src/services/codeRepos/contracts/errors";

const SPEC_MANDATED: ReadonlyArray<
  [CodeReposErrorName, number, (typeof ERROR_CODES)[keyof typeof ERROR_CODES]]
> = [
  ["CodeRepos:NameConflict", 409, ERROR_CODES.FAILED_PRECONDITION],
  ["CodeRepos:TemplateNotFound", 404, ERROR_CODES.NOT_FOUND],
  ["CodeRepos:TemplateInitFailed", 500, ERROR_CODES.INTERNAL],
  ["CodeRepos:ParentFolderNotFound", 404, ERROR_CODES.NOT_FOUND],
  ["CodeRepos:InvalidSettings", 400, ERROR_CODES.INVALID_ARGUMENT],
  ["CodeRepos:RepositoryArchived", 412, ERROR_CODES.FAILED_PRECONDITION],
];

describe("B2 — error catalog completeness", () => {
  it.each(SPEC_MANDATED)(
    "B2-C-30..35: %s → status=%i errorCode=%s",
    (name, status, code) => {
      const cat = CODE_REPOS_ERROR_STATUS[name];
      expect(cat).toBeDefined();
      expect(cat.status).toBe(status);
      expect(cat.errorCode).toBe(code);
    },
  );

  it("includes the 4 cross-cutting envelopes (G-C-08, G-C-09, G-C-13)", () => {
    expect(CODE_REPOS_ERROR_STATUS["CodeRepos:Unauthenticated"]?.status).toBe(
      401,
    );
    expect(
      CODE_REPOS_ERROR_STATUS["CodeRepos:RepositoryNotFound"]?.status,
    ).toBe(404);
    expect(
      CODE_REPOS_ERROR_STATUS["CodeRepos:PermissionDenied"]?.status,
    ).toBe(403);
    expect(CODE_REPOS_ERROR_STATUS["CodeRepos:Internal"]?.status).toBe(500);
  });

  it("CODE_REPOS_ERROR_NAMES enumerates exactly 27 names", () => {
    // 6 spec-mandated (B2-C-30..35) + 4 cross-cutting (G-C-08/09/13)
    // + 6 read-path (B2-C-10/11: InvalidPath, InvalidDepth, BranchNotFound,
    // FileNotFound, InvalidPathType, RateLimited)
    // + 3 commit-path (F4 deferral: StaleRefHead, EmptyChangeSet, CommitFailed)
    // + 2 imports-route B4-C-10/11 (InvalidImportsBody, StaleImportsState)
    // + 6 function-invoke (FunctionNotFound, RuntimeNotSupported,
    // FunctionCompileError, FunctionRuntimeError, FunctionTimeout, InvalidArgumentBody)
    // = 27 total
    expect(CODE_REPOS_ERROR_NAMES.length).toBe(27);
  });

  it("every error name matches the §1.6 ERROR_NAME_REGEX", () => {
    for (const name of CODE_REPOS_ERROR_NAMES) {
      expect(ERROR_NAME_REGEX.test(name)).toBe(true);
    }
  });
});

describe("B2 — codeReposError() envelope shape", () => {
  it("returns {status, envelope} with envelope conforming to §1.3", () => {
    const r = codeReposError("CodeRepos:NameConflict", {
      displayName: "foo",
      parentFolderRid: "ri.compass.main.folder.0123",
    });
    expect(r.status).toBe(409);
    expect(r.envelope.errorCode).toBe("FAILED_PRECONDITION");
    expect(r.envelope.errorName).toBe("CodeRepos:NameConflict");
    expect(typeof r.envelope.errorInstanceId).toBe("string");
    expect(r.envelope.errorInstanceId.length).toBeGreaterThan(0);
    expect(r.envelope.parameters).toEqual({
      displayName: "foo",
      parentFolderRid: "ri.compass.main.folder.0123",
    });
  });

  it("envelope has exactly 4 keys (no extra fields)", () => {
    const r = codeReposError("CodeRepos:Internal", { x: 1 });
    expect(Object.keys(r.envelope).sort()).toEqual([
      "errorCode",
      "errorInstanceId",
      "errorName",
      "parameters",
    ]);
  });

  it("envelope always includes 'parameters' (G-C-12: exactly 4 keys), empty {} when none provided", () => {
    const r = codeReposError("CodeRepos:RepositoryArchived");
    expect("parameters" in r.envelope).toBe(true);
    expect(r.envelope.parameters).toEqual({});
  });

  it("custom errorInstanceId is preserved", () => {
    const r = codeReposError(
      "CodeRepos:NameConflict",
      undefined,
      "fixed-instance-id-1234",
    );
    expect(r.envelope.errorInstanceId).toBe("fixed-instance-id-1234");
  });
});

describe("B2 — isCodeReposErrorName() type guard", () => {
  it("accepts every catalog name", () => {
    for (const n of CODE_REPOS_ERROR_NAMES) {
      expect(isCodeReposErrorName(n)).toBe(true);
    }
  });

  it("rejects unknown names", () => {
    expect(isCodeReposErrorName("CodeRepos:Bogus")).toBe(false);
    expect(isCodeReposErrorName("Stemma:RefUpdateRejected")).toBe(false);
    expect(isCodeReposErrorName("")).toBe(false);
    expect(isCodeReposErrorName("CODEREPOS:NAME_CONFLICT")).toBe(false);
  });
});

describe("B2 — error envelope status determinism", () => {
  it("same errorName always yields same status (no collisions)", () => {
    for (const name of CODE_REPOS_ERROR_NAMES) {
      const r1 = codeReposError(name);
      const r2 = codeReposError(name);
      expect(r1.status).toBe(r2.status);
      expect(r1.envelope.errorCode).toBe(r2.envelope.errorCode);
    }
  });
});
