// Quiver B9 — AIP types (events, tools, errors).
// Spec §B9 SSE event taxonomy + tool registry are the contract.

export type AipSurface = "GENERATE" | "CONFIGURE" | "ASSIST";

/** SSE event taxonomy — exact strings per B9 C-04. */
export type AipEvent =
  | { event: "tool_call"; data: { tool: string; input: unknown } }
  | { event: "tool_result"; data: { tool: string; output: unknown } }
  | { event: "token"; data: { delta: string } }
  | { event: "card_proposal"; data: { card: unknown } }
  | { event: "config_patch"; data: { jsonPatch: ReadonlyArray<unknown> } }
  | { event: "assistant_message"; data: { content: string } }
  | { event: "done"; data: { traceRid: string } }
  | {
      event: "error";
      data: { errorCode: string; errorName: string; message: string };
    };

/** Manifest-driven tool registry (B9 C-05). */
export type ToolName =
  | "object_query"
  | "function_call"
  | "apply_action"
  | "update_application_variable"
  | "command"
  | "ontology_context";

export interface ToolManifestEntry {
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface ToolInvocation {
  readonly tool: ToolName;
  readonly input: unknown;
  readonly output?: unknown;
  readonly errorName?: string;
  readonly latencyMs: number;
  readonly startedAt: string;
}

/** Subject + auth ports the tools call. */
export interface UserSubject {
  readonly userRid: string;
  readonly orgRid: string;
  readonly groups: readonly string[];
}

export interface AuthPort {
  /** B9 C-07: pre-validated against OMS canApplyAction BEFORE LLM is allowed to call. */
  canApplyAction(input: {
    userRid: string;
    actionTypeRid: string;
    branch: string;
  }): Promise<boolean>;

  /** Generic permission check for tools other than apply_action. */
  isAuthorized(input: {
    userRid: string;
    resourceRid: string;
    operation: string;
  }): Promise<boolean>;
}

export interface AipRequest {
  readonly analysisRid: string;
  readonly cardId?: string;
  readonly contextCardIds?: readonly string[];
  readonly conversationId?: string;
  readonly prompt: string;
  readonly userSubject: UserSubject;
  readonly branch: string;
  readonly remainingMs: number;
}

/** Mocked LLM port. Production swaps in tellus-aip-logic-service client. */
export interface AipPort {
  generate(req: AipRequest): AsyncIterable<AipEvent>;
  configure(req: AipRequest): AsyncIterable<AipEvent>;
  assist(req: AipRequest): AsyncIterable<AipEvent>;
}
