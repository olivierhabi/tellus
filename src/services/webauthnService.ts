/**
 * webauthnService.ts
 * ------------------
 * In-app FIDO2 / WebAuthn flows — no redirect to the Keycloak hostname.
 *
 * Uses @simplewebauthn/server as the Relying Party. The RP ID is the
 * tellus-fe hostname (no port component), which lets the same credential
 * work regardless of whether the developer is browsing on :3000 or :3001.
 * Passkeys are stored in the tellus database (user_webauthn_credentials)
 * keyed on the Keycloak `sub` — Keycloak remains the identity source,
 * but the credential UX lives entirely inside tellus.
 *
 * Two flows implemented here:
 *
 *   register() → verifyRegistration()
 *     Enrolls a new passkey for the currently-signed-in user. Used by
 *     /settings/passkeys via the backend /auth/me/webauthn/register-*
 *     endpoints. Accepts both standard (second-factor) and passwordless
 *     resident-key ceremonies.
 *
 *   authenticate() → verifyAuthentication()
 *     Drives the second step of the two-step /auth/login flow. The FE
 *     shows a "use your passkey" button; clicking it calls
 *     authenticate(), the browser runs navigator.credentials.get(),
 *     the assertion comes back to verifyAuthentication() which checks
 *     the signature and counter.
 */

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  GenerateRegistrationOptionsOpts,
  VerifyRegistrationResponseOpts,
  VerifiedRegistrationResponse,
  VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import type { Knex } from 'knex';
import { AppError } from '../utils/foundryAppError';

export interface WebauthnServiceConfig {
  rpName: string;
  rpID: string;
  expectedOrigins: string[];
}

export interface StoredCredential {
  id: string;
  keycloakSub: string;
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
  userLabel: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function normalizeBuffer(input: unknown): Uint8Array {
  if (input instanceof Uint8Array) return new Uint8Array(input);
  if (Buffer.isBuffer(input)) return new Uint8Array(input);
  throw new Error('invalid credential public key');
}

export class WebauthnService {
  constructor(private knex: Knex, private config: WebauthnServiceConfig) {}

  // -------- read helpers -------------------------------------------------

  async listByUser(keycloakSub: string): Promise<StoredCredential[]> {
    const rows = await this.knex('user_webauthn_credentials')
      .where({ keycloak_sub: keycloakSub })
      .orderBy('created_at', 'desc');
    return rows.map(this.rowToCredential);
  }

  async hasAny(keycloakSub: string): Promise<boolean> {
    const row = await this.knex('user_webauthn_credentials')
      .where({ keycloak_sub: keycloakSub })
      .count<{ count: string }>('* as count')
      .first();
    return Number(row?.count ?? 0) > 0;
  }

  async deleteCredential(keycloakSub: string, id: string): Promise<void> {
    const affected = await this.knex('user_webauthn_credentials')
      .where({ keycloak_sub: keycloakSub, id })
      .delete();
    if (!affected) {
      throw new AppError('Passkey not found', 404, 'NOT_FOUND');
    }
  }

  private rowToCredential = (r: {
    id: string;
    keycloak_sub: string;
    credential_id: string;
    public_key: Buffer;
    counter: string | number;
    transports: string[];
    device_type: 'singleDevice' | 'multiDevice';
    backed_up: boolean;
    user_label: string;
    created_at: Date;
    last_used_at: Date | null;
  }): StoredCredential => ({
    id: r.id,
    keycloakSub: r.keycloak_sub,
    credentialId: r.credential_id,
    publicKey: normalizeBuffer(r.public_key),
    counter: Number(r.counter),
    transports: r.transports ?? [],
    deviceType: r.device_type,
    backedUp: r.backed_up,
    userLabel: r.user_label,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  });

  // -------- registration --------------------------------------------------

  async buildRegistrationOptions(opts: {
    keycloakSub: string;
    userName: string;
    displayName: string;
    userLabel: string;
    /**
     * Discoverable-credential policy. Defaults to 'required' so the
     * authenticator stores the credential locally (real passkey UX —
     * Touch ID / Windows Hello / iCloud Keychain sync / etc.) and the
     * user doesn't have to type a username on subsequent logins. The
     * setting can be relaxed to 'preferred' for the legacy second-
     * factor flow, but mandatory-passkey enrollment should always use
     * 'required'.
     */
    residentKey?: 'required' | 'preferred' | 'discouraged';
    /**
     * When 'required' we force the authenticator to actually verify
     * the human (Touch ID biometric, macOS password, Windows Hello,
     * security key PIN). 'preferred' accepts an un-verifying tap,
     * which is NOT enough to count as a possession factor for the
     * mandatory-passkey policy. Default 'required'.
     */
    userVerification?: 'required' | 'preferred' | 'discouraged';
    /**
     * Restricts the ceremony to built-in platform authenticators
     * (Touch ID, Windows Hello, Android biometrics) or roaming
     * security keys. Undefined means "either is fine" — the browser
     * shows the user a picker. Leave undefined by default so a
     * MacBook user sees Touch ID AND has the option to plug in a
     * YubiKey if they prefer.
     */
    authenticatorAttachment?: 'platform' | 'cross-platform';
  }) {
    const existing = await this.listByUser(opts.keycloakSub);
    const residentKey = opts.residentKey ?? 'required';
    const userVerification = opts.userVerification ?? 'required';
    const regOpts: GenerateRegistrationOptionsOpts = {
      rpName: this.config.rpName,
      rpID: this.config.rpID,
      userName: opts.userName,
      userDisplayName: opts.displayName,
      attestationType: 'none',
      // Timeout tuned for platform authenticators — Touch ID and
      // Windows Hello usually resolve within 30s, and the browser
      // will abort the ceremony if the user doesn't confirm in time.
      timeout: 60_000,
      excludeCredentials: existing.map((c) => ({
        id: c.credentialId,
        transports: c.transports as ('usb' | 'ble' | 'nfc' | 'internal' | 'hybrid')[],
      })),
      authenticatorSelection: {
        residentKey,
        // requireResidentKey must track residentKey='required' for
        // backward-compat with authenticators that only look at the
        // boolean field. simplewebauthn computes this for you when
        // residentKey is 'required', but we set it explicitly so the
        // intent is obvious to a reviewer.
        requireResidentKey: residentKey === 'required',
        userVerification,
        ...(opts.authenticatorAttachment
          ? { authenticatorAttachment: opts.authenticatorAttachment }
          : {}),
      },
      supportedAlgorithmIDs: [-7, -257], // ES256 + RS256, matching realm policy
    };

    const options = await generateRegistrationOptions(regOpts);

    await this.knex('user_webauthn_challenges').insert({
      keycloak_sub: opts.keycloakSub,
      kind: 'register',
      challenge: options.challenge,
      user_label: opts.userLabel,
      expires_at: new Date(Date.now() + CHALLENGE_TTL_MS),
    });

    return options;
  }

  async verifyRegistration(
    keycloakSub: string,
    response: RegistrationResponseJSON,
  ): Promise<{ credentialId: string; userLabel: string }> {
    const challengeRow = await this.knex('user_webauthn_challenges')
      .where({ keycloak_sub: keycloakSub, kind: 'register' })
      .orderBy('created_at', 'desc')
      .first();
    if (!challengeRow) {
      throw new AppError('No active registration challenge', 400, 'NO_CHALLENGE');
    }
    if (new Date(challengeRow.expires_at) < new Date()) {
      throw new AppError('Registration challenge expired', 400, 'CHALLENGE_EXPIRED');
    }

    const verifyOpts: VerifyRegistrationResponseOpts = {
      response,
      expectedChallenge: challengeRow.challenge,
      expectedOrigin: this.config.expectedOrigins,
      expectedRPID: this.config.rpID,
      // Mandatory-passkey policy: reject any ceremony where the
      // authenticator didn't actually verify the human. The `UV`
      // flag in the attestation must be set — otherwise a malicious
      // caller could enroll a credential that logs in silently with
      // a tap, which is no better than a password.
      requireUserVerification: true,
    };

    const verification: VerifiedRegistrationResponse = await verifyRegistrationResponse(verifyOpts);
    if (!verification.verified || !verification.registrationInfo) {
      throw new AppError('Passkey verification failed', 400, 'VERIFICATION_FAILED');
    }

    const info = verification.registrationInfo;
    const credential = info.credential;
    await this.knex('user_webauthn_credentials').insert({
      keycloak_sub: keycloakSub,
      credential_id: credential.id,
      public_key: Buffer.from(credential.publicKey as Uint8Array),
      counter: credential.counter,
      transports: credential.transports ?? [],
      device_type: info.credentialDeviceType,
      backed_up: info.credentialBackedUp,
      user_label: challengeRow.user_label || 'Unnamed passkey',
      aaguid: info.aaguid ?? null,
    });

    await this.knex('user_webauthn_challenges').where({ id: challengeRow.id }).delete();

    return {
      credentialId: credential.id,
      userLabel: challengeRow.user_label || 'Unnamed passkey',
    };
  }

  // -------- authentication (used as MFA step 2) ---------------------------

  async buildAuthenticationOptions(
    keycloakSub: string,
    kind: 'mfa-login' | 'auth',
  ) {
    const credentials = await this.listByUser(keycloakSub);
    if (credentials.length === 0) {
      throw new AppError('No passkeys enrolled', 400, 'NO_CREDENTIALS');
    }
    const options = await generateAuthenticationOptions({
      rpID: this.config.rpID,
      timeout: 60_000,
      allowCredentials: credentials.map((c) => ({
        id: c.credentialId,
        transports: c.transports as ('usb' | 'ble' | 'nfc' | 'internal' | 'hybrid')[],
      })),
      // Force Touch ID / Windows Hello / PIN to actually run. The
      // possession factor is only meaningful if the user was also
      // present at the authenticator — a bare-tap signature is not
      // enough to count as MFA under the mandatory-passkey policy.
      userVerification: 'required',
    });

    await this.knex('user_webauthn_challenges').insert({
      keycloak_sub: keycloakSub,
      kind,
      challenge: options.challenge,
      expires_at: new Date(Date.now() + CHALLENGE_TTL_MS),
    });

    return options;
  }

  async verifyAuthentication(
    keycloakSub: string,
    kind: 'mfa-login' | 'auth',
    response: AuthenticationResponseJSON,
  ): Promise<{ credentialId: string }> {
    const challengeRow = await this.knex('user_webauthn_challenges')
      .where({ keycloak_sub: keycloakSub, kind })
      .orderBy('created_at', 'desc')
      .first();
    if (!challengeRow) {
      throw new AppError('No active authentication challenge', 400, 'NO_CHALLENGE');
    }
    if (new Date(challengeRow.expires_at) < new Date()) {
      throw new AppError('Authentication challenge expired', 400, 'CHALLENGE_EXPIRED');
    }

    const stored = await this.knex('user_webauthn_credentials')
      .where({ keycloak_sub: keycloakSub, credential_id: response.id })
      .first();
    if (!stored) {
      throw new AppError('Unknown passkey for this user', 404, 'NOT_FOUND');
    }

    const pkBytes = normalizeBuffer(stored.public_key);
    const verification: VerifiedAuthenticationResponse = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challengeRow.challenge,
      expectedOrigin: this.config.expectedOrigins,
      expectedRPID: this.config.rpID,
      credential: {
        id: stored.credential_id,
        publicKey: new Uint8Array(pkBytes),
        counter: Number(stored.counter),
        transports: stored.transports ?? [],
      },
      // Must match buildAuthenticationOptions — an assertion without
      // the UV bit set gets rejected here so MFA actually requires
      // a biometric / PIN, not just an authenticator tap.
      requireUserVerification: true,
    });

    if (!verification.verified) {
      throw new AppError('Passkey assertion invalid', 401, 'VERIFICATION_FAILED');
    }

    // counter bump + last_used
    await this.knex('user_webauthn_credentials')
      .where({ id: stored.id })
      .update({
        counter: verification.authenticationInfo.newCounter,
        last_used_at: new Date(),
      });

    await this.knex('user_webauthn_challenges').where({ id: challengeRow.id }).delete();

    return { credentialId: response.id };
  }
}

let singleton: WebauthnService | null = null;
export function getWebauthnService(knex: Knex): WebauthnService {
  if (!singleton) {
    const rpID = process.env.TELLUS_WEBAUTHN_RP_ID || 'localhost';
    const originsRaw = process.env.TELLUS_WEBAUTHN_ORIGINS
      || 'http://localhost:3000,http://localhost:3001';
    singleton = new WebauthnService(knex, {
      rpName: process.env.TELLUS_WEBAUTHN_RP_NAME || 'Tellus Ontology Platform',
      rpID,
      expectedOrigins: originsRaw.split(',').map((s) => s.trim()).filter(Boolean),
    });
  }
  return singleton;
}
