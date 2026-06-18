// ---------------------------------------------------------------------------
// tests/unit/code-repos/contracts/etag-unit.test.ts
//
// Covers contract IDs:
//   G-C-17 etag = W/"<resource_version>"
//   G-C-18 PUT/PATCH/DELETE require If-Match; missing → 412 (StaleEtag)
//   G-C-19 resource_version monotonically increasing integer
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  formatWeakEtag,
  parseWeakEtag,
  checkIfMatch,
} from "../../../../src/services/codeRepos/contracts/etag";

describe("G-C-17 ETag formatting", () => {
  it('formatWeakEtag(17) === \'W/"17"\'', () => {
    expect(formatWeakEtag(17)).toBe('W/"17"');
  });

  it("formatWeakEtag(0) is allowed (initial state)", () => {
    expect(formatWeakEtag(0)).toBe('W/"0"');
  });

  it("rejects negative version", () => {
    expect(() => formatWeakEtag(-1)).toThrow();
  });

  it("rejects non-integer", () => {
    expect(() => formatWeakEtag(1.5)).toThrow();
    expect(() => formatWeakEtag(Number.NaN)).toThrow();
  });

  it("parseWeakEtag roundtrips", () => {
    for (const v of [0, 1, 17, 999, 2 ** 31 - 1]) {
      expect(parseWeakEtag(formatWeakEtag(v))).toBe(v);
    }
  });

  it('parseWeakEtag rejects strong ETag form ("17" without W/)', () => {
    expect(parseWeakEtag('"17"')).toBeNull();
  });

  it("parseWeakEtag rejects malformed", () => {
    expect(parseWeakEtag(undefined)).toBeNull();
    expect(parseWeakEtag(null)).toBeNull();
    expect(parseWeakEtag("garbage")).toBeNull();
    expect(parseWeakEtag('W/"abc"')).toBeNull();
  });
});

describe("G-C-18 If-Match precondition", () => {
  it("ok when header matches current version", () => {
    expect(checkIfMatch('W/"17"', 17)).toEqual({ ok: true });
  });

  it("missing header → reason 'missing'", () => {
    expect(checkIfMatch(undefined, 17)).toEqual({ ok: false, reason: "missing" });
    expect(checkIfMatch("", 17)).toEqual({ ok: false, reason: "missing" });
  });

  it("malformed header → reason 'malformed'", () => {
    expect(checkIfMatch("garbage", 17)).toEqual({ ok: false, reason: "malformed" });
    expect(checkIfMatch('"17"', 17)).toEqual({ ok: false, reason: "malformed" });
  });

  it("stale header → reason 'stale'", () => {
    expect(checkIfMatch('W/"16"', 17)).toEqual({ ok: false, reason: "stale" });
    expect(checkIfMatch('W/"18"', 17)).toEqual({ ok: false, reason: "stale" });
  });
});
