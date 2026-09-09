// ---------------------------------------------------------------------------
// Unit tests for the extracted drafts / chat-sessions routers
// (src/services/codeRepository/admin/routers/).
//
// Registration is asserted structurally: each sub-router must expose exactly
// the routes it owned in admin/routes.ts. Wire behaviour is covered by the
// code-repos integration suites.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type { Router } from "express";
import { createDraftsRouter } from "../../../src/services/codeRepository/admin/routers/draftsRouter";
import { createChatSessionsRouter } from "../../../src/services/codeRepository/admin/routers/chatSessionsRouter";
import { createRouteContext } from "../../../src/services/codeRepository/admin/routeContext";

function stubCtx() {
  return createRouteContext({
    pool: {} as never,
    compass: {} as never,
    stemma: {} as never,
    template: {} as never,
  });
}

function routesOf(router: Router): Array<{ method: string; path: string }> {
  const stack = (router as unknown as { stack: Array<{
    route?: { path: string; methods: Record<string, boolean> };
  }> }).stack;
  return stack
    .filter((l) => l.route)
    .map((l) => ({
      method: Object.keys(l.route!.methods).filter((m) => m !== "_all")[0] ?? "?",
      path: String(l.route!.path),
    }));
}

describe("draftsRouter — registration", () => {
  it("exposes the three drafts routes", () => {
    expect(routesOf(createDraftsRouter(stubCtx()))).toEqual([
      { method: "get", path: "/:rid/branches/:branch/drafts" },
      { method: "put", path: "/:rid/branches/:branch/drafts" },
      { method: "delete", path: "/:rid/branches/:branch/drafts" },
    ]);
  });
});

describe("chatSessionsRouter — registration", () => {
  it("exposes the five chat-session routes", () => {
    expect(routesOf(createChatSessionsRouter(stubCtx()))).toEqual([
      { method: "get", path: "/:rid/chat-sessions" },
      { method: "post", path: "/:rid/chat-sessions" },
      { method: "get", path: "/:rid/chat-sessions/:sessionId" },
      { method: "put", path: "/:rid/chat-sessions/:sessionId" },
      { method: "delete", path: "/:rid/chat-sessions/:sessionId" },
    ]);
  });
});
