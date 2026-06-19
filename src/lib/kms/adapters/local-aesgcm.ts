// ---------------------------------------------------------------------------
// LocalAesGcmAdapter — the default in-session / CI KMS adapter (B2 §92).
//
// KEK source: TELLUS_LOCAL_KEK_B64 env var (base64-encoded 32 bytes). For
// tenant scoping, the adapter derives a tenant-specific subkey via HKDF
// over the base KEK and the tenant id, so a leaked KEK does not unlock
// other tenants' ciphertexts (defense-in-depth; the real isolation is at
// the route+auth layer).
//
// AEAD: AES-256-GCM via node:crypto. 12-byte IV, 16-byte auth tag.
// Wire format of WrappedDek.ciphertext:
//   [version=1 (1 byte)] [iv (12 bytes)] [tag (16 bytes)] [encrypted dek (32 bytes)]
// Total: 61 bytes.
//
// Rotation: change the base KEK env, restart. Existing rows remain readable
// because each row carries the old wrapped ciphertext; B2's rotation API
// re-wraps each row with the new KEK during a background sweep.
// ---------------------------------------------------------------------------

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { CredentialDecryptionFailed, KmsUnavailable } from "../../errors/connectivity.errors";
import { TellusError } from "../../errors/envelope";
import type { KmsAdapter, WrappedDek } from "../index";

const WIRE_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const WIRE_PREFIX = 1; // version byte

function loadBaseKek(): Uint8Array {
  const b64 = process.env.TELLUS_LOCAL_KEK_B64;
  if (!b64) {
    throw new TellusError(KmsUnavailable, {
      reason: "TELLUS_LOCAL_KEK_B64 not set",
      adapter: "local-aesgcm",
    });
  }
  const buf = Buffer.from(b64, "base64");
  if (buf.length !== KEY_BYTES) {
    throw new TellusError(KmsUnavailable, {
      reason: "TELLUS_LOCAL_KEK_B64 must decode to 32 bytes",
      length: buf.length,
    });
  }
  return new Uint8Array(buf);
}

function deriveTenantKey(baseKek: Uint8Array, tenant: string): Buffer {
  // HKDF-SHA256: salt = 'tellus.kms.local-aesgcm.v1', info = tenant.
  const derived = hkdfSync(
    "sha256",
    baseKek,
    Buffer.from("tellus.kms.local-aesgcm.v1"),
    Buffer.from(tenant, "utf8"),
    KEY_BYTES,
  );
  return Buffer.from(derived);
}

export class LocalAesGcmAdapter implements KmsAdapter {
  readonly id = "local-aesgcm";

  async wrap(
    plaintextDek: Uint8Array,
    opts: { tenant: string },
  ): Promise<WrappedDek> {
    if (plaintextDek.length !== KEY_BYTES) {
      throw new TellusError(KmsUnavailable, {
        reason: "DEK must be 32 bytes",
        length: plaintextDek.length,
      });
    }
    const tenantKey = deriveTenantKey(loadBaseKek(), opts.tenant);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", tenantKey, iv);
    const ct = Buffer.concat([cipher.update(plaintextDek), cipher.final()]);
    const tag = cipher.getAuthTag();
    const out = Buffer.alloc(WIRE_PREFIX + IV_BYTES + TAG_BYTES + ct.length);
    out[0] = WIRE_VERSION;
    iv.copy(out, WIRE_PREFIX);
    tag.copy(out, WIRE_PREFIX + IV_BYTES);
    ct.copy(out, WIRE_PREFIX + IV_BYTES + TAG_BYTES);
    return {
      ciphertext: new Uint8Array(out),
      keyId: `local-aesgcm:hkdf(${opts.tenant})`,
      adapter: this.id,
    };
  }

  async unwrap(
    wrapped: WrappedDek,
    opts: { tenant: string },
  ): Promise<Uint8Array> {
    const buf = Buffer.from(wrapped.ciphertext);
    if (buf.length < WIRE_PREFIX + IV_BYTES + TAG_BYTES + 1) {
      throw new TellusError(CredentialDecryptionFailed, {
        reason: "wrapped DEK too short",
        length: buf.length,
      });
    }
    if (buf[0] !== WIRE_VERSION) {
      throw new TellusError(CredentialDecryptionFailed, {
        reason: "unknown wire version",
        version: buf[0],
      });
    }
    const iv = buf.subarray(WIRE_PREFIX, WIRE_PREFIX + IV_BYTES);
    const tag = buf.subarray(
      WIRE_PREFIX + IV_BYTES,
      WIRE_PREFIX + IV_BYTES + TAG_BYTES,
    );
    const ct = buf.subarray(WIRE_PREFIX + IV_BYTES + TAG_BYTES);
    const tenantKey = deriveTenantKey(loadBaseKek(), opts.tenant);
    try {
      const decipher = createDecipheriv("aes-256-gcm", tenantKey, iv);
      decipher.setAuthTag(tag);
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      if (pt.length !== KEY_BYTES) {
        throw new TellusError(CredentialDecryptionFailed, {
          reason: "DEK length mismatch after decrypt",
          length: pt.length,
        });
      }
      return new Uint8Array(pt);
    } catch (e) {
      // GCM tag mismatch lands here; never include plaintext in the parameters.
      throw new TellusError(
        CredentialDecryptionFailed,
        { reason: "GCM tag verification failed" },
        e,
      );
    }
  }

  async describeKey(opts: { tenant: string }): Promise<{
    keyId: string;
    adapter: string;
    rotationEnabled: boolean;
    lastRotatedAt: null;
  }> {
    // KEK rotation is operator-driven (env var swap); we can't observe it
    // from here. The vault's rewrap sweep records its own audit rows.
    return {
      keyId: `local-aesgcm:hkdf(${opts.tenant})`,
      adapter: this.id,
      rotationEnabled: true,
      lastRotatedAt: null,
    };
  }
}
