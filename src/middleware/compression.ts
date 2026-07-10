// ---------------------------------------------------------------------------
// SSE-aware response compression.
//
// gzip/brotli is applied to compressible responses EXCEPT `text/event-stream`.
// zlib only flushes on res.flush()/res.end(), so compressing an SSE stream
// buffers every frame in the gzip pipe and bursts them out at the end — the
// "response comes at once, not streamed" bug that breaks the Code Assistant
// token/thinking/tool-step stream. SSE must pass through UNCOMPRESSED so each
// frame reaches the client as it is written.
//
// NB: the SSE routes also set `X-Accel-Buffering: no`, but that header only
// defeats *nginx* proxy buffering — it does NOTHING against this middleware,
// which sits inside the Node process. The filter below is the actual fix.
//
// Extracted from server.ts so the exclusion is unit-testable against the REAL
// middleware config (see tests/unit/middleware/compression-streaming-unit.test.ts).
// ---------------------------------------------------------------------------

import compression from "compression";

/**
 * Build the global compression middleware.
 *
 * `filter` returns false for `text/event-stream` (skip compression entirely)
 * and defers to `compression`'s default filter (Accept-Encoding + the
 * compressible content-type db) for everything else.
 */
export function createCompressionMiddleware() {
  return compression({
    filter: (req, res) => {
      const ct = String(res.getHeader("Content-Type") ?? "");
      if (ct.includes("text/event-stream")) return false;
      return compression.filter(req, res);
    },
  });
}
