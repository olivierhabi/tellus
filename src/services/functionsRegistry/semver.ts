// ---------------------------------------------------------------------------
// B8 — Functions Registry semver parser + range matcher + resolution.
//
// Spec §B8 mandates npm-semver-compatible ranges:
//   ^1.2.0      — caret: >=1.2.0 <2.0.0  (compatible with 1.x.x where x >= 2)
//   ~1.2.0      — tilde: >=1.2.0 <1.3.0  (compatible with 1.2.x)
//   1.2.x       — wildcard: >=1.2.0 <1.3.0
//   =1.2.3      — exact match
//   >=1.2.3     — gte
//   <2.0.0      — lt
//   >=1.2.3 <2  — conjunction (AND)
//
// Pre-release versions (1.0.0-beta.1) are RECOGNISED but NOT included in
// caret/tilde/wildcard matches unless the range itself names a pre-release
// of the same X.Y.Z (npm semver §10).
// ---------------------------------------------------------------------------

export interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Pre-release identifier components, or [] for stable releases. */
  readonly preRelease: ReadonlyArray<string>;
  /** Build metadata (ignored for ordering). */
  readonly buildMeta: ReadonlyArray<string>;
  /** Original input string. */
  readonly raw: string;
}

const STRICT_SEMVER_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*))*))?(?:\+([\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*))?$/;

export class SemverParseError extends Error {
  readonly code: "INVALID_SEMVER" | "INVALID_RANGE";
  constructor(code: SemverParseError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "SemverParseError";
  }
}

/**
 * Parse a strict semver string. Throws SemverParseError("INVALID_SEMVER")
 * on malformed input.
 */
export function parseSemver(input: string): ParsedSemver {
  const stripped = input.startsWith("v") ? input.slice(1) : input;
  const m = stripped.match(STRICT_SEMVER_REGEX);
  if (!m) {
    throw new SemverParseError("INVALID_SEMVER", `not a strict semver: ${input}`);
  }
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
    preRelease: m[4] ? m[4].split(".") : [],
    buildMeta: m[5] ? m[5].split(".") : [],
    raw: input,
  };
}

export function isStableRelease(s: ParsedSemver): boolean {
  return s.preRelease.length === 0;
}

/**
 * Preview vs stable release: a release off a non-default branch, or
 * a prerelease SemVer (1.2.3-rc1), is a preview build — it never
 * resolves as the default-branch stable.
 *
 * THE single predicate implementation, imported by both the
 * tag-release route (codeRepository/admin/routes.ts) and the
 * functions-publish worker (functionsPublish/service.ts). Throws
 * whatever parseSemver throws on invalid input (both call sites
 * validate earlier and surface their own 400 first).
 */
export function isPreviewRelease(
  branch: string,
  defaultBranch: string,
  semver: string,
): boolean {
  return branch !== defaultBranch || parseSemver(semver).preRelease.length > 0;
}

// ---------------------------------------------------------------------------
// Comparison.
// ---------------------------------------------------------------------------

/**
 * Compare two ParsedSemver per semver §11.
 *
 * Returns < 0 if a < b, 0 if equal (ignoring buildMeta), > 0 if a > b.
 */
export function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // Pre-release rules: a release with a pre-release < release without one.
  if (a.preRelease.length === 0 && b.preRelease.length > 0) return 1;
  if (a.preRelease.length > 0 && b.preRelease.length === 0) return -1;
  if (a.preRelease.length === 0 && b.preRelease.length === 0) return 0;
  // Both have pre-releases: compare identifier-by-identifier.
  const len = Math.min(a.preRelease.length, b.preRelease.length);
  for (let i = 0; i < len; i++) {
    const cmp = comparePreReleaseId(a.preRelease[i], b.preRelease[i]);
    if (cmp !== 0) return cmp;
  }
  return a.preRelease.length - b.preRelease.length;
}

function comparePreReleaseId(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return parseInt(a, 10) - parseInt(b, 10);
  if (aNum && !bNum) return -1; // numeric ids have lower precedence
  if (!aNum && bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Range parsing.
// ---------------------------------------------------------------------------

interface RangeBound {
  readonly op: ">=" | ">" | "<=" | "<" | "=";
  readonly version: ParsedSemver;
}

/** A range = conjunction of bounds. All bounds must hold for a match. */
export interface ParsedRange {
  readonly bounds: ReadonlyArray<RangeBound>;
  /** Original input string. */
  readonly raw: string;
}

/**
 * Parse an npm-style range. Supported forms:
 *   ^1.2.3            → >=1.2.3 <2.0.0
 *   ~1.2.3            → >=1.2.3 <1.3.0
 *   1.2.x  / 1.2.*    → >=1.2.0 <1.3.0
 *   1.x   / 1.*       → >=1.0.0 <2.0.0
 *   *                 → >=0.0.0  (every stable)
 *   =1.2.3            → exact
 *   >=1.2.3, <2.0.0   → conjunction (commas or whitespace)
 *   >=1.2.3 <2.0.0    → conjunction (whitespace)
 */
export function parseRange(input: string): ParsedRange {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new SemverParseError("INVALID_RANGE", "empty range");
  }

  // Single-token shortcuts.
  if (trimmed === "*") {
    return { bounds: [{ op: ">=", version: parseSemver("0.0.0") }], raw: input };
  }

  // ^1.2.3
  if (trimmed.startsWith("^")) {
    const v = parseSemver(trimmed.slice(1));
    const upper = computeCaretUpper(v);
    return {
      bounds: [
        { op: ">=", version: v },
        { op: "<", version: upper },
      ],
      raw: input,
    };
  }
  // ~1.2.3
  if (trimmed.startsWith("~")) {
    const v = parseSemver(trimmed.slice(1));
    const upper: ParsedSemver = {
      major: v.major,
      minor: v.minor + 1,
      patch: 0,
      preRelease: [],
      buildMeta: [],
      raw: `${v.major}.${v.minor + 1}.0`,
    };
    return {
      bounds: [
        { op: ">=", version: v },
        { op: "<", version: upper },
      ],
      raw: input,
    };
  }

  // Wildcard X.Y.x or X.x
  if (/^\d+\.\d+\.[xX*]$/.test(trimmed)) {
    const [maj, min] = trimmed.split(".").map((s) => (s === "x" || s === "X" || s === "*" ? 0 : parseInt(s, 10)));
    const lower = parseSemver(`${maj}.${min}.0`);
    const upper: ParsedSemver = {
      major: maj,
      minor: min + 1,
      patch: 0,
      preRelease: [],
      buildMeta: [],
      raw: `${maj}.${min + 1}.0`,
    };
    return {
      bounds: [
        { op: ">=", version: lower },
        { op: "<", version: upper },
      ],
      raw: input,
    };
  }
  if (/^\d+\.[xX*]$/.test(trimmed)) {
    const [maj] = trimmed.split(".");
    const major = parseInt(maj, 10);
    const lower = parseSemver(`${major}.0.0`);
    const upper: ParsedSemver = {
      major: major + 1,
      minor: 0,
      patch: 0,
      preRelease: [],
      buildMeta: [],
      raw: `${major + 1}.0.0`,
    };
    return {
      bounds: [
        { op: ">=", version: lower },
        { op: "<", version: upper },
      ],
      raw: input,
    };
  }

  // Conjunction of bounds — split on whitespace and/or commas.
  const tokens = trimmed.split(/[,\s]+/).filter(Boolean);
  const bounds: RangeBound[] = [];
  for (const tok of tokens) {
    bounds.push(parseSingleBound(tok));
  }
  return { bounds, raw: input };
}

function computeCaretUpper(v: ParsedSemver): ParsedSemver {
  // ^X.Y.Z when X > 0 → <(X+1).0.0
  // ^0.Y.Z when Y > 0 → <0.(Y+1).0
  // ^0.0.Z            → <0.0.(Z+1)
  if (v.major > 0) {
    return {
      major: v.major + 1,
      minor: 0,
      patch: 0,
      preRelease: [],
      buildMeta: [],
      raw: `${v.major + 1}.0.0`,
    };
  }
  if (v.minor > 0) {
    return {
      major: 0,
      minor: v.minor + 1,
      patch: 0,
      preRelease: [],
      buildMeta: [],
      raw: `0.${v.minor + 1}.0`,
    };
  }
  return {
    major: 0,
    minor: 0,
    patch: v.patch + 1,
    preRelease: [],
    buildMeta: [],
    raw: `0.0.${v.patch + 1}`,
  };
}

function parseSingleBound(tok: string): RangeBound {
  // Match operator + version.
  const m = tok.match(/^(>=|<=|>|<|=)?(.+)$/);
  if (!m) {
    throw new SemverParseError("INVALID_RANGE", `cannot parse bound: ${tok}`);
  }
  const op = (m[1] ?? "=") as RangeBound["op"];
  const version = parseSemver(m[2]);
  return { op, version };
}

// ---------------------------------------------------------------------------
// Range matching.
// ---------------------------------------------------------------------------

/**
 * Does a version satisfy a range?
 *
 * Per npm-semver §10: pre-release versions match a range only when the range
 * explicitly names a pre-release of the same X.Y.Z. We implement that rule:
 * a candidate with a non-empty preRelease list is excluded UNLESS some bound
 * in the range names the same X.Y.Z with a pre-release tag.
 */
export function matchesRange(version: ParsedSemver, range: ParsedRange): boolean {
  if (!isStableRelease(version)) {
    const allowsPrerelease = range.bounds.some((b) => {
      if (b.version.preRelease.length === 0) return false;
      return (
        b.version.major === version.major &&
        b.version.minor === version.minor &&
        b.version.patch === version.patch
      );
    });
    if (!allowsPrerelease) return false;
  }

  for (const b of range.bounds) {
    const cmp = compareSemver(version, b.version);
    switch (b.op) {
      case "=":
        if (cmp !== 0) return false;
        break;
      case ">=":
        if (cmp < 0) return false;
        break;
      case ">":
        if (cmp <= 0) return false;
        break;
      case "<=":
        if (cmp > 0) return false;
        break;
      case "<":
        if (cmp >= 0) return false;
        break;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Resolution.
// ---------------------------------------------------------------------------

export interface Candidate {
  readonly semver: string;
  readonly branch: string;
  readonly isPreview: boolean;
}

/**
 * Pick the highest matching version per spec §B8 algorithm:
 *   1. Filter `branch=requested OR (branch=defaultBranch AND is_preview=false)`.
 *   2. Pick the highest semver matching the range.
 *   3. Return null if none.
 *
 * The `requestedBranch` is the consumer's preferred branch; `defaultBranch`
 * is the repository's default branch.
 */
export function resolveTarget(
  candidates: ReadonlyArray<Candidate>,
  range: ParsedRange,
  requestedBranch: string,
  defaultBranch: string,
): Candidate | null {
  // Filter eligible candidates.
  const eligible = candidates.filter((c) => {
    if (c.branch === requestedBranch && (!c.isPreview || requestedBranch !== defaultBranch)) return true;
    if (c.branch === defaultBranch && !c.isPreview) return true;
    return false;
  });
  // Filter by range.
  const matching = eligible.filter((c) => {
    try {
      return matchesRange(parseSemver(c.semver), range);
    } catch {
      return false;
    }
  });
  if (matching.length === 0) return null;
  // Highest semver wins. If a candidate is on the requested branch AND tied
  // with one on default branch, prefer requested-branch precedence.
  const sorted = [...matching].sort((a, b) => {
    const cmp = compareSemver(parseSemver(b.semver), parseSemver(a.semver));
    if (cmp !== 0) return cmp;
    // Tie-break: requested branch wins over default branch.
    if (a.branch === requestedBranch && b.branch !== requestedBranch) return -1;
    if (a.branch !== requestedBranch && b.branch === requestedBranch) return 1;
    return 0;
  });
  return sorted[0];
}
