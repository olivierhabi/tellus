// F9 — Duplicate webhook systems (3 systems documentation).
//
// Documents the F9 finding: there are 3 separate webhook/notification
// systems in the codebase:
//   A. Canonical connectivity webhooks (ri.magritte.main.webhook.*)
//      — POST /connections/:rid/webhooks, POST /webhooks/:rid/execute
//   B. Legacy action side-effects (action_side_effect_job + sideEffectWorker)
//      — durable outbox for action-type side-effects
//   C. Inline-URL writeback (writebackExecutor direct HTTP)
//      — synchronous pre-commit writeback in actionExecutor
//
// Verifies by:
//   1. Probing the canonical webhook endpoints (System A).
//   2. Checking for the side-effect worker + job table (System B).
//   3. Checking for the writeback executor (System C).
//   4. Confirming all 3 exist simultaneously (the duplication hazard).

import { getApiContext, assert } from "./harness.js";
import * as fs from "node:fs";
import * as path from "node:path";

async function main(): Promise<void> {
  const ctx = await getApiContext("admin");
  console.log(`[F9] logged in as ${ctx.username}`);

  let systemsFound = 0;

  // System A — Canonical connectivity webhooks.
  const webhooks = await ctx.api("/api/v1/connectivity/connections?pageSize=1");
  assert(webhooks.status === 200, "System A: connections endpoint should work");
  const hasWebhookRoutes = fs.existsSync(
    path.resolve("src/services/connectivity/webhooks/handlers.ts"),
  );
  assert(hasWebhookRoutes, "System A: webhooks handler should exist");
  console.log(`[F9] System A (canonical webhooks): handlers.ts exists ✓`);
  systemsFound++;

  // System B — Legacy action side-effects.
  const hasSideEffectWorker = fs.existsSync(
    path.resolve("src/services/workers/sideEffectWorker.ts"),
  );
  const hasSideEffectJob = fs.existsSync(
    path.resolve("src/models/actionSideEffectJob.ts"),
  );
  assert(
    hasSideEffectWorker || hasSideEffectJob,
    "System B: side-effect worker or job model should exist",
  );
  console.log(
    `[F9] System B (action side-effects): worker=${hasSideEffectWorker} job=${hasSideEffectJob} ✓`,
  );
  systemsFound++;

  // System C — Inline-URL writeback.
  const hasWritebackExecutor = fs.existsSync(
    path.resolve("src/actions/writebackExecutor.ts"),
  );
  assert(
    hasWritebackExecutor,
    "System C: writebackExecutor should exist",
  );
  // Verify it does direct HTTP (not going through System A or B).
  if (hasWritebackExecutor) {
    const src = fs.readFileSync(
      path.resolve("src/actions/writebackExecutor.ts"),
      "utf8",
    );
    const hasDirectHttp = /httpsRequest|httpRequest|https\.request|http\.request|httpRequestFn|HttpRequestFn/.test(src);
    assert(
      hasDirectHttp,
      "System C: writebackExecutor should do direct HTTP (not via webhook system)",
    );
    console.log(`[F9] System C (inline-URL writeback): writebackExecutor.ts direct HTTP ✓`);
  }
  systemsFound++;

  // Confirm all 3 exist simultaneously.
  assert(
    systemsFound === 3,
    `all 3 webhook systems should exist; found ${systemsFound}`,
  );
  console.log(`[F9] all ${systemsFound} webhook systems exist simultaneously`);

  // Check for the action side-effect path (System A used by actions).
  const hasActionExecutor = fs.existsSync(
    path.resolve("src/actions/actionExecutor.ts"),
  );
  if (hasActionExecutor) {
    const src = fs.readFileSync(
      path.resolve("src/actions/actionExecutor.ts"),
      "utf8",
    );
    const usesWebhookSystem = /connectivity.*webhook|webhookRid|executeWebhook/.test(src);
    const usesWriteback = /writeback/.test(src);
    const usesSideEffect = /sideEffect|side_effect/.test(src);
    console.log(
      `[F9] actionExecutor references: webhookSystem=${usesWebhookSystem} writeback=${usesWriteback} sideEffect=${usesSideEffect}`,
    );
  }

  console.log("[F9] FINDING DOCUMENTED (3 duplicate webhook systems, fix pending)");
}

main().catch((e) => {
  console.error("[F9] FAILED:", e);
  process.exit(1);
});
