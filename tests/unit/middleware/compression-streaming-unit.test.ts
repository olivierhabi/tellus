// ---------------------------------------------------------------------------
// Regression test for the "response comes at once" SSE-buffering bug.
//
// ROOT CAUSE: the global `compression()` middleware gzips `text/event-stream`,
// and zlib only flushes on res.flush()/res.end() — so every SSE frame is
// buffered in the gzip pipe and bursts out at the END. The Code Assistant
// stream (thinking → tool_call → tool_result → tokens → done) must reach the
// client frame-by-frame; `X-Accel-Buffering: no` (set by the route) only
// defeats *nginx*, not this in-process middleware.
//
// This test mounts the REAL `createCompressionMiddleware` (the exact config
// server.ts uses) + the REAL codeAssistant route, with a fake engine that
// DRIPS frames 120ms apart. It then reads the response over a real HTTP
// socket + fetch and asserts:
//   1. frames arrive incrementally (≥3 chunks spread over time, not 1 burst)
//   2. the SSE response is NOT gzip-compressed (Content-Encoding absent)
//   3. a plain JSON response IS still gzip-compressed (compression not
//      disabled globally — only SSE is excluded)
//
// Run:  pnpm vitest run --config vitest.unit.config.ts
//       tests/unit/middleware/compression-streaming-unit.test.ts
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { Server } from "http";
import { createCodeAssistantRouter } from "../../../src/routes/codeAssistant";
import { createCompressionMiddleware } from "../../../src/middleware/compression";
import type {
  AiEnginePort,
  AiEngineResult,
} from "../../../src/services/aiEngine/client";

/** A fake engine whose stream DRIPS frames `delayMs` apart (time-spread). */
function drippingStreamEngine(frames: string[], delayMs: number): AiEnginePort {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      let i = 0;
      const tick = () => {
        if (i >= frames.length) {
          controller.close();
          return;
        }
        controller.enqueue(enc.encode(frames[i]));
        i += 1;
        setTimeout(tick, delayMs);
      };
      setTimeout(tick, 0);
    },
  });
  return {
    typescriptV2: vi.fn(async () => {
      throw new Error("non-stream path should not be called");
    }),
    typescriptV2Stream: vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
    ),
    getModels: vi.fn(async () => ({
      models: [],
      default: "gemini-2.5-flash",
    })),
    isReachable: vi.fn(async () => true),
  } as unknown as AiEnginePort & { typescriptV2(): Promise<AiEngineResult> };
}

/** Build the app with the REAL compression middleware + REAL route. */
function buildApp(client: AiEnginePort): express.Express {
  const app = express();
  app.use(createCompressionMiddleware()); // the exact config server.ts mounts
  app.use(express.json());
  // Control endpoint: a plain JSON response (must still be gzip-compressed).
  app.get("/control/json", (_req: Request, res: Response) => {
    res.json({ hello: "world", pad: "x".repeat(2048) });
  });
  app.use(
    "/api/v1/code-assistant",
    createCodeAssistantRouter({
      client,
      auth: (req: Request, _res: Response, next: NextFunction) => {
        req.codeAssistantPrincipal = { userId: "alice", source: "test" };
        next();
      },
    }),
  );
  return app;
}

function listen(app: express.Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

function close(server: Server | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((r) => server.close(() => r()));
}

describe("compression does not buffer SSE (the 'comes at once' regression)", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await close(server);
    server = undefined;
  });

  it("delivers SSE frames incrementally over time, not as one burst at the end", async () => {
    const frames = [
      `data: ${JSON.stringify({ type: "thinking", text: "reasoning…" })}\n\n`,
      `data: ${JSON.stringify({ type: "tool_call", name: "read_file" })}\n\n`,
      `data: ${JSON.stringify({ type: "tool_result", name: "read_file" })}\n\n`,
      `data: ${JSON.stringify({ type: "token", text: "Hello" })}\n\n`,
      `data: ${JSON.stringify({ type: "done" })}\n\n`,
    ];
    const app = buildApp(drippingStreamEngine(frames, 120));
    const handle = await listen(app);
    server = handle.server;
    const { port } = handle;

    const t0 = Date.now();
    const res = await fetch(
      `http://localhost:${port}/api/v1/code-assistant/typescript-v2`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          // Browsers send this on every request, including SSE — it's what
          // triggers compression to gzip the stream in the first place.
          "Accept-Encoding": "gzip",
        },
        body: JSON.stringify({ message: "hi", stream: true }),
      },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    // (2) SSE must NOT be gzip-compressed — the filter excluded it. If this
    // fails, compression is buffering the stream (the bug).
    expect(res.headers.get("content-encoding") ?? "").not.toMatch(/gzip/);

    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const arrivals: number[] = [];
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      arrivals.push(Date.now() - t0);
      text += dec.decode(value, { stream: true });
    }

    // (1) Streaming: multiple chunks arrive SPREAD over time. If compression
    // buffered, all frames collapse into ONE chunk at the end (arrivals.length
    // ≈ 1, first ≈ last). Require ≥3 chunks and a real time spread.
    expect(arrivals.length).toBeGreaterThanOrEqual(3);
    const first = arrivals[0];
    const last = arrivals[arrivals.length - 1];
    expect(first).toBeLessThan(last - 100); // spread, not a single burst

    // The pipe is intact — every frame type made it through.
    expect(text).toContain('"type":"thinking"');
    expect(text).toContain('"type":"tool_call"');
    expect(text).toContain('"type":"tool_result"');
    expect(text).toContain('"type":"token"');
    expect(text).toContain('"type":"done"');
  }, 10_000);

  it("still gzip-compresses non-SSE responses (compression not disabled globally)", async () => {
    const app = buildApp(drippingStreamEngine([], 10));
    const handle = await listen(app);
    server = handle.server;
    const { port } = handle;

    const res = await fetch(`http://localhost:${port}/control/json`, {
      headers: { "Accept-Encoding": "gzip" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    // (3) JSON IS compressed — the SSE exclusion didn't turn compression off.
    expect(res.headers.get("content-encoding") ?? "").toMatch(/gzip/);
  });
});
