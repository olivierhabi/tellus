import { randomUUID } from "node:crypto";

const api = process.env.WEBHOOK_VERIFY_API ?? "http://localhost:3013/api/v1";
const email = process.env.TELLUS_SUPERADMIN_EMAIL;
const password = process.env.TELLUS_SUPERADMIN_PASSWORD;
if (!email || !password) {
  throw new Error("TELLUS_SUPERADMIN_EMAIL and TELLUS_SUPERADMIN_PASSWORD are required");
}

async function json<T>(
  path: string,
  init: RequestInit = {},
  expected: number | number[] = 200,
): Promise<T> {
  const response = await fetch(`${api}${path}`, init);
  const body = await response.json().catch(() => null);
  const statuses = Array.isArray(expected) ? expected : [expected];
  if (!statuses.includes(response.status)) {
    throw new Error(
      `${init.method ?? "GET"} ${path} returned ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  return body as T;
}

async function main(): Promise<void> {
let token = "";
let connectionRid = "";
let webhookRid = "";

try {
  const login = await json<{ data: { accessToken: string } }>(
    "/auth/_test/login-bypass",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tellus-Test-Hook": "1",
      },
      body: JSON.stringify({ username: email, password }),
    },
  );
  token = login.data.accessToken;
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const unauthenticated = await fetch(`${api}/connectivity/connections`);
  if (unauthenticated.status !== 401) {
    throw new Error(`Expected unauthenticated access to return 401, got ${unauthenticated.status}`);
  }

  const suffix = Date.now().toString(36);
  const connection = await json<{ rid: string; version: number }>(
    "/connectivity/connections",
    {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        name: `WebhookVerify${suffix}`,
        connectorType: "rest-api",
        workerType: "foundryWorker",
        config: {
          connectorType: "rest-api",
          restApi: {
            domains: [
              {
                baseUrl: "https://postman-echo.com",
                port: 443,
                authentication: "none",
              },
            ],
            additionalSecretNames: ["apiToken"],
            apiName: `VerifyApi${suffix}`,
          },
        },
        egressPolicy: {
          allowlist: [{ kind: "host", host: "postman-echo.com", port: 443 }],
        },
        compassFolderRid:
          "ri.compass.main.folder.e3ae45b8-ffa4-434b-89bd-48fc890be507",
        settings: {
          export: { exportsEnabled: false, skipMarkingsValidation: false },
          codeImport: {
            allowCodeRepositories: false,
            allowComputeModules: false,
            allowPipelineUdfs: false,
            allowVirtualTables: true,
          },
        },
      }),
    },
    201,
  );
  connectionRid = connection.rid;

  await json(
    `/connectivity/connections/${encodeURIComponent(connectionRid)}/secrets`,
    {
      method: "POST",
      headers: {
        ...auth,
        "If-Match": `W/"${connection.version}"`,
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({
        field: "other",
        plaintext_base64: Buffer.from(
          JSON.stringify({ apiToken: "must-never-appear-in-history" }),
        ).toString("base64"),
      }),
    },
    201,
  );

  const callId = randomUUID();
  const configuration = {
    request: {
      calls: [
        {
          id: callId,
          name: "Create verification record",
          method: "POST",
          domainIndex: 0,
          relativePath: "/post?token={{inputs.queryToken}}",
          queryParameters: [],
          headers: [
            {
              id: randomUUID(),
              key: "X-API-Key",
              value: { kind: "secret", secretName: "apiToken", prefix: "" },
              enabled: true,
            },
          ],
          body: {
            kind: "rawJson",
            template: '{"message": {{inputs.message}}}',
          },
          readApi: false,
          retryableStatusCodes: [408, 429, 500, 502, 503, 504],
          externalSystemUnchangedStatusCodes: [400, 401, 403, 404, 409, 422],
        },
      ],
      disableUriEncoding: false,
    },
    inputs: [
      {
        id: "message",
        displayName: "Message",
        description: "",
        required: true,
        type: { kind: "string" },
      },
      {
        id: "queryToken",
        displayName: "Query token",
        description: "",
        required: true,
        type: { kind: "string" },
      },
    ],
    outputs: [
      {
        id: "status",
        displayName: "HTTP status",
        description: "",
        callId,
        selector: { kind: "statusCode" },
        type: { kind: "integer" },
      },
    ],
    storage: {
      retentionDays: 180,
      recordFullResponse: false,
      responsePreviewBytes: 4096,
    },
    executionPolicy: {
      timeoutSeconds: 5,
      concurrencyLimit: 2,
      rateLimit: { count: 20, window: "minute" },
      retry: {
        maxAttempts: 2,
        initialBackoffMs: 100,
        maxBackoffMs: 500,
        multiplier: 2,
        jitterRatio: 0,
      },
      idempotency: { enabled: true, headerName: "Idempotency-Key" },
      maxRequestBytes: 65_536,
      maxResponseBytes: 65_536,
    },
    trigger: { kind: "manual" },
    signature: null,
  };

  const webhook = await json<{
    rid: string;
    status: string;
    currentVersion: number;
  }>(
    `/connectivity/connections/${encodeURIComponent(connectionRid)}/webhooks`,
    {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        apiName: `VerifyWebhook${suffix}`,
        displayName: "Webhook integration verification",
        description: "Created by the source-linked webhook integration test.",
        status: "draft",
        configuration,
      }),
    },
    201,
  );
  webhookRid = webhook.rid;

  const testResult = await json<{
    execution: {
      status: string;
      outputSummary: { status: number };
      attempts: Array<{
        requestHeadersRedacted: Record<string, string>;
        requestUrlRedacted: string;
        responsePreview: string;
      }>;
    };
  }>(
    `/connectivity/webhooks/${encodeURIComponent(webhookRid)}/test`,
    {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        inputs: { message: "hello", queryToken: "sensitive-query" },
      }),
    },
    201,
  );
  if (
    testResult.execution.status !== "succeeded" ||
    testResult.execution.outputSummary.status !== 200
  ) {
    throw new Error(`Test execution failed: ${JSON.stringify(testResult)}`);
  }
  const attemptJson = JSON.stringify(testResult.execution.attempts);
  if (attemptJson.includes("must-never-appear-in-history")) {
    throw new Error("Secret material was exposed in execution history");
  }
  if (!attemptJson.includes("[REDACTED]")) {
    throw new Error("Expected secret-bearing header or query parameter to be redacted");
  }

  const ready = await json<{ currentVersion: number }>(
    `/connectivity/webhooks/${encodeURIComponent(webhookRid)}/ready`,
    {
      method: "POST",
      headers: { ...auth, "If-Match": `W/"${webhook.currentVersion}"` },
    },
  );
  const active = await json<{ currentVersion: number; status: string }>(
    `/connectivity/webhooks/${encodeURIComponent(webhookRid)}/activate`,
    {
      method: "POST",
      headers: { ...auth, "If-Match": `W/"${ready.currentVersion}"` },
    },
  );
  if (active.status !== "active") throw new Error("Webhook did not activate");

  const productionIdempotencyKey = randomUUID();
  const productionBody = {
    inputs: { message: "production", queryToken: "production-query" },
    idempotencyKey: productionIdempotencyKey,
  };
  const first = await json<{ execution: { rid: string; status: string }; replayed: boolean }>(
    `/connectivity/webhooks/${encodeURIComponent(webhookRid)}/execute`,
    {
      method: "POST",
      // A distinct transport idempotency key reaches the webhook repository,
      // while the stable body key verifies domain-level replay protection.
      headers: { ...auth, "Idempotency-Key": randomUUID() },
      body: JSON.stringify(productionBody),
    },
    201,
  );
  const replay = await json<{ execution: { rid: string }; replayed: boolean }>(
    `/connectivity/webhooks/${encodeURIComponent(webhookRid)}/execute`,
    {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": productionIdempotencyKey },
      body: JSON.stringify(productionBody),
    },
    200,
  );
  if (
    first.execution.status !== "succeeded" ||
    !replay.replayed ||
    replay.execution.rid !== first.execution.rid
  ) {
    throw new Error("Production execution idempotency verification failed");
  }

  const history = await json<{ data: Array<{ rid: string }> }>(
    `/connectivity/webhooks/${encodeURIComponent(webhookRid)}/executions`,
    { headers: auth },
  );
  if (history.data.length < 2) throw new Error("Execution history was not persisted");

  const disabled = await json<{ currentVersion: number; status: string }>(
    `/connectivity/webhooks/${encodeURIComponent(webhookRid)}/disable`,
    {
      method: "POST",
      headers: { ...auth, "If-Match": `W/"${active.currentVersion}"` },
    },
  );
  if (disabled.status !== "disabled") throw new Error("Webhook did not disable");

  const rejected = await fetch(
    `${api}/connectivity/webhooks/${encodeURIComponent(webhookRid)}/execute`,
    {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        inputs: { message: "blocked", queryToken: "blocked-query" },
      }),
    },
  );
  if (rejected.status < 400) {
    throw new Error("Disabled webhook unexpectedly executed in production");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        connectionRid,
        webhookRid,
        testStatus: testResult.execution.status,
        productionStatus: first.execution.status,
        idempotencyReplay: replay.replayed,
        historyCount: history.data.length,
        disabledExecutionStatus: rejected.status,
        secretsRedacted: true,
      },
      null,
      2,
    ),
  );
} finally {
  if (token && webhookRid) {
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const current = await fetch(
      `${api}/connectivity/webhooks/${encodeURIComponent(webhookRid)}`,
      { headers: auth },
    ).then((response) => response.json()).catch(() => null);
    if (current?.currentVersion) {
      await fetch(`${api}/connectivity/webhooks/${encodeURIComponent(webhookRid)}`, {
        method: "DELETE",
        headers: {
          ...auth,
          "If-Match": `W/"${current.currentVersion}"`,
        },
      }).catch(() => undefined);
    }
  }
  if (token && connectionRid) {
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const current = await fetch(
      `${api}/connectivity/connections/${encodeURIComponent(connectionRid)}`,
      { headers: auth },
    ).then((response) => response.json()).catch(() => null);
    if (current?.version) {
      await fetch(`${api}/connectivity/connections/${encodeURIComponent(connectionRid)}`, {
        method: "DELETE",
        headers: { ...auth, "If-Match": `W/"${current.version}"` },
      }).catch(() => undefined);
    }
  }
}
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
