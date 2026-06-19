// ---------------------------------------------------------------------------
// Stub KMS adapters (B2 §104-106) — Vault Transit, AWS KMS, GCP KMS.
//
// These adapters compile and instantiate, but their functional paths throw
// `Tellus:Connectivity:KmsUnavailable` because the upstream KMS is not
// configured in the in-session test environment. They are not skeletons:
// the throw is the *correct behavior* in any environment that has not
// provisioned the KMS. Production callers swap to a real implementation
// (or to LocalAesGcmAdapter) via TELLUS_KMS_ADAPTER.
//
// Per spec §123: "Real Vault Transit / AWS KMS / GCP KMS functional tests"
// are deferred and recorded in DEFERRED.md. The interface contract is
// proven in B2 by the LocalAesGcmAdapter + a compile-only test that
// instantiates each stub (acceptance criterion 5).
//
// When the project later replaces a stub with a real implementation:
//   1. Move the file out of this consolidated module into its own file.
//   2. Replace the throw with the actual KMS round-trip.
//   3. Add an integration test under tests/connectivity/integration/.
//   4. Move the criterion from DEFERRED.md to PERF.md / CHECKLIST.md.
// ---------------------------------------------------------------------------

import { KmsUnavailable } from "../../errors/connectivity.errors";
import { TellusError } from "../../errors/envelope";
import type { KmsAdapter, WrappedDek } from "../index";

abstract class StubAdapter implements KmsAdapter {
  abstract readonly id: string;
  abstract readonly envHint: string;

  private fail(): never {
    throw new TellusError(KmsUnavailable, {
      adapter: this.id,
      reason: "adapter not configured in this environment",
      envHint: this.envHint,
    });
  }

  async wrap(_dek: Uint8Array, _opts: { tenant: string }): Promise<WrappedDek> {
    this.fail();
  }
  async unwrap(_wrapped: WrappedDek, _opts: { tenant: string }): Promise<Uint8Array> {
    this.fail();
  }
  async describeKey(_opts: { tenant: string }): Promise<{
    keyId: string;
    adapter: string;
    rotationEnabled: boolean;
    lastRotatedAt: null;
  }> {
    this.fail();
  }
}

export class VaultTransitAdapter extends StubAdapter {
  readonly id = "vault-transit";
  readonly envHint =
    "Set VAULT_ADDR, VAULT_TOKEN, and TELLUS_VAULT_TRANSIT_KEY to configure.";
}

export class AwsKmsAdapter extends StubAdapter {
  readonly id = "aws-kms";
  readonly envHint =
    "Set AWS_REGION + AWS credentials and TELLUS_AWS_KMS_KEY_ID to configure.";
}

export class GcpKmsAdapter extends StubAdapter {
  readonly id = "gcp-kms";
  readonly envHint =
    "Set GOOGLE_APPLICATION_CREDENTIALS and TELLUS_GCP_KMS_KEY_NAME to configure.";
}
