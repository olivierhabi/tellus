import { z } from "zod";

const ApiName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Z][A-Za-z0-9]{0,99}$/);

const ParameterId = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/);

const TemplateValue = z.string().max(64 * 1024);
const HeaderName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/);

export const WebhookLifecycleStatus = z.enum([
  "draft",
  "validating",
  "ready",
  "active",
  "disabled",
  "failed",
  "archived",
]);
export type WebhookLifecycleStatus = z.infer<typeof WebhookLifecycleStatus>;

export const WebhookParameterType: z.ZodType<WebhookParameterTypeValue> = z.lazy(
  () =>
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("attachment") }),
      z.object({ kind: z.literal("boolean") }),
      z.object({ kind: z.literal("integer") }),
      z.object({ kind: z.literal("long") }),
      z.object({ kind: z.literal("double") }),
      z.object({
        kind: z.literal("string"),
        allowedValues: z.array(z.string().max(2000)).max(500).optional(),
      }),
      z.object({ kind: z.literal("date") }),
      z.object({ kind: z.literal("timestamp") }),
      z.object({ kind: z.literal("list"), elementType: WebhookParameterType }),
      z.object({
        kind: z.literal("record"),
        fields: z
          .array(
            z.object({
              id: ParameterId,
              required: z.boolean().default(true),
              type: WebhookParameterType,
            }),
          )
          .max(100),
      }),
    ]),
);

export type WebhookParameterTypeValue =
  | { kind: "attachment" }
  | { kind: "boolean" }
  | { kind: "integer" }
  | { kind: "long" }
  | { kind: "double" }
  | { kind: "string"; allowedValues?: string[] }
  | { kind: "date" }
  | { kind: "timestamp" }
  | { kind: "list"; elementType: WebhookParameterTypeValue }
  | {
      kind: "record";
      fields: Array<{
        id: string;
        required: boolean;
        type: WebhookParameterTypeValue;
      }>;
    };

export const WebhookParameter = z.object({
  id: ParameterId,
  displayName: z.string().min(1).max(256),
  description: z.string().max(2000).default(""),
  required: z.boolean().default(true),
  type: WebhookParameterType,
});
export type WebhookParameter = z.infer<typeof WebhookParameter>;

export const RequestValue = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: TemplateValue }),
  z.object({ kind: z.literal("template"), template: TemplateValue }),
  z.object({
    kind: z.literal("secret"),
    secretName: ParameterId,
    prefix: z.string().max(100).default(""),
  }),
]);
export type RequestValue = z.infer<typeof RequestValue>;

const KeyValue = z.object({
  id: z.string().uuid(),
  key: z.string().min(1).max(1024),
  value: RequestValue,
  enabled: z.boolean().default(true),
});

export const RequestBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("rawJson"),
    template: TemplateValue,
  }),
  z.object({
    kind: z.literal("plainText"),
    value: RequestValue,
  }),
  z.object({
    kind: z.literal("xml"),
    template: TemplateValue,
  }),
  z.object({
    kind: z.literal("formUrlEncoded"),
    fields: z.array(KeyValue).max(200),
  }),
  z.object({
    kind: z.literal("formData"),
    fields: z.array(KeyValue).max(200),
  }),
  z.object({
    kind: z.literal("file"),
    inputParameterId: ParameterId,
    contentType: z.string().max(200).optional(),
  }),
]);
export type RequestBody = z.infer<typeof RequestBody>;

export const WebhookCall = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  domainIndex: z.number().int().min(0).max(99).default(0),
  relativePath: TemplateValue.refine(
    (value) => !value.includes("://") && !/(^|\/)\.\.(\/|$)/.test(value),
    "relativePath must be relative to the selected source domain and may not traverse parent paths",
  ),
  queryParameters: z.array(KeyValue).max(200).default([]),
  headers: z
    .array(KeyValue.extend({ key: HeaderName }))
    .max(200)
    .default([]),
  body: RequestBody.default({ kind: "none" }),
  readApi: z.boolean().default(false),
  retryableStatusCodes: z
    .array(z.number().int().min(400).max(599))
    .max(100)
    .default([408, 429, 500, 502, 503, 504]),
  externalSystemUnchangedStatusCodes: z
    .array(z.number().int().min(400).max(599))
    .max(200)
    .default(Array.from({ length: 32 }, (_, index) => 400 + index)),
});
export type WebhookCall = z.infer<typeof WebhookCall>;

export const RequestConfiguration = z
  .object({
    calls: z.array(WebhookCall).min(1).max(10),
    disableUriEncoding: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    const ids = value.calls.map((call) => call.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["calls"],
        message: "Call identifiers must be unique.",
      });
    }
    const unsafeCount = value.calls.filter(
      (call) => call.method !== "GET" && !call.readApi,
    ).length;
    if (unsafeCount > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["calls"],
        message:
          "A webhook may contain at most one state-changing call. Mark proven-safe calls as Read API.",
      });
    }
  });
export type RequestConfiguration = z.infer<typeof RequestConfiguration>;

export const OutputParameter = z.object({
  id: ParameterId,
  displayName: z.string().min(1).max(256),
  description: z.string().max(2000).default(""),
  callId: z.string().uuid(),
  selector: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("wholeResponse") }),
    z.object({ kind: z.literal("jsonPath"), path: z.array(z.string()).min(1).max(50) }),
    z.object({ kind: z.literal("arrayIndex"), indexes: z.array(z.number().int().min(0)).min(1).max(50) }),
    z.object({ kind: z.literal("header"), name: HeaderName }),
    z.object({ kind: z.literal("statusCode") }),
  ]),
  type: WebhookParameterType,
});
export type OutputParameter = z.infer<typeof OutputParameter>;

export const StorageConfiguration = z.object({
  retentionDays: z.literal(180).default(180),
  recordFullResponse: z.boolean().default(false),
  recordFullResponseCallIds: z.array(z.string().uuid()).max(10).default([]),
  responsePreviewBytes: z.number().int().min(0).max(64 * 1024).default(4096),
});
export type StorageConfiguration = z.infer<typeof StorageConfiguration>;

export const RetryConfiguration = z.object({
  maxAttempts: z.number().int().min(1).max(5).default(1),
  initialBackoffMs: z.number().int().min(100).max(60_000).default(1000),
  maxBackoffMs: z.number().int().min(100).max(300_000).default(30_000),
  multiplier: z.number().min(1).max(10).default(2),
  jitterRatio: z.number().min(0).max(1).default(0.2),
});
export type RetryConfiguration = z.infer<typeof RetryConfiguration>;

export const ExecutionPolicy = z.object({
  timeoutSeconds: z.number().int().min(1).max(180).default(20),
  concurrencyLimit: z.number().int().min(1).max(100).nullable().default(null),
  rateLimit: z
    .object({
      count: z.number().int().min(1).max(100_000),
      window: z.enum(["second", "minute", "hour", "day"]),
    })
    .nullable()
    .default(null),
  retry: RetryConfiguration.default({
    maxAttempts: 1,
    initialBackoffMs: 1000,
    maxBackoffMs: 30_000,
    multiplier: 2,
    jitterRatio: 0.2,
  }),
  idempotency: z
    .object({
      enabled: z.boolean().default(true),
      headerName: HeaderName.default("Idempotency-Key"),
    })
    .default({ enabled: true, headerName: "Idempotency-Key" }),
  maxRequestBytes: z.number().int().min(0).max(10 * 1024 * 1024).default(1024 * 1024),
  maxResponseBytes: z.number().int().min(0).max(10 * 1024 * 1024).default(1024 * 1024),
});
export type ExecutionPolicy = z.infer<typeof ExecutionPolicy>;

export const TriggerConfiguration = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }),
  z.object({ kind: z.literal("action"), actionTypeApiName: ApiName }),
  z.object({ kind: z.literal("automation"), automationRid: z.string().min(1).max(512) }),
]);
export type TriggerConfiguration = z.infer<typeof TriggerConfiguration>;

export const SignatureConfiguration = z
  .object({
    algorithm: z.literal("hmac-sha256"),
    secretName: ParameterId,
    headerName: HeaderName.default("X-Tellus-Signature"),
    timestampHeaderName: HeaderName.default("X-Tellus-Timestamp"),
  })
  .nullable();
export type SignatureConfiguration = z.infer<typeof SignatureConfiguration>;

export const WebhookVersionConfiguration = z
  .object({
    request: RequestConfiguration,
    inputs: z.array(WebhookParameter).max(100).default([]),
    outputs: z.array(OutputParameter).max(100).default([]),
    storage: StorageConfiguration.default({
      retentionDays: 180,
      recordFullResponse: false,
      recordFullResponseCallIds: [],
      responsePreviewBytes: 4096,
    }),
    executionPolicy: ExecutionPolicy.default({
      timeoutSeconds: 20,
      concurrencyLimit: null,
      rateLimit: null,
      retry: {
        maxAttempts: 1,
        initialBackoffMs: 1000,
        maxBackoffMs: 30_000,
        multiplier: 2,
        jitterRatio: 0.2,
      },
      idempotency: { enabled: true, headerName: "Idempotency-Key" },
      maxRequestBytes: 1024 * 1024,
      maxResponseBytes: 1024 * 1024,
    }),
    trigger: TriggerConfiguration.default({ kind: "manual" }),
    signature: SignatureConfiguration.default(null),
  })
  .superRefine((value, ctx) => {
    const inputIds = value.inputs.map((input) => input.id);
    if (new Set(inputIds).size !== inputIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inputs"],
        message: "Input parameter IDs must be unique.",
      });
    }
    const attachmentInputIds = new Set(
      value.inputs
        .filter((input) => input.type.kind === "attachment")
        .map((input) => input.id),
    );
    for (const [callIndex, call] of value.request.calls.entries()) {
      if (
        call.body.kind === "file" &&
        !attachmentInputIds.has(call.body.inputParameterId)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["request", "calls", callIndex, "body", "inputParameterId"],
          message:
            "File request bodies must reference an Attachment input parameter.",
        });
      }
    }
    const callIds = new Set(value.request.calls.map((call) => call.id));
    for (const [index, output] of value.outputs.entries()) {
      if (!callIds.has(output.callId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outputs", index, "callId"],
          message: "Output parameter must reference a call in this version.",
        });
      }
    }
  });
export type WebhookVersionConfiguration = z.infer<
  typeof WebhookVersionConfiguration
>;

export const WebhookCreateRequest = z.object({
  apiName: ApiName,
  displayName: z.string().min(1).max(256),
  description: z.string().max(4000).default(""),
  status: z.enum(["draft", "ready", "active"]).default("active"),
  configuration: WebhookVersionConfiguration,
});
export type WebhookCreateRequest = z.infer<typeof WebhookCreateRequest>;

export const WebhookUpdateRequest = z.object({
  displayName: z.string().min(1).max(256).optional(),
  description: z.string().max(4000).optional(),
  configuration: WebhookVersionConfiguration,
});
export type WebhookUpdateRequest = z.infer<typeof WebhookUpdateRequest>;

export const WebhookExecuteRequest = z.object({
  inputs: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z.string().min(1).max(512).optional(),
});
export type WebhookExecuteRequest = z.infer<typeof WebhookExecuteRequest>;

export interface ConnectivityWebhook {
  rid: string;
  tenant: string;
  connectionRid: string;
  apiName: string;
  displayName: string;
  description: string;
  status: WebhookLifecycleStatus;
  currentVersion: number;
  configuration: WebhookVersionConfiguration;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface WebhookExecutionSummary {
  rid: string;
  webhookRid: string;
  webhookVersion: number;
  kind: "test" | "production";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "dead_lettered";
  correlationId: string;
  triggeredBy: string;
  inputSummary: Record<string, unknown>;
  outputSummary: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  httpStatus: number | null;
  durationMs: number | null;
  externalSystemChanged: boolean | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  attempts?: WebhookDeliveryAttempt[];
}

export interface WebhookDeliveryAttempt {
  id: string;
  attemptNumber: number;
  status: "running" | "succeeded" | "retryable_failure" | "terminal_failure" | "cancelled";
  requestMethod: string;
  requestUrlRedacted: string;
  requestHeadersRedacted: Record<string, unknown>;
  responseHeadersRedacted: Record<string, unknown> | null;
  httpStatus: number | null;
  responsePreview: string | null;
  responseBytes: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  nextAttemptAt: string | null;
}
