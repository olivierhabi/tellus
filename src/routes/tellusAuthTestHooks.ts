/**
 * tellusAuthTestHooks.ts
 * ----------------------
 * Dev-only router that Cypress uses to hard-reset MFA state between
 * test runs. Mounted by server.ts ONLY when NODE_ENV !== 'production'
 * and further gated by requiring the X-Tellus-Test-Hook: 1 header, so
 * even a developer running against a shared staging environment can't
 * accidentally nuke a user's credentials by curling this.
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
import { AppError } from '../utils/foundryAppError';

let _svc: TellusAuthService | null = null;
function tellusSvc(): TellusAuthService {
  if (!_svc) {
    _svc = new TellusAuthService(foundryDb as unknown as Knex, {
      kcUrl: process.env.KEYCLOAK_URL || 'http://localhost:8086',
      kcRealm: process.env.KEYCLOAK_REALM || 'tellus',
      kcFrontendClientId: process.env.KEYCLOAK_FRONTEND_CLIENT_ID || 'tellus-frontend',
    });
  }
  return _svc;
}

const router = Router();

function envelope(code: string, status: number, message: string, req: Request) {
  return {
    errorCode: code,
    errorName: 'AuthenticationError',
    message,
    statusCode: status,
    requestId: (req.headers['x-request-id'] as string) || crypto.randomUUID(),
  };
}

function sendError(err: unknown, req: Request, res: Response) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json(envelope(err.code, err.statusCode, err.message, req));
  }
  return res.status(500).json(envelope('INTERNAL_ERROR', 500, 'Internal error', req));
}

router.post('/reset-mfa', async (req: Request, res: Response) => {
  try {
    if (req.headers['x-tellus-test-hook'] !== '1') {
      throw new AppError('Test hook not authorized', 403, 'FORBIDDEN');
    }
    const username = (req.body?.username as string | undefined)?.trim();
    if (!username) throw new AppError('username required', 400, 'VALIDATION_ERROR');
    const admin = getKeycloakAdminService();
    const user = await admin.findUserByEmail(username);
    if (!user) throw new AppError('User not found in Keycloak', 404, 'NOT_FOUND');
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
    if (req.headers['x-tellus-test-hook'] !== '1') {
      throw new AppError('Test hook not authorized', 403, 'FORBIDDEN');
    }
    const username = (req.body?.username as string | undefined)?.trim();
    if (!username) throw new AppError('username required', 400, 'VALIDATION_ERROR');
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
//   1. NODE_ENV !== 'production' (mount in server.ts)
//   2. X-Tellus-Test-Hook: 1 header
//   3. Only issues cookies for a user whose password the caller
//      actually knows — we re-run loginWithPassword, so this is not
//      an impersonation bypass, it's just a "skip the 2nd factor"
//      shortcut that test harnesses use when they can't drive an
//      authenticator through curl.
// ---------------------------------------------------------------------------
router.post('/login-bypass', async (req: Request, res: Response) => {
  try {
    if (req.headers['x-tellus-test-hook'] !== '1') {
      throw new AppError('Test hook not authorized', 403, 'FORBIDDEN');
    }
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
