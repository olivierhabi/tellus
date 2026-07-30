#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// backfill-security.ts — stamp `_security.markings: ['PUBLIC']` on every
// document that predates the Phase A4 (F-03) remediation. (Gap M: made
// OpenSearch-resilient — bounded retry + DEFER on unavailable, no FATAL on
// a transient outage.)
// ---------------------------------------------------------------------------
//
// Usage:
//   tsx scripts/backfill-security.ts            # backfill all ontology-* indices
//   tsx scripts/backfill-security.ts <index>    # backfill a single index
//
// Exit codes:
//   0 — completed, OR fully DEFERRED because OpenSearch was unavailable
//       (idempotent — the next run retries; no data was lost or written).
//   1 — a FATAL per-index error (script / 4xx-non-404 logic error). NOT
//       retried; surfaces a real defect.
// ---------------------------------------------------------------------------

import { client } from "../src/services/opensearch/client";
import { DEFAULT_MARKING } from "../src/services/security/documentSecurity";
import {
  runSecurityBackfill,
  DEFAULT_BACKFILL_RETRY,
} from "../src/services/opensearch/securityBackfill";

async function listOntologyIndices(): Promise<string[]> {
  try {
    const { body } = await client.cat.indices({ format: "json" } as any);
    const rows = body as Array<{ index: string }>;
    return rows
      .map((r) => r.index)
      .filter((name) => name.startsWith("ontology-") || name.startsWith("object-"));
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  const indices = arg ? [arg] : await listOntologyIndices();

  if (indices.length === 0) {
    console.error("[backfill-security] no ontology indices found — exiting");
    return;
  }

  console.error(`[backfill-security] backfilling ${indices.length} indices (maxAttempts=${DEFAULT_BACKFILL_RETRY.maxAttempts})`);
  const report = await runSecurityBackfill(client, indices, DEFAULT_MARKING, DEFAULT_BACKFILL_RETRY);

  console.log(
    JSON.stringify(
      {
        indices: report.indices,
        totalUpdated: report.totalUpdated,
        totalFailures: report.totalFailures,
        deferred: report.deferred,
        fatal: report.fatal,
        perIndex: report.perIndex,
      },
      null,
      2,
    ),
  );

  if (report.fatal > 0) {
    console.error(`[backfill-security] FATAL: ${report.fatal} index(es) had unrecoverable errors`);
    process.exit(1);
  }
  if (report.deferred > 0) {
    console.error(
      `[backfill-security] DEFERRED: ${report.deferred} index(es) skipped — OpenSearch unavailable. ` +
        "Idempotent: the next run retries. No data was written or lost.",
    );
    // Exit 0: a transient OpenSearch outage does not fail the migration or
    // block startup (§17). The backfill is idempotent and self-healing.
    process.exit(0);
  }
  if (report.totalFailures > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  // A top-level fatal (e.g. listOntologyIndices threw an unexpected error).
  console.error("[backfill-security] FATAL:", err?.message || err);
  process.exit(1);
});
