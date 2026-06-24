import { describe, expect, it } from "vitest";
import { formatEtag, parseEtag } from "../../../src/middleware/etag";

describe("B5.02 — etag helpers", () => {
  it("formatEtag wraps a number in strong ETag form", () => {
    expect(formatEtag(7)).toBe('"v7"');
    expect(formatEtag(0)).toBe('"v0"');
    expect(formatEtag(null)).toBe('"v0"');
    expect(formatEtag(undefined)).toBe('"v0"');
  });
  it("parseEtag round-trips the format", () => {
    expect(parseEtag('"v7"')).toBe(7);
    expect(parseEtag('W/"v17"')).toBe(17);
    expect(parseEtag('bogus')).toBeNull();
    expect(parseEtag(null)).toBeNull();
  });
  it("formatEtag/parseEtag are inverses for v0..v999", () => {
    for (let v = 0; v < 100; v++) {
      expect(parseEtag(formatEtag(v))).toBe(v);
    }
  });
});
