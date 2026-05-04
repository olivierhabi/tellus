// Unit tests for the idempotency body-hashing and key-validation helpers.
// Contract IDs: G-03, B01 C-15, B01 C-16.

import { describe, it, expect } from "vitest";
import {
  hashBody,
  isValidIdempotencyKey,
} from "../../../src/services/workshop/idempotency";

describe("G-03: hashBody", () => {
  it("G-03: identical bodies hash equal", () => {
    expect(hashBody({ a: 1, b: 2 }).equals(hashBody({ a: 1, b: 2 }))).toBe(
      true,
    );
  });

  it("G-03: different bodies hash unequal", () => {
    expect(hashBody({ a: 1 }).equals(hashBody({ a: 2 }))).toBe(false);
  });

  it("G-03: hash output is 32 bytes (sha256)", () => {
    expect(hashBody({}).length).toBe(32);
  });
});

describe("G-03: isValidIdempotencyKey", () => {
  it("G-03: accepts a UUID v4", () => {
    expect(
      isValidIdempotencyKey("a1b2c3d4-e5f6-4789-9abc-def012345678"),
    ).toBe(true);
  });

  it("G-03: rejects UUID v1 (version digit != 4)", () => {
    expect(
      isValidIdempotencyKey("a1b2c3d4-e5f6-1789-9abc-def012345678"),
    ).toBe(false);
  });

  it("G-03: rejects malformed values", () => {
    expect(isValidIdempotencyKey("")).toBe(false);
    expect(isValidIdempotencyKey("not-a-uuid")).toBe(false);
    expect(
      isValidIdempotencyKey("a1b2c3d4-e5f6-4789-9abc-def01234567"),
    ).toBe(false); // too short
  });

  it("G-03: rejects non-RFC-4122 variant bits", () => {
    // Variant byte must start with 8/9/a/b
    expect(
      isValidIdempotencyKey("a1b2c3d4-e5f6-4789-cabc-def012345678"),
    ).toBe(false);
  });
});
