// B9 — SSE writer / parser round-trip (B9 C-04 event taxonomy).

import { describe, it, expect } from "vitest";
import { parseSseBody, writeSse } from "../../../src/services/quiver/aip/sse";
import type { AipEvent } from "../../../src/services/quiver/aip/types";

class MockRes {
  buf = "";
  setHeader() {}
  flushHeaders() {}
  write(s: string) {
    this.buf += s;
    return true;
  }
  flush() {}
  end() {}
}

describe("B9 — SSE round-trip", () => {
  it("B9 C-04: every event taxonomy entry round-trips", () => {
    const res = new MockRes();
    const events: AipEvent[] = [
      { event: "tool_call", data: { tool: "object_query", input: { x: 1 } } },
      { event: "tool_result", data: { tool: "object_query", output: [] } },
      { event: "token", data: { delta: "hi" } },
      { event: "card_proposal", data: { card: { id: "c1" } } },
      {
        event: "config_patch",
        data: { jsonPatch: [{ op: "replace", path: "/x", value: 1 }] },
      },
      { event: "assistant_message", data: { content: "ok" } },
      { event: "done", data: { traceRid: "ri.trace.1" } },
      {
        event: "error",
        data: {
          errorCode: "PERMISSION_DENIED",
          errorName: "Tellus:Quiver:LlmToolUnauthorized",
          message: "denied",
        },
      },
    ];
    for (const ev of events) writeSse(res as never, ev);
    const parsed = parseSseBody(res.buf);
    expect(parsed.length).toBe(events.length);
    expect(parsed.map((p) => p.event)).toEqual(events.map((e) => e.event));
  });

  it("B9 C-04: data field is JSON-encoded; multiline payloads survive", () => {
    const res = new MockRes();
    const ev: AipEvent = {
      event: "token",
      data: { delta: "line\u00261\nline2" },
    };
    writeSse(res as never, ev);
    expect(res.buf).toContain("event: token\n");
    const parsed = parseSseBody(res.buf);
    expect(parsed.length).toBe(1);
    expect((parsed[0].data as { delta: string }).delta).toBe(
      "line\u00261\nline2",
    );
  });
});
