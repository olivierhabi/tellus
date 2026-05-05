// Quiver B9 — AIP orchestrator.
// Wraps AipPort: enforces tool authorization, persists trace, emits audit,
// counts metrics, generates traceRid before streaming.

import { emitQuiverAudit } from "../audit.js";
import {
  aipCostUsdMicrosTotal,
  aipFirstTokenSeconds,
  aipTokensUsedTotal,
  aipToolInvocationTotal,
  aipToolUnauthorizedTotal,
} from "../metrics.js";
import { getMockUsage } from "./inProcessAip.js";
import { newTraceRid, persistTrace, sha256 } from "./traces.js";
import type {
  AipEvent,
  AipPort,
  AipRequest,
  AipSurface,
  ToolInvocation,
  ToolName,
} from "./types.js";

const AUTHORIZED_TOOLS_BY_DEFAULT: ReadonlyArray<ToolName> = [
  "object_query",
  "function_call",
  "update_application_variable",
  "command",
  "ontology_context",
];

export interface OrchestrateInput {
  readonly port: AipPort;
  readonly surface: AipSurface;
  readonly req: AipRequest;
  /** Tools authorized for this user-on-this-analysis. apply_action included only if pre-validated. */
  readonly authorizedTools: ReadonlyArray<ToolName>;
}

export async function* orchestrate(
  input: OrchestrateInput,
): AsyncIterable<AipEvent> {
  const traceRid = newTraceRid();
  const tools: ToolInvocation[] = [];
  const allowed = new Set<ToolName>(input.authorizedTools);
  let firstTokenAt: number | null = null;
  const startedAt = Date.now();
  let yieldedDone = false;
  const surfaceLowercase = input.surface.toLowerCase();

  const stream =
    input.surface === "GENERATE"
      ? input.port.generate(input.req)
      : input.surface === "CONFIGURE"
        ? input.port.configure(input.req)
        : input.port.assist(input.req);

  try {
    for await (const ev of stream) {
      if (ev.event === "tool_call") {
        const toolName = (ev.data as { tool: ToolName }).tool;
        if (!allowed.has(toolName)) {
          aipToolUnauthorizedTotal.inc({ tool: toolName });
          yield {
            event: "error",
            data: {
              errorCode: "PERMISSION_DENIED",
              errorName: "Tellus:Quiver:LlmToolUnauthorized",
              message: `tool ${toolName} not in authorized manifest`,
            },
          };
          // We do not propagate this proposal further.
          continue;
        }
        aipToolInvocationTotal.inc({ tool: toolName });
        tools.push({
          tool: toolName,
          input: (ev.data as { input: unknown }).input,
          latencyMs: 0,
          startedAt: new Date().toISOString(),
        });
        yield ev;
        continue;
      }

      if (ev.event === "token" && firstTokenAt === null) {
        firstTokenAt = Date.now();
        aipFirstTokenSeconds.observe(
          { surface: surfaceLowercase },
          (firstTokenAt - startedAt) / 1000,
        );
      }

      // Pass through everything else.
      yield ev;
    }

    // Stream ended without explicit error → emit done.
    const usage = getMockUsage();
    aipTokensUsedTotal.inc(
      { surface: surfaceLowercase, model: "in-process" },
      usage.tokens,
    );
    aipCostUsdMicrosTotal.inc(
      { surface: surfaceLowercase, model: "in-process" },
      usage.costUsdMicros,
    );

    await persistTrace({
      rid: traceRid,
      analysisRid: input.req.analysisRid,
      userRid: input.req.userSubject.userRid,
      surface: input.surface,
      prompt: input.req.prompt,
      toolInvocations: tools,
      totalTokens: usage.tokens,
      costUsdMicros: usage.costUsdMicros,
    });

    await emitQuiverAudit({
      actorSubject: input.req.userSubject.userRid,
      action: "QUIVER_AIP_INVOKED",
      rid: input.req.analysisRid,
      result: "SUCCESS",
      branch: input.req.branch,
      details: {
        surface: input.surface,
        promptSha256: sha256(input.req.prompt),
        traceRid,
      },
    });

    yieldedDone = true;
    yield { event: "done", data: { traceRid } };
  } catch (e) {
    const message = (e as Error).message ?? "unknown";
    yield {
      event: "error",
      data: {
        errorCode: "INTERNAL_ERROR",
        errorName: "Tellus:Quiver:LlmInternalError",
        message,
      },
    };
  } finally {
    if (!yieldedDone) {
      // Surface a hard timeout via 504 semantics — emit a final error frame
      // so the client can distinguish from happy-path stream-end.
      yield {
        event: "error",
        data: {
          errorCode: "DEADLINE_EXCEEDED",
          errorName: "Tellus:Quiver:LlmTimeout",
          message: "stream ended without `done` event",
        },
      };
    }
  }
}

export function defaultAuthorizedTools(): ReadonlyArray<ToolName> {
  return AUTHORIZED_TOOLS_BY_DEFAULT;
}
