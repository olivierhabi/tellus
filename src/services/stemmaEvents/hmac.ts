// ---------------------------------------------------------------------------
// B10 — Subscriber callback HMAC signing.
//
// Spec contracts:
//   B10-C-13  Subscriber callbacks include
//             `X-Tellus-Signature: sha256=<hex>`
//             HMAC over the body using the subscription secret.
//   §1.10     Secrets are encrypted at rest in stemma_subscription.secret_encrypted
//             (out of scope for this module; callers must decrypt before
//             calling sign()).
//
// Pure crypto. No I/O. Always uses node:crypto.createHmac under the hood.
// ---------------------------------------------------------------------------

import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "X-Tellus-Signature";
export const SIGNATURE_PREFIX = "sha256=";

/**
 * Compute the signature header value for `body` under `secret`. The body
 * is hashed as raw bytes; callers serialising JSON should hash the
 * exact bytes that will be sent on the wire (no re-stringify between
 * sign and POST or the verifier will fail).
 */
export function signCallbackBody(body: Buffer | string, secret: string): string {
  const mac = createHmac("sha256", secret);
  mac.update(body);
  return `${SIGNATURE_PREFIX}${mac.digest("hex")}`;
}

/**
 * Verify a subscriber-side signature header. Constant-time comparison
 * via timingSafeEqual; returns true only when the header is well-formed
 * AND the digest matches. A missing prefix, a non-hex tail, a
 * length-mismatched hex, or any digest mismatch returns false.
 *
 * This is the inverse of signCallbackBody and exists so a subscriber
 * implementation in this monorepo (e.g. an internal fan-out test or a
 * dev-mode echo subscriber) can verify without re-implementing.
 */
export function verifyCallbackSignature(
  header: string | undefined | null,
  body: Buffer | string,
  secret: string,
): boolean {
  if (typeof header !== "string") return false;
  if (!header.startsWith(SIGNATURE_PREFIX)) return false;
  const provided = header.slice(SIGNATURE_PREFIX.length);
  if (!/^[0-9a-f]+$/i.test(provided)) return false;

  const expected = createHmac("sha256", secret).update(body).digest("hex");
  if (provided.length !== expected.length) return false;

  // Buffer.from on hex returns equal-length buffers for equal-length hex
  // strings; the length check above is required because timingSafeEqual
  // throws on length mismatch (which would itself be a side-channel).
  return timingSafeEqual(
    Buffer.from(provided.toLowerCase(), "hex"),
    Buffer.from(expected, "hex"),
  );
}
