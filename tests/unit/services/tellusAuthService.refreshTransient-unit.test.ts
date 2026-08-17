// ---------------------------------------------------------------------------
// TellusAuthService.refreshSession — transient vs. dead-session typing test.
//
// Locks the fix for "frontend asks to log in every ~10 minutes despite
// TELLUS_SESSION_MAX_AGE=24h": every /auth/refresh failure used to surface
// as a cookie-wiping error regardless of cause, so a slow/hung Keycloak
// (observed in dev: H2 dev-file pool exhaustion, token endpoint taking
// 86s to answer) collapsed the 24h session to one access-token lifespan.
//
// The contract this test pins:
//   • Keycloak HTTP 400/401 on the grant  → 401 REFRESH_TOKEN_INVALID
//     (session genuinely dead → the route MAY clear cookies)
//   • Keycloak unreachable (network)      → 503 KEYCLOAK_UNREACHABLE
//   • Keycloak HTTP 5xx on the grant      → 502 KEYCLOAK_UNREACHABLE
//   • grant OK but fresh token fails      → 503 KEYCLOAK_UNREACHABLE
//     local verification (JWKS hiccup)
//   The route layer treats anything non-401 as transient and leaves the
//   httpOnly refresh cookie intact so the next attempt can succeed.
//
// Every test uses a DISTINCT refresh token: refreshSession single-flights
// and grace-caches by sha256(refreshToken) module-wide, so token reuse
// across cases would leak state between assertions.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Knex } from 'knex';
import { AppError } from '../../../src/utils/foundryAppError';
import { TellusAuthService } from '../../../src/services/tellusAuthService';

function makeService(kcUrl: string) {
  return new TellusAuthService({} as Knex, {
    kcUrl,
    kcRealm: 'tellus',
    kcFrontendClientId: 'tellus-frontend',
  });
}

async function expectRefreshError(kcUrl: string, token: string) {
  const svc = makeService(kcUrl);
  try {
    await svc.refreshSession(token);
    expect.unreachable(`refreshSession should have rejected (token ${token})`);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
}

/** Start a stub "Keycloak" whose token endpoint runs `handler`. */
function startStubKc(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('TellusAuthService.refreshSession — transient/dead typing', () => {
  it('Keycloak grant 400 → 401 REFRESH_TOKEN_INVALID (confirmed dead)', async () => {
    const { server, url } = await startStubKc((req, res) => {
      if (req.url?.endsWith('/protocol/openid-connect/token')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      res.writeHead(404).end();
    });
    try {
      const err = await expectRefreshError(url, 'rt-case-grant-400');
      expect(err.statusCode).toBe(401);
      expect(err.code).toBe('REFRESH_TOKEN_INVALID');
    } finally {
      await closeServer(server);
    }
  });

  it('Keycloak HTTP 5xx on the grant → 502 KEYCLOAK_UNREACHABLE (transient)', async () => {
    const { server, url } = await startStubKc((req, res) => {
      if (req.url?.endsWith('/protocol/openid-connect/token')) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'server_error' }));
        return;
      }
      res.writeHead(404).end();
    });
    try {
      const err = await expectRefreshError(url, 'rt-case-grant-500');
      expect(err.statusCode).toBe(502);
      expect(err.code).toBe('KEYCLOAK_UNREACHABLE');
    } finally {
      await closeServer(server);
    }
  });

  it('Keycloak unreachable (connection refused) → 503 KEYCLOAK_UNREACHABLE (transient)', async () => {
    // Grab a port, then close it so connects refuse immediately.
    const { server, url } = await startStubKc((_req, res) => res.writeHead(200).end());
    await closeServer(server);
    const err = await expectRefreshError(url, 'rt-case-unreachable');
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe('KEYCLOAK_UNREACHABLE');
  });

  it('grant 200 but fresh access token fails verification → 503 KEYCLOAK_UNREACHABLE (transient)', async () => {
    // A freshly-minted token failing local verification (JWKS hiccup /
    // malformed token / clock skew) must NOT be typed as a dead session:
    // the user's refresh cookie is still valid.
    const { server, url } = await startStubKc((req, res) => {
      if (req.url?.endsWith('/protocol/openid-connect/token')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: 'not-a-real-jwt',
            refresh_token: 'rotated-rt',
            expires_in: 3600,
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    try {
      const err = await expectRefreshError(url, 'rt-case-verify-fail');
      expect(err.statusCode).toBe(503);
      expect(err.code).toBe('KEYCLOAK_UNREACHABLE');
    } finally {
      await closeServer(server);
    }
  });

  it('a slow Keycloak hangs the grant → 503 KEYCLOAK_UNREACHABLE after the 5s bound', async () => {
    // Endpoint accepts but never answers; doRefreshGrant's
    // AbortSignal.timeout(5_000) must turn this into a TRANSIENT typed
    // error (not an untyped rejection the route would 500 + cookie-wipe).
    const { server, url } = await startStubKc(() => {
      /* never respond */
    });
    try {
      const startedAt = Date.now();
      const err = await expectRefreshError(url, 'rt-case-slow');
      expect(err.statusCode).toBe(503);
      expect(err.code).toBe('KEYCLOAK_UNREACHABLE');
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    } finally {
      server.closeAllConnections?.();
      await closeServer(server);
    }
  }, 12_000);
});
