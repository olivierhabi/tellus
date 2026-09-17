/**
 * tellusAuthTestHooks.ts
 * ----------------------
 * Dev-only router that Cypress uses to hard-reset MFA state between
 * test runs. Mounted by server.ts ONLY when NODE_ENV !== 'production'
 * AND TELLUS_AUTH_TEST_HOOKS=1 (the explicit credential-mutation opt-in,
 * distinct from the broader TELLUS_TEST_HOOKS), and every handler is
 * further gated by:
 *
 *   1. the X-Tellus-Test-Hook: 1 header, AND
 *   2. the raw TCP peer being loopback (socket peer, not req.ip), AND
 *   3. the TELLUS_AUTH_TEST_HOOKS=1 process opt-in.
 *
 * Security (unauth MFA-reset account takeover): these hooks DELETE second
 * factors for arbitrary usernames, so they must never be drivable by a
 * remote unauthenticated caller — the header value alone is public in the
 * source. Localhost consumers (verify-*.sh scripts, vitest-spawned
 * servers) keep working; network callers get 403. Every credential
 * mutation also emits a durable audit event (category mfa) so a silent
 * strip is detectable.
 *
 * Keeping it in its own router file makes the production bundle's
 * route table one step safer — in prod the file is imported but never
 * mounted, so the routes physically don't exist on the live app.
 */

import { Request, Response, Router } from 'express';
import crypto from 'crypto';
import { Knex } from 'knex';
import foundryDb from '../config/foundryDb';
import { getKeycloakAdminService } from '../services/keycloakAdminService';
import { TellusAuthService } from '../services/tellusAuthService';
import { emitAuditEvent } from '../services/auditEventService';
import { AppError } from '../utils/foundryAppError';
import { getKeycloakRealm } from "../auth/keycloakConfig"; // F-P4-26

let _svc: TellusAuthService | null = null;
function tellusSvc(): TellusAuthService {
  if (!_svc) {
    _svc = new TellusAuthService(foundryDb as unknown as Knex, {
      kcUrl: process.env.KEYCLOAK_URL || 'http://localhost:8086',
      kcRealm: getKeycloakRealm(),
      kcFrontendClientId: process.env.KEYCLOAK_FRONTEND_CLIENT_ID || 'tellus-frontend',
    });
  }
  return _svc;
}

const router = Router();

/**
 * Dev-only test hooks must never be drivable by a remote, unauthenticated
 * caller. Gate them on (a) an explicit opt-in env var AND (b) the raw TCP peer
 * being loopback — same pattern as the X-Tellus-Test-Auth hardening in
 * globalAuth.ts (vuln-0034). Uses the socket peer, NOT req.ip, so a forwarded
 * header cannot spoof loopback. Localhost consumers (verify-*.sh scripts,
 * vitest-spawned servers) keep working; network callers get 403.
 */
function isLoopbackPeer(req: Request): boolean {
  const ip = req.socket?.remoteAddress ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export function authorizeTestHook(req: Request): void {
  if (process.env.TELLUS_AUTH_TEST_HOOKS !== "1") {
    throw new AppError('Test hook not authorized', 403, 'FORBIDDEN');
  }
  if (req.headers['x-tellus-test-hook'] !== '1') {
    throw new AppError('Test hook not authorized', 403, 'FORBIDDEN');
  }
  if (!isLoopbackPeer(req)) {
    throw new AppError('Test hook not authorized', 403, 'FORBIDDEN');
  }
}

function envelope(code: string, status: number, message: string, req: Request) {
  return {
    errorCode: code,
    errorName: 'AuthenticationError',
    message,
    statusCode: status,
    requestId: (req.headers['x-request-id'] as string) || crypto.randomUUID(),
  };
}

// ---------------------------------------------------------------------------
// Seed-identity allowlist (Strix medium 6.5, Sept 2026): seeding a synthetic
// (never-verifiable) WebAuthn credential flips `userHasActivePasskey` for the
// target — an arbitrary-username seed locks the victim's password login into
// an unsatisfiable webauthn-only MFA challenge and satisfies the mandatory-
// passkey enrollment gate without any ceremony. Only the fixed Cypress seed
// identities may ever be seeded; extra identities for a given dev box come
// from TELLUS_AUTH_TEST_SEED_USERS (comma-separated emails, gitignored env).
// Non-allowlisted usernames get the SAME 403 envelope whether or not they
// exist in Keycloak — no existence differential, no cross-user lockout.
// ---------------------------------------------------------------------------
const SEED_ALLOWLIST_DEFAULTS = [
  'cypress@tellus.local',
  'cypress-admin@tellus.local',
  'cypress-viewer@tellus.local',
  'cypress-nogroups@tellus.local',
];

export function isSeedPasskeyAllowlisted(username: string): boolean {
  const target = username.trim().toLowerCase();
  const extras = (process.env.TELLUS_AUTH_TEST_SEED_USERS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return SEED_ALLOWLIST_DEFAULTS.includes(target) || extras.includes(target);
}

function sendError(err: unknown, req: Request, res: Response) {
  // eslint-disable-next-line no-console
  console.error('[login-bypass:sendError]', err instanceof Error ? `${err.name}: ${err.message}\n${err.stack}` : String(err));
  if (err instanceof AppError) {
    return res.status(err.statusCode).json(envelope(err.code, err.statusCode, err.message, req));
  }
  return res.status(500).json(envelope('INTERNAL_ERROR', 500, 'Internal error', req));
}

router.post('/reset-mfa', async (req: Request, res: Response) => {
  try {
    authorizeTestHook(req);
    const username = (req.body?.username as string | undefined)?.trim();
    if (!username) throw new AppError('username required', 400, 'VALIDATION_ERROR');
    const admin = getKeycloakAdminService();
    const user = await admin.findUserByEmail(username);
    if (!user) {
      // Uniform 204 for unknown users — the previous 404-vs-204 differential
      // was a username-existence oracle (vuln: unauth MFA reset). Fail closed
      // silently; the caller cannot distinguish existing from unknown users.
      res.status(204).end();
      return;
    }
    // Durable-before-ack: emit the audit row BEFORE the credential mutation,
    // so a failed audit write aborts the strip instead of silently deleting
    // a user's second factor (audit-durability contract, auditEventService).
    await emitAuditEvent({
      keycloakSub: user.id,
      category: 'mfa',
      action: 'mfa.admin-reset',
      result: 'SUCCESS',
      req,
      details: { via: 'dev-test-hook', targetUsername: username },
    });
    const db = foundryDb as unknown as Knex;
    await db('user_totp_secrets').where({ keycloak_sub: user.id }).delete();
    await db('user_webauthn_credentials').where({ keycloak_sub: user.id }).delete();
    await db('user_webauthn_challenges').where({ keycloak_sub: user.id }).delete();
    await db('auth_mfa_challenges').where({ keycloak_sub: user.id }).delete();
    await db('passkey_enrollment_tokens').where({ keycloak_sub: user.id }).delete();
    res.status(204).end();
  } catch (err) {
    sendError(err, req, res);
  }
});

// ---------------------------------------------------------------------------
// seed-passkey — inserts a dummy WebAuthn credential row for the given
// user WITHOUT running a real registration ceremony. This exists solely
// so hardening / Cypress test flows can satisfy the mandatory-passkey
// gate in /login (which refuses to issue cookies to a user who has
// zero credentials) without spinning up a real authenticator.
//
// The seeded credential is a SYNTHETIC row that will never verify a
// real WebAuthn assertion — it's enough to flip `userHasActivePasskey`
// to true. Tests that need to exercise the actual ceremony must use
// a real virtual authenticator via Cypress WebAuthn DevTools proto.
// ---------------------------------------------------------------------------
router.post('/seed-passkey', async (req: Request, res: Response) => {
  try {
    authorizeTestHook(req);
    const username = (req.body?.username as string | undefined)?.trim();
    if (!username) throw new AppError('username required', 400, 'VALIDATION_ERROR');
    // Identity allowlist BEFORE any Keycloak lookup — the uniform 403 for
    // non-allowlisted usernames removes the username-existence differential
    // and can never flip another principal's possession-factor state.
    if (!isSeedPasskeyAllowlisted(username)) {
      throw new AppError('Test hook not authorized', 403, 'FORBIDDEN');
    }
    const admin = getKeycloakAdminService();
    const user = await admin.findUserByEmail(username);
    if (!user) throw new AppError('User not found in Keycloak', 404, 'NOT_FOUND');
    const db = foundryDb as unknown as Knex;
    const existing = await db('user_webauthn_credentials')
      .where({ keycloak_sub: user.id })
      .count<{ count: string }>('* as count')
      .first();
    if (Number(existing?.count ?? 0) > 0) {
      res.status(200).json({ success: true, data: { seeded: false, reason: 'already_exists' } });
      return;
    }
    const syntheticId = `test-seed-${crypto.randomBytes(16).toString('hex')}`;
    await emitAuditEvent({
      keycloakSub: user.id,
      category: 'mfa',
      action: 'mfa.admin-seed',
      result: 'SUCCESS',
      req,
      details: { via: 'dev-test-hook', targetUsername: username, credentialId: syntheticId },
    });
    await db('user_webauthn_credentials').insert({
      keycloak_sub: user.id,
      credential_id: syntheticId,
      public_key: Buffer.from([0x00]),
      counter: 0,
      transports: [],
      device_type: 'singleDevice',
      backed_up: false,
      user_label: 'Test-seeded passkey',
      aaguid: null,
    });
    res.status(201).json({ success: true, data: { seeded: true, credentialId: syntheticId } });
  } catch (err) {
    sendError(err, req, res);
  }
});

// ---------------------------------------------------------------------------
// login-bypass — runs a full password direct-grant against Keycloak AND
// sets the normal session cookies on the response, skipping BOTH the
// MFA challenge AND the mandatory-passkey enrollment gate. Cypress +
// the hardening script use this to bootstrap a JAR session for the
// hundreds of subsequent assertions without running a real WebAuthn
// ceremony in curl. The endpoint is triple-gated:
//
//   1. NODE_ENV !== 'production' AND TELLUS_AUTH_TEST_HOOKS=1 (mount in server.ts)
//   2. X-Tellus-Test-Hook: 1 header + loopback TCP peer (authorizeTestHook)
//   3. Only issues cookies for a user whose password the caller
//      actually knows — we re-run loginWithPassword, so this is not
//      an impersonation bypass, it's just a "skip the 2nd factor"
//      shortcut that test harnesses use when they can't drive an
//      authenticator through curl.
// ---------------------------------------------------------------------------
router.post('/login-bypass', async (req: Request, res: Response) => {
  try {
    authorizeTestHook(req);
    const { username, password } = (req.body || {}) as { username?: string; password?: string };
    if (!username || !password) {
      throw new AppError('username and password required', 400, 'VALIDATION_ERROR');
    }
    const svc = tellusSvc();
    const result = await svc.loginWithPassword(username, password);
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie('TELLUS_TOKEN', result.accessToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
      maxAge: (result.expiresIn || 300) * 1000,
    });
    if (result.refreshToken) {
      res.cookie('TELLUS_REFRESH', result.refreshToken, {
        httpOnly: true,
        secure: isProd,
        sameSite: 'lax',
        path: '/api/v1/auth',
        maxAge: 8 * 60 * 60 * 1000,
      });
    }
    res.json({
      success: true,
      data: {
        tokenType: 'Bearer',
        accessToken: result.accessToken,
        expiresIn: result.expiresIn,
        tokenInfo: svc.toTokenInfo(result.claims),
      },
    });
  } catch (err) {
    sendError(err, req, res);
  }
});

export default router;
