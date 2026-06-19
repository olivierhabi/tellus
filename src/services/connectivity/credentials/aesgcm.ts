// ---------------------------------------------------------------------------
// AES-256-GCM primitive for connectivity credentials (B2).
//
// Wire format of payload ciphertext:
//   [version=1 (1)] [iv (12)] [tag (16)] [ciphertext (N)]
// Total overhead: 29 bytes.
//
// Symmetric with src/lib/kms/adapters/local-aesgcm.ts's DEK wire format —
// kept as a separate file because this layer is dataplane (per-credential
// AEAD) and the KMS layer is control-plane (per-DEK wrap). They share the
// same crypto primitive but have different security properties (DEK is
// process-local for the duration of an unwrap; payload key is per-row).
// ---------------------------------------------------------------------------

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { CredentialDecryptionFailed } from "../../../lib/errors/connectivity.errors";
import { TellusError } from "../../../lib/errors/envelope";

const WIRE_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export function generateDek(): Uint8Array {
  return new Uint8Array(randomBytes(KEY_BYTES));
}

/** Encrypt plaintext under dek; returns versioned binary blob suitable for BYTEA. */
export function encrypt(plaintext: Uint8Array, dek: Uint8Array): Uint8Array {
  if (dek.length !== KEY_BYTES) {
    throw new TellusError(CredentialDecryptionFailed, {
      reason: "DEK must be 32 bytes",
      length: dek.length,
    });
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(dek), iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const out = Buffer.alloc(1 + IV_BYTES + TAG_BYTES + ct.length);
  out[0] = WIRE_VERSION;
  iv.copy(out, 1);
  tag.copy(out, 1 + IV_BYTES);
  ct.copy(out, 1 + IV_BYTES + TAG_BYTES);
  return new Uint8Array(out);
}

/** Decrypt a versioned blob produced by `encrypt`. Throws CredentialDecryptionFailed on tag mismatch. */
export function decrypt(blob: Uint8Array, dek: Uint8Array): Uint8Array {
  const buf = Buffer.from(blob);
  if (buf.length < 1 + IV_BYTES + TAG_BYTES) {
    throw new TellusError(CredentialDecryptionFailed, {
      reason: "ciphertext too short",
      length: buf.length,
    });
  }
  if (buf[0] !== WIRE_VERSION) {
    throw new TellusError(CredentialDecryptionFailed, {
      reason: "unknown wire version",
      version: buf[0],
    });
  }
  const iv = buf.subarray(1, 1 + IV_BYTES);
  const tag = buf.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const ct = buf.subarray(1 + IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(dek), iv);
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(ct), decipher.final()]));
  } catch (e) {
    throw new TellusError(
      CredentialDecryptionFailed,
      { reason: "GCM tag verification failed" },
      e,
    );
  }
}
