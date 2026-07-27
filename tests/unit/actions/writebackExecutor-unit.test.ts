// ---------------------------------------------------------------------------
// Writeback Executor — Phase 4 unit tests
//
// Mocks the httpRequest injection + the webhookDefinition model. Exercises
// every branch:
//   * happy path: 2xx → outputs extracted per JSONPointer from outputBindings
//   * WEBHOOK_NOT_FOUND (no row in the registry)
//   * WEBHOOK_VERSION_DISABLED (status='disabled')
//   * WRITEBACK_CONFIG_INVALID (no endpoint URL)
//   * WRITEBACK_REJECTED (egress check fails; method check fails; non-2xx;
//     unsupported content-type; body over max_response_bytes)
//   * WRITEBACK_TIMEOUT (httpRequest throws)
//   * WRITEBACK_OUTPUT_SCHEMA_MISMATCH (JSON parse fail; binding path fail)
//   * Idempotency-key derivation stable
//   * `client-supplied` headers stripped at the egress stage + redacted for
//     diagnostic logs (not exposed in `userMessage`).
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";

const { getWebhookByNameVersionMock } = vi.hoisted(() => ({ getWebhookByNameVersionMock: vi.fn() }));

vi.mock("../../../src/models/webhookDefinition", () => ({
  getWebhookByNameVersion: getWebhookByNameVersionMock,
}));

// Connectivity path mocks — the REAL data-connection webhook engine.
const {
  getConnectivityWebhookByRidMock,
  findConnectionByRidMock,
  executeConnectivityWebhookMock,
} = vi.hoisted(() => ({
  getConnectivityWebhookByRidMock: vi.fn(),
  findConnectionByRidMock: vi.fn(),
  executeConnectivityWebhookMock: vi.fn(),
}));

vi.mock("../../../src/services/connectivity/webhooks/repository", () => ({
  getByRid: getConnectivityWebhookByRidMock,
}));
vi.mock("../../../src/services/connectivity/store/connections.repo", () => ({
  findByRid: findConnectionByRidMock,
}));
vi.mock("../../../src/services/connectivity/webhooks/executor", () => ({
  executeWebhook: executeConnectivityWebhookMock,
}));

import { executeWriteback, type HttpRequestFn, type WritebackConfig, type WritebackExecutionContext, type HttpResponseSimulated } from "../../../src/actions/writebackExecutor";
import { DEFAULT_EGRESS_POLICY, type EgressPolicy } from "../../../src/services/webhookSafeTransport";

const POLICY: EgressPolicy = {
  ...DEFAULT_EGRESS_POLICY,
  httpsRequired: true,
  maxResponseBytes: 1024 * 10,
};

function webhookRow(opts: Partial<{ status: string; method: string; endpointUrl: string; outputSchema: Record<string, unknown> | null }> = {}) {
  return {
    webhook_id: "wh-1",
    ontology_id: "ont-1",
    name: "NotifySlack",
    version: 1,
    description: null,
    status: opts.status ?? "active",
    method: opts.method ?? "POST",
    endpoint_config: opts.endpointUrl !== undefined ? { url: opts.endpointUrl } : { url: "https://api.example.invalid/notify" },
    input_schema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    output_schema: opts.outputSchema ?? null,
    authentication_config: { kind: "tellus_secret", ref: "slack-token", key: "apiToken" },
    timeout_ms: 5000,
    max_response_bytes: 1024 * 10,
    retry_policy: null,
    created_by: "system",
    created_at: "now",
    updated_at: "now",
  };
}

const CTX: WritebackExecutionContext = {
  actor: "test-actor",
  executionId: "exec-1",
  ontologyId: "ont-1",
};

const CONFIG: WritebackConfig = {
  webhookId: "NotifySlack",
  webhookVersion: 1,
  inputs: { message: "hello" },
  failurePolicy: "abort",
};

describe("executeWriteback — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getWebhookByNameVersionMock.mockResolvedValue(webhookRow());
  });

  it("returns ok with outputs extracted via JSONPointer when status is 2xx", async () => {
    const cfg: WritebackConfig = {
      ...CONFIG,
      outputBindings: {
        status: { outputId: "status", path: "/status", schema: {}, valueType: "string" },
        receipt: { outputId: "receipt", path: "/data/receipt", schema: {}, valueType: "string" },
      },
    };
    const http: HttpRequestFn = async () => ({
      status: 200,
      body: JSON.stringify({ status: "ok", data: { receipt: "rcpt-xyz" } }),
      contentType: "application/json",
      headers: {},
    });
    const r = await executeWriteback(cfg, CTX, POLICY, http);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.httpStatus).toBe(200);
    expect(r.outputs).toEqual({ status: "ok", receipt: "rcpt-xyz" });
    expect(r.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns ok without outputs when outputBindings are omitted", async () => {
    const http: HttpRequestFn = async () => ({
      status: 204,
      body: "{}",
      contentType: "application/json",
      headers: {},
    });
    const r = await executeWriteback(CONFIG, CTX, POLICY, http);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.outputs).toEqual({});
  });

  it("returns ok with content-type 'application/json; charset=utf-8'", async () => {
    const http: HttpRequestFn = async () => ({
      status: 200,
      body: "{}",
      contentType: "application/json; charset=utf-8",
      headers: {},
    });
    const r = await executeWriteback(CONFIG, CTX, POLICY, http);
    expect(r.kind).toBe("ok");
  });
});

describe("executeWriteback — webhook lifecycle errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns WEBHOOK_NOT_FOUND when the webhook row is null", async () => {
    getWebhookByNameVersionMock.mockResolvedValue(null);
    const http: HttpRequestFn = vi.fn();
    const r = await executeWriteback(CONFIG, CTX, POLICY, http as any);
    expect(r.kind).toBe("rejected");
    if (r.kind !== "rejected") return;
    expect(r.code).toBe("WEBHOOK_NOT_FOUND");
    expect(http).not.toHaveBeenCalled();
  });

  it("returns WEBHOOK_VERSION_DISABLED when status='disabled'", async () => {
    getWebhookByNameVersionMock.mockResolvedValue(webhookRow({ status: "disabled" }));
    const http: HttpRequestFn = vi.fn();
    const r = await executeWriteback(CONFIG, CTX, POLICY, http as any);
    expect(r.kind).toBe("rejected");
    if (r.kind !== "rejected") return;
    expect(r.code).toBe("WEBHOOK_VERSION_DISABLED");
    expect(http).not.toHaveBeenCalled();
  });
});

describe("executeWriteback — egress / method / config validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getWebhookByNameVersionMock.mockResolvedValue(webhookRow());
  });

  it("rejects when endpoint URL has no protocol/host (writeback_config_invalid:", async () => {
    getWebhookByNameVersionMock.mockResolvedValue(webhookRow({ endpointUrl: "" }));
    const http: HttpRequestFn = vi.fn();
    const r = await executeWriteback(CONFIG, CTX, POLICY, http as any);
    if (r.kind !== "rejected") throw new Error();
    expect(r.code).toBe("WRITEBACK_CONFIG_INVALID");
    expect(http).not.toHaveBeenCalled();
  });

  it("rejects when endpoint URL is HTTP in production (httpsRequired:", async () => {
    getWebhookByNameVersionMock.mockResolvedValue(webhookRow({ endpointUrl: "http://insecure.example.invalid/" }));
    const http: HttpRequestFn = vi.fn();
    const r = await executeWriteback(CONFIG, CTX, POLICY, http as any);
    if (r.kind !== "rejected") throw new Error();
    expect(r.code).toBe("WRITEBACK_REJECTED");
    expect(http).not.toHaveBeenCalled();
  });

  it("rejects with FORBIDDEN_IP when the URL points at loopback", async () => {
    getWebhookByNameVersionMock.mockResolvedValue(webhookRow({ endpointUrl: "https://127.0.0.1/" }));
    const r = await executeWriteback(CONFIG, CTX, POLICY, vi.fn() as any);
    if (r.kind !== "rejected") throw new Error();
    expect(r.code).toBe("WRITEBACK_REJECTED");
    expect(r.message.toLowerCase()).toContain("egress check failed");
  });

  it("rejects with metadata-IP message when URL points at cloud metadata", async () => {
    getWebhookByNameVersionMock.mockResolvedValue(webhookRow({ endpointUrl: "https://169.254.169.254/" }));
    const r = await executeWriteback(CONFIG, CTX, POLICY, vi.fn() as any);
    if (r.kind !== "rejected") throw new Error();
    expect(r.code).toBe("WRITEBACK_REJECTED");
    expect(r.message.toLowerCase()).toContain("egress check failed");
  });

  it("rejects when the method is forbidden (TRACE)", async () => {
    getWebhookByNameVersionMock.mockResolvedValue(webhookRow({ method: "TRACE" }));
    const r = await executeWriteback(CONFIG, CTX, POLICY, vi.fn() as any);
    if (r.kind !== "rejected") throw new Error();
    expect(r.code).toBe("WRITEBACK_REJECTED");
    expect(r.message).toContain("Method check failed");
  });
});

describe("executeWriteback — transport response errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getWebhookByNameVersionMock.mockResolvedValue(webhookRow());
  });

  it("returns WRITEBACK_TIMEOUT when httpRequest throws", async () => {
    const http: HttpRequestFn = async () => {
      throw new Error("connect ETIMEDOUT");
    };
    const r = await executeWriteback(CONFIG, CTX, POLICY, http);
    if (r.kind !== "rejected") throw new Error();
    expect(r.code).toBe("WRITEBACK_TIMEOUT");
    expect(r.userMessage).toContain("did not respond");
  });

  it("returns WRITEBACK_REJECTED on non-2xx status", async () => {
    const http: HttpRequestFn = async () => ({
      status: 500,
      body: "Internal Server Error",
      contentType: "text/plain",
      headers: {},
    });
    const r = await executeWriteback(CONFIG, CTX, POLICY, http);
    if (r.kind !== "rejected") throw new Error();
    expect(r.code).toBe("WRITEBACK_REJECTED");
    expect(r.diagnostic.httpStatus).toBe(500);
  });

  it("returns WRITEBACK_REJECTED when content-type is not allowed", async () => {
    const http: HttpRequestFn = async () => ({
      status: 200,
      body: "<html/>",
      contentType: "text/html",
      headers: {},
    });
    const r = await executeWriteback(CONFIG, CTX, POLICY, http);
    if (r.kind !== "rejected") throw new Error();
    expect(r.code).toBe("WRITEBACK_REJECTED");
    expect(r.message).toContain("Content-Type");
  });

  it("returns WRITEBACK_REJECTED when body exceeds maxResponseBytes", async () => {
    const big = "x".repeat(POLICY.maxResponseBytes + 100);
    const http: HttpRequestFn = async () => ({
      status: 200,
      body: big,
      contentType: "application/json",
      headers: {},
    });
    const r = await executeWriteback(CONFIG, CTX, POLICY, http);
    if (r.kind !== "rejected") throw new Error();
    expect(r.code).toBe("WRITEBACK_REJECTED");
    expect(r.message).toContain("exceeds maxResponseBytes");
  });
});

describe("executeWriteback — output binding extraction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getWebhookByNameVersionMock.mockResolvedValue(webhookRow());
  });

  it("returns WRITEBACK_OUTPUT_SCHEMA_MISMATCH when response body is not JSON", async () => {
    const http: HttpRequestFn = async () => ({
      status: 200,
      body: "not json",
      contentType: "application/json",
      headers: {},
    });
    const r = await executeWriteback(CONFIG, CTX, POLICY, http);
    if (r.kind !== "rejected") throw new Error();
    expect(r.code).toBe("WRITEBACK_OUTPUT_SCHEMA_MISMATCH");
    expect(r.message).toContain("not be parsed as JSON");
  });

  it("returns WRITEBACK_OUTPUT_SCHEMA_MISMATCH when a binding's JSONPointer misses a key", async () => {
    const cfg: WritebackConfig = {
      ...CONFIG,
      outputBindings: {
        status: { outputId: "status", path: "/status", schema: {}, valueType: "string" },
        missing: { outputId: "missing", path: "/does/not/exist", schema: {}, valueType: "string" },
      },
    };
    const http: HttpRequestFn = async () => ({
      status: 200,
      body: JSON.stringify({ status: "ok" }),
      contentType: "application/json",
      headers: {},
    });
    const r = await executeWriteback(cfg, CTX, POLICY, http);
    if (r.kind !== "rejected") throw new Error();
    expect(r.code).toBe("WRITEBACK_OUTPUT_SCHEMA_MISMATCH");
    expect(r.message).toContain("missing");
  });

  it("returns ok with array index extraction (JSONPointer /0 on array", async () => {
    const cfg: WritebackConfig = {
      ...CONFIG,
      outputBindings: {
        first: { outputId: "first", path: "/items/0/id", schema: {}, valueType: "string" },
      },
    };
    const http: HttpRequestFn = async () => ({
      status: 200,
      body: JSON.stringify({ items: [{ id: "first-id" }, { id: "second-id" }] }),
      contentType: "application/json",
      headers: {},
    });
    const r = await executeWriteback(cfg, CTX, POLICY, http);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.outputs.first).toBe("first-id");
  });

  it("honors ~1 / ~0 escapes in JSONPointer", async () => {
    const cfg: WritebackConfig = {
      ...CONFIG,
      outputBindings: {
        escaped: { outputId: "escaped", path: "/a~1b/c~0d", schema: {}, valueType: "string" },
      },
    };
    const http: HttpRequestFn = async () => ({
      status: 200,
      body: JSON.stringify({ "a/b": { "c~d": "value" } }),
      contentType: "application/json",
      headers: {},
    });
    const r = await executeWriteback(cfg, CTX, POLICY, http);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.outputs.escaped).toBe("value");
  });
});

describe("executeWriteback — diagnostic surface never leaks credentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getWebhookByNameVersionMock.mockResolvedValue(webhookRow());
  });

  it("redacts outbound auth/header secrets from the diagnostic structuà re on error", async () => {
    const http: HttpRequestFn = async () => ({
      status: 500,
      body: "err",
      contentType: "text/plain",
      headers: {},
    });
    const r = await executeWriteback(CONFIG, CTX, POLICY, http);
    if (r.kind !== "rejected") throw new Error();
    // The redacted diagnostic surface should NOT contain the raw auth
    // header literal; the redactHeadersForLog helper replaces
    // `Authorization` with `[REDACTED]`.
    expect(JSON.stringify(r.diagnostic.redactedHeaders ?? {})).toContain("[REDACTED]");
    expect(JSON.stringify(r.diagnostic.redactedHeaders ?? {})).not.toContain("Bearer <secret:");
  });

  it("userMessage never contains the full authorization head er", async () => {
    const http: HttpRequestFn = async () => {
      throw new Error("boom");
    };
    const r = await executeWriteback(CONFIG, CTX, POLICY, http);
    if (r.kind !== "rejected") throw new Error();
    expect(r.userMessage).not.toContain("Authorization");
    expect(r.userMessage).not.toContain("Bearer");
  });
});

// ---------------------------------------------------------------------------
// Connectivity path — `webhookId` is a data-connection webhook RID. The
// writeback delegates to the REAL connectivity engine; these tests pin
// the boundary contract (resolution, lifecycle gate, tenant threading,
// result mapping). The legacy registry path must NOT be consulted.
// ---------------------------------------------------------------------------

const CONNECTIVITY_RID =
  "ri.magritte.main.webhook.11111111-2222-4333-8444-555555555555";

const CONNECTIVITY_CONFIG: WritebackConfig = {
  webhookId: CONNECTIVITY_RID,
  webhookVersion: 3,
  inputs: { message: "hello" },
  failurePolicy: "abort",
};

function connectivityWebhook(opts: { status?: string } = {}) {
  return {
    rid: CONNECTIVITY_RID,
    tenant: "default",
    connectionRid: "ri.magritte.main.connection.abc",
    apiName: "notifySlack",
    displayName: "Notify Slack",
    description: "",
    status: opts.status ?? "active",
    currentVersion: 3,
    configuration: { inputs: [], outputs: [] },
    createdAt: "now",
    createdBy: "system",
    updatedAt: "now",
    updatedBy: "system",
  };
}

function restConnection() {
  return {
    rid: "ri.magritte.main.connection.abc",
    connectorType: "rest-api",
    egressPolicy: { allowlist: [] },
  };
}

const noopHttp: HttpRequestFn = async () => {
  throw new Error("connectivity path must never use the legacy httpRequest injection");
};

describe("executeWriteback — connectivity webhook path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConnectivityWebhookByRidMock.mockResolvedValue(connectivityWebhook());
    findConnectionByRidMock.mockResolvedValue(restConnection());
    executeConnectivityWebhookMock.mockResolvedValue({
      execution: {
        rid: "ri.magritte.main.webhook-execution.xyz",
        status: "succeeded",
        httpStatus: 200,
        outputSummary: { receipt: "rcpt-1" },
        errorCode: null,
        errorMessage: null,
      },
      replayed: false,
    });
  });

  it("executes through the connectivity engine and maps declared outputs", async () => {
    const r = await executeWriteback(CONNECTIVITY_CONFIG, CTX, POLICY, noopHttp);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.httpStatus).toBe(200);
    expect(r.outputs).toEqual({ receipt: "rcpt-1" });
    expect(r.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);

    // Pinned immutable version + production execution with resolved inputs.
    expect(getConnectivityWebhookByRidMock).toHaveBeenCalledWith(
      CONNECTIVITY_RID,
      "default",
      3,
    );
    expect(findConnectionByRidMock).toHaveBeenCalledWith(
      "ri.magritte.main.connection.abc",
      "default",
    );
    expect(executeConnectivityWebhookMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "production",
        actor: "test-actor",
        tenant: "default",
        inputs: { message: "hello" },
        idempotencyKey: r.idempotencyKey,
      }),
    );
    // The legacy registry path is never consulted.
    expect(getWebhookByNameVersionMock).not.toHaveBeenCalled();
  });

  it("threads ctx.tenant through to the connectivity store", async () => {
    const r = await executeWriteback(
      CONNECTIVITY_CONFIG,
      { ...CTX, tenant: "acme" },
      POLICY,
      noopHttp,
    );
    expect(r.kind).toBe("ok");
    expect(getConnectivityWebhookByRidMock).toHaveBeenCalledWith(
      CONNECTIVITY_RID,
      "acme",
      3,
    );
    expect(executeConnectivityWebhookMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenant: "acme" }),
    );
  });

  it("returns WEBHOOK_NOT_FOUND when the pinned version does not resolve", async () => {
    getConnectivityWebhookByRidMock.mockRejectedValue(new Error("WEBHOOK_NOT_FOUND"));
    const r = await executeWriteback(CONNECTIVITY_CONFIG, CTX, POLICY, noopHttp);
    expect(r.kind).toBe("rejected");
    if (r.kind !== "rejected") return;
    expect(r.code).toBe("WEBHOOK_NOT_FOUND");
    expect(executeConnectivityWebhookMock).not.toHaveBeenCalled();
  });

  it("returns WEBHOOK_VERSION_DISABLED when the webhook is not active", async () => {
    getConnectivityWebhookByRidMock.mockResolvedValue(connectivityWebhook({ status: "disabled" }));
    const r = await executeWriteback(CONNECTIVITY_CONFIG, CTX, POLICY, noopHttp);
    expect(r.kind).toBe("rejected");
    if (r.kind !== "rejected") return;
    expect(r.code).toBe("WEBHOOK_VERSION_DISABLED");
    expect(executeConnectivityWebhookMock).not.toHaveBeenCalled();
  });

  it("returns WRITEBACK_REJECTED when the execution dead-letters", async () => {
    executeConnectivityWebhookMock.mockResolvedValue({
      execution: {
        rid: "ri.magritte.main.webhook-execution.xyz",
        status: "dead_lettered",
        httpStatus: 500,
        outputSummary: null,
        errorCode: "HTTP_2XX_REQUIRED",
        errorMessage: "External system returned 500.",
      },
      replayed: false,
    });
    const r = await executeWriteback(CONNECTIVITY_CONFIG, CTX, POLICY, noopHttp);
    expect(r.kind).toBe("rejected");
    if (r.kind !== "rejected") return;
    expect(r.code).toBe("WRITEBACK_REJECTED");
    expect(r.diagnostic.httpStatus).toBe(500);
    expect(r.userMessage).not.toContain("500");
  });

  it("maps REQUEST_TIMEOUT to WRITEBACK_TIMEOUT", async () => {
    executeConnectivityWebhookMock.mockResolvedValue({
      execution: {
        rid: "ri.magritte.main.webhook-execution.xyz",
        status: "dead_lettered",
        httpStatus: null,
        outputSummary: null,
        errorCode: "REQUEST_TIMEOUT",
        errorMessage: "Timed out.",
      },
      replayed: false,
    });
    const r = await executeWriteback(CONNECTIVITY_CONFIG, CTX, POLICY, noopHttp);
    expect(r.kind).toBe("rejected");
    if (r.kind !== "rejected") return;
    expect(r.code).toBe("WRITEBACK_TIMEOUT");
  });

  it("returns WRITEBACK_REJECTED when the engine throws (input validation etc.)", async () => {
    executeConnectivityWebhookMock.mockRejectedValue(new Error("INPUT_REQUIRED: Required input 'message' is missing."));
    const r = await executeWriteback(CONNECTIVITY_CONFIG, CTX, POLICY, noopHttp);
    expect(r.kind).toBe("rejected");
    if (r.kind !== "rejected") return;
    expect(r.code).toBe("WRITEBACK_REJECTED");
  });
});
