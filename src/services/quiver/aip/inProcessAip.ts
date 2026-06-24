// Quiver B9 — InProcessAipPort: deterministic mock LLM.
// Production swaps in tellus-aip-logic-service client behind the same AipPort.

import type { AipEvent, AipPort, AipRequest } from "./types.js";

interface MockBehavior {
  /** Force timeout — yield no events, leak past remainingMs. */
  readonly timeout?: boolean;
  /** Pretend the LLM proposed an apply_action even when filtered out. */
  readonly proposeUnauthorizedTool?: boolean;
  /** Tokens consumed by the mocked stream. */
  readonly tokens?: number;
  /** Cost in USD micros. */
  readonly costUsdMicros?: number;
}

let behavior: MockBehavior = {};

export function setMockBehavior(b: MockBehavior): void {
  behavior = b;
}

export function clearMockBehavior(): void {
  behavior = {};
}

export function getMockUsage(): {
  tokens: number;
  costUsdMicros: number;
} {
  return {
    tokens: behavior.tokens ?? 12,
    costUsdMicros: behavior.costUsdMicros ?? 100,
  };
}

async function* maybeTimeout(_req: AipRequest): AsyncIterable<AipEvent> {
  if (behavior.timeout) {
    // Sleep longer than any reasonable test deadline so the route's
    // X-Deadline-Ms timer fires first and writes the LlmTimeout frame.
    await new Promise((r) => setTimeout(r, 1500));
    return;
  }
}

export class InProcessAipPort implements AipPort {
  async *generate(req: AipRequest): AsyncIterable<AipEvent> {
    yield* maybeTimeout(req);
    if (behavior.timeout) return;

    yield {
      event: "tool_call",
      data: { tool: "object_query", input: { prompt: req.prompt } },
    };
    yield {
      event: "tool_result",
      data: { tool: "object_query", output: { rows: [] } },
    };
    yield { event: "token", data: { delta: "Proposing " } };
    yield { event: "token", data: { delta: "card..." } };

    if (behavior.proposeUnauthorizedTool) {
      // The route layer must enforce — here we still emit the proposal for tests.
      yield {
        event: "tool_call",
        data: { tool: "apply_action", input: { actionTypeRid: "ri.action.x" } },
      };
      yield {
        event: "error",
        data: {
          errorCode: "PERMISSION_DENIED",
          errorName: "Tellus:Quiver:LlmToolUnauthorized",
          message: "apply_action not in authorized manifest",
        },
      };
      return;
    }

    yield {
      event: "card_proposal",
      data: {
        card: {
          id: "card-suggested-1",
          type: "OBJECT_SET",
          config: { from: "natural-language" },
        },
      },
    };
  }

  async *configure(req: AipRequest): AsyncIterable<AipEvent> {
    yield* maybeTimeout(req);
    if (behavior.timeout) return;

    yield {
      event: "tool_call",
      data: { tool: "ontology_context", input: { cardId: req.cardId } },
    };
    yield {
      event: "tool_result",
      data: { tool: "ontology_context", output: { schemas: [] } },
    };
    yield { event: "token", data: { delta: "Patching..." } };
    yield {
      event: "config_patch",
      data: {
        jsonPatch: [
          { op: "replace", path: "/limit", value: 1000 },
          { op: "add", path: "/note", value: req.prompt.slice(0, 32) },
        ],
      },
    };
  }

  async *assist(req: AipRequest): AsyncIterable<AipEvent> {
    yield* maybeTimeout(req);
    if (behavior.timeout) return;

    yield { event: "token", data: { delta: "Hello, " } };
    yield { event: "token", data: { delta: "I can help." } };
    yield {
      event: "assistant_message",
      data: { content: `Re: ${req.prompt.slice(0, 40)}` },
    };
  }
}

export const inProcessAipPort: AipPort = new InProcessAipPort();
