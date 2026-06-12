// ---------------------------------------------------------------------------
// FOUNDRY-GAPS §5 — action side-effect webhooks (Stage 5/7) tests.
//
// parseWebhookSpecs is pure. fireActionWebhooks is exercised against a REAL
// loopback HTTP server (no mocks) to prove the post-commit delivery + the SSRF
// egress guard (loopback is blocked by default; opted in via the connectivity
// allowlist env for this test).
// ---------------------------------------------------------------------------
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { parseWebhookSpecs, fireActionWebhooks } from "../../../src/actions/actionWebhooks";

const PAYLOAD = {
  executionId: "exec-1",
  actionTypeApiName: "approveOrder",
  ontologyId: "00000000-0000-0000-0000-000000000001",
  branchId: null,
  result: "success",
  executedBy: "tester",
  affectedObjects: [{ objectType: "Order", primaryKey: "o-1", operation: "update" }],
  firedAt: new Date(0).toISOString(),
};

describe("parseWebhookSpecs", () => {
  it("returns [] for null/empty and tolerates shapes", () => {
    expect(parseWebhookSpecs(null)).toEqual([]);
    expect(parseWebhookSpecs({})).toEqual([]);
    expect(parseWebhookSpecs({ webhooks: [{ url: "https://x.test/h" }] })).toHaveLength(1);
    expect(parseWebhookSpecs([{ url: "https://y.test/h", method: "post" }])[0].method).toBe("POST");
    // entries without a url string are dropped
    expect(parseWebhookSpecs([{ nope: 1 }, "string", { url: 5 }])).toEqual([]);
  });

  it("clamps timeout into [250, 30000]", () => {
    expect(parseWebhookSpecs([{ url: "https://x.test", timeoutMs: 10 }])[0].timeoutMs).toBe(250);
    expect(parseWebhookSpecs([{ url: "https://x.test", timeoutMs: 99999 }])[0].timeoutMs).toBe(30000);
  });
});

describe("fireActionWebhooks (live loopback server)", () => {
  let server: http.Server;
  let received: Array<{ headers: http.IncomingHttpHeaders; body: unknown }> = [];
  let url = "";
  const prevAllow = process.env.CONNECTIVITY_EGRESS_ALLOW_RESERVED;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body: raw ? JSON.parse(raw) : null });
        res.writeHead(req.url === "/fail" ? 500 : 200).end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    url = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    process.env.CONNECTIVITY_EGRESS_ALLOW_RESERVED = prevAllow;
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("blocks loopback by default (SSRF guard) — no delivery", async () => {
    process.env.CONNECTIVITY_EGRESS_ALLOW_RESERVED = "";
    received = [];
    const out = await fireActionWebhooks({ webhooks: [{ url: `${url}/h` }] }, PAYLOAD);
    expect(out[0].ok).toBe(false);
    expect(out[0].error).toMatch(/egress blocked/i);
    expect(received).toHaveLength(0);
  });

  it("delivers the action payload when the target is allowed", async () => {
    process.env.CONNECTIVITY_EGRESS_ALLOW_RESERVED = "127.0.0.1/8";
    received = [];
    const out = await fireActionWebhooks({ webhooks: [{ url: `${url}/h` }] }, PAYLOAD);
    expect(out[0].ok).toBe(true);
    expect(out[0].status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].headers["x-tellus-action"]).toBe("approveOrder");
    expect((received[0].body as { executionId: string }).executionId).toBe("exec-1");
  });

  it("reports a non-2xx as failed but never throws", async () => {
    process.env.CONNECTIVITY_EGRESS_ALLOW_RESERVED = "127.0.0.1/8";
    received = [];
    const out = await fireActionWebhooks({ webhooks: [{ url: `${url}/fail` }] }, PAYLOAD);
    expect(out[0].ok).toBe(false);
    expect(out[0].status).toBe(500);
  });
});
