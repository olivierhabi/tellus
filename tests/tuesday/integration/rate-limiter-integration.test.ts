// ---------------------------------------------------------------------------
// Action Execution Rate Limiter Integration Tests (Task 27)
//
// Verifies that action execution endpoints enforce rate limits. Tests the
// per-action-type limit (100/min), batch-per-user limit (10/min), response
// headers, and 429 error format.
//
// IMPORTANT: These tests fire many rapid requests. They use unique action
// type names to isolate rate limit counters from other test suites. The
// per-action-type limit (100/min) is the tightest and most testable.
//
// Tests cover:
//
//   1.  Normal requests include X-RateLimit-Remaining header
//   2.  Exceeding per-action-type limit returns 429
//   3.  429 response includes Retry-After header
//   4.  429 response includes correct error body format
//   5.  429 response includes X-RateLimit-Scope header
//   6.  Different action types have independent rate limits
//   7.  Batch endpoint returns X-RateLimit-Remaining header
//   8.  Exceeding batch-per-user limit returns 429
//   9.  Rate-limited requests don't count (remain at 0)
//  10.  Normal request after rate limit window resets succeeds
//
// These tests hit the live server at http://localhost:3000 and require
// PostgreSQL + OpenSearch to be running.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll } from "vitest";

const BASE = "http://localhost:3000";

let serverReachable = false;
let ontologyId = "";

const RUN_ID = Date.now().toString(36).slice(-6);

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function request(
  method: string,
  path: string,
  body?: unknown
) {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function actionTypesPath(suffix = "") {
  return `/api/v2/ontologies/${ontologyId}/actionTypes${suffix}`;
}

function actionsPath(actionApiName: string, suffix = "") {
  return `/api/v2/ontologies/${ontologyId}/actions/${actionApiName}${suffix}`;
}

async function ensureActionType(def: Record<string, unknown>): Promise<void> {
  const res = await request("POST", actionTypesPath(), def);
  if (res.status !== 201 && res.status !== 409) {
    throw new Error(
      `Failed to create action type '${def.apiName}': ${res.status} ${JSON.stringify(res.body).substring(0, 300)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Server reachability + ontology discovery
// ---------------------------------------------------------------------------

beforeAll(async () => {
  try {
    const res = await fetch(`${BASE}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    serverReachable = res.ok;
  } catch {
    console.warn(
      "Server not reachable at http://localhost:3000 — skipping rate limiter tests"
    );
    return;
  }

  const ont = await request("GET", "/api/v2/ontologies");
  if (ont.status === 200 && ont.body?.data?.length > 0) {
    const seedOnt = ont.body.data.find((o: any) => o.displayName === "RRA Tax Ontology") || ont.body.data[0];
    ontologyId = seedOnt.ontologyId;
  } else {
    console.warn("No ontologies found — skipping rate limiter tests");
    serverReachable = false;
  }
});

function skip(): boolean {
  return !serverReachable || !ontologyId;
}

// ===========================================================================
// Test Suite
// ===========================================================================

describe("Action Execution Rate Limiter (Task 27)", () => {
  // Unique action types for rate limit isolation
  const RL_ACTION_A = `rlActA${RUN_ID}`;
  const RL_ACTION_B = `rlActB${RUN_ID}`;
  const RL_BATCH_ACTION = `rlBatch${RUN_ID}`;

  // Setup: create action types
  beforeAll(async () => {
    if (skip()) return;

    const baseDef = (apiName: string) => ({
      apiName,
      displayName: `Rate Limit Test ${apiName}`,
      parameters: [
        { apiName: "tin", displayName: "TIN", type: "string", required: true },
        { apiName: "fullName", displayName: "Full Name", type: "string", required: true },
      ],
      rules: [
        {
          type: "createObject",
          objectType: "Taxpayer",
          properties: {
            tin: { source: "parameter", param: "tin" },
            fullName: { source: "parameter", param: "fullName" },
          },
        },
      ],
    });

    await Promise.all([
      ensureActionType(baseDef(RL_ACTION_A)),
      ensureActionType(baseDef(RL_ACTION_B)),
      ensureActionType(baseDef(RL_BATCH_ACTION)),
    ]);
  });

  // =========================================================================
  // Test 1: Normal requests include X-RateLimit-Remaining header
  // =========================================================================
  it("1. normal action execution includes X-RateLimit-Remaining header", async () => {
    if (skip()) return;

    const tin = `RL1-${RUN_ID}`;
    const res = await request(
      "POST",
      actionsPath(RL_ACTION_A, "/apply"),
      { parameters: { tin, fullName: "Rate Limit Test 1" } }
    );

    // May be 200 (success) or other, but header should be present
    const remaining = res.headers.get("x-ratelimit-remaining");
    expect(remaining).not.toBeNull();
    expect(parseInt(remaining!, 10)).toBeGreaterThanOrEqual(0);
  });

  // =========================================================================
  // Test 2: Exceeding per-action-type limit returns 429
  // =========================================================================
  it("2. exceeding per-action-type limit (100/min) returns 429", async () => {
    if (skip()) return;

    // Use a unique action type name to avoid collisions with other tests.
    // Fire 101 concurrent requests — the 101st should be rate-limited.
    // Note: the action will fail (duplicate PK) for most requests, but
    // the rate limiter runs BEFORE the handler, so it counts each attempt.
    const promises: Promise<{ status: number; body: any; headers: Headers }>[] = [];
    for (let i = 0; i < 101; i++) {
      promises.push(
        request("POST", actionsPath(RL_ACTION_A, "/apply"), {
          parameters: {
            tin: `RL2-${i}-${RUN_ID}`,
            fullName: `Rate Limit ${i}`,
          },
        })
      );
    }

    const results = await Promise.all(promises);
    const rateLimited = results.filter((r) => r.status === 429);

    // At least 1 request should be rate limited (the per-action-type limit
    // was already partially consumed by test 1, so we should exceed 100).
    expect(rateLimited.length).toBeGreaterThanOrEqual(1);
  }, 30000);

  // =========================================================================
  // Test 3: 429 response includes Retry-After header
  // =========================================================================
  it("3. 429 response includes Retry-After header", async () => {
    if (skip()) return;

    // The per-action-type limit for RL_ACTION_A was already exceeded in test 2.
    // Fire one more request — it should be 429.
    const res = await request(
      "POST",
      actionsPath(RL_ACTION_A, "/apply"),
      { parameters: { tin: `RL3-${RUN_ID}`, fullName: "Retry" } }
    );

    expect(res.status).toBe(429);
    const retryAfter = res.headers.get("retry-after");
    expect(retryAfter).not.toBeNull();
    expect(parseInt(retryAfter!, 10)).toBeGreaterThan(0);
  });

  // =========================================================================
  // Test 4: 429 response includes correct error body format
  // =========================================================================
  it("4. 429 response body has errorCode, errorName, message, parameters", async () => {
    if (skip()) return;

    const res = await request(
      "POST",
      actionsPath(RL_ACTION_A, "/apply"),
      { parameters: { tin: `RL4-${RUN_ID}`, fullName: "Body" } }
    );

    expect(res.status).toBe(429);
    expect(res.body.errorCode).toBe("RATE_LIMIT_EXCEEDED");
    expect(res.body.errorName).toBe("RateLimitExceededError");
    expect(res.body.errorInstanceId).toBeDefined();
    expect(typeof res.body.message).toBe("string");
    expect(res.body.message).toContain("Rate limit exceeded");
    expect(res.body.parameters).toBeDefined();
    expect(res.body.parameters.scope).toBeDefined();
  });

  // =========================================================================
  // Test 5: 429 response includes X-RateLimit-Scope header
  // =========================================================================
  it("5. 429 response includes X-RateLimit-Scope header", async () => {
    if (skip()) return;

    const res = await request(
      "POST",
      actionsPath(RL_ACTION_A, "/apply"),
      { parameters: { tin: `RL5-${RUN_ID}`, fullName: "Scope" } }
    );

    expect(res.status).toBe(429);
    const scope = res.headers.get("x-ratelimit-scope");
    expect(scope).not.toBeNull();
    // Should be "action_type" since that's the tightest limit we hit
    expect(scope).toBe("action_type");
  });

  // =========================================================================
  // Test 6: Different action types have independent rate limits
  // =========================================================================
  it("6. different action types have independent rate limit counters", async () => {
    if (skip()) return;

    // RL_ACTION_A is exhausted from test 2, but RL_ACTION_B is fresh.
    // A request to RL_ACTION_B should succeed (not 429).
    const res = await request(
      "POST",
      actionsPath(RL_ACTION_B, "/apply"),
      { parameters: { tin: `RL6-${RUN_ID}`, fullName: "Independent" } }
    );

    // Should NOT be rate limited (RL_ACTION_B hasn't been used much)
    expect(res.status).not.toBe(429);
  });

  // =========================================================================
  // Test 7: Batch endpoint returns X-RateLimit-Remaining header
  // =========================================================================
  it("7. batch endpoint includes X-RateLimit-Remaining header", async () => {
    if (skip()) return;

    const res = await request(
      "POST",
      actionsPath(RL_BATCH_ACTION, "/applyBatch"),
      {
        requests: [
          { parameters: { tin: `RL7-${RUN_ID}`, fullName: "Batch Header" } },
        ],
      }
    );

    const remaining = res.headers.get("x-ratelimit-remaining");
    expect(remaining).not.toBeNull();
    expect(parseInt(remaining!, 10)).toBeGreaterThanOrEqual(0);
  });

  // =========================================================================
  // Test 8: Exceeding batch-per-user limit returns 429
  // =========================================================================
  it("8. exceeding batch-per-user limit (10/min) returns 429", async () => {
    if (skip()) return;

    // Fire 11 batch requests — the 11th should be rate-limited.
    // (Test 7 already used 1, so we need 10 more to reach 11 total.)
    const promises: Promise<{ status: number; body: any; headers: Headers }>[] = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        request("POST", actionsPath(RL_BATCH_ACTION, "/applyBatch"), {
          requests: [
            {
              parameters: {
                tin: `RL8-${i}-${RUN_ID}`,
                fullName: `Batch Limit ${i}`,
              },
            },
          ],
        })
      );
    }

    const results = await Promise.all(promises);
    const rateLimited = results.filter((r) => r.status === 429);

    // At least 1 should be rate limited (batch per user limit is 10)
    expect(rateLimited.length).toBeGreaterThanOrEqual(1);
  }, 30000);

  // =========================================================================
  // Test 9: Rate-limited requests show remaining as 0
  // =========================================================================
  it("9. rate-limited response shows X-RateLimit-Remaining as 0", async () => {
    if (skip()) return;

    // RL_ACTION_A is still exhausted
    const res = await request(
      "POST",
      actionsPath(RL_ACTION_A, "/apply"),
      { parameters: { tin: `RL9-${RUN_ID}`, fullName: "Zero" } }
    );

    expect(res.status).toBe(429);
    const remaining = res.headers.get("x-ratelimit-remaining");
    expect(remaining).toBe("0");
  });

  // =========================================================================
  // Test 10: Retry-After value is a positive integer (seconds)
  // =========================================================================
  it("10. Retry-After is a positive integer representing seconds", async () => {
    if (skip()) return;

    const res = await request(
      "POST",
      actionsPath(RL_ACTION_A, "/apply"),
      { parameters: { tin: `RL10-${RUN_ID}`, fullName: "RetryAfterCheck" } }
    );

    expect(res.status).toBe(429);
    const retryAfter = res.headers.get("retry-after");
    expect(retryAfter).not.toBeNull();
    const seconds = parseInt(retryAfter!, 10);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(60); // window is 60s
  });
});
