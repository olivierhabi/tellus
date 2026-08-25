// ---------------------------------------------------------------------------
// verify-codeassistant-streaming-server.ts
//
// Definitive real-code probe for the SSE-streaming fix. Mounts the REAL
// `createCompressionMiddleware` (the exact config server.ts uses) + the REAL
// `createCodeAssistantRouter` (the exact proxy route) on Express, with a STUB
// AI engine whose stream DRIPS the exact frame sequence a real agent emits
// (thinking → tool_call read_file → tool_result → tool_call run_function →
// tool_result → tokens → done), 200ms apart. The bash wrapper curl-probes it
// and asserts the frames reach the client one-by-one over time (STREAMED),
// not as one burst at the end (BUFFERED).
//
// This exercises 100% real tellus code for the SSE path (compression
// middleware + route + AiEngineClient interface) — only the upstream LLM is
// stubbed (it just drips frames, exactly as the real Gemini agent does).
// ---------------------------------------------------------------------------

import express, { type Request, type Response, type NextFunction } from "express";
import { createCompressionMiddleware } from "../src/middleware/compression";
import { createCodeAssistantRouter } from "../src/routes/codeAssistant";
import type { AiEnginePort, AiEnginePayload, AiEngineResult } from "../src/services/aiEngine/client";

const PORT = Number(process.argv[2] || 4103);
const DELAY_MS = 200;

const FRAME = (obj: Record<string, unknown>) => `data: ${JSON.stringify(obj)}\n\n`;

// The exact multi-step sequence a real agent streams (mirrors the user's
// orderInsights trace): thinking, read_file call+result, run_function
// call+result (truncated sample), the answer tokens, then done.
const FRAMES: string[] = [
  FRAME({ type: "thinking", text: "Reading orderInsights to improve it…" }),
  FRAME({ type: "tool_call", name: "read_file", id: "c1", args: { file_path: "orderInsights.ts" } }),
  FRAME({ type: "tool_result", name: "read_file", id: "c1", result: "export default function orderInsights() {…}" }),
  FRAME({ type: "tool_call", name: "run_function", id: "c2", args: { input_args: {} } }),
  FRAME({ type: "tool_result", name: "run_function", id: "c2", result: "status=ok result={…truncated…}" }),
  FRAME({ type: "token", text: "The " }),
  FRAME({ type: "token", text: "orderInsights " }),
  FRAME({ type: "token", text: "function " }),
  FRAME({ type: "token", text: "has been improved." }),
  FRAME({ type: "done", _metadata: { model: "gemini-3.1-flash-lite", mode: "modify" } }),
];

/** Stub engine: drips FRAMES DELAY_MS apart through a real ReadableStream. */
function drippingEngine(): AiEnginePort {
  const stream = (frames: string[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        let i = 0;
        const tick = (): void => {
          if (i >= frames.length) {
            controller.close();
            return;
          }
          controller.enqueue(enc.encode(frames[i]));
          i += 1;
          setTimeout(tick, DELAY_MS);
        };
        setTimeout(tick, 0);
      },
    });
  return {
    typescriptV2: async (): Promise<AiEngineResult> => {
      throw new Error("non-stream path should not be called");
    },
    typescriptV2Stream: async (): Promise<Response> =>
      new Response(stream(FRAMES), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }) as unknown as Response,
    getModels: async () => ({ models: [], default: "gemini-3.1-flash-lite" }),
    isReachable: async () => true,
  } as unknown as AiEnginePort;
}

const app = express();
app.use(createCompressionMiddleware()); // REAL server.ts config
app.use(express.json());
app.use(
  "/api/v1/code-assistant",
  createCodeAssistantRouter({
    client: drippingEngine(),
    // No-op auth (sets a principal) so the route runs without CODE_ASSISTANT_TEST_AUTH.
    auth: (req: Request, _res: Response, next: NextFunction) => {
      req.codeAssistantPrincipal = { userId: "probe", source: "test" };
      next();
    },
  }),
);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`codeassistant streaming probe on :${PORT} (real route + real compression middleware)`);
});
