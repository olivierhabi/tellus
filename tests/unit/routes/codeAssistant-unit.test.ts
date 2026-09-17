// ---------------------------------------------------------------------------
// Unit tests for the Code Assistant proxy route + AI engine client.
//
// Run:  npx vitest run tests/unit/routes/codeAssistant-unit.test.ts
//
// The route is tested with a fake AiEnginePort (no real HTTP) and a no-op
// auth middleware, so the suite needs no DB / Keycloak / tellusAuth. The
// client's fetch-based error mapping is tested by stubbing global.fetch.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import {
  createCodeAssistantRouter,
  requireCodeAssistantAuth,
} from "../../../src/routes/codeAssistant";
import {
  AiEngineClient,
  type AiEnginePort,
  type AiEnginePayload,
  type AiEngineResult,
  type VegaChartAgentPayload,
} from "../../../src/services/aiEngine/client";
import { AppError } from "../../../src/utils/foundryAppError";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeFakeEngine(): {
  port: AiEnginePort;
  calls: Array<{ payload: AiEnginePayload; principalUserId?: string }>;
  vegaCalls: Array<{
    payload: VegaChartAgentPayload;
    principalUserId?: string;
  }>;
} {
  const calls: Array<{ payload: AiEnginePayload; principalUserId?: string }> = [];
  const vegaCalls: Array<{
    payload: VegaChartAgentPayload;
    principalUserId?: string;
  }> = [];
  const port: AiEnginePort = {
    typescriptV2: vi.fn(async (payload, principalUserId) => {
      calls.push({ payload, principalUserId });
      return {
        response: "ok",
        _metadata: { mode: payload.mode ?? "generate" },
      } as AiEngineResult;
    }),
    typescriptV2Stream: vi.fn(async () => {
      throw new Error("stream not supported by the non-streaming fake");
    }),
    vegaChart: vi.fn(async (payload, principalUserId) => {
      vegaCalls.push({ payload, principalUserId });
      return {
        response: {
          data: { name: "objects", values: [{ state: "Open" }] },
          mark: "bar",
          encoding: {
            x: { field: "state_bucket", type: "nominal" },
            y: { field: "order_count", type: "quantitative" },
          },
          _metadata: { model: "fake-vega" },
        },
      };
    }),
    getModels: vi.fn(async () => ({
      models: [
        {
          key: "gemini-2.5-flash",
          name: "gemini-2.5-flash",
          provider: "google",
          reasoning_support: false,
        },
      ],
      default: "gemini-2.5-flash",
    })),
    isReachable: vi.fn(async () => true),
  };
  return { port, calls, vegaCalls };
}

/** A fake engine whose typescriptV2Stream returns a ReadableStream of SSE frames. */
function fakeStreamEngine(frames: string[]): AiEnginePort {
  const body = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return {
    typescriptV2: vi.fn(async () => {
      throw new Error("non-stream path should not be called");
    }),
    typescriptV2Stream: vi.fn(async () =>
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    ),
    vegaChart: vi.fn(async () => ({ response: { mark: "bar" } })),
    getModels: vi.fn(async () => ({
      models: [
        {
          key: "gemini-2.5-flash",
          name: "gemini-2.5-flash",
          provider: "google",
          reasoning_support: false,
        },
      ],
      default: "gemini-2.5-flash",
    })),
    isReachable: vi.fn(async () => true),
  };
}

function buildApp(client: AiEnginePort): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/v1/code-assistant",
    createCodeAssistantRouter({
      client,
      // No-op auth that still sets a principal, so we can assert forwarding.
      auth: (req: Request, _res: Response, next: NextFunction) => {
        req.codeAssistantPrincipal = { userId: "alice", source: "test" };
        next();
      },
    }),
  );
  // Minimal error handler mirroring the global one (AppError → envelope).
  app.use(
    (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const e = err as AppError & { statusCode?: number; code?: string };
      const status = e?.statusCode ?? 500;
      const code = e?.code ?? "INTERNAL_ERROR";
      res.status(status).json({
        errorCode: code,
        errorName: code,
        message: e?.message ?? "error",
        statusCode: status,
      });
    },
  );
  return app;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

describe("createCodeAssistantRouter", () => {
  it("200 + {success, data} on success and forwards the principal", async () => {
    const { port, calls } = makeFakeEngine();
    const res = await request(buildApp(port))
      .post("/api/v1/code-assistant/typescript-v2")
      .send({ message: "hi", mode: "review", context: { filePath: "src/f.ts" } });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.response).toBe("ok");
    expect(res.body.data._metadata.mode).toBe("review");
    expect(calls[0].principalUserId).toBe("alice");
    expect(calls[0].payload.context?.filePath).toBe("src/f.ts");
  });

  it("400 AI_ENGINE_BAD_REQUEST on missing message", async () => {
    const { port } = makeFakeEngine();
    const res = await request(buildApp(port))
      .post("/api/v1/code-assistant/typescript-v2")
      .send({ mode: "generate" });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe("AI_ENGINE_BAD_REQUEST");
  });

  it("400 on invalid mode", async () => {
    const { port } = makeFakeEngine();
    const res = await request(buildApp(port))
      .post("/api/v1/code-assistant/typescript-v2")
      .send({ message: "hi", mode: "explode" });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe("AI_ENGINE_BAD_REQUEST");
  });

  it("defaults mode to generate", async () => {
    const { port, calls } = makeFakeEngine();
    await request(buildApp(port))
      .post("/api/v1/code-assistant/typescript-v2")
      .send({ message: "hi" });
    expect(calls[0].payload.mode).toBe("generate");
  });

  it("POST /vega-chart forwards Workshop context through the AI engine port", async () => {
    const { port, vegaCalls } = makeFakeEngine();
    const res = await request(buildApp(port))
      .post("/api/v1/code-assistant/vega-chart")
      .send({
        prompt: "horizontal bars sorted descending",
        objectTypeApiName: "Order",
        dataName: "order_metrics",
        dataInputs: [
          { name: "order_metrics", dataSource: "aggregation" },
        ],
        groupByProperties: [
          {
            id: "state",
            identifier: "state_bucket",
            propertyApiName: "status",
          },
        ],
        dataSource: "aggregation",
        aggregation: "count",
        aggregationName: "order_count",
        currentSpec: '{"mark":"point"}',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(vegaCalls[0].principalUserId).toBe("alice");
    expect(vegaCalls[0].payload.user_request).toContain(
      'named data input "order_metrics"',
    );
    expect(vegaCalls[0].payload.user_request).toContain(
      'output field "state_bucket" from property "status"',
    );
    expect(vegaCalls[0].payload.data_fields).toContain(
      "Object properties available for configuring aggregation",
    );
    expect(vegaCalls[0].payload.current_json).toEqual({ mark: "point" });
    const spec = JSON.parse(res.body.data.spec);
    expect(spec.data).toEqual({ name: "order_metrics" });
    expect(spec).not.toHaveProperty("_metadata");
    expect(res.body.data._metadata.model).toBe("fake-vega");
  });

  it("POST /vega-chart describes geoshape properties as GeoJSON", async () => {
    const { port, vegaCalls } = makeFakeEngine();
    const res = await request(buildApp(port))
      .post("/api/v1/code-assistant/vega-chart")
      .send({
        prompt: "population choropleth",
        objectTypeApiName: "District",
        dataName: "districts",
        dataSource: "object-set",
        properties: [
          { apiName: "district", baseType: "string" },
          { apiName: "boundary", baseType: "geoshape" },
          { apiName: "population", baseType: "long" },
        ],
      });

    expect(res.status).toBe(200);
    expect(vegaCalls[0].payload.data_fields).toContain("boundary (geojson)");
  });

  it("POST /vega-chart rejects an empty Data Input Name", async () => {
    const { port } = makeFakeEngine();
    const res = await request(buildApp(port))
      .post("/api/v1/code-assistant/vega-chart")
      .send({ prompt: "bar chart", dataName: "" });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe("AI_ENGINE_BAD_REQUEST");
  });

  it("POST /vega-chart accepts a full core-Vega current specification", async () => {
    const { port, vegaCalls } = makeFakeEngine();
    const app = buildApp(port);
    const currentSpec = JSON.stringify({
      $schema: "https://vega.github.io/schema/vega/v6.json",
      signals: Array.from({ length: 500 }, (_, index) => ({
        name: `layoutSignal${index}`,
        update: "datum.value == null ? [] : pluck(data('labels'), 'shift')",
      })),
      data: [{ name: "status" }, { name: "table", source: "status" }],
      marks: [{ type: "arc", from: { data: "table" } }],
    });
    expect(currentSpec.length).toBeGreaterThan(10_000);

    const response = await request(app)
      .post("/api/v1/code-assistant/vega-chart")
      .send({
        prompt: "Create Donut Labelled",
        dataName: "status",
        currentSpec,
      });

    expect(response.status).toBe(200);
    expect(vegaCalls).toHaveLength(1);
    expect(vegaCalls[0].payload.current_json).toEqual(JSON.parse(currentSpec));
  });

  it("propagates AppError from the client as the engine error code", async () => {
    const port: AiEnginePort = {
      typescriptV2: vi.fn(async () => {
        throw new AppError("AI engine error: boom", 502, "AI_ENGINE_ERROR");
      }),
      isReachable: vi.fn(async () => true),
    };
    const res = await request(buildApp(port))
      .post("/api/v1/code-assistant/typescript-v2")
      .send({ message: "hi" });
    expect(res.status).toBe(502);
    expect(res.body.errorCode).toBe("AI_ENGINE_ERROR");
  });

  it("forwards multi-turn history", async () => {
    const { port, calls } = makeFakeEngine();
    await request(buildApp(port))
      .post("/api/v1/code-assistant/typescript-v2")
      .send({
        message: "now refactor it",
        history: [
          { role: "user", content: "make a fn" },
          { role: "assistant", content: "ok" },
        ],
      });
    expect(calls[0].payload.history).toHaveLength(2);
  });

  it("pipes the engine SSE stream through to the client (stream:true)", async () => {
    const frames = [
      `data: ${JSON.stringify({ type: "token", text: "Hello" })}\n\n`,
      `data: ${JSON.stringify({ type: "token", text: " world" })}\n\n`,
      `data: ${JSON.stringify({ type: "done", _metadata: { mode: "generate" } })}\n\n`,
    ];
    const res = await request(buildApp(fakeStreamEngine(frames)))
      .post("/api/v1/code-assistant/typescript-v2")
      .send({ message: "hi", stream: true });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.text).toContain('"type":"token"');
    expect(res.text).toContain('"type":"done"');
    expect(res.text).toContain("Hello");
    expect(res.text).toContain("world");
  });

  it("GET /models proxies the engine catalog + default as {success, data}", async () => {
    const { port } = makeFakeEngine();
    const res = await request(buildApp(port)).get(
      "/api/v1/code-assistant/models",
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.default).toBe("gemini-2.5-flash");
    expect(res.body.data.models[0].key).toBe("gemini-2.5-flash");
    expect(vi.mocked(port.getModels)).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Client error mapping (global.fetch stubbed)
// ---------------------------------------------------------------------------

describe("AiEngineClient error mapping", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch as unknown as typeof global.fetch;
  });

  function stubFetch(response: {
    ok: boolean;
    status: number;
    json?: unknown;
    text?: string;
  }): void {
    global.fetch = vi.fn(async () => {
      return {
        ok: response.ok,
        status: response.status,
        json: async () => response.json,
        text: async () => response.text ?? "",
      } as unknown as Response;
    }) as unknown as typeof global.fetch;
  }

  it("returns result on 200 with {response}", async () => {
    stubFetch({ ok: true, status: 200, json: { response: "hi", _metadata: {} } });
    const c = new AiEngineClient({ baseUrl: "http://engine", timeoutMs: 1000 });
    const out = await c.typescriptV2({ message: "hi" });
    expect(out.response).toBe("hi");
  });

  it("getModels returns the catalog + default on 200", async () => {
    stubFetch({
      ok: true,
      status: 200,
      json: {
        models: [
          {
            key: "glm-5",
            name: "GLM-5",
            provider: "zai",
            reasoning_support: false,
          },
        ],
        default: "glm-5",
      },
    });
    const c = new AiEngineClient({ baseUrl: "http://engine", timeoutMs: 1000 });
    const out = await c.getModels();
    expect(out.default).toBe("glm-5");
    expect(out.models[0].key).toBe("glm-5");
  });

  it("vegaChart calls the engine's /api/vega-chart route", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({ response: { mark: "bar" } }),
      } as unknown as Response;
    }) as unknown as typeof global.fetch;
    const client = new AiEngineClient({
      baseUrl: "http://engine:5000",
      timeoutMs: 1000,
    });
    await client.vegaChart(
      {
        user_request: "bar chart",
        data_fields: "state_bucket (nominal)",
      },
      "alice",
    );
    expect(capturedUrl).toBe("http://engine:5000/api/vega-chart");
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      user_request: "bar chart",
      data_fields: "state_bucket (nominal)",
    });
    expect(
      (capturedInit?.headers as Record<string, string>)["X-Tellus-Principal"],
    ).toBe("alice");
  });

  it("getModels maps a 502 {error} to AI_ENGINE_ERROR", async () => {
    stubFetch({ ok: false, status: 502, json: { error: "catalog unavailable" } });
    const c = new AiEngineClient({ baseUrl: "http://engine", timeoutMs: 1000 });
    await expect(c.getModels()).rejects.toMatchObject({
      code: "AI_ENGINE_ERROR",
    });
  });

  it("throws AI_ENGINE_ERROR when engine returns {error}", async () => {
    stubFetch({ ok: true, status: 200, json: { error: "boom" } });
    const c = new AiEngineClient({ baseUrl: "http://engine", timeoutMs: 1000 });
    await expect(c.typescriptV2({ message: "hi" })).rejects.toMatchObject({
      code: "AI_ENGINE_ERROR",
    });
  });

  it("throws AI_ENGINE_BAD_REQUEST on 400", async () => {
    stubFetch({ ok: false, status: 400, json: { error: "bad" } });
    const c = new AiEngineClient({ baseUrl: "http://engine", timeoutMs: 1000 });
    await expect(c.typescriptV2({ message: "hi" })).rejects.toMatchObject({
      code: "AI_ENGINE_BAD_REQUEST",
    });
  });

  it("throws AI_ENGINE_UNAVAILABLE on network error", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof global.fetch;
    const c = new AiEngineClient({ baseUrl: "http://engine", timeoutMs: 1000 });
    await expect(c.typescriptV2({ message: "hi" })).rejects.toMatchObject({
      code: "AI_ENGINE_UNAVAILABLE",
    });
  });

  it("throws AI_ENGINE_TIMEOUT on abort", async () => {
    global.fetch = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          const e = new Error("aborted");
          e.name = "AbortError";
          signal.addEventListener("abort", () => reject(e));
        }
      });
    }) as unknown as typeof global.fetch;
    const c = new AiEngineClient({ baseUrl: "http://engine", timeoutMs: 10 });
    await expect(c.typescriptV2({ message: "hi" })).rejects.toMatchObject({
      code: "AI_ENGINE_TIMEOUT",
    });
  });

  it("sends X-Tellus-Principal header when principalUserId is given", async () => {
    let captured: RequestInit | undefined;
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      captured = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({ response: "hi" }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof global.fetch;
    const c = new AiEngineClient({ baseUrl: "http://engine", timeoutMs: 1000 });
    await c.typescriptV2({ message: "hi" }, "user-42");
    expect(
      (captured!.headers as Record<string, string>)["X-Tellus-Principal"],
    ).toBe("user-42");
  });

  it("forwards a caller AbortSignal so an FE cancel aborts the engine call", async () => {
    global.fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const sig = init?.signal;
          if (sig) {
            const e = new Error("aborted");
            e.name = "AbortError";
            sig.addEventListener("abort", () => reject(e));
          }
        }),
    ) as unknown as typeof global.fetch;
    const c = new AiEngineClient({ baseUrl: "http://engine", timeoutMs: 30000 });
    const ctl = new AbortController();
    const p = c.typescriptV2({ message: "hi" }, undefined, ctl.signal);
    ctl.abort();
    await expect(p).rejects.toMatchObject({ code: "AI_ENGINE_TIMEOUT" });
  });

  it("maps a 5xx with {error} to AI_ENGINE_ERROR without a raw body dump", async () => {
    stubFetch({ ok: false, status: 502, json: { error: "upstream LLM down" } });
    const c = new AiEngineClient({ baseUrl: "http://engine", timeoutMs: 1000 });
    let caught: unknown;
    try {
      await c.typescriptV2({ message: "hi" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ code: "AI_ENGINE_ERROR" });
    expect((caught as Error).message).to.contain("upstream LLM down");
    expect((caught as Error).message).to.not.contain('{"error"');
  });
});

describe("requireCodeAssistantAuth (test-mode bypass)", () => {
  const TOKEN = "code-assistant-lane-token-0123456789abcdef0123456789abcdef";

  it("honours X-Tellus-Test-Principal when CODE_ASSISTANT_TEST_AUTH=1", () => {
    process.env.CODE_ASSISTANT_TEST_AUTH = "1";
    process.env.CODE_REPOS_TEST_AUTH_TOKEN = TOKEN;
    process.env.NODE_ENV = "test";
    const req = {
      header: (h: string) =>
        h === "X-Tellus-Test-Principal"
          ? "alice/editor"
          : h === "X-Tellus-Test-Auth-Token"
            ? TOKEN
            : undefined,
    } as unknown as Request;
    const res = {} as Response;
    let nextCalled = false;
    requireCodeAssistantAuth()(req as Request, res as Response, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(req.codeAssistantPrincipal?.userId).toBe("alice");
    expect(req.codeAssistantPrincipal?.source).toBe("test");
    delete process.env.CODE_ASSISTANT_TEST_AUTH;
    delete process.env.CODE_REPOS_TEST_AUTH_TOKEN;
  });

  it("401s when the principal header is presented without the harness token", () => {
    process.env.CODE_ASSISTANT_TEST_AUTH = "1";
    process.env.CODE_REPOS_TEST_AUTH_TOKEN = TOKEN;
    process.env.NODE_ENV = "test";
    const req = {
      header: (h: string) =>
        h === "X-Tellus-Test-Principal" ? "alice/editor" : undefined,
    } as unknown as Request;
    const res = {
      status: () => ({ json: () => undefined }),
    } as unknown as Response;
    let nextCalled = false;
    requireCodeAssistantAuth()(req as Request, res as Response, () => {
      nextCalled = true;
    });
    // Token-bound: an untokened principal header must NOT bind an identity.
    expect(nextCalled).toBe(false);
    delete process.env.CODE_ASSISTANT_TEST_AUTH;
    delete process.env.CODE_REPOS_TEST_AUTH_TOKEN;
  });

  it("is fail-closed when NODE_ENV is unset (bypass NOT active)", () => {
    process.env.CODE_ASSISTANT_TEST_AUTH = "1";
    const savedEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      const req = {
        header: () => "alice/editor",
      } as unknown as Request;
      const res = {
        status: () => ({ json: () => undefined }),
      } as unknown as Response;
      let nextCalled = false;
      requireCodeAssistantAuth()(req as Request, res as Response, () => {
        nextCalled = true;
      });
      // NODE_ENV unset => the bypass is inactive => next() is not called.
      expect(nextCalled).toBe(false);
    } finally {
      process.env.NODE_ENV = savedEnv;
    }
  });
});
