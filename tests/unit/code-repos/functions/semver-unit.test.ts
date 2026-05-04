// ---------------------------------------------------------------------------
// B8 — semver parser + range matcher + resolution unit tests.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  SemverParseError,
  compareSemver,
  matchesRange,
  parseRange,
  parseSemver,
  resolveTarget,
  type Candidate,
} from "../../../../src/services/functionsRegistry/semver";

describe("parseSemver — strict mode", () => {
  it.each([
    ["1.2.3", { major: 1, minor: 2, patch: 3 }],
    ["v1.2.3", { major: 1, minor: 2, patch: 3 }],
    ["0.0.0", { major: 0, minor: 0, patch: 0 }],
    ["10.20.30", { major: 10, minor: 20, patch: 30 }],
  ])("parses %s", (input, expected) => {
    const r = parseSemver(input);
    expect(r.major).toBe(expected.major);
    expect(r.minor).toBe(expected.minor);
    expect(r.patch).toBe(expected.patch);
  });

  it("parses pre-release identifiers", () => {
    const r = parseSemver("1.0.0-beta.1");
    expect(r.preRelease).toEqual(["beta", "1"]);
    expect(r.buildMeta).toEqual([]);
  });

  it("parses build metadata", () => {
    const r = parseSemver("1.0.0+abcd1234");
    expect(r.preRelease).toEqual([]);
    expect(r.buildMeta).toEqual(["abcd1234"]);
  });

  it("parses pre-release + build metadata", () => {
    const r = parseSemver("1.0.0-rc.1+sha.abc");
    expect(r.preRelease).toEqual(["rc", "1"]);
    expect(r.buildMeta).toEqual(["sha", "abc"]);
  });

  it.each(["1", "1.2", "1.2.3.4", "01.2.3", "1.2.x", "abc", "1.2.3-", "1.2.-rc"])(
    "rejects %s with INVALID_SEMVER",
    (input) => {
      expect(() => parseSemver(input)).toThrow(SemverParseError);
    },
  );
});

describe("compareSemver — semver §11 ordering", () => {
  it("major > minor > patch precedence", () => {
    expect(compareSemver(parseSemver("2.0.0"), parseSemver("1.99.99"))).toBeGreaterThan(0);
    expect(compareSemver(parseSemver("1.2.0"), parseSemver("1.1.99"))).toBeGreaterThan(0);
    expect(compareSemver(parseSemver("1.2.4"), parseSemver("1.2.3"))).toBeGreaterThan(0);
  });

  it("equal versions return 0 (ignoring buildMeta)", () => {
    expect(compareSemver(parseSemver("1.2.3"), parseSemver("1.2.3"))).toBe(0);
    expect(compareSemver(parseSemver("1.2.3+a"), parseSemver("1.2.3+b"))).toBe(0);
  });

  it("stable > pre-release of same X.Y.Z", () => {
    expect(compareSemver(parseSemver("1.0.0"), parseSemver("1.0.0-rc.1"))).toBeGreaterThan(0);
    expect(compareSemver(parseSemver("1.0.0-rc.1"), parseSemver("1.0.0"))).toBeLessThan(0);
  });

  it("pre-release identifier ordering: numeric < non-numeric", () => {
    expect(compareSemver(parseSemver("1.0.0-1"), parseSemver("1.0.0-alpha"))).toBeLessThan(0);
  });

  it("pre-release identifier ordering: identifier-by-identifier", () => {
    expect(
      compareSemver(parseSemver("1.0.0-alpha.1"), parseSemver("1.0.0-alpha.2")),
    ).toBeLessThan(0);
    expect(
      compareSemver(parseSemver("1.0.0-alpha.10"), parseSemver("1.0.0-alpha.2")),
    ).toBeGreaterThan(0); // numeric — 10 > 2
  });

  it("longer pre-release > shorter prefix", () => {
    expect(compareSemver(parseSemver("1.0.0-alpha"), parseSemver("1.0.0-alpha.1"))).toBeLessThan(0);
  });
});

describe("parseRange — npm-compatible forms", () => {
  it("caret ^1.2.3 → >=1.2.3 <2.0.0", () => {
    const r = parseRange("^1.2.3");
    expect(matchesRange(parseSemver("1.2.3"), r)).toBe(true);
    expect(matchesRange(parseSemver("1.99.99"), r)).toBe(true);
    expect(matchesRange(parseSemver("2.0.0"), r)).toBe(false);
    expect(matchesRange(parseSemver("1.2.2"), r)).toBe(false);
  });

  it("caret ^0.2.3 → >=0.2.3 <0.3.0", () => {
    const r = parseRange("^0.2.3");
    expect(matchesRange(parseSemver("0.2.3"), r)).toBe(true);
    expect(matchesRange(parseSemver("0.2.99"), r)).toBe(true);
    expect(matchesRange(parseSemver("0.3.0"), r)).toBe(false);
  });

  it("caret ^0.0.3 → >=0.0.3 <0.0.4", () => {
    const r = parseRange("^0.0.3");
    expect(matchesRange(parseSemver("0.0.3"), r)).toBe(true);
    expect(matchesRange(parseSemver("0.0.4"), r)).toBe(false);
  });

  it("tilde ~1.2.3 → >=1.2.3 <1.3.0", () => {
    const r = parseRange("~1.2.3");
    expect(matchesRange(parseSemver("1.2.3"), r)).toBe(true);
    expect(matchesRange(parseSemver("1.2.99"), r)).toBe(true);
    expect(matchesRange(parseSemver("1.3.0"), r)).toBe(false);
  });

  it("wildcard 1.2.x → >=1.2.0 <1.3.0", () => {
    const r = parseRange("1.2.x");
    expect(matchesRange(parseSemver("1.2.0"), r)).toBe(true);
    expect(matchesRange(parseSemver("1.2.99"), r)).toBe(true);
    expect(matchesRange(parseSemver("1.3.0"), r)).toBe(false);
    expect(matchesRange(parseSemver("1.1.99"), r)).toBe(false);
  });

  it("wildcard 1.x → >=1.0.0 <2.0.0", () => {
    const r = parseRange("1.x");
    expect(matchesRange(parseSemver("1.0.0"), r)).toBe(true);
    expect(matchesRange(parseSemver("1.99.99"), r)).toBe(true);
    expect(matchesRange(parseSemver("2.0.0"), r)).toBe(false);
  });

  it("exact =1.2.3", () => {
    const r = parseRange("=1.2.3");
    expect(matchesRange(parseSemver("1.2.3"), r)).toBe(true);
    expect(matchesRange(parseSemver("1.2.4"), r)).toBe(false);
  });

  it("conjunction >=1.2.3 <2.0.0", () => {
    const r = parseRange(">=1.2.3 <2.0.0");
    expect(matchesRange(parseSemver("1.2.3"), r)).toBe(true);
    expect(matchesRange(parseSemver("1.99.99"), r)).toBe(true);
    expect(matchesRange(parseSemver("2.0.0"), r)).toBe(false);
    expect(matchesRange(parseSemver("1.2.2"), r)).toBe(false);
  });

  it("conjunction with comma >=1.2.3, <2.0.0", () => {
    const r = parseRange(">=1.2.3, <2.0.0");
    expect(matchesRange(parseSemver("1.5.0"), r)).toBe(true);
  });

  it("star * matches every stable", () => {
    const r = parseRange("*");
    expect(matchesRange(parseSemver("0.0.0"), r)).toBe(true);
    expect(matchesRange(parseSemver("99.99.99"), r)).toBe(true);
  });

  it("pre-release versions are EXCLUDED from caret/tilde unless explicitly named", () => {
    expect(matchesRange(parseSemver("1.0.0-rc.1"), parseRange("^1.0.0"))).toBe(false);
    expect(matchesRange(parseSemver("1.0.0-rc.1"), parseRange(">=1.0.0-rc.1 <2.0.0"))).toBe(true);
  });
});

describe("resolveTarget — branch-aware preview semantics (B8)", () => {
  const candidates: Candidate[] = [
    { semver: "1.0.0", branch: "main", isPreview: false },
    { semver: "1.0.1", branch: "main", isPreview: false },
    { semver: "1.0.0-beta.1", branch: "feature/foo", isPreview: true },
    { semver: "1.1.0", branch: "feature/foo", isPreview: true },
    { semver: "0.9.0", branch: "main", isPreview: false },
  ];

  it("returns highest match on requested branch (main)", () => {
    const r = resolveTarget(candidates, parseRange("^1.0.0"), "main", "main");
    expect(r?.semver).toBe("1.0.1");
    expect(r?.branch).toBe("main");
  });

  it("requested feature branch sees preview + falls back to main stable", () => {
    // ^1.0.0 on feature/foo:
    //   - feature/foo: 1.0.0-beta.1 (excluded by caret rules)
    //                  1.1.0       (in range — but PREVIEW; eligible for the
    //                                requested branch)
    //   - main:        1.0.0, 1.0.1 (both eligible — branch=default && !preview)
    //   - 0.9.0       (out of range)
    // Highest is 1.1.0 (feature) > 1.0.1 (main).
    const r = resolveTarget(candidates, parseRange("^1.0.0"), "feature/foo", "main");
    expect(r?.semver).toBe("1.1.0");
  });

  it("preview is_preview=true on default branch is INELIGIBLE for default-branch consumers", () => {
    const cands: Candidate[] = [
      { semver: "1.0.0", branch: "main", isPreview: false },
      { semver: "1.5.0", branch: "main", isPreview: true }, // hypothetical preview on default
    ];
    const r = resolveTarget(cands, parseRange("^1.0.0"), "main", "main");
    expect(r?.semver).toBe("1.0.0"); // 1.5.0 excluded
  });

  it("returns null when no candidate matches", () => {
    const r = resolveTarget(candidates, parseRange("^9.0.0"), "main", "main");
    expect(r).toBeNull();
  });

  it("requested branch with no matches falls back to main stable", () => {
    const cands: Candidate[] = [
      { semver: "1.0.0", branch: "main", isPreview: false },
      { semver: "0.5.0", branch: "feature/x", isPreview: true },
    ];
    const r = resolveTarget(cands, parseRange("^1.0.0"), "feature/x", "main");
    expect(r?.semver).toBe("1.0.0");
    expect(r?.branch).toBe("main");
  });

  it("tie-break: requested branch wins over default branch when versions are equal", () => {
    const cands: Candidate[] = [
      { semver: "1.0.0", branch: "main", isPreview: false },
      { semver: "1.0.0", branch: "feature/x", isPreview: true },
    ];
    const r = resolveTarget(cands, parseRange("=1.0.0"), "feature/x", "main");
    expect(r?.branch).toBe("feature/x");
  });
});
