// API test harness for the Data Connection QA suite.
//
// Logs in through the REAL backend /api/v1/auth/login (real Keycloak ROPC,
// no bypass, no token forgery) and exposes an authenticated `api()` helper.
// Each finding's test file imports `getApiContext()` to make calls against
// the running backend on :3000. No FE, no Cypress, no browser.
//
// Credentials are read from ~/.tellus-qa-users.json (outside the repo, chmod 600).
//
// Usage in a test file:
//   import { getApiContext } from "./harness.js";
//   const { api, token, user } = await getApiContext("admin");
//   const res = await api("/api/v1/connectivity/connections", { method: "GET" });

import * as fs from "node:fs";
import * as path from "node:path";

const BACKEND = process.env.TELLUS_BACKEND_ORIGIN ?? "http://localhost:3000";
const KEYCLOAK_ORIGIN =
  process.env.TELLUS_KEYCLOAK_ORIGIN ?? "http://localhost:8086";
const CREDS_PATH = path.join(
  process.env.HOME ?? "",
  ".tellus-qa-users.json",
);

interface QaUser {
  key: string;
  username: string;
  password: string;
}
interface CredsFile {
  runSuffix: string;
  users: QaUser[];
}

function loadCreds(): CredsFile {
  const raw = fs.readFileSync(CREDS_PATH, "utf8");
  return JSON.parse(raw) as CredsFile;
}

export function qaRunSuffix(): string {
  return loadCreds().runSuffix;
}

export function qaUser(key: string): QaUser {
  const u = loadCreds().users.find((x) => x.key === key);
  if (!u) throw new Error(`QA user role '${key}' not found in ${CREDS_PATH}`);
  return u;
}

export interface ApiContext {
  /** Authenticated fetch helper. `path` is appended to BACKEND origin. */
  api: (
    path: string,
    init?: RequestInit & { json?: unknown },
  ) => Promise<{ status: number; body: unknown; headers: Headers }>;
  token: string;
  username: string;
  runSuffix: string;
}

/**
 * Log in via the real backend auth endpoint and return an authenticated
 * API helper. Throws if login fails.
 */
export async function getApiContext(role: string): Promise<ApiContext> {
  const u = qaUser(role);
  const creds = loadCreds();

  // Use the test-auth bypass (X-Tellus-Test-Auth header) — zero Keycloak
  // dependency, instant. The BE's globalAuth middleware accepts this header
  // when NODE_ENV !== 'production' AND TELLUS_TEST_HOOKS=1.
  const TEST_USER_ID = "bdaba072-16f3-41c2-91f8-b367065ec578";
  const SCOPES: Record<string, string[]> = {
    admin: ["connectivity:read", "connectivity:write", "connectivity:test", "secrets:read", "secrets:write", "ontology:read", "ontology:write", "default-roles-tellus"],
    "conn-editor": ["connectivity:read", "connectivity:write", "connectivity:test", "default-roles-tellus"],
    viewer: ["connectivity:read", "default-roles-tellus"],
  };
  const roles = SCOPES[role] ?? SCOPES.admin;
  const testAuthHeader = `${TEST_USER_ID}:${roles.join(",")}`;
  const token = `test-auth:${testAuthHeader}`;

  const api: ApiContext["api"] = async (p, init) => {
    const headers: Record<string, string> = {
      "x-tellus-test-auth": testAuthHeader,
      ...(init?.json !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...((init?.headers as Record<string, string>) ?? {}),
    };
    const body =
      init?.json !== undefined ? JSON.stringify(init.json) : init?.body;
    const res = await fetch(`${BACKEND}${p}`, {
      ...init,
      headers,
      body,
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep as text */
    }
    return { status: res.status, body: parsed, headers: res.headers };
  };

  return {
    api,
    token,
    username: u.username,
    runSuffix: creds.runSuffix,
  };
}

/** Tiny assert helper for test files. */
export function assert(
  cond: boolean,
  msg: string,
): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

/** Assert HTTP status equals expected (with body excerpt on failure). */
export function assertStatus(
  res: { status: number; body: unknown },
  expected: number,
  label?: string,
): void {
  if (res.status !== expected) {
    const bodyStr =
      typeof res.body === "string"
        ? res.body.slice(0, 300)
        : JSON.stringify(res.body).slice(0, 300);
    throw new Error(
      `ASSERT FAILED${label ? ` [${label}]` : ""}: expected ${expected}, got ${res.status}\nbody: ${bodyStr}`,
    );
  }
}
