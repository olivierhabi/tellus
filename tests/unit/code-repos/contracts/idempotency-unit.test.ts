// ---------------------------------------------------------------------------
// tests/unit/code-repos/contracts/idempotency-unit.test.ts
//
// Covers contract IDs:
//   G-C-20 every mutating POST requires Idempotency-Key (UUIDv4)
//   G-C-21 (24h TTL constant defined; runtime test deferred to integration)
//   G-C-22 same key + same hash → replay
//   G-C-23 same key + different hash → conflict
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  isValidIdempotencyKey,
  hashRequest,
  decideReplay,
  IDEMPOTENCY_KEY_TTL_SECONDS,
} from "../../../../src/services/codeRepos/contracts/idempotency";

describe("G-C-20 Idempotency-Key validation", () => {
  it("accepts a UUIDv4", () => {
    expect(isValidIdempotencyKey("b9b8e3a4-1234-4abc-89ef-0123456789ab")).toBe(true);
  });

  it("rejects non-UUID", () => {
    expect(isValidIdempotencyKey("nope")).toBe(false);
    expect(isValidIdempotencyKey("")).toBe(false);
  });

  it("rejects UUIDv1/v3 (must be v4)", () => {
    // version=1
    expect(isValidIdempotencyKey("b9b8e3a4-1234-1abc-89ef-0123456789ab")).toBe(false);
    // version=3
    expect(isValidIdempotencyKey("b9b8e3a4-1234-3abc-89ef-0123456789ab")).toBe(false);
  });

  it("rejects uppercase hex", () => {
    expect(isValidIdempotencyKey("B9B8E3A4-1234-4abc-89ef-0123456789ab")).toBe(false);
  });
});

describe("G-C-21 TTL constant", () => {
  it("is exactly 24h in seconds (>= per spec)", () => {
    expect(IDEMPOTENCY_KEY_TTL_SECONDS).toBe(24 * 60 * 60);
  });
});

describe("hashRequest determinism (G-C-22 fundament)", () => {
  it("identical inputs → identical hash", () => {
    const a = hashRequest({ method: "POST", path: "/x", body: { b: 1, a: 2 } });
    const b = hashRequest({ method: "POST", path: "/x", body: { a: 2, b: 1 } });
    expect(a).toBe(b);
  });

  it("method case is normalized", () => {
    expect(hashRequest({ method: "post", path: "/x", body: null })).toBe(
      hashRequest({ method: "POST", path: "/x", body: null })
    );
  });

  it("different bodies → different hash", () => {
    expect(hashRequest({ method: "POST", path: "/x", body: { a: 1 } })).not.toBe(
      hashRequest({ method: "POST", path: "/x", body: { a: 2 } })
    );
  });

  it("different path → different hash (key cannot replay across endpoints)", () => {
    expect(hashRequest({ method: "POST", path: "/x", body: null })).not.toBe(
      hashRequest({ method: "POST", path: "/y", body: null })
    );
  });

  it("missing body normalized to null", () => {
    expect(hashRequest({ method: "POST", path: "/x", body: undefined })).toBe(
      hashRequest({ method: "POST", path: "/x", body: null })
    );
  });
});

describe("G-C-22 / G-C-23 decideReplay", () => {
  it("first-time key → 'new'", () => {
    expect(decideReplay(undefined, undefined, "abc")).toEqual({ kind: "new" });
  });

  it("same hash → 'replay' with stored response id", () => {
    expect(decideReplay("abc", "rsp-1", "abc")).toEqual({
      kind: "replay",
      storedResponseId: "rsp-1",
    });
  });

  it("different hash → 'conflict'", () => {
    expect(decideReplay("abc", "rsp-1", "xyz")).toEqual({ kind: "conflict" });
  });

  it("invariant: hash present without response id throws (corrupt store)", () => {
    expect(() => decideReplay("abc", undefined, "abc")).toThrow(/invariant/i);
  });
});
