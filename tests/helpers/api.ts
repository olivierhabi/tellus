// ---------------------------------------------------------------------------
// Shared HTTP Client — JSON fetch wrapper for integration tests
//
// Provides a typed `api()` function used by all integration test modules.
// Configurable via TEST_BASE_URL environment variable.
//
// Usage:
//   import { api, BASE_URL } from "../helpers/api";
//   const { status, body, headers } = await api("GET", "/health");
// ---------------------------------------------------------------------------

export const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";

export interface ApiResponse {
  status: number;
  body: any;
  headers: Headers;
}

// Module-level bearer token. Tests that run behind Keycloak/auth
// middleware call `setAuthToken()` after their login-bypass step; every
// subsequent `api()` call auto-attaches `Authorization: Bearer …`
// unless the caller explicitly passes a different Authorization header.
// Foundry integration (BE-003..BE-030) depends on this — otherwise
// every CRUD test returns 401 because the auth header is missing.
//
// F-01 / Phase A2: sub-process test suites (run via selfTestBridge's
// `runInChildProcess`) inherit the parent's env but not its module
// state. To keep those suites authenticated without rewriting them,
// the TELLUS_TEST_BEARER env var — populated by tests/setupFiles.ts
// and propagated to child processes by selfTestBridge — seeds the
// initial token here. The parent vitest process overrides this via
// setAuthToken() after its own direct-grant call.
let bearerToken: string | null = process.env.TELLUS_TEST_BEARER || null;

export function setAuthToken(token: string | null): void {
  bearerToken = token && token.length > 0 ? token : null;
}

export async function api(
  method: string,
  urlPath: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<ApiResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
    ...extraHeaders,
  };
  const opts: RequestInit = {
    method,
    headers,
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE_URL}${urlPath}`, opts);
  let data: any = null;
  const text = await res.text();
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: res.status, body: data, headers: res.headers };
}
