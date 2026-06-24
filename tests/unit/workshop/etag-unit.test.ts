// Unit tests for the Workshop ETag utility.
//
// Contract IDs covered (see tasks/workshop/contracts.md):
//   - G-02 (ETag scheme)
//   - B01 C-09, B01 C-10, B01 C-11 (PUT If-Match semantics build on this util)
//
// These tests fail when:
//   - canonicalization is non-deterministic (key order leakage)
//   - the digest is sensitive to JS object insertion order
//   - the ISO timestamp parser drops microsecond resolution
//   - parseEtag accepts malformed values

import { describe, it, expect } from "vitest";
import {
  canonicalizeJson,
  computeEtag,
  isoToMicros,
  parseEtag,
} from "../../../src/services/workshop/etag";

describe("G-02: canonicalizeJson", () => {
  it("G-02: produces identical output regardless of object key insertion order", () => {
    const a = { a: 1, b: { x: [1, 2], y: "two" } };
    const b = { b: { y: "two", x: [1, 2] }, a: 1 };
    expect(canonicalizeJson(a)).toEqual(canonicalizeJson(b));
  });

  it("G-02: preserves array order", () => {
    expect(canonicalizeJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("G-02: rejects non-finite numbers", () => {
    expect(() => canonicalizeJson({ x: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => canonicalizeJson({ x: Number.NaN })).toThrow();
  });

  it("G-02: rejects undefined", () => {
    expect(() => canonicalizeJson({ x: undefined } as unknown)).toThrow();
  });

  it("G-02: integer literal serialization for whole numbers", () => {
    expect(canonicalizeJson(42)).toBe("42");
    expect(canonicalizeJson(42.5)).toBe("42.5");
  });

  it("G-02: nested keys sorted recursively", () => {
    const v = { z: { c: 1, a: 2 }, a: { b: 1, A: 2 } };
    // Object keys are sorted lexicographically by JS string compare; uppercase
    // sorts before lowercase under that ordering.
    expect(canonicalizeJson(v)).toBe(
      '{"a":{"A":2,"b":1},"z":{"a":2,"c":1}}',
    );
  });
});

describe("G-02: computeEtag", () => {
  it("G-02: identical inputs yield identical ETag", () => {
    const def = { schemaVersion: 4, hello: "world" };
    expect(computeEtag(def, 1700000000000000n)).toBe(
      computeEtag(def, 1700000000000000n),
    );
  });

  it("G-02: ETag changes when timestamp changes", () => {
    const def = { schemaVersion: 4 };
    expect(computeEtag(def, 1n)).not.toEqual(computeEtag(def, 2n));
  });

  it("G-02: ETag changes when content changes", () => {
    expect(
      computeEtag({ schemaVersion: 4, x: 1 }, 1n),
    ).not.toEqual(computeEtag({ schemaVersion: 4, x: 2 }, 1n));
  });

  it("G-02: ETag has weak prefix W/ and 64-hex-char digest", () => {
    const etag = computeEtag({ a: 1 }, 1n);
    expect(etag).toMatch(/^W\/"[0-9a-f]{64}"$/);
  });

  it("G-02: ETag is invariant to object key insertion order", () => {
    const a = { x: { p: 1, q: 2 }, y: 3 };
    const b = { y: 3, x: { q: 2, p: 1 } };
    expect(computeEtag(a, 1n)).toBe(computeEtag(b, 1n));
  });
});

describe("G-02: isoToMicros", () => {
  it("G-02: parses Z-suffixed timestamps with microsecond precision", () => {
    // Date.UTC(2026, 4, 3, 14, 25, 36) = 1777818336000 ms; +123456 µs.
    const expected =
      BigInt(Date.UTC(2026, 4, 3, 14, 25, 36)) * 1000n + 123456n;
    expect(isoToMicros("2026-05-03T14:25:36.123456Z")).toBe(expected);
  });

  it("G-02: applies positive timezone offsets", () => {
    // 14:00 +02:00 == 12:00 Z
    const a = isoToMicros("2026-05-03T14:00:00.000000+02:00");
    const b = isoToMicros("2026-05-03T12:00:00.000000Z");
    expect(a).toBe(b);
  });

  it("G-02: applies negative timezone offsets", () => {
    const a = isoToMicros("2026-05-03T07:00:00.000000-05:00");
    const b = isoToMicros("2026-05-03T12:00:00.000000Z");
    expect(a).toBe(b);
  });

  it("G-02: pads sub-microsecond fractional digits to six places", () => {
    // 0.5 seconds = 500000 microseconds
    expect(isoToMicros("2026-05-03T00:00:00.5Z")).toBe(
      isoToMicros("2026-05-03T00:00:00.500000Z"),
    );
  });

  it("G-02: rejects malformed timestamps", () => {
    expect(() => isoToMicros("not a timestamp")).toThrow();
  });

  it("G-02: parses Postgres wire format (space separator, +00 offset)", () => {
    // Postgres emits this exact shape via OID-1184 raw text.
    const expected =
      BigInt(Date.UTC(2026, 4, 3, 14, 25, 36)) * 1000n + 123456n;
    expect(isoToMicros("2026-05-03 14:25:36.123456+00")).toBe(expected);
  });

  it("G-02: parses Postgres wire format with non-UTC offset", () => {
    // 14:00 +05 == 09:00 Z
    const expected = BigInt(Date.UTC(2026, 4, 3, 9, 0, 0)) * 1000n;
    expect(isoToMicros("2026-05-03 14:00:00+05")).toBe(expected);
  });
});

describe("G-02: parseEtag", () => {
  it("G-02: parses weak ETag", () => {
    const digest = "a".repeat(64);
    expect(parseEtag(`W/"${digest}"`)).toBe(digest);
  });

  it("G-02: parses strong ETag", () => {
    const digest = "b".repeat(64);
    expect(parseEtag(`"${digest}"`)).toBe(digest);
  });

  it("G-02: returns null on missing or malformed values", () => {
    expect(parseEtag(undefined)).toBeNull();
    expect(parseEtag("")).toBeNull();
    expect(parseEtag('"too-short"')).toBeNull();
    expect(parseEtag("nohash")).toBeNull();
  });

  it("G-02: rejects non-hex characters", () => {
    expect(parseEtag(`W/"${"z".repeat(64)}"`)).toBeNull();
  });
});
