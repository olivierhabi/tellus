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

export async function api(
  method: string,
  urlPath: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<ApiResponse> {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", ...extraHeaders },
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
