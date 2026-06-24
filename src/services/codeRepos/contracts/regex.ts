// ---------------------------------------------------------------------------
// Code Repositories — Global Field Validation
//
// Spec: tasks/code-repository/code-repository-tasks.md §1.6 (lines 84-90).
// Contract IDs covered:
//   G-C-27  apiName regex
//   G-C-28  apiName reserved words
//   G-C-29  branchName regex + structural rules
//   G-C-30  tagName regex (branchName rules + semver)
//   G-C-31  repositoryName regex
//   G-C-32  filePath constraints
//
// IMPORTANT: these are pure functions returning {ok, reason?}. They do NOT
// throw. Routes wrap them in InvalidParameterError / errorHandler.
// ---------------------------------------------------------------------------

/** Result of a validator. */
export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

const ok: ValidationResult = { ok: true };
const fail = (reason: string): ValidationResult => ({ ok: false, reason });

// ---------------------------------------------------------------------------
// G-C-27, G-C-28 — apiName
// ---------------------------------------------------------------------------

export const API_NAME_REGEX = /^[a-z][a-zA-Z0-9]{0,63}$/;

/**
 * Reserved apiName words. Spec §1.6 lists these verbatim; comparison is
 * case-insensitive (an `apiName=Object` is forbidden, not just `object`).
 */
export const API_NAME_RESERVED = Object.freeze<readonly string[]>([
  "ontology",
  "object",
  "property",
  "link",
  "relation",
  "rid",
  "primaryKey",
  "typeId",
  "ontologyObject",
  "branch",
  "repository",
  "function",
  "action",
]);

const API_NAME_RESERVED_LC = new Set(API_NAME_RESERVED.map((w) => w.toLowerCase()));

export function validateApiName(name: string): ValidationResult {
  if (typeof name !== "string") return fail("apiName must be a string");
  if (name.length === 0) return fail("apiName must not be empty");
  if (!API_NAME_REGEX.test(name)) {
    return fail(
      `apiName must match ${API_NAME_REGEX.source} (got ${JSON.stringify(name)})`
    );
  }
  if (API_NAME_RESERVED_LC.has(name.toLowerCase())) {
    return fail(`apiName ${JSON.stringify(name)} is reserved`);
  }
  return ok;
}

// ---------------------------------------------------------------------------
// G-C-29 — branchName
// ---------------------------------------------------------------------------
// "^[a-zA-Z0-9._/-]{1,255}$, must not contain `..`, `@{`, `\`, must not start
//  with `-` or `/`, must not end with `.lock` (matches Git ref-format rules)."
//
// Implementation note: the structural rules go beyond what a single regex
// expresses cleanly. We do the regex then a series of substring/prefix/suffix
// checks. All in one pass so callers get a single reason on failure.

export const BRANCH_NAME_CHAR_REGEX = /^[a-zA-Z0-9._/-]{1,255}$/;

export function validateBranchName(name: string): ValidationResult {
  if (typeof name !== "string") return fail("branchName must be a string");
  if (name.length === 0) return fail("branchName must not be empty");
  if (name.length > 255) return fail("branchName exceeds 255 chars");
  if (!BRANCH_NAME_CHAR_REGEX.test(name)) {
    return fail(`branchName has invalid characters (allowed: a-zA-Z0-9._/-)`);
  }
  if (name.includes("..")) return fail("branchName must not contain '..'");
  if (name.includes("@{")) return fail("branchName must not contain '@{'");
  if (name.includes("\\")) return fail("branchName must not contain backslash");
  if (name.startsWith("-")) return fail("branchName must not start with '-'");
  if (name.startsWith("/")) return fail("branchName must not start with '/'");
  if (name.endsWith(".lock")) return fail("branchName must not end with '.lock'");
  return ok;
}

// ---------------------------------------------------------------------------
// G-C-30 — tagName
// ---------------------------------------------------------------------------
// branchName rules + must match the (semver, optional `v` prefix) regex.
// The leading `v` is normalized away on storage (caller should call
// stripTagVPrefix() after validation).

export const TAG_NAME_SEMVER_REGEX =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;

export function validateTagName(name: string): ValidationResult {
  const branchOk = validateBranchName(name);
  if (!branchOk.ok) return branchOk;
  if (!TAG_NAME_SEMVER_REGEX.test(name)) {
    return fail(
      `tagName must be semver (optional 'v' prefix), got ${JSON.stringify(name)}`
    );
  }
  return ok;
}

/** Strip a leading `v` from a validated tag name. Idempotent. */
export function stripTagVPrefix(name: string): string {
  return name.startsWith("v") ? name.slice(1) : name;
}

// ---------------------------------------------------------------------------
// G-C-31 — repositoryName (display)
// ---------------------------------------------------------------------------
// "^[\w][\w \-.()]{0,127}$" — leading word char, then up to 127 of [\w \-.()].
// `\w` in PCRE-flavoured regex is `[A-Za-z0-9_]`. JS RegExp matches that.

export const REPOSITORY_NAME_REGEX = /^[\w][\w \-.()]{0,127}$/;

export function validateRepositoryName(name: string): ValidationResult {
  if (typeof name !== "string") return fail("repositoryName must be a string");
  if (name.length === 0) return fail("repositoryName must not be empty");
  if (name.length > 128) return fail("repositoryName exceeds 128 chars");
  if (!REPOSITORY_NAME_REGEX.test(name)) {
    return fail(
      `repositoryName must match ${REPOSITORY_NAME_REGEX.source} (got ${JSON.stringify(name)})`
    );
  }
  return ok;
}

// ---------------------------------------------------------------------------
// G-C-32 — filePath
// ---------------------------------------------------------------------------
// Must be < 4096 bytes; no null bytes; no leading `/`; no `..` segments;
// must not equal `.git` or live under `.git/`.

const PATH_MAX_BYTES = 4096;

export function validateFilePath(path: string): ValidationResult {
  if (typeof path !== "string") return fail("filePath must be a string");
  if (path.length === 0) return fail("filePath must not be empty");
  // Byte-length check (utf-8). Use TextEncoder for accurate byte counting.
  const bytes = new TextEncoder().encode(path).length;
  if (bytes >= PATH_MAX_BYTES) return fail(`filePath exceeds ${PATH_MAX_BYTES} bytes`);
  if (path.includes("\u0000")) return fail("filePath must not contain NUL byte");
  if (path.startsWith("/")) return fail("filePath must not start with '/'");
  if (path === ".git") return fail("filePath must not be '.git'");
  if (path.startsWith(".git/")) return fail("filePath must not be under '.git/'");
  // No `..` SEGMENTS (so `foo..bar` is fine, `foo/../bar` is not).
  const segments = path.split("/");
  if (segments.some((s) => s === "..")) {
    return fail("filePath must not contain '..' segments");
  }
  // Empty segments (e.g. trailing slash) are also invalid for a *file* path.
  if (segments.some((s) => s.length === 0)) {
    return fail("filePath must not contain empty segments");
  }
  return ok;
}
