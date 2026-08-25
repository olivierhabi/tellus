// ---------------------------------------------------------------------------
// AI Engine client — secure service-to-service caller for telos-AIE-agent.
//
// The tellus backend is the ONLY component allowed to talk to the AI engine.
// The frontend never sees this URL. This client is the outbound half of the
// Frontend -> Backend -> AI Engine flow for both the TypeScript Functions v2
// coding assistant and Workshop Vega chart generation.
//
// Pattern mirrors src/services/funnel/lakekeeperClient.ts: a thin fetch
// wrapper with an AbortController timeout, config-from-env, and typed errors
// (AppError) so the global errorHandler emits the spec error envelope.
// ---------------------------------------------------------------------------

import { AppError } from "../../utils/foundryAppError";

/** Payload the AI engine expects at /api/code-repositories-typescript-v2. */
export interface AiEnginePayload {
  message: string;
  model?: string;
  mode?: "generate" | "review" | "modify";
  context?: {
    repositoryRid?: string;
    branch?: string;
    filePath?: string;
    functionApiName?: string;
    fileContent?: string;
  };
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

/** Successful AI engine result. */
export interface AiEngineResult {
  response: string;
  _metadata?: Record<string, unknown>;
}

/** Payload accepted by telos-AIE-agent POST /api/vega-chart. */
export interface VegaChartAgentPayload {
  user_request: string;
  data_fields: string;
  current_json?: string;
  model?: string;
}

/** Raw result returned by telos-AIE-agent POST /api/vega-chart. */
export interface VegaChartAgentResult {
  response: unknown;
  _metadata?: Record<string, unknown>;
}

/** A model entry in the engine's SUPPORTED_MODELS catalog. */
export interface AiEngineModel {
  key: string;
  name: string;
  provider: string;
  reasoning_support: boolean;
}

/** Result of GET /api/models — the catalog + the engine's chosen default. */
export interface AiEngineModelsResult {
  models: AiEngineModel[];
  default: string;
}

/**
 * Payload the AI engine accepts at POST /api/code-repositories-python-transform.
 *
 * Same shape as AiEnginePayload (the engine's typescript-v2 path) so the FE
 * and the proxy wiring stay uniform; the path is the discriminator. Track 1
 * adds the python transform authoring/validating/executing entry — the agent
 * uses the same `message | model | mode | context | history | stream` surface
 * that the typescript-v2 agent uses, against the backend code-repository
 * transforms routes (test/preview/builds) plus the new AIE-side route.
 */
export interface AiEnginePayloadPython extends AiEnginePayload {
  /** Optional runtime hint so the agent can offer lightweight vs spark
   * guidance. Mirrors transform_build.runtime. */
  runtime?: "lightweight" | "spark";
}

/** Port the route depends on — injectable for tests. */
export interface AiEnginePort {
  typescriptV2(
    payload: AiEnginePayload,
    principalUserId?: string,
    signal?: AbortSignal,
  ): Promise<AiEngineResult>;
  typescriptV2Stream(
    payload: AiEnginePayload,
    principalUserId?: string,
    signal?: AbortSignal,
  ): Promise<Response>;
  /** Fetch the engine's supported-models catalog + its default (GET /api/models). */
  getModels(signal?: AbortSignal): Promise<AiEngineModelsResult>;
  vegaChart(
    payload: VegaChartAgentPayload,
    principalUserId?: string,
    signal?: AbortSignal,
  ): Promise<VegaChartAgentResult>;
  /** Python transform agent (Track 1). POST /api/code-repositories-python-transform. */
  pythonTransform(
    payload: AiEnginePayloadPython,
    principalUserId?: string,
    signal?: AbortSignal,
  ): Promise<AiEngineResult>;
  /** Streaming variant of pythonTransform — returns the engine SSE Response. */
  pythonTransformStream(
    payload: AiEnginePayloadPython,
    principalUserId?: string,
    signal?: AbortSignal,
  ): Promise<Response>;
  isReachable(): Promise<boolean>;
}

export interface AiEngineClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

export class AiEngineClient implements AiEnginePort {
  readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: AiEngineClientOptions = {}) {
    // TELOS_AIE_AGENT_URL is the AI engine origin (e.g. http://127.0.0.1:5000).
    // Trailing slashes are stripped so `${baseUrl}/api/...` is always clean.
    this.baseUrl = (
      opts.baseUrl ??
      process.env.TELOS_AIE_AGENT_URL ??
      "http://127.0.0.1:5000"
    ).replace(/\/+$/, "");
    // LLM calls are slow — give them a generous ceiling (default 2 min).
    this.timeoutMs =
      opts.timeoutMs ??
      Number(process.env.AI_ENGINE_TIMEOUT_MS ?? "120000");
  }

  async isReachable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Fetch the engine's supported-models catalog and its configured default
   * (GET /api/models). This is a fast catalog read — a 5s timeout, not the
   * 2-min LLM ceiling. Same error mapping as typescriptV2 (AI_ENGINE_TIMEOUT /
   * AI_ENGINE_UNAVAILABLE / AI_ENGINE_ERROR) so the frontend gets a consistent
   * envelope. No principal header — this is a read-only catalog lookup.
   */
  async getModels(signal?: AbortSignal): Promise<AiEngineModelsResult> {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 5_000);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/models`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          // Defense-in-depth: shared secret with the engine (optional).
          ...(process.env.TELOS_AIE_AGENT_TOKEN
            ? { "X-Tellus-Engine-Token": process.env.TELOS_AIE_AGENT_TOKEN }
            : {}),
        },
        // Combine the timeout controller with the caller's signal so a
        // cancelled FE request also aborts the catalog read.
        signal: AbortSignal.any(
          [ctrl.signal, signal].filter(Boolean) as AbortSignal[],
        ),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new AppError(
          "AI engine models request timed out",
          504,
          "AI_ENGINE_TIMEOUT",
        );
      }
      throw new AppError(
        `AI engine unreachable: ${
          err instanceof Error ? err.message : String(err)
        }`,
        502,
        "AI_ENGINE_UNAVAILABLE",
      );
    } finally {
      clearTimeout(tid);
    }

    if (!res.ok) {
      let engineError = "";
      try {
        const errBody = (await res.json()) as { error?: unknown } | null;
        if (errBody && typeof errBody.error === "string") {
          engineError = errBody.error;
        }
      } catch {
        // non-JSON / empty body — leave engineError empty
      }
      throw new AppError(
        engineError
          ? `AI engine error: ${engineError}`
          : `AI engine returned HTTP ${res.status}`,
        502,
        "AI_ENGINE_ERROR",
      );
    }

    const body = (await res.json()) as
      | AiEngineModelsResult
      | { error?: string };
    if (
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof (body as { error?: unknown }).error === "string"
    ) {
      throw new AppError(
        `AI engine error: ${(body as { error: string }).error}`,
        502,
        "AI_ENGINE_ERROR",
      );
    }
    return body as AiEngineModelsResult;
  }

  async typescriptV2(
    payload: AiEnginePayload,
    principalUserId?: string,
    signal?: AbortSignal,
  ): Promise<AiEngineResult> {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(
        `${this.baseUrl}/api/code-repositories-typescript-v2`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Forward the authenticated principal for traceability only —
            // the engine never makes authorization decisions on this.
            ...(principalUserId
              ? { "X-Tellus-Principal": principalUserId }
              : {}),
            // Defense-in-depth: shared secret with the engine (optional).
            ...(process.env.TELOS_AIE_AGENT_TOKEN
              ? { "X-Tellus-Engine-Token": process.env.TELOS_AIE_AGENT_TOKEN }
              : {}),
          },
          body: JSON.stringify(payload),
          // Combine the timeout controller with the caller's signal so a
          // cancelled FE request also aborts the (expensive) LLM call.
          signal: AbortSignal.any(
            [ctrl.signal, signal].filter(Boolean) as AbortSignal[],
          ),
        },
      );
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new AppError(
          "AI engine request timed out",
          504,
          "AI_ENGINE_TIMEOUT",
        );
      }
      throw new AppError(
        `AI engine unreachable: ${err instanceof Error ? err.message : String(err)
        }`,
        502,
        "AI_ENGINE_UNAVAILABLE",
      );
    } finally {
      clearTimeout(tid);
    }

    if (!res.ok) {
      // Try to extract the engine's own {error: "..."} message (the engine
      // returns this on agent/LLM failures, even at HTTP 502). Fall back to a
      // generic status message — never dump the raw body to the client. The
      // global errorHandler further sanitizes whatever message we throw.
      let engineError = "";
      try {
        const errBody = (await res.json()) as { error?: unknown } | null;
        if (errBody && typeof errBody.error === "string") {
          engineError = errBody.error;
        }
      } catch {
        // non-JSON / empty body — leave engineError empty
      }
      if (res.status === 400) {
        throw new AppError(
          "AI engine rejected the request",
          400,
          "AI_ENGINE_BAD_REQUEST",
        );
      }
      throw new AppError(
        engineError
          ? `AI engine error: ${engineError}`
          : `AI engine returned HTTP ${res.status}`,
        502,
        "AI_ENGINE_ERROR",
      );
    }

    const body = (await res.json()) as
      | AiEngineResult
      | { error?: string };
    // The engine returns { error, ... } when the agent itself failed (bad
    // model, upstream LLM error). Surface that as a 502 so the frontend
    // gets a consistent AI_ENGINE_ERROR envelope.
    if (
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof (body as { error?: unknown }).error === "string"
    ) {
      throw new AppError(
        `AI engine error: ${(body as { error: string }).error}`,
        502,
        "AI_ENGINE_ERROR",
      );
    }
    return body as AiEngineResult;
  }

  async vegaChart(
    payload: VegaChartAgentPayload,
    principalUserId?: string,
    signal?: AbortSignal,
  ): Promise<VegaChartAgentResult> {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/vega-chart`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(principalUserId
            ? { "X-Tellus-Principal": principalUserId }
            : {}),
          ...(process.env.TELOS_AIE_AGENT_TOKEN
            ? { "X-Tellus-Engine-Token": process.env.TELOS_AIE_AGENT_TOKEN }
            : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.any(
          [ctrl.signal, signal].filter(Boolean) as AbortSignal[],
        ),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new AppError(
          "AI engine Vega request timed out",
          504,
          "AI_ENGINE_TIMEOUT",
        );
      }
      throw new AppError(
        `AI engine unreachable: ${
          err instanceof Error ? err.message : String(err)
        }`,
        502,
        "AI_ENGINE_UNAVAILABLE",
      );
    } finally {
      clearTimeout(tid);
    }

    if (!res.ok) {
      let engineError = "";
      try {
        const errorBody = (await res.json()) as { error?: unknown } | null;
        if (errorBody && typeof errorBody.error === "string") {
          engineError = errorBody.error;
        }
      } catch {
        // Non-JSON engine error; use the status below.
      }
      if (res.status === 400) {
        throw new AppError(
          engineError || "AI engine rejected the Vega request",
          400,
          "AI_ENGINE_BAD_REQUEST",
        );
      }
      throw new AppError(
        engineError
          ? `AI engine error: ${engineError}`
          : `AI engine returned HTTP ${res.status}`,
        502,
        "AI_ENGINE_ERROR",
      );
    }

    const body = (await res.json()) as
      | VegaChartAgentResult
      | { error?: string };
    if (
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string"
    ) {
      throw new AppError(
        `AI engine error: ${body.error}`,
        502,
        "AI_ENGINE_ERROR",
      );
    }
    return body as VegaChartAgentResult;
  }

  /**
   * Streaming variant: POSTs with stream:true and returns the engine's SSE
   * Response (res.body is the token stream). The route pipes res.body through
   * to the frontend. Same timeout + error mapping as typescriptV2.
   */
  async typescriptV2Stream(
    payload: AiEnginePayload,
    principalUserId?: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(
        `${this.baseUrl}/api/code-repositories-typescript-v2`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...(principalUserId
              ? { "X-Tellus-Principal": principalUserId }
              : {}),
            ...(process.env.TELOS_AIE_AGENT_TOKEN
              ? { "X-Tellus-Engine-Token": process.env.TELOS_AIE_AGENT_TOKEN }
              : {}),
          },
          body: JSON.stringify({ ...payload, stream: true }),
          signal: AbortSignal.any(
            [ctrl.signal, signal].filter(Boolean) as AbortSignal[],
          ),
        },
      );
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError")
        throw new AppError(
          "AI engine stream timed out",
          504,
          "AI_ENGINE_TIMEOUT",
        );
      throw new AppError(
        `AI engine unreachable: ${err instanceof Error ? err.message : String(err)
        }`,
        502,
        "AI_ENGINE_UNAVAILABLE",
      );
    } finally {
      clearTimeout(tid);
    }
    if (!res.ok) {
      let engineError = "";
      try {
        const errBody = (await res.json()) as { error?: unknown } | null;
        if (errBody && typeof errBody.error === "string")
          engineError = errBody.error;
      } catch {
        // non-JSON / empty
      }
      if (res.status === 400)
        throw new AppError(
          "AI engine rejected the request",
          400,
          "AI_ENGINE_BAD_REQUEST",
        );
      throw new AppError(
        engineError
          ? `AI engine error: ${engineError}`
          : `AI engine returned HTTP ${res.status}`,
        502,
        "AI_ENGINE_ERROR",
      );
    }
    return res;
  }

  // --------------------------------------------------------------------------
  // Python transform agent (Track 1). Mirrors typescriptV2 / typescriptV2Stream
  // against POST /api/code-repositories-python-transform so the engine keeps a
  // uniform message-mode|stream contract; the AIE-side route picks the python
  // tool set. Same timeout (this.timeoutMs, default 2 min) and AppError mapping
  // (AI_ENGINE_TIMEOUT / AI_ENGINE_UNAVAILABLE / AI_ENGINE_BAD_REQUEST /
  // AI_ENGINE_ERROR) so the FE receives the same envelope shape as the TS v2
  // route — the python route is purely ADDITIVE (no-touch boundary: the
  // existing /typescript-v2 + /vega-chart routes are unchanged).
  // --------------------------------------------------------------------------
  async pythonTransform(
    payload: AiEnginePayloadPython,
    principalUserId?: string,
    signal?: AbortSignal,
  ): Promise<AiEngineResult> {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(
        `${this.baseUrl}/api/code-repositories-python-transform`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...(principalUserId
              ? { "X-Tellus-Principal": principalUserId }
              : {}),
            ...(process.env.TELOS_AIE_AGENT_TOKEN
              ? { "X-Tellus-Engine-Token": process.env.TELOS_AIE_AGENT_TOKEN }
              : {}),
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.any(
            [ctrl.signal, signal].filter(Boolean) as AbortSignal[],
          ),
        },
      );
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new AppError(
          "AI engine python-transform request timed out",
          504,
          "AI_ENGINE_TIMEOUT",
        );
      }
      throw new AppError(
        `AI engine unreachable: ${
          err instanceof Error ? err.message : String(err)
        }`,
        502,
        "AI_ENGINE_UNAVAILABLE",
      );
    } finally {
      clearTimeout(tid);
    }

    if (!res.ok) {
      let engineError = "";
      try {
        const errBody = (await res.json()) as { error?: unknown } | null;
        if (errBody && typeof errBody.error === "string") {
          engineError = errBody.error;
        }
      } catch {
        // non-JSON / empty body — leave engineError empty
      }
      if (res.status === 400) {
        throw new AppError(
          "AI engine rejected the python-transform request",
          400,
          "AI_ENGINE_BAD_REQUEST",
        );
      }
      throw new AppError(
        engineError
          ? `AI engine error: ${engineError}`
          : `AI engine returned HTTP ${res.status}`,
        502,
        "AI_ENGINE_ERROR",
      );
    }

    const body = (await res.json()) as AiEngineResult | { error?: string };
    if (
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof (body as { error?: unknown }).error === "string"
    ) {
      throw new AppError(
        `AI engine error: ${(body as { error: string }).error}`,
        502,
        "AI_ENGINE_ERROR",
      );
    }
    return body as AiEngineResult;
  }

  async pythonTransformStream(
    payload: AiEnginePayloadPython,
    principalUserId?: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(
        `${this.baseUrl}/api/code-repositories-python-transform`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...(principalUserId
              ? { "X-Tellus-Principal": principalUserId }
              : {}),
            ...(process.env.TELOS_AIE_AGENT_TOKEN
              ? { "X-Tellus-Engine-Token": process.env.TELOS_AIE_AGENT_TOKEN }
              : {}),
          },
          body: JSON.stringify({ ...payload, stream: true }),
          signal: AbortSignal.any(
            [ctrl.signal, signal].filter(Boolean) as AbortSignal[],
          ),
        },
      );
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError")
        throw new AppError(
          "AI engine python-transform stream timed out",
          504,
          "AI_ENGINE_TIMEOUT",
        );
      throw new AppError(
        `AI engine unreachable: ${
          err instanceof Error ? err.message : String(err)
        }`,
        502,
        "AI_ENGINE_UNAVAILABLE",
      );
    } finally {
      clearTimeout(tid);
    }
    if (!res.ok) {
      let engineError = "";
      try {
        const errBody = (await res.json()) as { error?: unknown } | null;
        if (errBody && typeof errBody.error === "string")
          engineError = errBody.error;
      } catch {
        // non-JSON / empty
      }
      if (res.status === 400)
        throw new AppError(
          "AI engine rejected the python-transform request",
          400,
          "AI_ENGINE_BAD_REQUEST",
        );
      throw new AppError(
        engineError
          ? `AI engine error: ${engineError}`
          : `AI engine returned HTTP ${res.status}`,
        502,
        "AI_ENGINE_ERROR",
      );
    }
    return res;
  }
}

/** Default singleton used in production. */
export const aiEngineClient = new AiEngineClient();

// Test seam — inject a fake client (mirrors setTrinoEngineForTests).
let _override: AiEnginePort | null = null;
export function setAiEngineClientForTests(client: AiEnginePort | null): void {
  _override = client;
}
export function getAiEngineClient(): AiEnginePort {
  return _override ?? aiEngineClient;
}
