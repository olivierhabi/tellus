// ---------------------------------------------------------------------------
// tests/unit/code-repos/stemma-events/hmac-unit.test.ts
//
// Spec contract: B10-C-13 — subscriber callbacks include
//   `X-Tellus-Signature: sha256=<hex>` HMAC over the body using the
//   subscription secret.
//
// Pure-crypto. No I/O.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  signCallbackBody,
  verifyCallbackSignature,
  SIGNATURE_PREFIX,
  SIGNATURE_HEADER,
} from "../../../../src/services/stemmaEvents/hmac";
import { createHmac } from "node:crypto";

describe("B10-C-13 callback HMAC signing", () => {
  it("signs to `sha256=<hex>` over the raw body", () => {
    const body = JSON.stringify({ event: "PUSH", n: 1 });
    const secret = "supersecret";
    const sig = signCallbackBody(body, secret);
    expect(sig.startsWith(SIGNATURE_PREFIX)).toBe(true);
    const hex = sig.slice(SIGNATURE_PREFIX.length);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    // Independently recompute the expected hex.
    const expected = createHmac("sha256", secret).update(body).digest("hex");
    expect(hex).toBe(expected);
  });

  it("signs identical for identical input (deterministic)", () => {
    const a = signCallbackBody("body-1", "k");
    const b = signCallbackBody("body-1", "k");
    expect(a).toBe(b);
  });

  it("signs differently for different secrets", () => {
    const a = signCallbackBody("body-1", "k1");
    const b = signCallbackBody("body-1", "k2");
    expect(a).not.toBe(b);
  });

  it("signs differently for different bodies", () => {
    const a = signCallbackBody("body-1", "k");
    const b = signCallbackBody("body-2", "k");
    expect(a).not.toBe(b);
  });

  it("Buffer body produces same signature as identical-bytes string body", () => {
    const s = signCallbackBody("hello", "k");
    const b = signCallbackBody(Buffer.from("hello", "utf8"), "k");
    expect(b).toBe(s);
  });
});

describe("verifyCallbackSignature", () => {
  it("accepts a freshly signed header", () => {
    const body = "{\"x\":1}";
    const sig = signCallbackBody(body, "secret");
    expect(verifyCallbackSignature(sig, body, "secret")).toBe(true);
  });

  it("rejects a header without the sha256= prefix", () => {
    expect(verifyCallbackSignature("md5=abc", "body", "k")).toBe(false);
    expect(verifyCallbackSignature("abc", "body", "k")).toBe(false);
  });

  it("rejects a header with non-hex tail", () => {
    expect(
      verifyCallbackSignature(`${SIGNATURE_PREFIX}not-hex`, "body", "k"),
    ).toBe(false);
  });

  it("rejects a header with mismatched length (length-side-channel guard)", () => {
    // Truncated signature — must not crash, must return false.
    const sig = signCallbackBody("body", "k");
    const truncated = sig.slice(0, sig.length - 4);
    expect(verifyCallbackSignature(truncated, "body", "k")).toBe(false);
  });

  it("rejects when the body has been tampered with", () => {
    const sig = signCallbackBody("original", "k");
    expect(verifyCallbackSignature(sig, "tampered", "k")).toBe(false);
  });

  it("rejects when the secret is wrong", () => {
    const sig = signCallbackBody("body", "k1");
    expect(verifyCallbackSignature(sig, "body", "k2")).toBe(false);
  });

  it("accepts uppercase hex (case-insensitive verify; sign emits lowercase)", () => {
    const sig = signCallbackBody("body", "k");
    const upper = SIGNATURE_PREFIX + sig.slice(SIGNATURE_PREFIX.length).toUpperCase();
    expect(verifyCallbackSignature(upper, "body", "k")).toBe(true);
  });

  it("rejects undefined/null header inputs", () => {
    expect(verifyCallbackSignature(undefined, "body", "k")).toBe(false);
    expect(verifyCallbackSignature(null, "body", "k")).toBe(false);
  });

  it("constants — header name + prefix exposed for the wire layer", () => {
    expect(SIGNATURE_HEADER).toBe("X-Tellus-Signature");
    expect(SIGNATURE_PREFIX).toBe("sha256=");
  });
});
