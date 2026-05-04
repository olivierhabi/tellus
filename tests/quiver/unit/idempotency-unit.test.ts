// Quiver — idempotency module unit tests (G-04).
//
// These tests cover canonical-JSON body hashing and key-shape validation.
// Round-tripping through Postgres lives in tests/quiver/integration/.

import { describe, it, expect } from "vitest";
import {
  bodyHash,
  makeContext,
} from "../../../src/services/quiver/idempotency";

describe("Quiver idempotency (G-04)", () => {
  it("G-04: bodyHash is stable under key re-ordering", () => {
    const a = bodyHash({ a: 1, b: 2, c: { d: 3, e: 4 } });
    const b = bodyHash({ c: { e: 4, d: 3 }, b: 2, a: 1 });
    expect(a.equals(b)).toBe(true);
  });

  it("G-04: bodyHash differs when any value changes", () => {
    const a = bodyHash({ a: 1 });
    const b = bodyHash({ a: 2 });
    expect(a.equals(b)).toBe(false);
  });

  it("G-04: makeContext rejects illegal idempotency keys", () => {
    expect(() =>
      makeContext({
        key: "not legal/has slash",
        userId: "u",
        route: "POST /x",
        body: {},
      }),
    ).toThrow(/idempotency-key must match/);
  });

  it("G-04: makeContext accepts uuid-shaped keys", () => {
    const ctx = makeContext({
      key: "018f6c2d-7000-7abc-8def-1234567890ab",
      userId: "u",
      route: "POST /x",
      body: { a: 1 },
    });
    expect(ctx.key).toBe("018f6c2d-7000-7abc-8def-1234567890ab");
    expect(ctx.bodySha256).toHaveLength(32);
  });
});
