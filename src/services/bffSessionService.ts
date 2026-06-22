/**
 * bffSessionService.ts — Backend-for-Frontend session layer (Palantir parity).
 *
 * This is the server-side half of the BFF cut-over. It implements the
 * authentication mechanics Foundry/Multipass uses in production:
 *
 *   • Authorization Code + PKCE (S256) redirect flow, with the CONFIDENTIAL
 *     `tellus-bff` client. The browser authenticates ON Keycloak's page; the
 *     OAuth client (secret, code exchange, tokens) lives entirely here.
 *   • Tokens are held SERVER-SIDE in Redis. The browser receives only an
 *     opaque, httpOnly session id (`TELLUS_SID`) — it never holds a usable
 *     credential (the credential-isolation property of Palantir's smart-proxy
 *     patent US11818171B2, approximated via the BFF).
 *   • Refresh is performed server-side, single-flight per session, so the
 *     realm's refresh-token rotation + reuse/theft detection
 *     (revokeRefreshToken=true, refreshTokenMaxReuse=0) cannot be tripped by
 *     concurrent browser tabs — the browser has no refresh token at all.
 *
 * This module is ADDITIVE: it does not touch the existing ROPC `/auth/login`
 * path or the `TELLUS_TOKEN` cookie. The two models coexist; the FE chooses
 * via a feature flag during the staged cut-over.
 *
 * Verified end-to-end against the live Keycloak by
 * tellus-fe/scripts/verify-palantir-auth-parity.sh.
 */

import crypto from "crypto";
import jwt, { type JwtHeader, type SigningKeyCallback } from "jsonwebtoken";
import jwksClient, { type JwksClient } from "jwks-rsa";
import { getKeycloakRealm } from "../auth/keycloakConfig";
import { SESSION_MAX_AGE_SECONDS } from "../config/sessionConfig";

// ---------------------------------------------------------------------------
// Config (env-driven; all default to the local docker-compose values)
// ---------------------------------------------------------------------------
const KC_URL = process.env.KEYCLOAK_URL || "http://localhost:8086";
const KC_REALM = getKeycloakRealm();
const ISSUER = `${KC_URL}/realms/${KC_REALM}`;
const AUTHZ_EP = `${ISSUER}/protocol/openid-connect/auth`;
const TOKEN_EP = `${ISSUER}/protocol/openid-connect/token`;
const LOGOUT_EP = `${ISSUER}/protocol/openid-connect/logout`;
const JWKS_URL = `${ISSUER}/protocol/openid-connect/certs`;

const BFF_CLIENT_ID = process.env.KEYCLOAK_BFF_CLIENT_ID || "tellus-bff";
const BFF_CLIENT_SECRET = process.env.KEYCLOAK_BFF_CLIENT_SECRET || "";
/** Must match a registered redirect URI on the tellus-bff Keycloak client. */
const CALLBACK_URL =
  process.env.TELLUS_BFF_CALLBACK_URL ||
  "http://localhost:3000/api/v1/auth/sso/callback";
/** Absolute origin of the FE app — where the user lands after login. */
const FE_BASE_URL = process.env.TELLUS_FE_BASE_URL || "http://localhost:3001";

export const SID_COOKIE = "TELLUS_SID";
const FLOW_TTL_SECONDS = 600; // 10 min to complete the login round-trip
const SESSION_TTL_SECONDS = SESSION_MAX_AGE_SECONDS;
const REFRESH_SKEW_SECONDS = 30; // refresh this long before the access token expires

/** True only when the confidential client secret is wired — routes 503 otherwise. */
export function isBffConfigured(): boolean {
  return BFF_CLIENT_SECRET.length > 0;
}

export function feBaseUrl(): string {
  return FE_BASE_URL;
}

// ---------------------------------------------------------------------------
// Redis (mirrors the lazy self-contained pattern in services/linkPagination.ts)
// ---------------------------------------------------------------------------
type RedisLike = {
  get(k: string): Promise<string | null>;
  set(k: string, v: string, o?: { EX?: number }): Promise<unknown>;
  del(k: string): Promise<unknown>;
};
let redisInstance: RedisLike | null | undefined;
async function getRedis(): Promise<RedisLike | null> {
  if (redisInstance !== undefined) return redisInstance;
  try {
    const mod: any = await import("redis");
    const url = process.env.REDIS_URL ?? "redis://localhost:6379";
    const client = mod.createClient({
      url,
      socket: {
        connectTimeout: 5_000,
        reconnectStrategy: (retries: number) => Math.min(retries * 500, 30_000),
      },
    });
    client.on("error", () => {
      /* silenced — callers treat a null redis as "session unavailable" */
    });
    await client.connect();
    redisInstance = client as RedisLike;
  } catch {
    redisInstance = null;
  }
  return redisInstance;
}

// ---------------------------------------------------------------------------
// JWKS verification (mirrors middleware/globalAuth.ts)
// ---------------------------------------------------------------------------
let _jwks: JwksClient | null = null;
function jwks(): JwksClient {
  if (!_jwks) {
    _jwks = jwksClient({
      jwksUri: JWKS_URL,
      cache: true,
      cacheMaxEntries: 5,
      cacheMaxAge: 10 * 60 * 1000,
      rateLimit: true,
      jwksRequestsPerMinute: 30,
      timeout: 5_000,
    });
  }
  return _jwks;
}
function getKey(header: JwtHeader, cb: SigningKeyCallback): void {
  if (!header.kid) return cb(new Error("token missing kid"));
  jwks()
    .getSigningKey(header.kid)
    .then((k) => cb(null, k.getPublicKey()))
    .catch((e) => cb(e));
}
function verifyJwt(
  token: string,
  opts: jwt.VerifyOptions,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      getKey,
      { algorithms: ["RS256"], issuer: [ISSUER, `http://localhost:8086/realms/${KC_REALM}`, `http://keycloak:8086/realms/${KC_REALM}`], ...opts },
      (err, decoded) => {
        if (err || !decoded || typeof decoded !== "object") {
          return reject(err || new Error("JWT verification failed"));
        }
        resolve(decoded as Record<string, unknown>);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// PKCE / random helpers
// ---------------------------------------------------------------------------
const b64url = (buf: Buffer): string => buf.toString("base64url");
const randomToken = (bytes = 32): string => b64url(crypto.randomBytes(bytes));
const pkceChallenge = (verifier: string): string =>
  b64url(crypto.createHash("sha256").update(verifier).digest());

function sanitizeReturnTo(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  // Same-origin paths only — never an open-redirect target.
  return s.startsWith("/") && !s.startsWith("//") ? s : "/";
}

interface SsoFlow {
  codeVerifier: string;
  nonce: string;
  returnTo: string;
}
interface BffSession {
  sub: string;
  accessToken: string;
  refreshToken: string;
  accessExp: number; // epoch seconds
  claims: Record<string, unknown>;
  idToken?: string;
}

// ---------------------------------------------------------------------------
// 1) begin — build the Keycloak authorize URL + stash the PKCE/nonce/returnTo
// ---------------------------------------------------------------------------
export async function beginSsoFlow(
  returnToRaw: unknown,
): Promise<{ authorizeUrl: string } | null> {
  const redis = await getRedis();
  if (!redis) return null;
  const state = randomToken(16);
  const nonce = randomToken(16);
  const codeVerifier = randomToken(32);
  const flow: SsoFlow = {
    codeVerifier,
    nonce,
    returnTo: sanitizeReturnTo(returnToRaw),
  };
  await redis.set(`ssoflow:${state}`, JSON.stringify(flow), {
    EX: FLOW_TTL_SECONDS,
  });
  const u = new URL(AUTHZ_EP);
  u.searchParams.set("client_id", BFF_CLIENT_ID);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid profile email offline_access");
  u.searchParams.set("redirect_uri", CALLBACK_URL);
  u.searchParams.set("state", state);
  u.searchParams.set("nonce", nonce);
  u.searchParams.set("code_challenge", pkceChallenge(codeVerifier));
  u.searchParams.set("code_challenge_method", "S256");
  return { authorizeUrl: u.toString() };
}

// ---------------------------------------------------------------------------
// 2) complete — exchange the code, validate id_token+nonce, mint the session
// ---------------------------------------------------------------------------
export async function completeSsoFlow(
  code: unknown,
  state: unknown,
): Promise<{ sid: string; maxAgeMs: number; returnTo: string } | null> {
  if (typeof code !== "string" || typeof state !== "string") return null;
  const redis = await getRedis();
  if (!redis) return null;
  const raw = await redis.get(`ssoflow:${state}`);
  if (!raw) return null; // unknown/expired/replayed state — reject (CSRF guard)
  await redis.del(`ssoflow:${state}`); // single-use
  const flow = JSON.parse(raw) as SsoFlow;

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: BFF_CLIENT_ID,
    client_secret: BFF_CLIENT_SECRET,
    code,
    redirect_uri: CALLBACK_URL,
    code_verifier: flow.codeVerifier,
  });
  const res = await fetch(TOKEN_EP, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    expires_in: number;
  };

  // Validate the ID token signature + nonce (replay protection).
  if (data.id_token) {
    try {
      const idClaims = await verifyJwt(data.id_token, {
        audience: BFF_CLIENT_ID,
      });
      if (idClaims.nonce !== flow.nonce) return null;
    } catch {
      return null;
    }
  }

  // Verify the access token and pull claims (sub, roles, email, exp).
  let claims: Record<string, unknown>;
  try {
    claims = await verifyJwt(data.access_token, {});
  } catch {
    return null;
  }

  const sid = randomToken(32);
  const accessExp =
    typeof claims.exp === "number"
      ? claims.exp
      : Math.floor(Date.now() / 1000) + 300;
  const session: BffSession = {
    sub: String(claims.sub ?? ""),
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? "",
    accessExp,
    claims,
    idToken: data.id_token,
  };
  await redis.set(`sess:${sid}`, JSON.stringify(session), {
    EX: SESSION_TTL_SECONDS,
  });
  return {
    sid,
    maxAgeMs: SESSION_TTL_SECONDS * 1000,
    returnTo: flow.returnTo,
  };
}

// ---------------------------------------------------------------------------
// 3) resolve — load the session, refreshing server-side (single-flight) when
//    the access token is near expiry. Returns the live claims, or null if the
//    session is gone / unrefreshable.
// ---------------------------------------------------------------------------
const refreshInFlight = new Map<string, Promise<BffSession | null>>();

async function refreshSession(
  sid: string,
  session: BffSession,
): Promise<BffSession | null> {
  const existing = refreshInFlight.get(sid);
  if (existing) return existing;
  const p = (async (): Promise<BffSession | null> => {
    const redis = await getRedis();
    if (!redis || !session.refreshToken) return null;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: BFF_CLIENT_ID,
      client_secret: BFF_CLIENT_SECRET,
      refresh_token: session.refreshToken,
    });
    const res = await fetch(TOKEN_EP, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      // Refresh rejected (expired / revoked / reuse-detected) — kill the session.
      await redis.del(`sess:${sid}`);
      return null;
    }
    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    let claims: Record<string, unknown>;
    try {
      claims = await verifyJwt(data.access_token, {});
    } catch {
      return null;
    }
    const updated: BffSession = {
      ...session,
      accessToken: data.access_token,
      // Keycloak rotates the refresh token — store the new one.
      refreshToken: data.refresh_token ?? session.refreshToken,
      accessExp:
        typeof claims.exp === "number"
          ? claims.exp
          : Math.floor(Date.now() / 1000) + 300,
      claims,
    };
    await redis.set(`sess:${sid}`, JSON.stringify(updated), {
      EX: SESSION_TTL_SECONDS,
    });
    return updated;
  })().finally(() => refreshInFlight.delete(sid));
  refreshInFlight.set(sid, p);
  return p;
}

export async function resolveSession(
  sid: string,
): Promise<Record<string, unknown> | null> {
  const redis = await getRedis();
  if (!redis) return null;
  const raw = await redis.get(`sess:${sid}`);
  if (!raw) return null;
  let session = JSON.parse(raw) as BffSession;
  const now = Math.floor(Date.now() / 1000);
  if (now >= session.accessExp - REFRESH_SKEW_SECONDS) {
    const refreshed = await refreshSession(sid, session);
    if (!refreshed) return null;
    session = refreshed;
  }
  return session.claims;
}

export interface BffProfile {
  id: string;
  email?: string;
  displayName?: string;
  roles: string[];
}
export async function getSessionProfile(
  sid: string,
): Promise<BffProfile | null> {
  const claims = await resolveSession(sid);
  if (!claims) return null;
  const realmAccess = (claims.realm_access as { roles?: string[] }) || {};
  return {
    id: String(claims.sub ?? ""),
    email: (claims.email as string) ?? undefined,
    displayName:
      (claims.preferred_username as string) ??
      (claims.name as string) ??
      undefined,
    roles: Array.isArray(realmAccess.roles) ? realmAccess.roles : [],
  };
}

// ---------------------------------------------------------------------------
// 4) destroy — RP-initiated logout at Keycloak + drop the server session
// ---------------------------------------------------------------------------
export async function destroySession(sid: string): Promise<void> {
  const redis = await getRedis();
  if (!redis) return;
  const raw = await redis.get(`sess:${sid}`);
  if (!raw) return;
  const session = JSON.parse(raw) as BffSession;
  if (session.refreshToken) {
    const body = new URLSearchParams({
      client_id: BFF_CLIENT_ID,
      client_secret: BFF_CLIENT_SECRET,
      refresh_token: session.refreshToken,
    });
    await fetch(LOGOUT_EP, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(3_000),
    }).catch(() => undefined);
  }
  await redis.del(`sess:${sid}`);
}
