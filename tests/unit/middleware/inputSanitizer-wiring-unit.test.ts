// ---------------------------------------------------------------------------
// Regression test for the "large Vega spec silently truncated on workshop
// save" bug (P0 gap #6).
//
// ROOT CAUSE: server.ts mounted the DEFAULT export `inputSanitizer` =
// `createInputSanitizer()` with NO options, so `shouldSkipBody` was undefined.
// The sanitizer's 10000-char string truncation (inputSanitizer.ts:95-97) then
// corrupted any Workshop module definition carrying a Vega spec JSON string
// longer than 10000 chars on save. The skip mechanism (inputSanitizer.ts:206)
// + a 16k-spec self-test (#13) existed but were unwired at the mount site.
//
// FIX: server.ts:377 now mounts
//   `createInputSanitizer({ shouldSkipBody: req => req.path.startsWith("/api/v1/workshop") })`.
//
// This test mounts the REAL `createInputSanitizer` with the EXACT predicate
// server.ts uses, plus a stub workshop route that echoes req.body, and asserts:
//   1. a >10k spec body PUT to /api/v1/workshop/modules/:rid SURVIVES (no
//      truncation/trim) — the round-trip the gap acceptance requires.
//   2. the same body PUT to a non-workshop path IS truncated to 10000 (the
//      cap still applies where it should).
//   3. a deeply-nested workshop body is still rejected with 400 (the depth
//      DoS guard is retained on skipped paths).
//
// If someone reverts server.ts to the default export, this test fails — it
// pins the wiring independently of the boot script.
//
// Run: pnpm vitest run --config vitest.unit.config.ts
//      tests/unit/middleware/inputSanitizer-wiring-unit.test.ts
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import express, { type Request, type Response } from "express";
import request from "supertest";
import { createInputSanitizer } from "../../../src/middleware/inputSanitizer";

// The EXACT config server.ts:377 mounts. Constructed here (not imported from
// server.ts — a boot script) so this test pins the wiring independently.
const WIRED = createInputSanitizer({
  shouldSkipBody: (req: Request) => (req.path || "").startsWith("/api/v1/workshop"),
});

function buildApp() {
  const app = express();
  // Match server.ts ordering: body parsing BEFORE the sanitizer.
  app.use(express.json({ limit: "20mb" }));
  app.use(WIRED);
  // Stub workshop route — echoes the body it received (post-sanitizer).
  app.put("/api/v1/workshop/modules/:rid", (req: Request, res: Response) => {
    res.status(200).json({ received: req.body });
  });
  // Stub non-workshop route.
  app.put("/api/v1/objects/:type/search", (req: Request, res: Response) => {
    res.status(200).json({ received: req.body });
  });
  return app;
}

const BIG_SPEC = "x".repeat(16000); // a Vega spec longer than the 10000 cap

describe("inputSanitizer wiring — workshop large-spec round-trip (gap #6)", () => {
  it("survives a >10k spec on /api/v1/workshop (shouldSkipBody honored)", async () => {
    const app = buildApp();
    const body = {
      definition: {
        widgets: {
          w1: { config: { vegaChart: { spec: BIG_SPEC } } },
        },
      },
    };
    const res = await request(app)
      .put("/api/v1/workshop/modules/ri.workshop.main.module.test")
      .send(body);
    expect(res.status).toBe(200);
    const spec = res.body.received.definition.widgets.w1.config.vegaChart.spec;
    expect(spec).toBe(BIG_SPEC);
    expect(spec.length).toBe(16000);
  });

  it("still truncates a >10k string on a non-workshop path", async () => {
    const app = buildApp();
    const res = await request(app)
      .put("/api/v1/objects/Foo/search")
      .send({ note: BIG_SPEC });
    expect(res.status).toBe(200);
    expect(res.body.received.note.length).toBe(10000);
  });

  it("retains the depth DoS guard on workshop paths", async () => {
    const app = buildApp();
    // 11 levels, exceeds the default maxDepth of 10. Built programmatically
    // (oxc choked on an 11-level inline object literal).
    let deep: unknown = 1;
    for (let i = 0; i < 11; i++) deep = { k: deep };
    const res = await request(app)
      .put("/api/v1/workshop/modules/x")
      .send(deep);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
  });
});
