// Quiver B9 — SSE writer.
// text/event-stream encoder; flushes per event; safe newline encoding.

import type { Response } from "express";
import type { AipEvent } from "./types.js";

export function startSse(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // Disable proxy buffering when behind nginx.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
}

export function writeSse(res: Response, ev: AipEvent): void {
  // Each SSE message: "event: <name>\ndata: <json>\n\n"
  const json = JSON.stringify(ev.data);
  res.write(`event: ${ev.event}\n`);
  res.write(`data: ${json}\n\n`);
  // Express adds a flush when the chunk is large enough; nudge it:
  (res as unknown as { flush?: () => void }).flush?.();
}

export function endSse(res: Response): void {
  res.end();
}

/**
 * Parse an SSE stream body into events. Test helper used by integration tests.
 */
export function parseSseBody(body: string): AipEvent[] {
  const out: AipEvent[] = [];
  for (const block of body.split(/\n\n+/)) {
    const lines = block.split("\n");
    let event: string | undefined;
    let data: string | undefined;
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data = line.slice(5).trim();
    }
    if (event && data !== undefined) {
      try {
        out.push({ event, data: JSON.parse(data) } as AipEvent);
      } catch {
        // skip malformed
      }
    }
  }
  return out;
}
