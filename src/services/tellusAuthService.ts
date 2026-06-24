/**
 * tellusAuthService.ts
 * --------------------
 * Core authentication service for the Palantir Multipass-equivalent auth
 * layer described in ontology/tellus-auth.md.
 *
 * Responsibilities (Phase 1):
 *   • Proxy direct-grant login to Keycloak and return tokens
 *   • Validate Keycloak JWTs against the realm JWKS (RS256)
 *   • Track revoked jti values so logout invalidates a session
 *   • CRUD operations on Personal Access Tokens (Task 9) with hashed storage
 *   • Stubbed hasOperation() authorization check keyed on realm roles
 *
 * Items explicitly deferred to a later phase (documented in tellus-auth.md):
 *   • Redis-backed revocation with reuse detection (1-minute grace)
 *   • Markings/Orgs/CBAC claims (Task 6)
 *   • Scoped sessions (Task 7)
 *   • Kafka audit pipeline (Task 10)
 */

import crypto from 'crypto';
import jwt, { JwtHeader, SigningKeyCallback } from 'jsonwebtoken';
import jwksClient, { JwksClient } from 'jwks-rsa';
import { Knex } from 'knex';
import { AppError } from '../utils/foundryAppError';

export interface TellusAuthConfig {
  kcUrl: string;
  kcRealm: string;
  kcFrontendClientId: string;
  kcConfidentialClientId?: string;
  kcConfidentialClientSecret?: string;
}

export interface TellusClaims {
  sub: string;
  jti: string;
  org: string;
  email?: string;
  preferred_username?: string;
  realm_access?: { roles: string[] };
  resource_access?: Record<string, { roles: string[] }>;
  iss: string;
  exp: number;
  iat: number;
  azp?: string;
}

export interface LoginResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  claims: TellusClaims;
}

export interface CheckAccessRequest {
  operation: string;
  resourceRid?: string;
  resourceType?: string;
}

export interface CheckAccessResponse {
  allowed: boolean;
  reason: string;
}

export interface PatCreateInput {
  userId: string;
  keycloakSub: string;
  name: string;
  expiresAt: Date;
  scopes: string[];
}

export interface PatRecord {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  expiresAt: Date;
  lastUsedAt: Date | null;
  createdAt: Date;
}

const PAT_PREFIX = 'tellus_pat_';

/**
 * Process-wide revoked-jti set. Module-level (not per-instance) so the
 * middleware singleton and any router-owned service instance see the
 * same revocation state — otherwise a logout routed through the
 * tellusAuthV1 service would not be observed by the middleware's
 * service instance.
 */
const REVOKED_JTIS: Map<string, number> = new Map();

// hasOperation() stub — matches spec's centralized authorization model.
// Real Palantir resolves via Multipass.hasOperation(token, op, resource);
// here we approximate with role-based checks on Keycloak realm roles.
const ROLE_OP_MAP: Record<string, Set<string>> = {
  'ontology-admin': new Set(['read', 'write', 'edit', 'delete', 'admin', 'expand-access']),
  'ontology-editor': new Set(['read', 'write', 'edit']),
  'ontology-viewer': new Set(['read']),
  'audit-viewer': new Set(['audit-export:view']),
};

export class TellusAuthService {
  private jwks: JwksClient;
  private issuer: string;

  constructor(
    private knex: Knex,
    private config: TellusAuthConfig,
  ) {
    this.issuer = `${config.kcUrl}/realms/${config.kcRealm}`;
    this.jwks = jwksClient({
      jwksUri: `${this.issuer}/protocol/openid-connect/certs`,
      cache: true,
      cacheMaxEntries: 5,
      cacheMaxAge: 10 * 60 * 1000,
      rateLimit: true,
      jwksRequestsPerMinute: 30,
    });
  }

  /** Extract signing key for a JWT header via JWKS lookup. */
  private getKey = (header: JwtHeader, cb: SigningKeyCallback) => {
    if (!header.kid) return cb(new Error('token missing kid'));
    this.jwks
      .getSigningKey(header.kid)
      .then((k) => cb(null, k.getPublicKey()))
      .catch((e) => cb(e));
  };

  /**
   * Exchange username/password for a Keycloak token pair. Direct-grant is
   * used here to keep the existing email-password login form in the FE
   * working end-to-end; the spec-compliant PKCE redirect flow is exposed
   * separately via /api/v1/auth/oidc/*.
   */
  async loginWithPassword(username: string, password: string): Promise<LoginResult> {
    const body = new URLSearchParams({
      grant_type: 'password',
      client_id: this.config.kcFrontendClientId,
      username,
      password,
      scope: 'openid profile email offline_access',
    });

    // F-P4-08: bound the password-grant call. Keycloak p99 under normal
    // load is ~300ms; 5s gives generous slack while still preventing a
    // frozen authenticator from starving login traffic.
    const res = await fetch(
      `${this.issuer}/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(5_000),
      },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 400) {
        throw new AppError('Invalid email or password', 401, 'UNAUTHORIZED');
      }
      throw new AppError(`Keycloak login failed: ${text || res.statusText}`, 502, 'KEYCLOAK_UNREACHABLE');
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    const claims = await this.verifyAccessToken(data.access_token);
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      claims,
    };
  }

  /**
   * Rotate an access token using the Keycloak refresh_token grant. The
   * realm has revokeRefreshToken=true so the returned refresh_token is
   * brand-new and the old one is invalidated on Keycloak's side —
   * surviving our 5-minute access token lifespan without forcing a
   * full re-login. If Keycloak rejects the refresh (expired, revoked,
   * or reuse-detected) we map it back to a clean 401 envelope.
   */
  async refreshSession(refreshToken: string): Promise<LoginResult> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.config.kcFrontendClientId,
      refresh_token: refreshToken,
    });
    // F-P4-08: same 5s bound as loginWithPassword; callers expect
    // token-rotation to be cheap.
    const res = await fetch(`${this.issuer}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      if (res.status === 400 || res.status === 401) {
        throw new AppError('Refresh token is invalid or expired', 401, 'REFRESH_TOKEN_INVALID');
      }
      throw new AppError('Keycloak unreachable during refresh', 502, 'KEYCLOAK_UNREACHABLE');
    }
    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    const claims = await this.verifyAccessToken(data.access_token);
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      claims,
    };
  }

  /** Verify a Keycloak-issued JWT and return the decoded claims. */
  verifyAccessToken(token: string): Promise<TellusClaims> {
    return new Promise((resolve, reject) => {
      // Support loopback and docker network issuer profiles (consistent with globalAuth.ts)
      const allowedIssuers = [
        this.issuer,
        `http://localhost:8086/realms/${this.config.kcRealm}`,
        `http://keycloak:8086/realms/${this.config.kcRealm}`,
      ];

      jwt.verify(
        token,
        this.getKey as jwt.GetPublicKeyOrSecret,
        { algorithms: ['RS256'], issuer: allowedIssuers } as jwt.VerifyOptions,
        (err: any, decoded: any) => {
          if (err) {
            if (err.name === 'TokenExpiredError') {
              return reject(new AppError('Access token has expired.', 401, 'TOKEN_EXPIRED'));
            }
            return reject(new AppError(err.message, 401, 'TOKEN_INVALID'));
          }
          resolve(decoded as TellusClaims);
        },
      );
    });
  }

  /** Hand back a normalized claims object for /auth/token-info responses. */
  toTokenInfo(c: TellusClaims) {
    return {
      sub: c.sub,
      jti: c.jti,
      org: c.org ?? c.azp ?? this.config.kcRealm,
      email: c.email,
      preferredUsername: c.preferred_username,
      realmRoles: c.realm_access?.roles ?? [],
      markings: [] as string[], // Task 6 — stubbed until CBAC ships
      orgs: [c.org ?? this.config.kcRealm],
      cbacClearance: null as string | null,
      sessionScope: [] as string[], // Task 7 — stubbed
      exp: c.exp,
      iat: c.iat,
      iss: c.iss,
    };
  }

  /** Logout: revoke the token on Keycloak and add its jti to the blacklist. */
  async logout(claims: TellusClaims, refreshToken?: string): Promise<void> {
    await this.revokeJti(claims.jti, claims.sub, new Date(claims.exp * 1000));
    if (refreshToken) {
      const body = new URLSearchParams({
        client_id: this.config.kcFrontendClientId,
        refresh_token: refreshToken,
      });
      // F-P4-08: logout is best-effort; 3s is enough. The outer
      // `.catch(() => undefined)` swallows timeout so logout still
      // succeeds locally when Keycloak is slow.
      await fetch(`${this.issuer}/protocol/openid-connect/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(3_000),
      }).catch(() => undefined);
    }
  }

  /** Record a jti as revoked until its natural expiration. */
  async revokeJti(jti: string, keycloakSub: string, expiresAt: Date): Promise<void> {
    // Always record in the shared module-level set first so revocation
    // cannot be bypassed by a transient DB failure or a missing migration,
    // and so that every TellusAuthService instance in the process sees it.
    REVOKED_JTIS.set(jti, expiresAt.getTime());
    try {
      await this.knex('auth_revoked_tokens')
        .insert({ jti, keycloak_sub: keycloakSub, expires_at: expiresAt })
        .onConflict('jti')
        .ignore();
    } catch {
      /* DB path unavailable — in-memory set is still authoritative. */
    }
  }

  async isJtiRevoked(jti: string): Promise<boolean> {
    const mem = REVOKED_JTIS.get(jti);
    if (mem !== undefined) {
      if (mem > Date.now()) return true;
      REVOKED_JTIS.delete(jti);
    }
    try {
      const row = await this.knex('auth_revoked_tokens').where({ jti }).first();
      if (!row) return false;
      if (new Date(row.expires_at) < new Date()) return false;
      return true;
    } catch (err) {
      // Fail CLOSED: if we cannot confirm a token is NOT revoked, we must
      // not accept it. The revocation table lives in the primary Postgres
      // that every data path already depends on, so a failure here means
      // the request would fail downstream regardless — rejecting it does
      // not widen the outage, but it does close the window in which a token
      // revoked on another replica (logout / compromise) would be honored.
      console.error('isJtiRevoked: revocation check failed, denying token', {
        jti,
        error: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
  }

  /** hasOperation(token, op, resource) — the centralized authorization check. */
  checkAccess(claims: TellusClaims, req: CheckAccessRequest): CheckAccessResponse {
    const roles = claims.realm_access?.roles ?? [];
    for (const role of roles) {
      const ops = ROLE_OP_MAP[role];
      if (ops && ops.has(req.operation)) {
        return { allowed: true, reason: `User has ${role} role` };
      }
    }
    return {
      allowed: false,
      reason: 'INSUFFICIENT_ROLE',
    };
  }

  // -----------------------------------------------------------------------
  // Personal Access Tokens (Task 9)
  // -----------------------------------------------------------------------

  static hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  async createPat(input: PatCreateInput): Promise<{ tokenId: string; token: string; record: PatRecord }> {
    if (input.expiresAt.getTime() <= Date.now()) {
      throw new AppError('expiresAt must be in the future', 400, 'VALIDATION_ERROR');
    }
    const rawSuffix = crypto.randomBytes(32).toString('hex');
    const token = `${PAT_PREFIX}${rawSuffix}`;
    const tokenHash = TellusAuthService.hashToken(token);
    const tokenPrefix = token.slice(0, PAT_PREFIX.length + 8);

    const [row] = await this.knex('personal_access_tokens')
      .insert({
        user_id: input.userId,
        keycloak_sub: input.keycloakSub,
        name: input.name,
        token_hash: tokenHash,
        token_prefix: tokenPrefix,
        scopes: input.scopes,
        expires_at: input.expiresAt,
      })
      .returning(['id', 'name', 'token_prefix', 'scopes', 'expires_at', 'last_used_at', 'created_at']);

    return {
      tokenId: row.id,
      token,
      record: {
        id: row.id,
        name: row.name,
        tokenPrefix: row.token_prefix,
        scopes: row.scopes ?? [],
        expiresAt: row.expires_at,
        lastUsedAt: row.last_used_at,
        createdAt: row.created_at,
      },
    };
  }

  async listPats(userId: string): Promise<PatRecord[]> {
    const rows = await this.knex('personal_access_tokens')
      .where({ user_id: userId })
      .whereNull('revoked_at')
      .orderBy('created_at', 'desc');
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      tokenPrefix: r.token_prefix,
      scopes: r.scopes ?? [],
      expiresAt: r.expires_at,
      lastUsedAt: r.last_used_at,
      createdAt: r.created_at,
    }));
  }

  async revokePat(userId: string, tokenId: string): Promise<void> {
    const affected = await this.knex('personal_access_tokens')
      .where({ id: tokenId, user_id: userId })
      .whereNull('revoked_at')
      .update({ revoked_at: new Date() });
    if (!affected) {
      throw new AppError('Token not found', 404, 'NOT_FOUND');
    }
  }

  /** Look up a PAT bearer string. Returns the owning user or throws. */
  async resolvePat(tokenString: string): Promise<{ userId: string; keycloakSub: string | null; scopes: string[] }> {
    if (!tokenString.startsWith(PAT_PREFIX)) {
      throw new AppError('Not a PAT', 401, 'TOKEN_INVALID');
    }
    const hash = TellusAuthService.hashToken(tokenString);
    const row = await this.knex('personal_access_tokens').where({ token_hash: hash }).first();
    if (!row) {
      throw new AppError('Token not found', 401, 'TOKEN_INVALID');
    }
    if (row.revoked_at) {
      throw new AppError('Token revoked', 401, 'TOKEN_REVOKED');
    }
    if (new Date(row.expires_at) < new Date()) {
      throw new AppError('Token expired', 401, 'TOKEN_EXPIRED');
    }
    await this.knex('personal_access_tokens')
      .where({ id: row.id })
      .update({ last_used_at: new Date() });
    return { userId: row.user_id, keycloakSub: row.keycloak_sub, scopes: row.scopes ?? [] };
  }
}
