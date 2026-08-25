// ---------------------------------------------------------------------------
// Controlled Webhook Test Service — long-lived CLI entry for E2E/Cypress and
// the integration globalSetup. Kept out of src/ (test-only) so it is never
// bundled into production. Started automatically by tests/globalSetup.ts
// during `vitest run` and by the Cypress orchestration; no developer step.
//
//   PORT = CONTROLLED_WEBHOOK_PORT (default 3329)
//   binds 127.0.0.1, advertises http://localhost:<port>
// ---------------------------------------------------------------------------

import { startControlledWebhookServerCli } from "../../src/services/testing/controlledWebhookServer";

startControlledWebhookServerCli().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("[controlled-webhook] failed to start:", e);
  process.exit(1);
});
