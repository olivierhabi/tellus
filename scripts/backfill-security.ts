#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// backfill-security.ts — stamp `_security.markings: ['PUBLIC']` on every
// document that predates the Phase A4 (F-03) remediation.
// ---------------------------------------------------------------------------
//
// Purpose: after the public-leak branch was removed from
// `buildSecurityFilter` (middleware/securityContext.ts), documents without
// `_security.markings` become invisible to marking-constrained users. This
// script is the one-time migration that stamps the default `['PUBLIC']`
// classification on every existing document so the legacy data remains
// visible under the stricter filter.
//
// Idempotent: re-running the script is a no-op for docs that already have
// `_security.markings`. The `ctx._security` existence check inside the
// painless script ensures we never overwrite an existing classification.
//
// Usage:
//   tsx scripts/backfill-security.ts            # backfill all ontology-* indices
//   tsx scripts/backfill-security.ts <index>    # backfill a single index
//
// Exits 0 on success, 1 on any failure. Emits progress to stderr and the
// list of modified indices + doc counts to stdout (for chaining into a
// migration ledger update).
// ---------------------------------------------------------------------------

import { client } from "../src/services/opensearch/client";
import { DEFAULT_MARKING } from "../src/services/security/documentSecurity";

interface BackfillResult {
  index: string;
  updated: number;
  noop: number;
  failures: number;
}

async function backfillIndex(indexName: string): Promise<BackfillResult> {
  // Update-by-query with a Painless script that idempotently sets
  // `_security.markings` to `['PUBLIC']` for any doc that lacks it.
  // `conflicts: "proceed"` lets the script run to completion even if
  // concurrent writers touch the same docs.
  const script = `
    if (ctx._source._security == null) {
      ctx._source._security = ['markings': params.defaultMarkings, 'cbac': []];
    } else if (ctx._source._security.markings == null || ctx._source._security.markings.size() == 0) {
      ctx._source._security.markings = params.defaultMarkings;
      if (ctx._source._security.cbac == null) { ctx._source._security.cbac = []; }
    } else {
      ctx.op = 'noop';
    }
  `.trim();

  try {
    const { body } = await client.updateByQuery({
      index: indexName,
      refresh: true,
      conflicts: "proceed",
      body: {
        script: {
          source: script,
          params: { defaultMarkings: [DEFAULT_MARKING] },
        },
        query: { match_all: {} },
      },
    });

    const resp = body as {
      updated?: number;
      noops?: number;
      failures?: Array<{ cause?: { reason?: string } }>;
    };
    return {
      index: indexName,
      updated: resp.updated ?? 0,
      noop: resp.noops ?? 0,
      failures: Array.isArray(resp.failures) ? resp.failures.length : 0,
    };
  } catch (err: any) {
    if (err?.statusCode === 404 || err?.meta?.statusCode === 404) {
      return { index: indexName, updated: 0, noop: 0, failures: 0 };
    }
    throw err;
  }
}

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

  console.error(`[backfill-security] backfilling ${indices.length} indices`);
  const results: BackfillResult[] = [];
  for (const index of indices) {
    const r = await backfillIndex(index);
    results.push(r);
    const tag = r.failures > 0 ? "FAIL" : r.updated > 0 ? "MIG" : "OK";
    console.error(
      `  [${tag}] ${r.index}  updated=${r.updated}  noop=${r.noop}  failures=${r.failures}`,
    );
  }

  const totalUpdated = results.reduce((s, r) => s + r.updated, 0);
  const totalFailures = results.reduce((s, r) => s + r.failures, 0);
  console.log(
    JSON.stringify(
      {
        indices: results.length,
        totalUpdated,
        totalFailures,
        perIndex: results,
      },
      null,
      2,
    ),
  );
  if (totalFailures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[backfill-security] FATAL:", err?.message || err);
  process.exit(1);
});
