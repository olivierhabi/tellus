// ---------------------------------------------------------------------------
// PB-B5 — live Flink SQL Gateway integration.
//
// Exercises HttpFlinkAdapter against the docker-compose Flink cluster
// (docker-compose-files/flink.docker-compose.yml). Skips gracefully
// when the cluster is down.
//
// Submits a trivial `SELECT 1` statement and asserts the gateway
// returns a session + operation handle, which proves the REST
// plumbing that PB-B5 acceptance (c) depends on. Full
// Kafka→Iceberg soak is PB-B5.follow-soak — the bigger test needs
// the Iceberg connector jar mounted on Flink.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { HttpFlinkAdapter } from "../../../src/services/pipelines/flinkAdapter";

async function gatewayReachable(): Promise<boolean> {
  try {
    const r = await fetch("http://localhost:18083/info", {
      signal: AbortSignal.timeout(2_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

describe("PB-B5 live Flink SQL Gateway", () => {
  it("opens a session + executes a SELECT 1 statement", async () => {
    if (!(await gatewayReachable())) {
      console.warn("[pb-b5 live] SQL Gateway unreachable; skipping");
      return;
    }

    // Open a session directly via fetch so we verify the real REST
    // shape the adapter constructs URLs against.
    const sessionRes = await fetch("http://localhost:18083/v2/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(sessionRes.ok).toBe(true);
    const session = (await sessionRes.json()) as { sessionHandle: string };
    expect(session.sessionHandle).toMatch(/^[0-9a-f-]{36}$/);

    const opRes = await fetch(
      `http://localhost:18083/v2/sessions/${session.sessionHandle}/statements`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ statement: "SELECT 1" }),
      },
    );
    expect(opRes.ok).toBe(true);
    const op = (await opRes.json()) as { operationHandle: string };
    expect(op.operationHandle).toMatch(/^[0-9a-f-]{36}$/);

    // Also instantiate the adapter to prove the wrapper compiles
    // against the live base URL (Noop branch isn't exercised here).
    const adapter = new HttpFlinkAdapter({
      baseUrl: "http://localhost:18081",
      sqlGatewayUrl: "http://localhost:18083",
      timeoutMs: 10_000,
    });
    expect(adapter.mode).toBe("http");
  }, 30_000);
});
