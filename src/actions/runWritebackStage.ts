// ---------------------------------------------------------------------------
// src/actions/runWritebackStage.ts — Phase 6.3 writeback executor entry
//
// The actionExecutor historically ran the writeback pre-edit hook at Stage 5
// — AFTER compileRules Stage 4ab — so the typed outputs map returned by a
// successful writeback was not available to compileRules for the
// `writebackResponse` value-source resolution. Phase 6.3 lifts the Stage 5
// hooks to BEFORE Stage 4 (logically Stage 3.5) and threads the resulting
// outputs map into the `compileRules` execution context, closing the gap.
//
// To minimize the Stage 5 → Stage 3.5 re-ordering surface, the bulky
// writeback pre-edit body (input resolution + https/http transport +
// redacted-diagnostic logging + structured OntologyError mapping) is
// extracted here so the executor's Stage 3.5 site is one descriptive call.
//
// Phase 4's wire-up + the abort-on-failure contract are preserved:
//   * `runWritebackStage` returns `{ kind: "ok", outputs }` on a successful
//     pre-edit webhook (or `null` when the action has no writeback_config).
//   * On a `kind: "rejected"`, the helper translates the sanitized
//     `WritebackResult` to a structured `OntologyError` with the canonical
//     HTTP-status mapping (404/409/504/502/422 by code).
//   * On an unrecoverable transport-level runtime exception, the helper
//     rejects with a `WRITEBACK_REJECTED` 502 `OntologyError`.
//
// Caller is responsible for the `result.result = "failed"` post-failure
// bookkeeping; the helper throws so the executor's outer try/catch handles
// the audit + roll-back. The structured WARN log still emits here.
// ---------------------------------------------------------------------------

import https from "https";
import * as http from "http";
import {
  executeWriteback,
  type WritebackConfig,
  type WritebackResult,
  type HttpRequestFn,
  type HttpResponseSimulated,
} from "./writebackExecutor";
import { DEFAULT_EGRESS_POLICY } from "../services/webhookSafeTransport";
import { OntologyError } from "../utils/queryErrors";

export interface RunWritebackInput {
  actionType: {
    writeback_config: unknown | null;
  };
  /** The post-Stage-2 resolved action parameters. The writeback's
   * `inputs[name]` ValueSources (`parameter` / `static` / `currentTimestamp` /
   * `currentUser`) are resolved against this map. */
  resolvedParameters: Record<string, unknown>;
  /** Phase 6.1 — security context for the actor (used to resolve the
   * `currentUser` ValueSource + to populate the X-Actor helper header). */
  executedBy: string;
  ontologyId: string;
  /** The action type's api_name — for the structured log + the
   * surfaced error envelope. */
  actionTypeApiName: string;
  /** The action execution's UUID — for the X-Tellus-Execution-Id + the
   * structured diagnostic log + the surfaced error envelope. */
  executionId: string;
  /** Tenant scope for data-connection webhook resolution (the
   * connectivity store is tenant-scoped). Threaded from the route's
   * authenticated principal; the writeback executor falls back to
   * "default" when absent. */
  tenant?: string;
}

export type RunWritebackSuccess =
  | { kind: "ok"; outputs: Record<string, unknown> | undefined }
  | { kind: "no_writeback" };

/**
 * Run the writeback pre-edit hook. Returns the typed outputs map (keyed by
 * binding `outputId`) when the webhook returned a 2xx + the response body
 * matched the declared `outputBindings` shape. Returns `no_writeback` when
 * the action's `writeback_config` is null/undefined (no pre-edit hook).
 *
 * THROWS an `OntologyError` on rejection — the actionExecutor catches + sets
 * `result.result = "failed"`, `failureType = "writeback_rejected"`, then
 * re-yields to its outer finally block so the standalone failure audit
 * writes a deterministic-durability row.
 *
 * Phase 4 caller-side implementation moved here verbatim; only the
 * interface (returning `outputs` vs. throwing) was reshaped so the
 * post-Stage-3.5 caller can pass the outputs map to compileRules without
 * poking at the rejected-result envelope.
 */
export async function runWritebackStage(input: RunWritebackInput): Promise<RunWritebackSuccess> {
  if (input.actionType.writeback_config == null) {
    return { kind: "no_writeback" };
  }
  let writebackResult: WritebackResult;
  try {
    const wbConfig: WritebackConfig = input.actionType.writeback_config as WritebackConfig;

    // Resolve each `inputs[name]` ValueSource against the
    // already-resolved action parameters. The writeback stage is
    // intentionally pre-Stage-4 (Phase 6.3) so the executor can
    // also consume writeback_outputs as a value source downstream.
    const resolvedInputs: Record<string, unknown> = {};
    const sourceV = (v: any): unknown => {
      if (!v || typeof v !== "object") return undefined;
      switch (v.source) {
        case "parameter":
          return input.resolvedParameters[v.param];
        case "static":
          return v.value;
        case "currentTimestamp":
          return new Date().toISOString();
        case "currentUser":
          return input.executedBy || "system";
        default:
          return undefined;
      }
    };
    for (const [name, src] of Object.entries(wbConfig.inputs ?? {})) {
      resolvedInputs[name] = sourceV(src);
    }
    const executableConfig: WritebackConfig = {
      ...wbConfig,
      inputs: resolvedInputs,
    };

    const httpRequest: HttpRequestFn = (params) =>
      new Promise<HttpResponseSimulated>((resolveP, reject) => {
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(params.url);
        } catch (e) {
          reject(e);
          return;
        }
        const isHttps = parsedUrl.protocol === "https:";
        const lib = isHttps ? https : http;
        const opts: https.RequestOptions = {
          method: params.method,
          headers: params.headers,
          timeout: params.timeoutMs,
        };
        const req = lib.request(parsedUrl, opts, (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => {
            resolveP({
              status: res.statusCode ?? 0,
              body,
              contentType: res.headers["content-type"] ?? "",
              headers: res.headers as unknown as Record<string, string>,
              durationMs: undefined,
            });
          });
        });
        req.on("timeout", () => {
          req.destroy(new Error(`Writeback request timed out after ${params.timeoutMs}ms`));
        });
        req.on("error", reject);
        req.write(params.body);
        req.end();
      });

    writebackResult = await executeWriteback(
      executableConfig,
      { actor: input.executedBy, executionId: input.executionId, ontologyId: input.ontologyId, tenant: input.tenant },
      DEFAULT_EGRESS_POLICY,
      httpRequest,
    );
  } catch (err: any) {
    // Transport-level runtime error (e.g. DNS failure / ECONNRESET /
    // an unhandled exception in the https callback). Complete failure
    // — surface as WRITEBACK_REJECTED 502.
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        type: "action_writeback_error",
        executionId: input.executionId,
        actionTypeApiName: input.actionTypeApiName,
        ontologyId: input.ontologyId,
        error: err?.message ?? String(err),
      }),
    );
    throw new OntologyError(
      `Writeback execution error: ${err?.message ?? String(err)}`,
      "WRITEBACK_REJECTED",
      502,
      { executionId: input.executionId, actionTypeApiName: input.actionTypeApiName },
    );
  }

  if (writebackResult.kind === "rejected") {
    const code =
      writebackResult.code === "WEBHOOK_NOT_FOUND"
        ? "WEBHOOK_NOT_FOUND"
        : writebackResult.code === "WEBHOOK_VERSION_DISABLED"
          ? "WEBHOOK_VERSION_DISABLED"
          : writebackResult.code === "WRITEBACK_CONFIG_INVALID"
            ? "WRITEBACK_CONFIG_INVALID"
            : writebackResult.code === "WRITEBACK_TIMEOUT"
              ? "WRITEBACK_TIMEOUT"
              : writebackResult.code === "WRITEBACK_OUTPUT_SCHEMA_MISMATCH"
                ? "WRITEBACK_OUTPUT_SCHEMA_MISMATCH"
                : "WRITEBACK_REJECTED";
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        type: "action_writeback_rejected",
        executionId: input.executionId,
        actionTypeApiName: input.actionTypeApiName,
        ontologyId: input.ontologyId,
        webhookName: writebackResult.diagnostic.webhookName,
        webhookVersion: writebackResult.diagnostic.webhookVersion,
        httpStatus: writebackResult.diagnostic.httpStatus,
        endpoint: writebackResult.diagnostic.endpoint,
        contentType: writebackResult.diagnostic.contentType,
        code,
      }),
    );
    throw new OntologyError(
      writebackResult.message,
      code,
      code === "WEBHOOK_NOT_FOUND"
        ? 404
        : code === "WEBHOOK_VERSION_DISABLED"
          ? 409
          : code === "WRITEBACK_TIMEOUT"
            ? 504
            : code === "WRITEBACK_REJECTED"
              ? 502
              : 422,
      {
        executionId: input.executionId,
        actionTypeApiName: input.actionTypeApiName,
        webhookName: writebackResult.diagnostic.webhookName,
        webhookVersion: writebackResult.diagnostic.webhookVersion,
        userMessage: writebackResult.userMessage,
        httpStatus: writebackResult.diagnostic.httpStatus,
        endpoint: writebackResult.diagnostic.endpoint ? "[redacted]" : undefined,
      },
    );
  }

  // ok — carry the typed outputs map forward for compileRules to consume
  // for the `writebackResponse` value-source resolution. Phase 6.3.
  return {
    kind: "ok",
    outputs: writebackResult.outputs,
  };
}
