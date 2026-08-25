// ---------------------------------------------------------------------------
// verify-sse-streaming-server.ts — probe server for verify-sse-streaming.sh.
//
// Mounts TWO otherwise-identical SSE endpoints that drip N frames `delay`ms
// apart, the ONLY difference being the compression middleware:
//   /sse  → the REAL createCompressionMiddleware (excludes text/event-stream)
//   /broken → plain compression() (the original bug — gzips SSE → buffers)
// The bash script curl-probes both and asserts the fixed one streams
// (first byte early, frames drip) while the broken one buffers (first byte
// at the end). Uses the REAL middleware from src/middleware/compression.ts.
// ---------------------------------------------------------------------------

import express from "express";
import compression from "compression";
import { createCompressionMiddleware } from "../src/middleware/compression";

const PORT_FIXED = Number(process.argv[2] || 4101);
const PORT_BROKEN = Number(process.argv[3] || 4102);
const N = 5;
const DELAY_MS = 200;
const FRAME = `data: ${JSON.stringify({ type: "token", text: "step" })}\n\n`;

function sseHandler(_req: express.Request, res: express.Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  let i = 0;
  const tick = (): void => {
    if (i >= N) {
      res.end();
      return;
    }
    res.write(FRAME);
    const r = res as express.Response & { flush?: () => void };
    if (typeof r.flush === "function") r.flush();
    i += 1;
    setTimeout(tick, DELAY_MS);
  };
  setTimeout(tick, 0);
}

function buildApp(useReal: boolean): express.Express {
  const app = express();
  app.use(useReal ? createCompressionMiddleware() : compression());
  app.get("/health", (_req, res) => res.status(200).send("ok"));
  app.get("/sse", sseHandler);
  return app;
}

const fixed = buildApp(true).listen(PORT_FIXED, () => {
  // eslint-disable-next-line no-console
  console.log(`fixed  (real middleware) on :${PORT_FIXED}`);
});
const broken = buildApp(false).listen(PORT_BROKEN, () => {
  // eslint-disable-next-line no-console
  console.log(`broken (plain compression) on :${PORT_BROKEN}`);
});

process.on("SIGTERM", () => {
  fixed.close();
  broken.close();
  process.exit(0);
});
