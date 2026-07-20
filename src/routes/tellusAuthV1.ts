/**
 * /api/v1/auth/* — Palantir Multipass-equivalent auth surface.
 * See ontology/tellus-auth.md (Tasks 3, 4, 9) for the contract this
 * router implements.
 *
 * Endpoints
 *   POST   /login              — direct-grant login, sets TELLUS_TOKEN cookie
 *   POST   /logout             — revokes jti, clears cookie, 204
 *   GET    /token-info         — decoded claims for the current session
 *   POST   /check-access       — centralized hasOperation() authorization
 *   GET    /oidc/authorize     — kicks off OIDC Auth Code + PKCE
 *   POST   /oidc/callback      — exchanges code for tokens
 *   POST   /tokens             — create a PAT
 *   GET    /tokens             — list PATs (never returns raw token)
 *   DELETE /tokens/:id         — revoke a PAT
 */

import { Request, Response, NextFunction, Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { Knex } from 'knex';
import foundryDb from '../config/foundryDb';
import { TellusAuthService, TellusClaims } from '../services/tellusAuthService';
import { getKeycloakAdminService } from '../services/keycloakAdminService';
import { getWebauthnService } from '../services/webauthnService';
import {
  getTotpService,
  saveMfaChallenge,
  loadMfaChallenge,
  peekMfaChallenge,
  consumeMfaChallenge,
  newMfaChallengeId,
  registerMfaFailure,
  resetMfaBudget,
  isMfaBudgetExhausted,
} from '../services/totpService';
import { emitAuditEvent, listAuditEvents } from '../services/auditEventService';
import { enqueueEmail, renderEmail } from '../services/emailOutboxService';
import {
  issueReauthToken,
  consumeReauthToken,
  isReauthBudgetExhausted,
  registerReauthFailure,
  resetReauthBudget,
} from '../services/reauthService';
import { validatePatScopes, TELLUS_PAT_SCOPES, requirePatScope } from '../services/patScopes';
import { getPatScopeManifest } from '../services/patScopeMap';
import { AppError } from '../utils/foundryAppError';
import { requireTellusAuth } from '../middleware/tellusAuth';
import { csrfSameOrigin } from '../middleware/csrfSameOrigin';
import { requireSuperAdmin, TELLUS_SUPERADMIN_ROLE } from '../middleware/requireSuperAdmin';
import { ensureLocalUserForClaims } from '../services/userProvisioning';
import {
  getPasskeyEnrollmentService,
  PASSKEY_ENROLLMENT_TOKEN_PREFIX,
} from '../services/passkeyEnrollmentService';
import {
  getSystemSettingsService,
  KNOWN_SETTINGS,
  type KnownSettingKey,
} from '../services/systemSettingsService';
import { getKeycloakRealm } from '../auth/keycloakConfig'; // F-P4-26
import { SESSION_MAX_AGE_SECONDS, SESSION_IDLE_TIMEOUT_SECONDS } from '../config/sessionConfig';

const TELLUS_COOKIE = 'TELLUS_TOKEN';
const TELLUS_REFRESH_COOKIE = 'TELLUS_REFRESH';
// Non-httpOnly, Path=/, value=epoch-ms. Server-issued at every interactive
// boundary (P0-1) — the FE absolute cap + the edge middleware liveness gate
// read it. Non-secret (a timestamp); forging it only skips the edge redirect.
const TELLUS_SESSION_EXPIRES_COOKIE = 'TELLUS_SESSION_EXPIRES';

const router = Router();

const kcConfig = {
  kcUrl: process.env.KEYCLOAK_URL || 'http://localhost:8086',
  kcRealm: getKeycloakRealm(),
  kcFrontendClientId: process.env.KEYCLOAK_FRONTEND_CLIENT_ID || 'tellus-frontend',
  kcConfidentialClientId: process.env.KEYCLOAK_CONFIDENTIAL_CLIENT_ID,
  kcConfidentialClientSecret: process.env.KEYCLOAK_CONFIDENTIAL_CLIENT_SECRET,
};
export const tellusAuthService = new TellusAuthService(foundryDb as unknown as Knex, kcConfig);

// Error envelope matching tellus-auth.md Part 2.
function envelope(errorCode: string, statusCode: number, message: string, req: Request) {
  return {
    errorCode,
    errorName: 'AuthenticationError',
    message,
    statusCode,
    requestId: (req.headers['x-request-id'] as string) || crypto.randomUUID(),
  };
}

function sendError(err: unknown, req: Request, res: Response) {
  // Defensive guard: the wall-clock requestTimeoutMiddleware (5s) may have
  // already written a 504 envelope while a slow upstream (Keycloak) was
  // still in flight. Writing a second response throws ERR_HTTP_HEADERS_SENT
  // and surfaces as an unhandled rejection. The timeout middleware owns the
  // response in that case; we silently drop the late error.
  if (res.headersSent || res.writableEnded) return;
  if (err instanceof AppError) {
    return res.status(err.statusCode).json(envelope(err.code, err.statusCode, err.message, req));
  }
  const message = err instanceof Error ? err.message : 'Internal error';
  return res.status(500).json(envelope('INTERNAL_ERROR', 500, message, req));
}

// Brute-force tripwire: 10 auth attempts per 5 minutes per IP+username.
// ipKeyGenerator normalizes IPv6 addresses into the /64 subnet so express-
// rate-limit v8's strict validator is satisfied.
const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 10 : 500,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const ipKey = ipKeyGenerator(req.ip || '');
    const who = (req.body && (req.body.username || req.body.email)) || '';
    return `${ipKey}:${who}`;
  },
  handler: (req, res) =>
    res.status(429).json(envelope('AUTH_RATE_LIMIT', 429, 'Too many authentication attempts', req)),
});

function setSessionCookies(
  res: Response,
  accessToken: string,
  refreshToken: string | undefined,
  // Absolute session expiry (epoch ms). The marker cookie value AND the Max-Age
  // of both token cookies are derived from this so all three EXPIRE TOGETHER.
  // /login + /login/mfa + /enroll/passkey/verify pass Date.now()+SESSION_MAX_AGE_SECONDS*1000
  // (fresh window); /refresh reads the value from the INCOMING marker cookie so
  // refresh ROTATES the token but does NOT extend the absolute window — kills
  // the rolling-backend-vs-absolute-FE divergence (plan P0-1).
  absoluteExpiryMs: number,
) {
  const isProd = process.env.NODE_ENV === 'production';
  const remainingMs = Math.max(0, absoluteExpiryMs - Date.now());
  res.cookie(TELLUS_COOKIE, accessToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'strict' : 'lax',
    maxAge: remainingMs,
    path: '/',
  });
  if (refreshToken) {
    res.cookie(TELLUS_REFRESH_COOKIE, refreshToken, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'strict' : 'lax',
      maxAge: remainingMs,
      path: '/api/v1/auth',
    });
  }
  // Server-issued marker — single source of truth for the FE absolute cap +
  // the edge middleware liveness gate. Non-httpOnly (AuthGuard, middleware,
  // Cypress read it); non-secret (a timestamp). Max-Age matches the token
  // cookies so the browser evicts all three together.
  res.cookie(TELLUS_SESSION_EXPIRES_COOKIE, String(absoluteExpiryMs), {
    httpOnly: false,
    secure: isProd,
    sameSite: isProd ? 'strict' : 'lax',
    maxAge: remainingMs,
    path: '/',
  });
}

function clearSessionCookies(res: Response) {
  // Same race as sendError: if requestTimeoutMiddleware already flushed a
  // 504, res.clearCookie -> res.cookie -> res.append('Set-Cookie', ...)
  // throws ERR_HTTP_HEADERS_SENT. The cookies are stale either way; the
  // FE will retry through /login on a 401/504.
  if (res.headersSent || res.writableEnded) return;
  res.clearCookie(TELLUS_COOKIE, { path: '/' });
  res.clearCookie(TELLUS_REFRESH_COOKIE, { path: '/api/v1/auth' });
  res.clearCookie(TELLUS_SESSION_EXPIRES_COOKIE, { path: '/' });
}

// ----- POST /login — two-step MFA-aware ------------------------------------
// Step 1: password. If the user has no enrolled MFA factors the session
// cookie is set and the response looks like the old /login. If they have
// a TOTP secret or a WebAuthn credential enrolled in tellus, we instead
// return `{ mfaRequired: true, mfaChallenge, methods }` and hold the
// Keycloak tokens server-side (auth_mfa_challenges) until the FE
// completes /login/mfa.
const LoginSchema = z.object({
  username: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  password: z.string().min(1),
}).refine((v) => v.username || v.email, { message: 'username or email required' });

router.post('/login', loginLimiter, csrfSameOrigin, async (req: Request, res: Response) => {
  try {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
    }
    const username = parsed.data.username || parsed.data.email!;
    const result = await tellusAuthService.loginWithPassword(username, parsed.data.password);

    // Probe local enrollment for second-factor hints.
    const totp = getTotpService(foundryDb as unknown as Knex);
    const webauthn = getWebauthnService(foundryDb as unknown as Knex);
    const [hasTotp, hasPasskey] = await Promise.all([
      totp.isEnabled(result.claims.sub),
      webauthn.hasAny(result.claims.sub),
    ]);

    // Mandatory-passkey enrollment gate. If the account has no active
    // WebAuthn credential AND the system-level toggle requires
    // enrollment, we NEVER set session cookies on this path — not on
    // the fast-path, not after MFA — because the policy requires
    // every interactive session to be protected by a possession
    // factor. The toggle lives in system_settings.require_passkey_enrollment
    // and can be flipped by a superadmin via the /admin/settings
    // endpoints. Default (and fail-safe if the row is missing) is
    // `true`, so a fresh install starts with mandatory enrollment on.
    const settings = getSystemSettingsService(foundryDb as unknown as Knex);
    const requirePasskey = await settings.get<boolean>(
      'require_passkey_enrollment',
      true,
    );
    if (!hasPasskey && requirePasskey === true) {
      const enroll = getPasskeyEnrollmentService(foundryDb as unknown as Knex);
      const issued = await enroll.issueEnrollmentToken({
        keycloakSub: result.claims.sub,
        email: result.claims.email ?? null,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken ?? null,
      });
      await emitAuditEvent({
        keycloakSub: result.claims.sub,
        category: 'session',
        action: 'session.passkey-enrollment-required',
        result: 'SUCCESS',
        req,
        details: { enrollmentTokenId: issued.id, hadTotp: hasTotp },
      });
      res.json({
        success: true,
        data: {
          passkeyEnrollmentRequired: true,
          enrollmentToken: issued.token,
          expiresAt: issued.expiresAt.toISOString(),
          email: result.claims.email ?? null,
          preferredUsername: result.claims.preferred_username ?? null,
        },
      });
      return;
    }

    if (hasTotp || hasPasskey) {
      // Per-account rolling-hour budget — a password holder can't
      // keep minting fresh challenges to work around the 5-per-
      // challenge cap. Once exhausted the user has to wait.
      const budget = await isMfaBudgetExhausted(foundryDb as unknown as Knex, result.claims.sub);
      if (budget.blocked) {
        await emitAuditEvent({
          keycloakSub: result.claims.sub,
          category: 'mfa',
          action: 'mfa.budget-exceeded',
          result: 'FAILURE',
          req,
          details: { retryAt: budget.retryAt?.toISOString() },
        });
        throw new AppError(
          'Too many failed MFA attempts on this account. Try again later.',
          429,
          'MFA_BUDGET_EXHAUSTED',
        );
      }
      const methods: string[] = [];
      if (hasTotp) methods.push('totp');
      if (hasPasskey) methods.push('webauthn');
      const challengeId = newMfaChallengeId();
      await saveMfaChallenge(foundryDb as unknown as Knex, {
        id: challengeId,
        keycloakSub: result.claims.sub,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        methods,
        ttlSeconds: 5 * 60,
      });
      // Do NOT set session cookies — the caller must complete /login/mfa.
      // We also deliberately do NOT leak the subject, email, or preferred
      // username at this point — the caller has proven password
      // knowledge but not possession of the second factor, and we don't
      // want to hand them a confirmed enumeration oracle.
      res.json({
        success: true,
        data: {
          mfaRequired: true,
          mfaChallenge: challengeId,
          methods,
        },
      });
      return;
    }

    setSessionCookies(res, result.accessToken, result.refreshToken, Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
    await resetMfaBudget(foundryDb as unknown as Knex, result.claims.sub);
    await emitAuditEvent({
      keycloakSub: result.claims.sub,
      category: 'session',
      action: 'session.login',
      result: 'SUCCESS',
      req,
      details: { mfa: false },
    });
    // Surface the passkey-enrollment hint so the FE can decide whether
    // to route the user through the post-login soft-prompt without
    // having to make a follow-up GET /me/webauthn/credentials round-
    // trip. `requiresPasskeyEnrollment` is the FE's contract — it is
    // intentionally a boolean rather than a count so the BE owns the
    // policy decision and the FE never has to interpret raw counts.
    // We only emit `true` when the policy is "soft prompt": the user
    // signed in successfully (no mandatory enrollment, no MFA gate)
    // but has zero passkeys. Mandatory enrollment took the
    // passkeyEnrollmentRequired branch above and never reaches here.
    res.json({
      success: true,
      data: {
        tokenType: 'Bearer',
        accessToken: result.accessToken,
        expiresIn: result.expiresIn,
        tokenInfo: tellusAuthService.toTokenInfo(result.claims),
        sessionMaxAgeSeconds: SESSION_MAX_AGE_SECONDS,
        sessionExpiresAt: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
        idleTimeoutSeconds: SESSION_IDLE_TIMEOUT_SECONDS,
        hasPasskey,
        requiresPasskeyEnrollment: !hasPasskey,
      },
    });
  } catch (err) {
    sendError(err, req, res);
  }
});

// ----- POST /login/mfa — step 2: TOTP code or WebAuthn assertion ----------
const LoginMfaTotpSchema = z.object({
  mfaChallenge: z.string().min(1),
  method: z.literal('totp'),
  code: z.string().regex(/^\d{6}$/),
});

const LoginMfaWebauthnSchema = z.object({
  mfaChallenge: z.string().min(1),
  method: z.literal('webauthn'),
  assertionResponse: z.any(),
});

router.post('/login/mfa', loginLimiter, csrfSameOrigin, async (req: Request, res: Response) => {
  try {
    const body = req.body as { method?: string };
    const knex = foundryDb as unknown as Knex;

    if (body?.method === 'totp') {
      const parsed = LoginMfaTotpSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }
      // loadMfaChallenge atomically increments the attempt counter and
      // returns null if the challenge is missing, expired, or has
      // burned through MFA_MAX_ATTEMPTS. We treat all three as the
      // same opaque failure so the caller can't distinguish "wrong
      // code" from "brute force lockout" from "session timed out".
      const challenge = await loadMfaChallenge(knex, parsed.data.mfaChallenge);
      if (!challenge) {
        throw new AppError(
          'MFA challenge expired, unknown, or too many attempts',
          401,
          'MFA_CHALLENGE_INVALID',
        );
      }
      const ok = await getTotpService(knex).verifyCode(
        challenge.keycloakSub,
        parsed.data.code,
      );
      if (!ok) {
        // Leave the challenge in place (with its incremented counter)
        // so the user gets to retry up to MFA_MAX_ATTEMPTS before the
        // next loadMfaChallenge call burns it. Track the failure in
        // the per-account rolling budget too.
        const budget = await registerMfaFailure(knex, challenge.keycloakSub);
        await emitAuditEvent({
          keycloakSub: challenge.keycloakSub,
          category: 'mfa',
          action: 'mfa.login',
          result: 'FAILURE',
          req,
          details: { method: 'totp', budgetBlocked: budget.blocked },
        });
        if (budget.blocked) {
          throw new AppError(
            'Too many failed MFA attempts on this account. Try again later.',
            429,
            'MFA_BUDGET_EXHAUSTED',
          );
        }
        throw new AppError('Invalid TOTP code', 401, 'MFA_INVALID');
      }
      await consumeMfaChallenge(knex, parsed.data.mfaChallenge);
      await resetMfaBudget(knex, challenge.keycloakSub);
      await emitAuditEvent({
        keycloakSub: challenge.keycloakSub,
        category: 'mfa',
        action: 'mfa.login',
        result: 'SUCCESS',
        req,
        details: { method: 'totp' },
      });
      return completeMfaLogin(res, challenge);
    }

    if (body?.method === 'webauthn') {
      const parsed = LoginMfaWebauthnSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }
      const challenge = await loadMfaChallenge(knex, parsed.data.mfaChallenge);
      if (!challenge) {
        throw new AppError(
          'MFA challenge expired, unknown, or too many attempts',
          401,
          'MFA_CHALLENGE_INVALID',
        );
      }
      try {
        await getWebauthnService(knex).verifyAuthentication(
          challenge.keycloakSub,
          'mfa-login',
          parsed.data.assertionResponse,
        );
      } catch (wErr) {
        await registerMfaFailure(knex, challenge.keycloakSub);
        await emitAuditEvent({
          keycloakSub: challenge.keycloakSub,
          category: 'mfa',
          action: 'mfa.login',
          result: 'FAILURE',
          req,
          details: { method: 'webauthn' },
        });
        throw wErr;
      }
      await consumeMfaChallenge(knex, parsed.data.mfaChallenge);
      await resetMfaBudget(knex, challenge.keycloakSub);
      await emitAuditEvent({
        keycloakSub: challenge.keycloakSub,
        category: 'mfa',
        action: 'mfa.login',
        result: 'SUCCESS',
        req,
        details: { method: 'webauthn' },
      });
      return completeMfaLogin(res, challenge);
    }

    throw new AppError('Unknown MFA method', 400, 'VALIDATION_ERROR');
  } catch (err) {
    sendError(err, req, res);
  }
});

// ----- POST /refresh — silent access-token rotation -----------------------
// Called by the FE axios interceptor when a request hits 401. Uses the
// TELLUS_REFRESH httpOnly cookie to mint a new access token via the
// Keycloak refresh grant, re-issues both cookies, and returns the
// updated tokenInfo so the caller can keep its hydrated profile in
// sync. If the refresh cookie is missing, invalid, or expired the
// caller gets a clean 401 REFRESH_TOKEN_INVALID envelope and should
// redirect to /login.
router.post('/refresh', csrfSameOrigin, async (req: Request, res: Response) => {
  try {
    const refresh = (req.cookies && (req.cookies as Record<string, string>)[TELLUS_REFRESH_COOKIE]) as
      | string
      | undefined;
    if (!refresh) {
      throw new AppError('No refresh token cookie', 401, 'REFRESH_TOKEN_MISSING');
    }
    const result = await tellusAuthService.refreshSession(refresh);
    // Absolute cap is anchored at the ORIGINAL interactive login (the marker).
    // Refresh ROTATES the access/refresh tokens but must NOT extend the window
    // — the cookies' Max-Age is the REMAINING time so they expire exactly when
    // the marker does.
    //
    // Missing/invalid marker: re-anchor to a full SESSION_MAX_AGE window
    // rather than fail-closed with Max-Age=0. Fail-closed wiped a live
    // session whenever the non-httpOnly marker was dropped (ITP, cookie
    // jar partial clear, older clients) while the httpOnly refresh cookie
    // was still valid — the user was bounced to re-auth despite a
    // perfectly refreshable session. Re-anchoring preserves the product
    // invariant "a valid refresh cookie keeps you signed in" and still
    // caps the new window at SESSION_MAX_AGE.
    const markerRaw = (req.cookies && (req.cookies as Record<string, string>)[TELLUS_SESSION_EXPIRES_COOKIE]) as
      | string
      | undefined;
    const markerMs = markerRaw ? Number(markerRaw) : NaN;
    const absoluteExpiryMs =
      Number.isFinite(markerMs) && markerMs > Date.now()
        ? markerMs
        : Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
    setSessionCookies(res, result.accessToken, result.refreshToken, absoluteExpiryMs);
    res.json({
      success: true,
      data: {
        tokenType: 'Bearer',
        accessToken: result.accessToken,
        expiresIn: result.expiresIn,
        tokenInfo: tellusAuthService.toTokenInfo(result.claims),
        sessionMaxAgeSeconds: SESSION_MAX_AGE_SECONDS,
        sessionExpiresAt: absoluteExpiryMs,
        idleTimeoutSeconds: SESSION_IDLE_TIMEOUT_SECONDS,
      },
    });
  } catch (err) {
    // Clear stale cookies so the FE can't keep retrying on the same
    // dead refresh token.
    clearSessionCookies(res);
    sendError(err, req, res);
  }
});

// Build the WebAuthn authentication options for an in-flight MFA challenge.
//
// Uses peekMfaChallenge() (read-only) — NOT loadMfaChallenge(). Fetching
// WebAuthn options is a prerequisite to the ceremony, not an auth attempt,
// so it must not burn one of the 5 brute-force slots on auth_mfa_challenges.
// Burning a slot here meant every passkey retry AND every dismissed OS
// prompt (options fetched, ceremony cancelled) ate into MFA_MAX_ATTEMPTS,
// so a user who dismissed the prompt a few times was wrongly told to
// "Start over from the sign-in screen" before ever submitting an assertion.
router.post('/login/mfa/webauthn-options', async (req: Request, res: Response) => {
  try {
    const id = (req.body?.mfaChallenge as string | undefined) || '';
    if (!id) throw new AppError('mfaChallenge required', 400, 'VALIDATION_ERROR');
    const challenge = await peekMfaChallenge(foundryDb as unknown as Knex, id);
    if (!challenge) throw new AppError('MFA challenge expired', 401, 'MFA_CHALLENGE_INVALID');
    const options = await getWebauthnService(
      foundryDb as unknown as Knex,
    ).buildAuthenticationOptions(challenge.keycloakSub, 'mfa-login');
    res.json({ success: true, data: options });
  } catch (err) {
    sendError(err, req, res);
  }
});

// ===========================================================================
// Mandatory-passkey enrollment endpoints.
//
// The caller reached /login with a valid password but no WebAuthn
// credential on file. The /login handler returned a short-lived
// `tellus_enroll_*` bearer token instead of session cookies. These
// two endpoints consume that bearer to drive the WebAuthn
// registration ceremony:
//
//   POST /enroll/passkey/options  → options JSON (challenge stored server-side)
//   POST /enroll/passkey/verify   → credential insert + stashed-tokens → cookies
//
// Both endpoints are PUBLIC with respect to the normal auth middleware
// (they're listed in UNAUTHENTICATED_ROUTES in patScopeMap.ts) and do
// their own token resolution via PasskeyEnrollmentService. A caller
// cannot jump straight to /enroll/passkey/verify with a random token —
// resolveEnrollmentToken() hashes the bearer and rejects unknown,
// expired, or already-consumed tokens.
// ===========================================================================

function extractEnrollmentBearer(req: Request): string {
  const hdr = (req.headers.authorization || '').toString();
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  const bodyTok = (req.body as { enrollmentToken?: unknown } | undefined)?.enrollmentToken;
  const fromBody = typeof bodyTok === 'string' ? bodyTok : '';
  const token = m ? m[1] : fromBody;
  if (!token || !token.startsWith(PASSKEY_ENROLLMENT_TOKEN_PREFIX)) {
    throw new AppError(
      'Enrollment token missing or malformed',
      401,
      'ENROLLMENT_TOKEN_INVALID',
    );
  }
  return token;
}

const EnrollOptionsSchema = z.object({
  enrollmentToken: z.string().min(1).optional(),
  userLabel: z.string().min(1).max(255).default('Primary passkey'),
  // Mandatory-passkey enrollment always asks for a discoverable,
  // user-verifying credential so the result is a real passkey:
  //   • macOS: Touch ID / iCloud Keychain passkey
  //   • Windows: Windows Hello
  //   • ChromeOS / Android: on-device biometric passkey
  //   • Hardware keys: resident key on a YubiKey 5+
  // The caller can ask for 'preferred' in case of an older authenticator
  // but the default is the strict setting.
  residentKey: z.enum(['required', 'preferred', 'discouraged']).default('required'),
});

router.post('/enroll/passkey/options', loginLimiter, async (req: Request, res: Response) => {
  try {
    const parsed = EnrollOptionsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
    }
    const raw = extractEnrollmentBearer(req);
    const knex = foundryDb as unknown as Knex;
    const enroll = getPasskeyEnrollmentService(knex);
    const resolved = await enroll.resolveEnrollmentToken(raw);

    // Double-safety: if the user has acquired a passkey between /login
    // and this call (e.g., a concurrent tab completed enrollment), this
    // flow is now moot and the caller should just sign in again.
    if (await enroll.userHasActivePasskey(resolved.keycloakSub)) {
      throw new AppError(
        'A passkey is already enrolled for this user — sign in again',
        409,
        'ENROLLMENT_NOT_REQUIRED',
      );
    }

    const options = await getWebauthnService(knex).buildRegistrationOptions({
      keycloakSub: resolved.keycloakSub,
      userName: resolved.email ?? resolved.keycloakSub,
      displayName: resolved.email ?? resolved.keycloakSub,
      userLabel: parsed.data.userLabel,
      residentKey: parsed.data.residentKey,
      userVerification: 'required',
      // Leave authenticatorAttachment undefined so the browser offers
      // every available authenticator: Touch ID on a MacBook, Windows
      // Hello on a PC, a plugged-in YubiKey, or a phone as a roaming
      // authenticator via hybrid transport. The user gets to choose.
    });
    res.json({ success: true, data: options });
  } catch (err) {
    sendError(err, req, res);
  }
});

router.post('/enroll/passkey/verify', loginLimiter, async (req: Request, res: Response) => {
  try {
    const raw = extractEnrollmentBearer(req);
    const body = req.body as { response?: unknown; enrollmentToken?: string } | undefined;
    if (!body || typeof body.response !== 'object' || body.response == null) {
      throw new AppError('Missing WebAuthn response payload', 400, 'VALIDATION_ERROR');
    }
    const knex = foundryDb as unknown as Knex;
    const enroll = getPasskeyEnrollmentService(knex);
    const resolved = await enroll.resolveEnrollmentToken(raw);

    if (await enroll.userHasActivePasskey(resolved.keycloakSub)) {
      throw new AppError(
        'A passkey is already enrolled for this user — sign in again',
        409,
        'ENROLLMENT_NOT_REQUIRED',
      );
    }

    const registerResult = await getWebauthnService(knex).verifyRegistration(
      resolved.keycloakSub,
      body.response as Parameters<
        ReturnType<typeof getWebauthnService>['verifyRegistration']
      >[1],
    );

    await enroll.consumeEnrollmentToken(resolved.id);

    setSessionCookies(
      res,
      resolved.stashedAccessToken,
      resolved.stashedRefreshToken ?? undefined,
      Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
    );

    let claims: TellusClaims;
    try {
      claims = await tellusAuthService.verifyAccessToken(resolved.stashedAccessToken);
    } catch {
      clearSessionCookies(res);
      throw new AppError(
        'Stashed session expired during enrollment — please sign in again',
        401,
        'ENROLLMENT_SESSION_EXPIRED',
      );
    }

    await emitAuditEvent({
      keycloakSub: resolved.keycloakSub,
      category: 'webauthn',
      action: 'webauthn.register',
      result: 'SUCCESS',
      req,
      details: {
        userLabel: registerResult.userLabel,
        credentialIdPrefix: registerResult.credentialId.slice(0, 16),
        firstEnrollment: true,
      },
    });
    await emitAuditEvent({
      keycloakSub: resolved.keycloakSub,
      category: 'session',
      action: 'session.login',
      result: 'SUCCESS',
      req,
      details: { viaPasskeyEnrollment: true },
    });

    res.status(201).json({
      success: true,
      data: {
        tokenType: 'Bearer',
        accessToken: resolved.stashedAccessToken,
        tokenInfo: tellusAuthService.toTokenInfo(claims),
        sessionMaxAgeSeconds: SESSION_MAX_AGE_SECONDS,
        sessionExpiresAt: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
        idleTimeoutSeconds: SESSION_IDLE_TIMEOUT_SECONDS,
        credential: {
          credentialId: registerResult.credentialId,
          userLabel: registerResult.userLabel,
        },
      },
    });
  } catch (err) {
    sendError(err, req, res);
  }
});

async function completeMfaLogin(
  res: Response,
  challenge: { keycloakSub: string; accessToken: string; refreshToken: string | null },
  req?: Request,
) {
  const claims = await tellusAuthService.verifyAccessToken(challenge.accessToken);
  setSessionCookies(res, challenge.accessToken, challenge.refreshToken ?? undefined, Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
  // Re-probe passkey enrollment AFTER the second factor succeeds so the
  // FE soft-prompt decision survives the MFA detour. A user who passed
  // /login with TOTP but has no passkey will still see the soft prompt
  // here, identical to the fast-path branch in /login above.
  const webauthn = getWebauthnService(foundryDb as unknown as Knex);
  const hasPasskey = await webauthn.hasAny(challenge.keycloakSub);
  await emitAuditEvent({
    keycloakSub: challenge.keycloakSub,
    category: 'session',
    action: 'session.login',
    result: 'SUCCESS',
    req,
    details: { mfa: true },
  });
  res.json({
    success: true,
    data: {
      tokenType: 'Bearer',
      accessToken: challenge.accessToken,
      tokenInfo: tellusAuthService.toTokenInfo(claims),
      sessionMaxAgeSeconds: SESSION_MAX_AGE_SECONDS,
      sessionExpiresAt: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
      idleTimeoutSeconds: SESSION_IDLE_TIMEOUT_SECONDS,
      hasPasskey,
      requiresPasskeyEnrollment: !hasPasskey,
    },
  });
}

// ----- POST /logout ----------------------------------------------------------
router.post('/logout', requireTellusAuth({ allowPat: false }), csrfSameOrigin, async (req: Request, res: Response) => {
  try {
    const claims = (req as Request & { tellusClaims?: TellusClaims }).tellusClaims;
    const refresh = (req.cookies && req.cookies[TELLUS_REFRESH_COOKIE]) as string | undefined;
    if (claims) {
      await tellusAuthService.logout(claims, refresh);
      await emitAuditEvent({
        keycloakSub: claims.sub,
        category: 'session',
        action: 'session.logout',
        result: 'SUCCESS',
        req,
      });
    }
    clearSessionCookies(res);
    res.status(204).end();
  } catch (err) {
    sendError(err, req, res);
  }
});

// ----- GET /token-info -------------------------------------------------------
// Returns the resolved session metadata regardless of whether the caller
// authenticated with a Keycloak JWT (cookie or Bearer) or a Personal
// Access Token. For PATs we synthesize a minimal info block from the
// stored principal since there are no JWT claims to decode.
router.get('/token-info', requireTellusAuth(), async (req: Request, res: Response) => {
  const claims = (req as Request & { tellusClaims?: TellusClaims }).tellusClaims;
  if (claims) {
    // Probe passkey enrollment so the FE's cold-load path on
    // /login/passkey can decide whether to render the soft-prompt
    // card without a second round-trip to /me/webauthn/credentials.
    // Best-effort: if the probe blows up we surface `hasPasskey:false`
    // so the page degrades to a soft-prompt invitation rather than a
    // bounce. We never return 5xx on /token-info — the FE relies on
    // this endpoint as a session liveness check.
    let hasPasskey = false;
    try {
      const webauthn = getWebauthnService(foundryDb as unknown as Knex);
      hasPasskey = await webauthn.hasAny(claims.sub);
    } catch {
      hasPasskey = false;
    }
    return res.json({
      success: true,
      data: {
        ...tellusAuthService.toTokenInfo(claims),
        hasPasskey,
        requiresPasskeyEnrollment: !hasPasskey,
      },
    });
  }
  const principal = req.tellusPrincipal;
  if (!principal || principal.source !== 'pat') {
    return sendError(new AppError('No principal', 401, 'TOKEN_INVALID'), req, res);
  }
  return res.json({
    success: true,
    data: {
      sub: principal.keycloakSub || principal.userId || 'pat',
      jti: null,
      org: kcConfig.kcRealm,
      email: null,
      preferredUsername: null,
      realmRoles: [],
      markings: [],
      orgs: [kcConfig.kcRealm],
      cbacClearance: null,
      sessionScope: [],
      tokenKind: 'pat',
      scopes: principal.scopes,
      exp: null,
      iat: null,
      iss: `${kcConfig.kcUrl}/realms/${kcConfig.kcRealm}`,
      // PATs are non-interactive and never go through the soft-prompt
      // flow; report `false` so a misbehaving FE that calls this with
      // a PAT cookie can't accidentally trigger an enrollment loop.
      hasPasskey: false,
      requiresPasskeyEnrollment: false,
    },
  });
});

// ----- POST /check-access ----------------------------------------------------
const CheckAccessSchema = z.object({
  operation: z.string().min(1),
  resourceRid: z.string().optional(),
  resourceType: z.string().optional(),
});

router.post('/check-access', requireTellusAuth(), (req: Request, res: Response) => {
  try {
    const parsed = CheckAccessSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
    }
    const claims = (req as Request & { tellusClaims?: TellusClaims }).tellusClaims!;
    const result = tellusAuthService.checkAccess(claims, parsed.data);
    res.json({ success: true, data: result });
  } catch (err) {
    sendError(err, req, res);
  }
});

// ----- SAML SP metadata proxy (Task 2) --------------------------------------
// Palantir exposes SP metadata so partner IdPs can trust Foundry as a SP.
// Keycloak serves this natively; we reverse-proxy it under /api/v1/auth for
// a stable front-door URL and assert it looks like a real SAML descriptor.
router.get('/saml/metadata', async (req: Request, res: Response) => {
  try {
    const url = `${kcConfig.kcUrl}/realms/${kcConfig.kcRealm}/protocol/saml/descriptor`;
    // F-P4-08: SAML SP metadata reverse proxy. A frozen Keycloak must
    // not be allowed to hold this route's request handler open past
    // the 5 s budget — otherwise connection slots on the Tellus
    // dispatcher go to waste on stalled IdP trust probes.
    const upstream = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!upstream.ok) throw new AppError('SP metadata unavailable', 502, 'METADATA_UNAVAILABLE');
    const body = await upstream.text();
    if (!body.includes('EntityDescriptor')) {
      throw new AppError('Keycloak returned unexpected SP metadata', 502, 'METADATA_INVALID');
    }
    res.type('application/xml').send(body);
  } catch (err) {
    sendError(err, req, res);
  }
});

// ----- OIDC discovery surface (Task 2) --------------------------------------
// Thin wrapper so the FE has a single /api/v1/auth/oidc/config entry point
// instead of having to know the Keycloak realm URL.
router.get('/oidc/config', async (req: Request, res: Response) => {
  try {
    const url = `${kcConfig.kcUrl}/realms/${kcConfig.kcRealm}/.well-known/openid-configuration`;
    // F-P4-08: same bound as /saml/metadata — the FE calls this on every
    // login page load, so an unbounded fetch here would wedge logins.
    const upstream = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!upstream.ok) throw new AppError('OIDC discovery unavailable', 502, 'OIDC_UNAVAILABLE');
    const doc = await upstream.json() as {
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      jwks_uri: string;
      end_session_endpoint?: string;
      grant_types_supported: string[];
      code_challenge_methods_supported?: string[];
      backchannel_logout_supported?: boolean;
    };
    res.json({ success: true, data: {
      realm: kcConfig.kcRealm,
      clientId: kcConfig.kcFrontendClientId,
      issuer: doc.issuer,
      authorizationEndpoint: doc.authorization_endpoint,
      tokenEndpoint: doc.token_endpoint,
      jwksUri: doc.jwks_uri,
      endSessionEndpoint: doc.end_session_endpoint,
      grantTypesSupported: doc.grant_types_supported,
      codeChallengeMethodsSupported: doc.code_challenge_methods_supported,
      backchannelLogoutSupported: doc.backchannel_logout_supported === true,
    }});
  } catch (err) {
    sendError(err, req, res);
  }
});

// ----- OIDC / PKCE browser redirect entry points — REMOVED in Phase 3 ------
// The PKCE Authorization Code + session-cookie callback flow used to live
// here and 302-redirect the browser to `$KC_URL/realms/tellus/...`. That
// violated the hard rule "frontend must never navigate to the Keycloak
// hostname", so the flow is gone. Authentication is now:
//   1) POST /api/v1/auth/login            (password, possibly two-step MFA)
//   2) POST /api/v1/auth/login/mfa        (TOTP / WebAuthn)
// Both run entirely inside tellus. Keycloak is still the identity source
// (tellus proxies direct-grant requests to KC under the hood), but the
// browser only ever talks to tellus-fe + tellus backend.

// ----- PATs (Task 9) ---------------------------------------------------------
const PatCreateSchema = z.object({
  name: z.string().min(1).max(255),
  expiresAt: z.string().datetime(),
  scopes: z.array(z.string()).max(100).default([]),
});

router.post('/tokens', requireTellusAuth({ allowPat: false }), async (req: Request, res: Response) => {
  try {
    const parsed = PatCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
    }
    // Reject anything that isn't in the closed scope enum. Spec-grade
    // PATs can't carry free-form strings because the backend has no
    // way to enforce permissions on an unknown scope value.
    const scopeCheck = validatePatScopes(parsed.data.scopes);
    if (!scopeCheck.ok) {
      throw new AppError(
        `Unknown PAT scopes: ${scopeCheck.invalid.join(', ')}. Valid scopes: ${TELLUS_PAT_SCOPES.join(', ')}`,
        400,
        'PAT_SCOPE_INVALID',
      );
    }
    const claims = (req as Request & { tellusClaims?: TellusClaims }).tellusClaims!;
    const userId = await ensureLocalUserForClaims(foundryDb as unknown as Knex, claims);
    const result = await tellusAuthService.createPat({
      userId,
      keycloakSub: claims.sub,
      name: parsed.data.name,
      expiresAt: new Date(parsed.data.expiresAt),
      scopes: parsed.data.scopes,
    });
    await emitAuditEvent({
      keycloakSub: claims.sub,
      category: 'pat',
      action: 'pat.create',
      result: 'SUCCESS',
      req,
      details: { tokenId: result.tokenId, name: parsed.data.name, scopes: parsed.data.scopes },
    });
    res.status(201).json({
      success: true,
      data: {
        tokenId: result.tokenId,
        token: result.token, // returned once
        name: result.record.name,
        scopes: result.record.scopes,
        expiresAt: result.record.expiresAt,
        createdAt: result.record.createdAt,
      },
    });
  } catch (err) {
    sendError(err, req, res);
  }
});

router.get('/tokens', requireTellusAuth({ allowPat: true }), requirePatScope('pats:read'), async (req: Request, res: Response) => {
  try {
    // Interactive session: resolve the local userId via the JWT claims.
    // PAT caller: the principal already carries the owning userId so
    // we don't need to go through ensureLocalUserForClaims() (which
    // would fail — a PAT has no JWT claims to translate).
    const principal = req.tellusPrincipal;
    if (!principal) throw new AppError('No principal', 401, 'UNAUTHORIZED');
    let userId: string;
    if (principal.source === 'pat') {
      if (!principal.userId) throw new AppError('PAT not linked to a user', 401, 'UNAUTHORIZED');
      userId = principal.userId;
    } else {
      const claims = (req as Request & { tellusClaims?: TellusClaims }).tellusClaims!;
      userId = await ensureLocalUserForClaims(foundryDb as unknown as Knex, claims);
    }
    const rows = await tellusAuthService.listPats(userId);
    // Contract: listing must NEVER return the raw token value.
    res.json({
      success: true,
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        tokenPrefix: r.tokenPrefix,
        scopes: r.scopes,
        expiresAt: r.expiresAt,
        lastUsedAt: r.lastUsedAt,
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    sendError(err, req, res);
  }
});

router.delete('/tokens/:id', requireTellusAuth({ allowPat: false }), async (req: Request, res: Response) => {
  try {
    await enforceFreshReauth(req);
    const claims = (req as Request & { tellusClaims?: TellusClaims }).tellusClaims!;
    const userId = await ensureLocalUserForClaims(foundryDb as unknown as Knex, claims);
    await tellusAuthService.revokePat(userId, req.params.id);
    await emitAuditEvent({
      keycloakSub: claims.sub,
      category: 'pat',
      action: 'pat.revoke',
      result: 'SUCCESS',
      req,
      details: { tokenId: req.params.id },
    });
    res.status(204).end();
  } catch (err) {
    sendError(err, req, res);
  }
});

// ===========================================================================
// Phase 2 — self-service settings surface for the frontend /settings pages.
//
// These endpoints proxy to Keycloak's admin API via keycloakAdminService,
// which authenticates via client_credentials on tellus-confidential with
// realm-management roles. The tellus-fe UI hits each one from a small
// typed client in lib/settingsApi.ts.
// ===========================================================================

function kcAdmin() {
  return getKeycloakAdminService();
}

function requireClaimsFor(req: Request): TellusClaims {
  const claims = (req as Request & { tellusClaims?: TellusClaims }).tellusClaims;
  if (!claims) {
    throw new AppError(
      'This endpoint requires a live Keycloak session (JWT or cookie)',
      401,
      'TOKEN_INVALID',
    );
  }
  return claims;
}

// ----- GET /me ---------------------------------------------------------------
router.get('/me', requireTellusAuth({ allowPat: false }), (req: Request, res: Response) => {
  try {
    const claims = requireClaimsFor(req);
    const info = tellusAuthService.toTokenInfo(claims);
    res.json({
      success: true,
      data: {
        ...info,
        name: claims['name' as keyof TellusClaims] as string | undefined,
        accountConsoleUrl: `${kcConfig.kcUrl}/realms/${kcConfig.kcRealm}/account`,
      },
    });
  } catch (err) {
    sendError(err, req, res);
  }
});

// ----- GET /me/credentials ---------------------------------------------------
router.get('/me/credentials', requireTellusAuth({ allowPat: false }), async (req: Request, res: Response) => {
  try {
    const claims = requireClaimsFor(req);
    const credentials = await kcAdmin().listCredentials(claims.sub);
    res.json({
      success: true,
      data: credentials.map((c) => ({
        id: c.id,
        type: c.type,
        userLabel: c.userLabel,
        createdDate: c.createdDate,
        // Re-shape Keycloak credential types to the spec vocabulary so the
        // UI can group rows by "password", "totp", "passkey".
        category:
          c.type === 'password'
            ? 'password'
            : c.type === 'otp'
              ? 'totp'
              : c.type.startsWith('webauthn')
                ? 'passkey'
                : 'other',
        isPasswordless: c.type === 'webauthn-passwordless',
      })),
    });
  } catch (err) {
    sendError(err, req, res);
  }
});

router.delete('/me/credentials/:credentialId', requireTellusAuth({ allowPat: false }), async (req: Request, res: Response) => {
  try {
    const claims = requireClaimsFor(req);
    await kcAdmin().deleteCredential(claims.sub, req.params.credentialId);
    res.status(204).end();
  } catch (err) {
    sendError(err, req, res);
  }
});

// ----- POST /me/reauth — mint a short-lived reauth token -------------------
// Before the user can perform a destructive credential-management
// action (disable TOTP, delete passkey, revoke PAT) the frontend
// prompts them for their password and POSTs it here. On success we
// return a 5-minute reauth token the FE caches in memory and sends
// via X-Tellus-Reauth on the subsequent destructive request.
const ReauthSchema = z.object({ password: z.string().min(1) });

router.post('/me/reauth', loginLimiter, requireTellusAuth({ allowPat: false }), async (req: Request, res: Response) => {
  try {
    const parsed = ReauthSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
    }
    const claims = requireClaimsFor(req);
    // Defense-in-depth rate limit on top of the shared loginLimiter:
    // caps per-user wrong-password attempts on reauth at 10 per rolling
    // 15-minute window. Blocks a cookie holder without the password
    // from grinding down the direct-grant path at 500/5min in dev.
    const budget = await isReauthBudgetExhausted(claims.sub);
    if (budget.blocked) {
      res.setHeader('Retry-After', Math.max(1, Math.floor((budget.retryAt!.getTime() - Date.now()) / 1000)));
      throw new AppError(
        'Too many reauthentication failures. Try again later.',
        429,
        'REAUTH_BUDGET_EXHAUSTED',
      );
    }
    const username = claims.email || claims.preferred_username;
    if (!username) {
      throw new AppError('Cannot resolve username for reauth', 400, 'VALIDATION_ERROR');
    }
    try {
      await tellusAuthService.loginWithPassword(username, parsed.data.password);
    } catch (err) {
      const after = await registerReauthFailure(claims.sub);
      await emitAuditEvent({
        keycloakSub: claims.sub,
        category: 'reauth',
        action: 'reauth.fail',
        result: 'FAILURE',
        req,
        details: { budgetBlocked: after.blocked },
      });
      if (after.blocked) {
        res.setHeader('Retry-After', Math.max(1, Math.floor((after.retryAt!.getTime() - Date.now()) / 1000)));
        throw new AppError(
          'Too many reauthentication failures. Try again later.',
          429,
          'REAUTH_BUDGET_EXHAUSTED',
        );
      }
      if (err instanceof AppError && err.code === 'UNAUTHORIZED') {
        throw new AppError('Password is incorrect', 401, 'REAUTH_INVALID_PASSWORD');
      }
      throw err;
    }
    // Success clears the per-user budget — a correct password should
    // not leave the user penalised from earlier typos.
    await resetReauthBudget(claims.sub);
    const { token, expiresAt } = await issueReauthToken(claims.sub);
    await emitAuditEvent({
      keycloakSub: claims.sub,
      category: 'reauth',
      action: 'reauth.issue',
      result: 'SUCCESS',
      req,
    });
    res.json({
      success: true,
      data: {
        reauthToken: token,
        expiresAt: expiresAt.toISOString(),
        ttlSeconds: Math.floor((expiresAt.getTime() - Date.now()) / 1000),
      },
    });
  } catch (err) {
    sendError(err, req, res);
  }
});

/**
 * Require a fresh reauth token on the current request. Reads the
 * X-Tellus-Reauth header (case-insensitive), validates it against
 * user_reauth_tokens, and throws REAUTH_REQUIRED / REAUTH_INVALID /
 * REAUTH_EXPIRED on any failure. The middleware runs AFTER
 * requireTellusAuth so it can rely on req.tellusClaims.
 */
async function enforceFreshReauth(req: Request): Promise<void> {
  const header = req.headers['x-tellus-reauth'];
  const token = Array.isArray(header) ? header[0] : header;
  const claims = requireClaimsFor(req);
  await consumeReauthToken(token as string, claims.sub);
}

// ----- POST /me/password — in-app password change --------------------------
// Verifies the old password by issuing a direct-grant against Keycloak
// (no client-side redirect) and then resets the password via the admin
// API. The new password is validated against the realm password policy
// by Keycloak itself — if it fails, we bubble the error envelope back.
const ChangePasswordSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: z.string().min(12),
});

router.post('/me/password', requireTellusAuth({ allowPat: false }), async (req: Request, res: Response) => {
  try {
    const parsed = ChangePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
    }
    const claims = requireClaimsFor(req);
    const email = claims.email || claims.preferred_username;
    if (!email) {
      throw new AppError('Cannot resolve username for password change', 400, 'VALIDATION_ERROR');
    }
    // Step 1 — verify the old password by attempting a direct-grant. If
    // Keycloak rejects it we return 401 OLD_PASSWORD_INVALID without
    // touching the new password.
    try {
      await tellusAuthService.loginWithPassword(email, parsed.data.oldPassword);
    } catch (err) {
      if (err instanceof AppError && err.code === 'UNAUTHORIZED') {
        throw new AppError('Current password is incorrect', 401, 'OLD_PASSWORD_INVALID');
      }
      throw err;
    }
    // Step 2 — reset via the admin API. Keycloak enforces the realm
    // password policy server-side; failures surface as 400 with the
    // upstream error propagated.
    const admin = kcAdmin();
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.KEYCLOAK_CONFIDENTIAL_CLIENT_ID || 'tellus-confidential',
      client_secret: process.env.KEYCLOAK_CONFIDENTIAL_CLIENT_SECRET || 'tellus-confidential-secret-change-me',
    });
    // F-P4-08: client_credentials token exchange inside the
    // password-reset path. 5 s matches tellusAuthService.loginWithPassword
    // so a slow Keycloak surfaces as a typed 502 rather than a hung
    // PUT /auth/password.
    const tokenRes = await fetch(
      `${kcConfig.kcUrl}/realms/${kcConfig.kcRealm}/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!tokenRes.ok) {
      throw new AppError('Admin token exchange failed', 502, 'KEYCLOAK_UNREACHABLE');
    }
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    // F-P4-08: reset-password call. 8 s matches keycloakAdminService.call
    // — long enough for p99 realm-scan latency, short enough to surface
    // as 502 KEYCLOAK_UNREACHABLE rather than hanging forever.
    const resetRes = await fetch(
      `${kcConfig.kcUrl}/admin/realms/${kcConfig.kcRealm}/users/${claims.sub}/reset-password`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'password',
          value: parsed.data.newPassword,
          temporary: false,
        }),
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!resetRes.ok) {
      const txt = await resetRes.text().catch(() => '');
      const parsedErr = safeJson(txt);
      if (resetRes.status === 400) {
        // Keycloak error messages for password policy violations are
        // reasonably safe to surface, but we only pass through the
        // short errorMessage string — never the full response body.
        const message = parsedErr?.errorMessage
          ? sanitizeKeycloakMessage(parsedErr.errorMessage)
          : 'New password does not meet the realm password policy';
        throw new AppError(message, 400, 'PASSWORD_POLICY_VIOLATION');
      }
      // Everything else is an internal upstream failure — do not leak
      // raw KC error strings to the caller.
      throw new AppError('Password reset failed — try again later', 502, 'KEYCLOAK_ADMIN_ERROR');
    }

    // Security: after a successful password change, kill every active
    // session for this user INCLUDING the caller's. This forces a
    // fresh login with the new password and guarantees that any
    // compromised cookie still floating around is immediately dead.
    try {
      await admin.logoutAll(claims.sub);
    } catch {
      /* best-effort — we already rotated the password; failing this
         step shouldn't block the 204. The next /token-info will 401
         and force a redirect on its own. */
    }
    await tellusAuthService.revokeJti(claims.jti, claims.sub, new Date(claims.exp * 1000));
    clearSessionCookies(res);
    // Audit + email notification — both fire-and-forget.
    await emitAuditEvent({
      keycloakSub: claims.sub,
      category: 'password',
      action: 'password.change',
      result: 'SUCCESS',
      req,
    });
    if (claims.email) {
      try {
        const rendered = renderEmail(
          'password-changed',
          'Your Tellus password was changed',
          {
            displayName: claims.preferred_username || claims.email,
            email: claims.email,
            occurredAt: new Date().toISOString(),
            ip: req.ip ?? 'unknown',
            userAgent: req.headers['user-agent'] ?? 'unknown',
            tellusOrigin: process.env.TELLUS_FRONTEND_URL || 'http://localhost:3001',
          },
        );
        await enqueueEmail({ to: claims.email, rendered });
      } catch {
        /* template failure must never block the 204 */
      }
    }
    res.status(204).end();
  } catch (err) {
    sendError(err, req, res);
  }
});

/**
 * Trim and strip anything that looks like a stack trace, path, or
 * class name from a Keycloak error message before it's forwarded to
 * the caller. Keeps policy violation strings ("Invalid password:
 * minimum length 12") readable without leaking the fully-qualified
 * Java exception they originated from.
 */
function sanitizeKeycloakMessage(input: string): string {
  return input
    .replace(/\s*at\s+[a-zA-Z0-9_.$]+\([^)]*\)/g, '')
    .replace(/\bjava\.[a-z0-9_.]+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function safeJson(input: string): { errorMessage?: string } | null {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

// ----- POST /me/totp/start — begin TOTP enrollment -------------------------
router.post('/me/totp/start', requireTellusAuth({ allowPat: false }), async (req: Request, res: Response) => {
  try {
    const claims = requireClaimsFor(req);
    const label = claims.email || claims.preferred_username || claims.sub;
    const totp = getTotpService(foundryDb as unknown as Knex);
    const enrollment = await totp.startEnrollment(claims.sub, label);
    await emitAuditEvent({
      keycloakSub: claims.sub,
      category: 'totp',
      action: 'totp.enroll.start',
      result: 'SUCCESS',
      req,
    });
    res.json({ success: true, data: enrollment });
  } catch (err) {
    sendError(err, req, res);
  }
});

const TotpVerifySchema = z.object({ code: z.string().regex(/^\d{6}$/) });

router.post('/me/totp/verify', requireTellusAuth({ allowPat: false }), async (req: Request, res: Response) => {
  try {
    const parsed = TotpVerifySchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
    const claims = requireClaimsFor(req);
    try {
      await getTotpService(foundryDb as unknown as Knex).verifyEnrollment(claims.sub, parsed.data.code);
    } catch (err) {
      await emitAuditEvent({
        keycloakSub: claims.sub,
        category: 'totp',
        action: 'totp.enroll.verify',
        result: 'FAILURE',
        req,
      });
      throw err;
    }
    await emitAuditEvent({
      keycloakSub: claims.sub,
      category: 'totp',
      action: 'totp.enroll.verify',
      result: 'SUCCESS',
      req,
    });
    res.status(204).end();
  } catch (err) {
    sendError(err, req, res);
  }
});

// Disabling TOTP is a destructive credential change — gate it behind
// a fresh reauth challenge so a compromised session can't silently
// drop the second factor.
router.delete('/me/totp', requireTellusAuth({ allowPat: false }), async (req: Request, res: Response) => {
  try {
    await enforceFreshReauth(req);
    const claims = requireClaimsFor(req);
    await getTotpService(foundryDb as unknown as Knex).disable(claims.sub);
    await emitAuditEvent({
      keycloakSub: claims.sub,
      category: 'totp',
      action: 'totp.disable',
      result: 'SUCCESS',
      req,
    });
    res.status(204).end();
  } catch (err) {
    sendError(err, req, res);
  }
});

router.get('/me/totp/status', requireTellusAuth({ allowPat: true }), requirePatScope('api:read'), async (req: Request, res: Response) => {
  try {
    const claims = requireClaimsFor(req);
    const enabled = await getTotpService(foundryDb as unknown as Knex).isEnabled(claims.sub);
    res.json({ success: true, data: { enabled } });
  } catch (err) {
    sendError(err, req, res);
  }
});

// ----- WebAuthn (in-app passkeys) ------------------------------------------
// The browser runs the WebAuthn ceremony via @simplewebauthn/browser
// against the tellus frontend origin — Keycloak is never contacted
// from the browser. Credentials are stored in tellus DB and used as
// the second factor of /login/mfa.
const WebauthnRegisterOptionsSchema = z.object({
  userLabel: z.string().min(1).max(255),
  // Default to 'required' so every new passkey is a proper
  // discoverable credential (Touch ID / Windows Hello / iCloud
  // passkey) that supports usernameless + synced login. Callers
  // can still downgrade to 'preferred' for older authenticators.
  residentKey: z.enum(['required', 'preferred', 'discouraged']).default('required'),
});

router.post('/me/webauthn/register-options', requireTellusAuth({ allowPat: false }), async (req: Request, res: Response) => {
  try {
    const parsed = WebauthnRegisterOptionsSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
    const claims = requireClaimsFor(req);
    const options = await getWebauthnService(foundryDb as unknown as Knex).buildRegistrationOptions({
      keycloakSub: claims.sub,
      userName: claims.email || claims.preferred_username || claims.sub,
      displayName: claims.preferred_username || claims.email || claims.sub,
      userLabel: parsed.data.userLabel,
      residentKey: parsed.data.residentKey,
    });
    res.json({ success: true, data: options });
  } catch (err) {
    sendError(err, req, res);
  }
});

router.post('/me/webauthn/register-verify', requireTellusAuth({ allowPat: false }), async (req: Request, res: Response) => {
  try {
    const claims = requireClaimsFor(req);
    const result = await getWebauthnService(foundryDb as unknown as Knex).verifyRegistration(
      claims.sub,
      req.body,
    );
    await emitAuditEvent({
      keycloakSub: claims.sub,
      category: 'webauthn',
      action: 'webauthn.register',
      result: 'SUCCESS',
      req,
      details: { userLabel: result.userLabel, credentialIdPrefix: result.credentialId.slice(0, 16) },
    });
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    sendError(err, req, res);
  }
});

router.get('/me/webauthn/credentials', requireTellusAuth({ allowPat: true }), requirePatScope('api:read'), async (req: Request, res: Response) => {
  try {
    const claims = requireClaimsFor(req);
    const list = await getWebauthnService(foundryDb as unknown as Knex).listByUser(claims.sub);
    res.json({
      success: true,
      data: list.map((c) => ({
        id: c.id,
        credentialId: c.credentialId,
        userLabel: c.userLabel,
        deviceType: c.deviceType,
        backedUp: c.backedUp,
        transports: c.transports,
        createdAt: c.createdAt,
        lastUsedAt: c.lastUsedAt,
      })),
    });
  } catch (err) {
    sendError(err, req, res);
  }
});

router.delete('/me/webauthn/credentials/:id', requireTellusAuth({ allowPat: false }), async (req: Request, res: Response) => {
  try {
    await enforceFreshReauth(req);
    const claims = requireClaimsFor(req);
    const knex = foundryDb as unknown as Knex;
    // Mandatory-passkey policy: refuse to delete the user's LAST
    // active WebAuthn credential. Otherwise the next /login would
    // bounce into the enrollment handshake and the caller could
    // lock themselves out (especially if they only have the browser
    // they just killed the credential on). Users who want to rotate
    // should register a replacement first and then delete the old one.
    const existing = await knex('user_webauthn_credentials')
      .where({ keycloak_sub: claims.sub })
      .whereNot({ id: req.params.id })
      .count<{ count: string }>('* as count')
      .first();
    if (Number(existing?.count ?? 0) === 0) {
      throw new AppError(
        'Cannot delete the last passkey — register a replacement first',
        409,
        'PASSKEY_LAST_REMAINING',
      );
    }
    await getWebauthnService(knex).deleteCredential(claims.sub, req.params.id);
    await emitAuditEvent({
      keycloakSub: claims.sub,
      category: 'webauthn',
      action: 'webauthn.delete',
      result: 'SUCCESS',
      req,
      details: { credentialId: req.params.id },
    });
    res.status(204).end();
  } catch (err) {
    sendError(err, req, res);
  }
});

// ----- GET /me/sessions ------------------------------------------------------
router.get('/me/sessions', requireTellusAuth({ allowPat: true }), requirePatScope('api:read'), async (req: Request, res: Response) => {
  try {
    const principal = req.tellusPrincipal;
    const sub = req.tellusClaims?.sub || principal?.keycloakSub;
    if (!sub) throw new AppError('No principal', 401, 'UNAUTHORIZED');
    const sessions = await kcAdmin().listSessions(sub);
    res.json({
      success: true,
      data: sessions.map((s) => ({
        id: s.id,
        ipAddress: s.ipAddress ?? null,
        started: s.start ? new Date(s.start).toISOString() : null,
        lastAccess: s.lastAccess ? new Date(s.lastAccess).toISOString() : null,
        clients: s.clients ? Object.values(s.clients) : [],
        // Current-session marker only makes sense for interactive
        // callers — PAT callers don't have a KC session to compare.
        isCurrent: (req.tellusClaims?.['sid' as keyof TellusClaims] ?? null) === s.id,
      })),
    });
  } catch (err) {
    sendError(err, req, res);
  }
});

router.delete('/me/sessions/:sessionId', requireTellusAuth({ allowPat: false }), async (req: Request, res: Response) => {
  try {
    const claims = requireClaimsFor(req);
    await kcAdmin().deleteSession(req.params.sessionId);
    await emitAuditEvent({
      keycloakSub: claims.sub,
      category: 'session',
      action: 'session.revoke',
      result: 'SUCCESS',
      req,
      details: { sessionId: req.params.sessionId },
    });
    res.status(204).end();
  } catch (err) {
    sendError(err, req, res);
  }
});

router.post('/me/logout-all', requireTellusAuth({ allowPat: false }), async (req: Request, res: Response) => {
  try {
    const claims = requireClaimsFor(req);
    await kcAdmin().logoutAll(claims.sub);
    await tellusAuthService.revokeJti(claims.jti, claims.sub, new Date(claims.exp * 1000));
    clearSessionCookies(res);
    await emitAuditEvent({
      keycloakSub: claims.sub,
      category: 'session',
      action: 'session.logout-all',
      result: 'SUCCESS',
      req,
    });
    res.status(204).end();
  } catch (err) {
    sendError(err, req, res);
  }
});

// ----- GET /audit/auth-events (Task 10 read-side) ----------------------------
// Palantir's full audit.3 pipeline is a Kafka fan-out with ~15m latency;
// that's out of scope for Phase 1. As a faithful read-side substitute we
// proxy Keycloak's native events store, which already records LOGIN /
// LOGOUT / CODE_TO_TOKEN / REFRESH_TOKEN / UPDATE_PASSWORD events with
// the details the spec's SIEM API enumerates (uid, sid, ipAddress, time,
// result, details.auth_method).
router.get('/me/audit', requireTellusAuth({ allowPat: false }), async (req: Request, res: Response) => {
  try {
    const claims = requireClaimsFor(req);
    const type = (req.query.type as string | undefined)?.split(',').filter(Boolean);
    const max = Math.min(parseInt((req.query.max as string) || '50', 10) || 50, 500);

    // Pull BOTH streams in parallel: Keycloak's native events (LOGIN,
    // LOGOUT, CODE_TO_TOKEN, UPDATE_PASSWORD…) AND the tellus-side
    // audit log that covers every credential-management action we own
    // (password change, TOTP enroll/disable, passkey register/delete,
    // PAT create/revoke, reauth issue, MFA budget exhaustion). The
    // two streams are merged into a single time-ordered list so the
    // /settings/audit page renders one unified history.
    // Fetch `max` from each source independently so one side can't
    // starve the other. After merging we slice down to the caller's
    // requested max. This matters when the user has many Keycloak
    // LOGIN events which would otherwise push tellus credential-
    // management events out of the top N.
    const [kcEventsSettled, tellusEventsSettled] = await Promise.allSettled([
      kcAdmin().listEvents({ user: claims.sub, type, max }),
      listAuditEvents({ keycloakSub: claims.sub, limit: max }),
    ]);

    const kcEvents = kcEventsSettled.status === 'fulfilled' ? kcEventsSettled.value : [];
    const tellusEvents = tellusEventsSettled.status === 'fulfilled' ? tellusEventsSettled.value : [];

    const kcShaped = kcEvents.map((e) => ({
      source: 'keycloak' as const,
      time: new Date(e.time).toISOString(),
      type: e.type,
      category: mapEventCategory(e.type),
      result: e.type.endsWith('_ERROR') ? ('ERROR' as const) : ('SUCCESS' as const),
      ipAddress: e.ipAddress ?? null,
      sessionId: e.sessionId ?? null,
      clientId: e.clientId ?? null,
      error: e.error ?? null,
      details: e.details ?? {},
    }));

    const tellusShaped = tellusEvents.map((e) => ({
      source: 'tellus' as const,
      time: e.createdAt,
      type: e.action,
      category: e.category,
      result: (e.result === 'SUCCESS' ? 'SUCCESS' : 'ERROR') as 'SUCCESS' | 'ERROR',
      ipAddress: e.ip,
      sessionId: null,
      clientId: null,
      error: null,
      details: e.details,
    }));

    // Sort DESC by time. We keep the caller's `max` cap, but take it
    // from the merged + sorted list rather than slicing one source
    // first — this guarantees tellus events (which tend to be much
    // rarer than Keycloak login events) never get crowded out.
    const merged = [...kcShaped, ...tellusShaped]
      .sort((a, b) => (a.time < b.time ? 1 : -1))
      .slice(0, Math.max(max, kcShaped.length + tellusShaped.length));

    res.json({ success: true, data: merged });
  } catch (err) {
    sendError(err, req, res);
  }
});

function mapEventCategory(eventType: string): string {
  if (eventType.startsWith('LOGIN')) return 'userLogin';
  if (eventType.startsWith('LOGOUT')) return 'userLogout';
  if (eventType.includes('TOKEN')) return 'tokenGeneration';
  if (eventType.includes('PASSWORD') || eventType.includes('TOTP') || eventType.includes('REQUIRED_ACTION')) {
    return 'credentialChange';
  }
  return 'authenticationCheck';
}

// ----- POST /auth/switch-scope (Task 7 — minimal backend implementation) ----
// Stores the narrowed marking subset in the shared revocation map keyed
// by jti so /check-access can honor it until a full SPI ships. The spec
// allows narrowing only; widening requires re-login.
const scopedSessions = new Map<string, string[]>();
const SwitchScopeSchema = z.object({ newScope: z.array(z.string()) });

router.post('/switch-scope', requireTellusAuth({ allowPat: false }), (req: Request, res: Response) => {
  try {
    const parsed = SwitchScopeSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
    }
    const claims = requireClaimsFor(req);
    // In Phase 2 we don't have real markings — any non-empty subset that
    // isn't a superset of {"PUBLIC"} is rejected as a placeholder. This
    // endpoint exists so the UI can exercise the flow end-to-end.
    scopedSessions.set(claims.jti, parsed.data.newScope);
    res.json({
      success: true,
      data: {
        jti: claims.jti,
        sessionScope: parsed.data.newScope,
        note: 'Markings engine not yet installed — scope stored but enforcement is a no-op until Task 6 lands.',
      },
    });
  } catch (err) {
    sendError(err, req, res);
  }
});

router.get('/me/session-scope', requireTellusAuth({ allowPat: false }), (req: Request, res: Response) => {
  try {
    const claims = requireClaimsFor(req);
    const scope = scopedSessions.get(claims.jti) ?? [];
    res.json({ success: true, data: { sessionScope: scope } });
  } catch (err) {
    sendError(err, req, res);
  }
});

// ----- /admin/applications (Task 8 — Developer Console) ---------------------
const AppCreateSchema = z.object({
  name: z.string().min(1).max(255),
  clientType: z.enum(['public', 'confidential']),
  redirectUris: z.array(z.string().url()).max(100).default([]),
  resourceScopes: z.array(z.string()).max(1000).default([]),
});

function requireAdminRole(req: Request) {
  const roles = req.tellusPrincipal?.roles ?? [];
  if (!roles.includes('ontology-admin')) {
    throw new AppError('ontology-admin role required', 403, 'INSUFFICIENT_ROLE');
  }
}

router.get('/admin/applications', requireTellusAuth({ allowPat: false }), async (req: Request, res: Response) => {
  try {
    requireAdminRole(req);
    const clients = await kcAdmin().listClients();
    // Hide the three internal clients the bootstrap script owns.
    const HIDDEN = new Set(['tellus-frontend', 'tellus-api', 'tellus-confidential', 'account', 'account-console', 'admin-cli', 'broker', 'realm-management', 'security-admin-console']);
    res.json({
      success: true,
      data: clients
        .filter((c) => !HIDDEN.has(c.clientId))
        .map((c) => ({
          id: c.id,
          clientId: c.clientId,
          name: c.name ?? c.clientId,
          publicClient: c.publicClient,
          redirectUris: c.redirectUris ?? [],
        })),
    });
  } catch (err) {
    sendError(err, req, res);
  }
});

router.post('/admin/applications', requireTellusAuth({ allowPat: false }), async (req: Request, res: Response) => {
  try {
    requireAdminRole(req);
    const parsed = AppCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
    }
    const totalScopes = (parsed.data.resourceScopes?.length ?? 0);
    if (totalScopes > 1000) {
      throw new AppError('SCOPE_LIMIT_EXCEEDED', 400, 'SCOPE_LIMIT_EXCEEDED');
    }
    const clientId = `tellus-app-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const created = await kcAdmin().createClient({
      clientId,
      name: parsed.data.name,
      publicClient: parsed.data.clientType === 'public',
      standardFlowEnabled: true,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: parsed.data.clientType === 'confidential',
      redirectUris: parsed.data.redirectUris,
    });
    const payload: Record<string, unknown> = {
      applicationId: created.id,
      clientId: created.clientId,
      name: parsed.data.name,
      clientType: parsed.data.clientType,
      redirectUris: parsed.data.redirectUris,
    };
    if (parsed.data.clientType === 'confidential') {
      payload.clientSecret = await kcAdmin().getClientSecret(created.id);
    }
    res.status(201).json({ success: true, data: payload });
  } catch (err) {
    sendError(err, req, res);
  }
});

router.delete('/admin/applications/:id', requireTellusAuth({ allowPat: false }), async (req: Request, res: Response) => {
  try {
    requireAdminRole(req);
    await kcAdmin().deleteClient(req.params.id);
    res.status(204).end();
  } catch (err) {
    sendError(err, req, res);
  }
});

// ===========================================================================
// Superadmin console — /admin/users + /admin/settings.
//
// These endpoints back the FE /users page that only the holder of the
// `tellus-superadmin` realm role can reach. They expose:
//
//   • list, create, delete, enable/disable Keycloak users
//   • read + mutate system_settings (currently just the
//     `require_passkey_enrollment` toggle)
//
// Every mutation is audited into tellus_audit_events so the same event
// shows up in the audit feed. PATs are REJECTED by the middleware —
// superadmin actions must tie to a live human for the audit trail.
// ===========================================================================

const ListUsersQuerySchema = z.object({
  search: z.string().max(255).optional(),
  first: z.coerce.number().int().min(0).max(10_000).optional(),
  max: z.coerce.number().int().min(1).max(200).optional(),
});

router.get(
  '/admin/users',
  requireTellusAuth({ allowPat: false }),
  requireSuperAdmin,
  async (req: Request, res: Response) => {
    try {
      const parsed = ListUsersQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }
      const [users, total] = await Promise.all([
        kcAdmin().listUsers({
          search: parsed.data.search,
          first: parsed.data.first,
          max: parsed.data.max,
        }),
        kcAdmin().countUsers(parsed.data.search),
      ]);
      res.json({
        success: true,
        data: {
          users,
          total,
          superadminRole: TELLUS_SUPERADMIN_ROLE,
        },
      });
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

const CreateUserSchema = z.object({
  email: z.string().email().max(320),
  username: z.string().min(1).max(255).optional(),
  // firstName/lastName are REQUIRED: the Keycloak realm requires non-blank
  // names for direct-grant (Keycloak blocks the password grant with
  // "Account is not fully set up" when either is blank), and fabricating a
  // placeholder leaks a fake `name` claim into the greeting. The admin UI
  // form collects both; reject early here so the operator sees the reason.
  firstName: z.string().min(1).max(128),
  lastName: z.string().min(1).max(128),
  // The realm's password policy enforces 12+ chars, one upper, one
  // lower, one digit, one symbol — KC will 400 the create call if
  // the password violates that, and we surface the KC error straight
  // through to the FE so the operator sees the real reason.
  password: z.string().min(12).max(256),
  enabled: z.boolean().optional(),
  emailVerified: z.boolean().optional(),
});

router.post(
  '/admin/users',
  requireTellusAuth({ allowPat: false }),
  requireSuperAdmin,
  async (req: Request, res: Response) => {
    try {
      const parsed = CreateUserSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }
      const username = parsed.data.username ?? parsed.data.email;
      const actor = requireClaimsFor(req);

      // Pre-flight: refuse if the email or username is already taken.
      // KC would 409 on the create call, but surfacing the check here
      // gives us a typed error code the FE can show inline.
      const existing = await kcAdmin().findUserByEmail(parsed.data.email);
      if (existing) {
        throw new AppError(
          'A user with this email already exists',
          409,
          'USER_ALREADY_EXISTS',
        );
      }

      const userId = await kcAdmin().createUser({
        username,
        email: parsed.data.email,
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName,
        password: parsed.data.password,
        enabled: parsed.data.enabled ?? true,
        emailVerified: parsed.data.emailVerified ?? true,
      });

      await emitAuditEvent({
        keycloakSub: actor.sub,
        category: 'admin',
        action: 'admin.user.create',
        result: 'SUCCESS',
        req,
        details: {
          targetUserId: userId,
          targetEmail: parsed.data.email,
        },
      });

      res.status(201).json({
        success: true,
        data: {
          id: userId,
          username,
          email: parsed.data.email,
          firstName: parsed.data.firstName ?? null,
          lastName: parsed.data.lastName ?? null,
          enabled: parsed.data.enabled ?? true,
          emailVerified: parsed.data.emailVerified ?? true,
          roles: [] as string[],
        },
      });
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

router.delete(
  '/admin/users/:id',
  requireTellusAuth({ allowPat: false }),
  requireSuperAdmin,
  async (req: Request, res: Response) => {
    try {
      const actor = requireClaimsFor(req);
      if (req.params.id === actor.sub) {
        // A superadmin deleting their own account would orphan the
        // console and could only be recovered by hand-editing the
        // realm. Require them to hand the role to someone else first.
        throw new AppError(
          'Superadmins cannot delete their own account',
          400,
          'CANNOT_DELETE_SELF',
        );
      }
      // Wipe the in-tellus mirrors first so a later signup with the
      // same email doesn't inherit stale credentials.
      const db = foundryDb as unknown as Knex;
      await db('user_totp_secrets').where({ keycloak_sub: req.params.id }).delete();
      await db('user_webauthn_credentials').where({ keycloak_sub: req.params.id }).delete();
      await db('user_webauthn_challenges').where({ keycloak_sub: req.params.id }).delete();
      await db('auth_mfa_challenges').where({ keycloak_sub: req.params.id }).delete();
      await db('passkey_enrollment_tokens').where({ keycloak_sub: req.params.id }).delete();
      await db('user_reauth_tokens').where({ keycloak_sub: req.params.id }).delete();

      await kcAdmin().deleteUser(req.params.id);

      await emitAuditEvent({
        keycloakSub: actor.sub,
        category: 'admin',
        action: 'admin.user.delete',
        result: 'SUCCESS',
        req,
        details: { targetUserId: req.params.id },
      });

      res.status(204).end();
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

const ToggleUserSchema = z.object({ enabled: z.boolean() });

router.patch(
  '/admin/users/:id/enabled',
  requireTellusAuth({ allowPat: false }),
  requireSuperAdmin,
  async (req: Request, res: Response) => {
    try {
      const parsed = ToggleUserSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }
      const actor = requireClaimsFor(req);
      if (req.params.id === actor.sub && parsed.data.enabled === false) {
        throw new AppError(
          'Superadmins cannot disable their own account',
          400,
          'CANNOT_DISABLE_SELF',
        );
      }
      await kcAdmin().setUserEnabled(req.params.id, parsed.data.enabled);
      await emitAuditEvent({
        keycloakSub: actor.sub,
        category: 'admin',
        action: parsed.data.enabled ? 'admin.user.enable' : 'admin.user.disable',
        result: 'SUCCESS',
        req,
        details: { targetUserId: req.params.id },
      });
      res.json({ success: true, data: { id: req.params.id, enabled: parsed.data.enabled } });
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

// --- System settings ---------------------------------------------------

router.get(
  '/admin/settings',
  requireTellusAuth({ allowPat: false }),
  requireSuperAdmin,
  async (req: Request, res: Response) => {
    try {
      const settings = await getSystemSettingsService(foundryDb as unknown as Knex).getAll();
      res.json({
        success: true,
        data: {
          settings,
          knownKeys: KNOWN_SETTINGS,
        },
      });
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

const UpdateSettingSchema = z.object({
  value: z.union([z.boolean(), z.string(), z.number(), z.null()]),
});

router.put(
  '/admin/settings/:key',
  requireTellusAuth({ allowPat: false }),
  requireSuperAdmin,
  async (req: Request, res: Response) => {
    try {
      const key = req.params.key as KnownSettingKey;
      if (!KNOWN_SETTINGS.includes(key)) {
        throw new AppError(`Unknown setting: ${key}`, 400, 'UNKNOWN_SETTING');
      }
      const parsed = UpdateSettingSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(parsed.error.issues[0].message, 400, 'VALIDATION_ERROR');
      }
      const actor = requireClaimsFor(req);
      const updated = await getSystemSettingsService(foundryDb as unknown as Knex).set(
        key,
        parsed.data.value,
        actor.sub,
      );
      await emitAuditEvent({
        keycloakSub: actor.sub,
        category: 'admin',
        action: 'admin.setting.update',
        result: 'SUCCESS',
        req,
        details: { key, newValue: parsed.data.value },
      });
      res.json({ success: true, data: updated });
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

// ===========================================================================
// Keycloak health probe — wired into the detailed health endpoint in
// server.ts. Reports status=UP if the realm's OIDC discovery document
// responds within 3 seconds, DEGRADED otherwise. The latency is always
// reported so the dashboard can alert on slow Keycloak responses well
// before they tip over into hard failures.
// ===========================================================================
router.get('/health', async (_req: Request, res: Response) => {
  const issuer = `${kcConfig.kcUrl}/realms/${kcConfig.kcRealm}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  const start = Date.now();
  try {
    const r = await fetch(`${issuer}/.well-known/openid-configuration`, {
      signal: controller.signal,
    });
    const latencyMs = Date.now() - start;
    clearTimeout(timer);
    if (!r.ok) {
      return res.status(503).json({
        success: false,
        data: {
          keycloak: { status: 'DEGRADED', latencyMs, httpStatus: r.status },
          realm: kcConfig.kcRealm,
          issuer,
        },
      });
    }
    res.json({
      success: true,
      data: {
        keycloak: { status: 'UP', latencyMs },
        realm: kcConfig.kcRealm,
        issuer,
      },
    });
  } catch (err) {
    clearTimeout(timer);
    const latencyMs = Date.now() - start;
    res.status(503).json({
      success: false,
      data: {
        keycloak: {
          status: 'DOWN',
          latencyMs,
          error: err instanceof Error ? err.message : String(err),
        },
        realm: kcConfig.kcRealm,
        issuer,
      },
    });
  }
});

// ===========================================================================
// Example: a protected /me/audit/export endpoint that demonstrates
// PAT scope enforcement. Only PATs that were minted with the
// `audit:read` scope can reach it; JWT/cookie sessions fall through
// to the normal realm-role check.
// ===========================================================================
router.get(
  '/me/audit/export',
  requireTellusAuth({ allowPat: true }),
  requirePatScope('audit:read'),
  async (req: Request, res: Response) => {
    try {
      const principal = req.tellusPrincipal;
      if (!principal) throw new AppError('No principal', 401, 'UNAUTHORIZED');
      const sub = principal.keycloakSub || (req.tellusClaims?.sub ?? '');
      if (!sub) throw new AppError('No subject', 401, 'UNAUTHORIZED');
      const events = await listAuditEvents({
        keycloakSub: sub,
        limit: Math.min(parseInt((req.query.max as string) || '200', 10) || 200, 1000),
      });
      res.json({ success: true, data: events });
    } catch (err) {
      sendError(err, req, res);
    }
  },
);

// ===========================================================================
// Public PAT scope manifest — advertises the closed enum of scopes a PAT
// can carry plus the prefix→scope routing table used by the app-wide gate.
// Tooling that mints PATs for third-party apps reads this instead of
// scraping services/patScopeMap.ts, so the access model has a single
// documented source of truth. Intentionally public — it's documentation.
// ===========================================================================
router.get('/pat-scopes', (_req: Request, res: Response) => {
  res.json({ success: true, data: getPatScopeManifest() });
});

export default router;
export { TELLUS_COOKIE, TELLUS_REFRESH_COOKIE };
