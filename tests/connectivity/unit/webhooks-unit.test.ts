import { afterEach, describe, expect, it } from "vitest";
import {
  WebhookCreateRequest,
  WebhookVersionConfiguration,
  type ConnectivityWebhook,
  type WebhookCall,
} from "../../../src/services/connectivity/webhooks/contracts";
import {
  assertDnsDestinationAllowed,
  calculateBackoffMs,
  classifyRetryable,
  redactExecutionInputs,
  renderJsonTemplate,
  renderTextTemplate,
  signPayload,
  validateExecutionInputs,
} from "../../../src/services/connectivity/webhooks/executor";
import {
  assertEgressUrl,
  redactHeadersForLog,
  sanitizeOutboundHeaders,
  type EgressPolicy,
} from "../../../src/services/webhookSafeTransport";

function call(
  method: WebhookCall["method"] = "POST",
  readApi = false,
): WebhookCall {
  return {
    id: crypto.randomUUID(),
    name: "Request",
    method,
    domainIndex: 0,
    relativePath: "/tickets/{{inputs.ticketId}}",
    queryParameters: [],
    headers: [],
    body: { kind: "rawJson", template: '{"id": {{inputs.ticketId}}}' },
    readApi,
    retryableStatusCodes: [408, 429, 500, 502, 503, 504],
    externalSystemUnchangedStatusCodes: [400, 404],
  };
}

function configuration() {
  const request = call();
  return {
    request: { calls: [request], disableUriEncoding: false },
    inputs: [
      {
        id: "ticketId",
        displayName: "Ticket ID",
        description: "",
        required: true,
        type: { kind: "string" as const },
      },
    ],
    outputs: [
      {
        id: "status",
        displayName: "Status",
        description: "",
        callId: request.id,
        selector: { kind: "statusCode" as const },
        type: { kind: "integer" as const },
      },
    ],
    storage: {
      retentionDays: 180 as const,
      recordFullResponse: false,
      responsePreviewBytes: 4096,
    },
    executionPolicy: {
      timeoutSeconds: 20,
      concurrencyLimit: null,
      rateLimit: null,
      retry: {
        maxAttempts: 3,
        initialBackoffMs: 1000,
        maxBackoffMs: 30_000,
        multiplier: 2,
        jitterRatio: 0.2,
      },
      idempotency: { enabled: true, headerName: "Idempotency-Key" },
      maxRequestBytes: 1024 * 1024,
      maxResponseBytes: 1024 * 1024,
    },
    trigger: { kind: "manual" as const },
    signature: null,
  };
}

function webhook(): ConnectivityWebhook {
  return {
    rid: "ri.magritte.main.webhook.test",
    tenant: "tenant-a",
    connectionRid: "ri.magritte.main.connection.test",
    apiName: "CreateTicket",
    displayName: "Create ticket",
    description: "",
    status: "active",
    currentVersion: 1,
    configuration: WebhookVersionConfiguration.parse(configuration()),
    createdAt: new Date(0).toISOString(),
    createdBy: "user-a",
    updatedAt: new Date(0).toISOString(),
    updatedBy: "user-a",
  };
}

describe("source-linked webhook contracts", () => {
  it("applies enterprise defaults and rejects an unstable API name", () => {
    const invalid = WebhookCreateRequest.safeParse({
      apiName: "create-ticket",
      displayName: "Create ticket",
      configuration: configuration(),
    });
    expect(invalid.success).toBe(false);

    const valid = WebhookCreateRequest.parse({
      apiName: "CreateTicket",
      displayName: "Create ticket",
      configuration: configuration(),
    });
    expect(valid.status).toBe("active");
    expect(valid.configuration.storage.retentionDays).toBe(180);
    expect(valid.configuration.executionPolicy.timeoutSeconds).toBe(20);
  });

  it("allows multiple read calls but at most one state-changing call", () => {
    const config = configuration();
    expect(
      WebhookVersionConfiguration.safeParse({
        ...config,
        request: {
          calls: [call("POST"), call("PATCH")],
          disableUriEncoding: false,
        },
      }).success,
    ).toBe(false);
    expect(
      WebhookVersionConfiguration.safeParse({
        ...config,
        outputs: [],
        request: {
          calls: [call("POST"), call("GET"), call("PATCH", true)],
          disableUriEncoding: false,
        },
      }).success,
    ).toBe(true);
  });

  it("rejects outputs referencing calls outside the saved version", () => {
    const config = configuration();
    expect(
      WebhookVersionConfiguration.safeParse({
        ...config,
        outputs: [{ ...config.outputs[0], callId: crypto.randomUUID() }],
      }).success,
    ).toBe(false);
  });

  it("requires file request bodies to reference attachment inputs", () => {
    const config = configuration();
    const fileCall = {
      ...config.request.calls[0],
      body: { kind: "file" as const, inputParameterId: "ticketId" },
    };
    expect(
      WebhookVersionConfiguration.safeParse({
        ...config,
        request: { calls: [fileCall], disableUriEncoding: false },
      }).success,
    ).toBe(false);
    expect(
      WebhookVersionConfiguration.safeParse({
        ...config,
        inputs: [
          ...config.inputs,
          {
            id: "upload",
            displayName: "Upload",
            description: "",
            required: true,
            type: { kind: "attachment" },
          },
        ],
        request: {
          calls: [{ ...fileCall, body: { kind: "file", inputParameterId: "upload" } }],
          disableUriEncoding: false,
        },
      }).success,
    ).toBe(true);
  });
});

describe("deterministic request construction", () => {
  it("renders strings and JSON without evaluating expressions", () => {
    const context = {
      inputs: { ticketId: 'a"b', count: 2 },
      calls: {},
    };
    expect(renderTextTemplate("/{{inputs.ticketId}}", context)).toBe('/a"b');
    expect(
      JSON.parse(
        renderJsonTemplate(
          '{"ticket": {{inputs.ticketId}}, "count": {{inputs.count}}}',
          context,
        ),
      ),
    ).toEqual({ ticket: 'a"b', count: 2 });
    expect(() =>
      renderTextTemplate("{{constructor.constructor('return process')()}}", context),
    ).toThrow(/only reference typed webhook inputs/i);
  });

  it("validates required, unknown, and typed execution inputs", () => {
    const definition = webhook();
    expect(() => validateExecutionInputs(definition, {})).toThrow(/required/i);
    expect(() =>
      validateExecutionInputs(definition, { ticketId: "1", unexpected: true }),
    ).toThrow(/not defined/i);
    expect(() =>
      validateExecutionInputs(definition, { ticketId: 123 }),
    ).toThrow(/does not match/i);
    expect(() =>
      validateExecutionInputs(definition, { ticketId: "123" }),
    ).not.toThrow();
  });

  it("validates list elements and record fields recursively", () => {
    const subject = webhook();
    subject.configuration = WebhookVersionConfiguration.parse({
      ...configuration(),
      inputs: [
        {
          id: "labels",
          displayName: "Labels",
          description: "",
          required: true,
          type: { kind: "list", elementType: { kind: "string" } },
        },
        {
          id: "contact",
          displayName: "Contact",
          description: "",
          required: true,
          type: {
            kind: "record",
            fields: [
              { id: "name", required: true, type: { kind: "string" } },
              { id: "priority", required: false, type: { kind: "integer" } },
            ],
          },
        },
      ],
    });

    expect(() =>
      validateExecutionInputs(subject, {
        labels: ["urgent", "customer"],
        contact: { name: "Ada", priority: 2 },
      }),
    ).not.toThrow();
    expect(() =>
      validateExecutionInputs(subject, {
        labels: ["urgent", 2],
        contact: { name: "Ada" },
      }),
    ).toThrow(/does not match type 'list'/i);
    expect(() =>
      validateExecutionInputs(subject, {
        labels: ["urgent"],
        contact: { name: "Ada", unknown: true },
      }),
    ).toThrow(/does not match type 'record'/i);
  });

  it("classifies retryable status codes and bounds exponential backoff", () => {
    const request = call();
    expect(classifyRetryable({ httpStatus: 503 }, request)).toBe(true);
    expect(classifyRetryable({ httpStatus: 400 }, request)).toBe(false);
    expect(
      calculateBackoffMs(
        3,
        {
          initialBackoffMs: 1000,
          maxBackoffMs: 3000,
          multiplier: 2,
          jitterRatio: 0,
        },
        () => 0.5,
      ),
    ).toBe(3000);
  });

  it("redacts sensitive inputs and attachment references", () => {
    const definition = webhook();
    definition.configuration.inputs.push(
      {
        id: "apiToken",
        displayName: "API token",
        description: "",
        required: false,
        type: { kind: "string" },
      },
      {
        id: "document",
        displayName: "Document",
        description: "",
        required: false,
        type: { kind: "attachment" },
      },
    );
    expect(
      redactExecutionInputs(definition, {
        ticketId: "ABC",
        apiToken: "sensitive",
        document: "ri.attachment.secret",
      }),
    ).toEqual({
      ticketId: "ABC",
      apiToken: "[REDACTED]",
      document: "[ATTACHMENT]",
    });
  });

  it("signs the timestamp and body deterministically", () => {
    expect(signPayload("{}", "secret", "2026-07-27T00:00:00.000Z")).toBe(
      signPayload("{}", "secret", "2026-07-27T00:00:00.000Z"),
    );
    expect(signPayload("{}", "secret", "2026-07-27T00:00:00.000Z")).not.toBe(
      signPayload('{"changed":true}', "secret", "2026-07-27T00:00:00.000Z"),
    );
  });
});

describe("webhook egress and log safety", () => {
  const policy: EgressPolicy = {
    httpsRequired: true,
    followRedirects: false,
    allowedHosts: ["api.example.com"],
    headerAllowlist: [],
    maxRequestBytes: 1024,
    maxResponseBytes: 1024,
    allowedResponseContentTypes: ["application/json"],
  };

  afterEach(() => {
    delete process.env.WEBHOOK_ALLOW_PRIVATE_NETWORK_FOR_DEV;
  });

  it("blocks HTTP, metadata endpoints, and non-allowlisted hosts", () => {
    expect(assertEgressUrl("http://api.example.com", policy).kind).toBe("errors");
    expect(assertEgressUrl("https://169.254.169.254/latest", policy).kind).toBe(
      "errors",
    );
    expect(assertEgressUrl("https://other.example.com", policy).kind).toBe(
      "errors",
    );
    expect(assertEgressUrl("https://api.example.com/v1", policy).kind).toBe("ok");
  });

  it("blocks private and loopback DNS destinations", async () => {
    await expect(assertDnsDestinationAllowed("127.0.0.1")).rejects.toThrow(
      /private|loopback/i,
    );
    await expect(assertDnsDestinationAllowed("169.254.169.254")).rejects.toThrow(
      /private|link-local/i,
    );
  });

  it("removes hop-by-hop headers and redacts credential headers", () => {
    const safe = sanitizeOutboundHeaders(
      {
        Authorization: "Bearer secret",
        Connection: "keep-alive",
        "X-Request-Id": "request-1",
      },
      policy,
    );
    expect(safe.headers.Connection).toBeUndefined();
    expect(redactHeadersForLog(safe.headers)).toEqual({
      Authorization: "[REDACTED]",
      "X-Request-Id": "request-1",
    });
  });
});
