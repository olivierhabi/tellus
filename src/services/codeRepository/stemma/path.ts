// ---------------------------------------------------------------------------
// B2 — Stemma path validation (B2-C-10 / B2-C-11).
//
// Validates a repo-relative file path supplied via query string. Pure;
// no I/O; deterministic; total. Every rejection is enumerated so the
// route layer can map it 1:1 to a §1.3 error envelope.
//
// Spec invariants per code-repository-tasks.md §G-C-13 (regex catalog
// for filePath):
//   - max 4 KiB (UTF-8 bytes)
//   - no NUL byte
//   - no leading "/"
//   - no ".." or "." segments
//   - must not equal ".git" or live under ".git/"
// ---------------------------------------------------------------------------

export type PathRejection =
  | "absolute"
  | "traversal"
  | "null-byte"
  | "too-long"
  | "git-reserved"
  | "non-string";

export interface ValidatedPath {
  readonly normalized: string;
  readonly segments: readonly string[];
}

const MAX_PATH_BYTES = 4096;

/**
 * Validate a repo-relative path. The empty string and `null`/`undefined`
 * normalise to `""` (= repo root), which is the legal default for the
 * tree-listing endpoint.
 *
 * Any rejection returns a discriminated outcome — callers must pattern-
 * match all rejection kinds (TS exhaustiveness check).
 */
export function validateRelativePath(
  input: unknown,
):
  | { ok: true; value: ValidatedPath }
  | { ok: false; reason: PathRejection } {
  if (input == null || input === "") {
    return { ok: true, value: { normalized: "", segments: [] } };
  }
  if (typeof input !== "string") {
    return { ok: false, reason: "non-string" };
  }
  if (Buffer.byteLength(input, "utf8") > MAX_PATH_BYTES) {
    return { ok: false, reason: "too-long" };
  }
  if (input.includes("\0")) {
    return { ok: false, reason: "null-byte" };
  }
  if (input.startsWith("/")) {
    return { ok: false, reason: "absolute" };
  }
  // Reject Windows-style drive prefixes defensively (e.g. `C:`); we never
  // serve these paths on Stemma.
  if (/^[A-Za-z]:/.test(input)) {
    return { ok: false, reason: "absolute" };
  }
  const segments = input.split("/").filter((s) => s.length > 0);
  for (const s of segments) {
    if (s === "." || s === "..") {
      return { ok: false, reason: "traversal" };
    }
    if (s === ".git") {
      return { ok: false, reason: "git-reserved" };
    }
  }
  return {
    ok: true,
    value: { normalized: segments.join("/"), segments },
  };
}

/**
 * Validate a depth value from a query string. Accepts integers in
 * `[1, 5]`. Default is 1. Anything else (negative, non-integer, NaN,
 * out-of-range) is a hard rejection.
 */
export function validateDepth(
  input: unknown,
): { ok: true; value: number } | { ok: false } {
  if (input == null || input === "") return { ok: true, value: 1 };
  const n =
    typeof input === "number" ? input : Number(String(input));
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false };
  if (n < 1 || n > 5) return { ok: false };
  return { ok: true, value: n };
}
