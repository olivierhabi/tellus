// ---------------------------------------------------------------------------
// KmsAdapter — pluggable key-management surface for the connectivity
// credential vault (B2). Adapters: local-aesgcm (default), vault-transit,
// aws-kms, gcp-kms. Selection via TELLUS_KMS_ADAPTER env var.
//
// Wrap/unwrap operate on a 32-byte DEK; the DEK itself encrypts/decrypts
// the actual credential plaintext via AES-256-GCM (see credentials/aesgcm.ts).
// This split keeps adapter implementations simple and KMS round-trips O(1)
// per credential operation regardless of plaintext size.
// ---------------------------------------------------------------------------

import { KmsUnavailable } from "../errors/connectivity.errors";
import { TellusError } from "../errors/envelope";

export interface WrappedDek {
  /** Wrapped DEK bytes — opaque to the adapter's caller. */
  ciphertext: Uint8Array;
  /** KMS key identifier (URI, ARN, key name). */
  keyId: string;
  /** Adapter id, e.g. 'local-aesgcm'. */
  adapter: string;
}

export interface KmsAdapter {
  /** Adapter identifier; persisted in connectivity_credentials.kms_adapter. */
  readonly id: string;

  /**
   * Wrap a freshly-generated 32-byte DEK with the tenant-scoped KEK and
   * return ciphertext + key metadata for storage.
   */
  wrap(plaintextDek: Uint8Array, opts: { tenant: string }): Promise<WrappedDek>;

  /**
   * Unwrap a previously-wrapped DEK. Throws TellusError(KmsUnavailable) on
   * a KMS-side failure; throws TellusError(CredentialDecryptionFailed) on
   * AEAD/tag verification failure.
   */
  unwrap(
    wrapped: WrappedDek,
    opts: { tenant: string },
  ): Promise<Uint8Array>;

  /** Returns operator-visible metadata about the configured key. */
  describeKey(opts: { tenant: string }): Promise<{
    keyId: string;
    adapter: string;
    rotationEnabled: boolean;
    /** ISO-8601 or null. Best-effort; some adapters don't expose. */
    lastRotatedAt?: string | null;
  }>;
}

/**
 * Process-singleton KMS adapter selector. The first call reads env and
 * binds the active adapter; subsequent calls return the same instance.
 *
 * Tests inject a test adapter via setKmsAdapter().
 */
let active: KmsAdapter | null = null;

export function getKmsAdapter(): KmsAdapter {
  if (active) return active;
  const explicit = process.env.TELLUS_KMS_ADAPTER?.trim();
  const id = (explicit ?? "local-aesgcm").toLowerCase();

  // Production guard. The local-aesgcm adapter keeps the KEK in process memory
  // / local env with no HSM-backed isolation, so it must never be the SILENT
  // default in production. Fail closed: in production a managed adapter must be
  // configured explicitly, and selecting local-aesgcm requires an acknowledged
  // opt-in so the weaker posture is always a deliberate operator choice.
  const isProd = (process.env.NODE_ENV ?? "").toLowerCase() === "production";
  if (isProd && id === "local-aesgcm") {
    if (!explicit) {
      throw new TellusError(KmsUnavailable, {
        reason: "no_kms_adapter_configured_in_production",
        hint: "set TELLUS_KMS_ADAPTER to a managed adapter (vault-transit, aws-kms, gcp-kms)",
      });
    }
    if (process.env.TELLUS_ALLOW_LOCAL_KMS !== "1") {
      throw new TellusError(KmsUnavailable, {
        reason: "local_kms_adapter_forbidden_in_production",
        hint: "use a managed KMS, or set TELLUS_ALLOW_LOCAL_KMS=1 to deliberately accept the local adapter",
      });
    }
  }

  switch (id) {
    case "local-aesgcm": {
      // Lazy import — keeps adapter modules out of the cold-start unless
      // selected.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { LocalAesGcmAdapter } = require("./adapters/local-aesgcm");
      active = new LocalAesGcmAdapter();
      return active!;
    }
    case "vault-transit": {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { VaultTransitAdapter } = require("./adapters/vault-transit");
      active = new VaultTransitAdapter();
      return active!;
    }
    case "aws-kms": {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { AwsKmsAdapter } = require("./adapters/aws-kms");
      active = new AwsKmsAdapter();
      return active!;
    }
    case "gcp-kms": {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { GcpKmsAdapter } = require("./adapters/gcp-kms");
      active = new GcpKmsAdapter();
      return active!;
    }
    default:
      throw new TellusError(KmsUnavailable, { configured: id, reason: "unknown_adapter_id" });
  }
}

export function setKmsAdapter(adapter: KmsAdapter | null): void {
  active = adapter;
}
