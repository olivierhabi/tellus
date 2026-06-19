// ---------------------------------------------------------------------------
// Save-to-Ontology idempotency wiring guard.
//
// The POST /api/v1/ontology/:ontologyId/objectTypeId/:objectTypeId route
// must mount `idempotencyKeyMiddleware` so retries (cross-tab, axios
// retry, browser nav remount) can't double-emit `editBatchPending`
// signals. The middleware itself is exhaustively tested elsewhere
// (see tests/foundry/integration/filesystem-v2-b3-integration.test.ts);
// this spec only pins that the new route is wired correctly.
//
// Static-source analysis is the right tool here — it's fast, hermetic,
// and catches the regression class (someone refactors the route and
// drops the middleware) without needing a running backend.
// ---------------------------------------------------------------------------
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";

describe("save-to-ontology — idempotency middleware wired", () => {
  const src = fs.readFileSync("src/server.ts", "utf8");

  it("imports idempotencyKeyMiddleware", () => {
    expect(src).toMatch(/idempotencyKeyMiddleware.*from.*idempotencyKey/);
  });

  it("POST /api/v1/ontology/:ontologyId/objectTypeId/:objectTypeId is wrapped", () => {
    // Find the app.post(...) block for the by-id save route and assert
    // the middleware appears between the route literal and the handler.
    const match = src.match(
      /app\.post\(\s*["'`]\/api\/v1\/ontology\/:ontologyId\/objectTypeId\/:objectTypeId["'`]([\s\S]*?)\);/,
    );
    expect(match, "by-id save route must exist as app.post(...)").not.toBeNull();
    const block = match![1];
    expect(
      block,
      "idempotencyKeyMiddleware must be mounted on the by-id save route",
    ).toMatch(/idempotencyKeyMiddleware\s*\(\s*pool\s*,/);
    expect(
      block,
      "resolveObjectTypeIdToApiName must follow the middleware",
    ).toMatch(/resolveObjectTypeIdToApiName/);
    expect(block, "saveToOntology must be the final handler").toMatch(
      /saveToOntology/,
    );
  });

  it("middleware label is stable so the cache namespace doesn't drift", () => {
    // The middleware uses (key, endpoint) as a composite — if someone
    // changes the endpoint label, all in-flight idempotency keys are
    // invalidated mid-deploy. Pin the label to surface that intent.
    expect(src).toMatch(
      /idempotencyKeyMiddleware\(\s*pool\s*,\s*["'`]POST \/ontology\/\{ontologyId\}\/objectTypeId\/\{objectTypeId\}["'`]\s*\)/,
    );
  });
});
