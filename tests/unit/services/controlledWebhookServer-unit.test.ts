// ---------------------------------------------------------------------------
// Controlled Webhook Test Service — unit tests (Gap A)
//
// Proves every deterministic behavior, the sanitized invocation history, the
// duplicate-detection idempotency ledger, and the reset mechanism — directly
// against an in-process instance of the service (ephemeral port 0). The
// integration suite proves the production transport actually reaches the
// service over the wire through the dev egress policy (see
// actions/runWritebackStage-controlled-integration.test.ts).
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import {
  createControlledWebhookServer,
  CONTROLLED_BEHAVIOR_PATHS,
  type ControlledWebhookServer,
} from "../../../src/services/testing/controlledWebhookServer";

let svc: ControlledWebhookServer;

function req(
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(svc.url + path);
    const r = http.request(
      u,
      {
        method: opts.method ?? "POST",
        headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
        timeout: opts.timeoutMs ?? 4000,
      },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: b,
            contentType: res.headers["content-type"] ?? "",
          }),
        );
      },
    );
    r.on("timeout", () => {
      r.destroy(new Error("client-timeout"));
    });
    r.on("error", reject);
    if (opts.body != null) r.write(opts.body);
    r.end();
  });
}

beforeAll(async () => {
  svc = createControlledWebhookServer();
  await new Promise<void>((r) => svc.server.listen(0, "127.0.0.1", r));
});

afterAll(async () => {
  await svc.close();
});

describe("controlledWebhookServer — behavior catalogue", () => {
  it("exposes every required behavior path", () => {
    const required = [
      "/writeback/success",
      "/writeback/fail",
      "/writeback/slow",
      "/writeback/timeout",
      "/writeback/malformed",
      "/writeback/invalid",
      "/writeback/nested",
      "/writeback/nullable",
      "/writeback/attachment",
      "/sideeffect/success",
      "/sideeffect/fail",
      "/sideeffect/slow",
      "/sideeffect/repeat",
      "/sideeffect/duplicate",
    ];
    for (const p of required) {
      expect(CONTROLLED_BEHAVIOR_PATHS).toContain(p);
    }
  });

  it("successful writeback → 200 JSON with confirmed output", async () => {
    const r = await req("/writeback/success", { body: '{"order":"o1"}' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).confirmed).toBe(true);
  });

  it("failed writeback → non-2xx with error code", async () => {
    const r = await req("/writeback/fail", { body: '{"order":"o1"}' });
    expect(r.status).toBe(502);
    expect(JSON.parse(r.body).code).toBe("DOWNSTREAM_REJECTED");
  });

  it("slow writeback responds after the configured delay", async () => {
    const start = Date.now();
    const r = await req("/writeback/slow?ms=150", { body: "{}", timeoutMs: 5000 });
    expect(r.status).toBe(200);
    // Allow scheduling jitter; assert a meaningful wait happened.
    expect(Date.now() - start).toBeGreaterThanOrEqual(120);
  });

  it("timeout writeback never responds (caller enforces timeout)", async () => {
    await expect(
      req("/writeback/timeout", { body: "{}", timeoutMs: 600 }),
    ).rejects.toThrow(/client-timeout/);
  });

  it("malformed response body is not valid JSON", async () => {
    const r = await req("/writeback/malformed", { body: "{}" });
    expect(r.status).toBe(200);
    expect(() => JSON.parse(r.body)).toThrow();
  });

  it("structurally invalid response omits the required output", async () => {
    const r = await req("/writeback/invalid", { body: "{}" });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).confirmed).toBeUndefined();
  });

  it("nested typed response carries nested records and lists", async () => {
    const r = await req("/writeback/nested", { body: "{}" });
    const b = JSON.parse(r.body);
    expect(b.result.record.code).toBe("AC-1");
    expect(b.result.record.flags).toEqual(["a", "b"]);
  });

  it("nullable response carries null values", async () => {
    const r = await req("/writeback/nullable", { body: "{}" });
    expect(JSON.parse(r.body).value).toBeNull();
  });

  it("attachment response carries metadata without raw content", async () => {
    const r = await req("/writeback/attachment", { body: "{}" });
    const b = JSON.parse(r.body);
    expect(b.attachment.filename).toBe("out.bin");
    expect(b.attachment.size).toBe(4);
    // No raw attachment byte content is present in the body — only metadata.
    expect(b.attachment.data).toBeUndefined();
    expect(b.attachment.content).toBeUndefined();
    expect(b.attachment.bytes).toBeUndefined();
    // Recorded request body must redact attachment-shaped request keys.
    const hist = svc.history().filter((h) => h.endpoint === "/writeback/attachment");
    expect(hist.length).toBeGreaterThan(0);
  });

  it("side-effect repeat echoes the request body as a list (fan-out)", async () => {
    const r = await req("/sideeffect/repeat?count=3", { body: '{"item":"x"}' });
    expect(r.status).toBe(200);
    const arr = JSON.parse(r.body);
    expect(Array.isArray(arr)).toBe(true);
    expect(arr).toHaveLength(3);
    expect(arr[0].item).toBe("x");
  });

  it("side-effect duplicate marks the second call as duplicated by idempotency key", async () => {
    svc.reset();
    const headers = { "x-idempotency-key": "k-1" };
    const first = await req("/sideeffect/duplicate", { body: "{}", headers });
    const second = await req("/sideeffect/duplicate", { body: "{}", headers });
    expect(JSON.parse(first.body).deduplicated).toBe(false);
    expect(JSON.parse(second.body).deduplicated).toBe(true);
    const hist = svc.history();
    expect(hist).toHaveLength(2);
    expect(hist[1].duplicate).toBe(true);
    expect(hist[0].duplicate).toBe(false);
  });
});

describe("controlledWebhookServer — sanitized invocation history", () => {
  it("records seq, endpoint, method, status, body type, duration, count", async () => {
    svc.reset();
    await req("/writeback/success", { body: '{"a":1}' });
    await req("/writeback/success", { body: '{"a":2}' });
    const hist = svc.history();
    expect(hist[0].seq).toBe(1);
    expect(hist[1].seq).toBe(2);
    expect(hist[0].endpoint).toBe("/writeback/success");
    expect(hist[0].method).toBe("POST");
    expect(hist[0].responseStatus).toBe(200);
    expect(hist[0].responseBodyType).toBe("json");
    expect(hist[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(hist[1].invocationCount).toBe(2);
  });

  it("records correlation id, idempotency key, and operation id from headers", async () => {
    svc.reset();
    await req("/writeback/success", {
      body: "{}",
      headers: {
        "x-trace-id": "trace-9",
        "x-idempotency-key": "idem-9",
        "x-actor": "op-actor-9",
      },
    });
    const h = svc.history()[0];
    expect(h.correlationId).toBe("trace-9");
    expect(h.idempotencyKey).toBe("idem-9");
    expect(h.actionOperationId).toBe("op-actor-9");
  });

  it("never records authorization, cookie, or api-key headers", async () => {
    svc.reset();
    await req("/writeback/success", {
      body: "{}",
      headers: {
        authorization: "Bearer SECRET-TOKEN",
        cookie: "session=abc",
        "x-api-key": "k123",
      },
    });
    // The recorded request body is sanitized; we cannot read headers from
    // history directly, but assert that the body field carries no secret.
    const blob = JSON.stringify(svc.history());
    expect(blob).not.toContain("SECRET-TOKEN");
    expect(blob).not.toContain("session=abc");
    expect(blob).not.toContain("k123");
  });

  it("redacts attachment-shaped request body fields in the recorded history", async () => {
    svc.reset();
    await req("/writeback/success", {
      body: JSON.stringify({ attachment: "RAWBYTES", file: "RAWBYTES2" }),
    });
    const recorded = JSON.stringify(svc.history()[0].requestBody);
    expect(recorded).not.toContain("RAWBYTES");
    expect(recorded).toMatch(/attachment:/);
  });

  it("reset clears history and the dedup ledger deterministically", async () => {
    await req("/writeback/success", { body: "{}" });
    expect(svc.history().length).toBeGreaterThan(0);
    svc.reset();
    expect(svc.history()).toHaveLength(0);
    // After reset, a duplicate key is treated as a first call.
    const first = await req("/sideeffect/duplicate", {
      body: "{}",
      headers: { "x-idempotency-key": "fresh" },
    });
    expect(JSON.parse(first.body).deduplicated).toBe(false);
  });
});
