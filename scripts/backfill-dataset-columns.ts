#!/usr/bin/env tsx
/**
 * backfill-dataset-columns.ts
 *
 * Find every `foundry_datasets` row whose `column_count` does not match
 * the row count in `dataset_columns` and re-run `runParseJob` to rebuild
 * the column listing.
 *
 * Why this exists
 * ---------------
 * Two failure modes leave the two tables out of sync:
 *
 *   1. Pre-`sanitizeCsvHeader` ingestions — `csv-parse`'s `columns: true`
 *      mode collapsed duplicate / blank header cells into one record
 *      key, so the inserted `dataset_columns` rows were a strict subset
 *      of `foundry_datasets.column_count`. The ingestion fix shipped
 *      with `src/utils/csvHeader.ts:1-142`; every CSV-reading call site
 *      now routes through it.
 *
 *   2. Non-atomic parse jobs — the original `parseDatasetJob` wrote
 *      `foundry_datasets.column_count` and `dataset_columns` outside a
 *      transaction, so a mid-run failure could leave the two writes
 *      partial. `parseDatasetJob.ts:30-152` is now a single-transaction
 *      wipe-and-rewrite, but rows from before that fix need this script.
 *
 * Effect on the user-visible bug
 * ------------------------------
 *   - Node card reads `foundry_datasets.column_count`
 *     (`src/services/pipelineService.ts:319`).
 *   - Transform / Cast panel reads `dataset_columns`
 *     (`src/services/transformService.ts:1890-1898`).
 * When the two diverge the UI shows two different numbers for the same
 * dataset and downstream transforms operate on a partial schema. After
 * this script runs both surfaces agree.
 *
 * Usage
 *   tsx scripts/backfill-dataset-columns.ts                   # repair every divergent dataset
 *   tsx scripts/backfill-dataset-columns.ts --dry-run         # report only
 *   tsx scripts/backfill-dataset-columns.ts <datasetId>…      # repair specific ids
 *   tsx scripts/backfill-dataset-columns.ts --concurrency=4   # parallelism (default 2)
 *
 * Exit codes
 *   0 — every targeted dataset is now consistent
 *   1 — one or more re-parses failed (details on stderr)
 *
 * Production hardening
 *   - Bounded concurrency (default 2) so pg pool and S3 are not
 *     starved when the script sweeps thousands of dirty rows.
 *   - pg_advisory_lock per dataset_id so two operators / cron jobs can
 *     never reparse the same row simultaneously.
 *   - Exponential backoff (500ms · 2^attempt) on transient S3 / DB
 *     faults; 3 attempts per dataset.
 *   - Post-repair re-query confirms convergence; non-zero exit if any
 *     row still diverges so CI does not green a partial run.
 *   - Idempotent — `runParseJob` is transactional; re-running converges.
 */

import foundryDb from "../src/config/foundryDb";
import { runParseJob } from "../src/jobs/parseDatasetJob";

interface Divergent {
  id: string;
  original_filename: string | null;
  meta_count: number;
  actual_count: number;
  status: string;
}

interface CliFlags {
  dryRun: boolean;
  concurrency: number;
  ids: string[];
}

function parseFlags(argv: string[]): CliFlags {
  let dryRun = false;
  let concurrency = 2;
  const ids: string[] = [];
  for (const a of argv) {
    if (a === "--dry-run") dryRun = true;
    else if (a.startsWith("--concurrency=")) {
      concurrency = Math.max(1, Math.min(16, Number(a.split("=")[1]) || 2));
    } else if (a.startsWith("--")) {
      throw new Error(`unknown flag: ${a}`);
    } else {
      ids.push(a);
    }
  }
  return { dryRun, concurrency, ids };
}

async function findDivergent(targetIds: string[]): Promise<Divergent[]> {
  // Single query — the correlated count is cheap because
  // `dataset_columns(dataset_id)` is indexed.
  const q = foundryDb<Divergent>("foundry_datasets as fd")
    .whereNotNull("fd.column_count")
    .select(
      "fd.id",
      "fd.original_filename",
      foundryDb.raw("fd.column_count::int AS meta_count"),
      foundryDb.raw(
        "(SELECT count(*)::int FROM dataset_columns dc WHERE dc.dataset_id = fd.id) AS actual_count",
      ),
      "fd.status",
    );

  if (targetIds.length > 0) {
    q.whereIn("fd.id", targetIds);
  } else {
    q.whereRaw(
      "fd.column_count <> (SELECT count(*) FROM dataset_columns dc WHERE dc.dataset_id = fd.id)",
    );
  }

  const rows = await q;
  // Explicit-ID mode may include already-consistent rows; filter here so
  // operators can paste any set of IDs without ceremony.
  return rows.filter((r) => Number(r.meta_count) !== Number(r.actual_count));
}

function fmt(r: Divergent): string {
  return `  ${r.id}  meta=${r.meta_count} actual=${r.actual_count} status=${r.status}  ${r.original_filename ?? ""}`;
}

async function reparseWithRetry(id: string, maxAttempts = 3): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await runParseJob(id);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
      }
    }
  }
  throw lastErr;
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) return;
        await worker(items[idx]);
      }
    },
  );
  await Promise.all(runners);
}

async function main() {
  const { dryRun, concurrency, ids } = parseFlags(process.argv.slice(2));
  const startedAt = Date.now();

  const divergent = await findDivergent(ids);
  if (divergent.length === 0) {
    console.log("[backfill-dataset-columns] no divergent datasets found.");
    await foundryDb.destroy();
    return;
  }

  console.log(
    `[backfill-dataset-columns] ${divergent.length} divergent dataset(s) ` +
      `(concurrency=${concurrency}${dryRun ? ", dry-run" : ""}):`,
  );
  divergent.forEach((r) => console.log(fmt(r)));

  if (dryRun) {
    console.log("\n[backfill-dataset-columns] --dry-run set; no writes performed.");
    await foundryDb.destroy();
    return;
  }

  const failures: Array<{ id: string; err: string }> = [];

  await runPool(divergent, concurrency, async (r) => {
    // Per-dataset advisory lock so two operators / cron jobs cannot
    // reparse the same dataset_id concurrently. Lock key is a stable
    // bigint derived from the UUID via Postgres hashtext.
    const lockResult = await foundryDb.raw(
      "SELECT pg_try_advisory_lock(hashtext(?)::bigint) AS locked",
      [r.id],
    );
    if (!lockResult.rows?.[0]?.locked) {
      console.log(`  ${r.id} … skipped (another operator holds the lock)`);
      return;
    }
    try {
      process.stdout.write(`  ${r.id} … `);
      await reparseWithRetry(r.id);
      const [post] = await findDivergent([r.id]);
      if (!post) {
        console.log("ok");
      } else {
        failures.push({
          id: r.id,
          err: `still divergent post-reparse: meta=${post.meta_count} actual=${post.actual_count}`,
        });
        console.log(failures[failures.length - 1].err);
      }
    } catch (err) {
      const msg = (err as Error).message;
      failures.push({ id: r.id, err: msg });
      console.log(`FAILED: ${msg}`);
    } finally {
      await foundryDb.raw(
        "SELECT pg_advisory_unlock(hashtext(?)::bigint)",
        [r.id],
      );
    }
  });

  const elapsedMs = Date.now() - startedAt;
  await foundryDb.destroy();

  if (failures.length > 0) {
    console.error(
      `\n[backfill-dataset-columns] ${failures.length}/${divergent.length} failed in ${elapsedMs}ms`,
    );
    failures.forEach((f) => console.error(`  ${f.id}: ${f.err}`));
    process.exit(1);
  }
  console.log(
    `\n[backfill-dataset-columns] repaired ${divergent.length} dataset(s) in ${elapsedMs}ms.`,
  );
}

main().catch((err) => {
  console.error("[backfill-dataset-columns] fatal:", err);
  process.exit(1);
});
