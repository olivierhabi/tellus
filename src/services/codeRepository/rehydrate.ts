// ---------------------------------------------------------------------------
// B2 — Boot-time in-memory Stemma rehydrator.
//
// Purpose. The in-memory `StemmaAdapter` test-double is process-local. When
// the backend restarts, every `code_repository` row in Postgres still
// resolves at the metadata layer (auth, list, get) but its branches and
// files are gone. The frontend then 404s on `GET /tree` and `GET /files`
// against existing RIDs, which looks like data loss to the user.
//
// This module re-injects every ACTIVE `code_repository` row into the
// in-memory adapter at startup so the read paths line up. It is a
// development-mode crutch that:
//
//   • Hard-rejects against any non-`InMemoryStemma` adapter — production
//     swaps in a real Stemma client whose persistence is authoritative,
//     and we MUST NOT accidentally write into it from Postgres metadata.
//   • Is idempotent — re-running over already-seeded RIDs is a no-op.
//   • Is best-effort — a single row failure logs and continues; it does
//     not block server start.
//
// When the real B1 Stemma server lands (with persistent ref + object
// storage), this module's only correct production behaviour is to log the
// "skipped" path and exit.
// ---------------------------------------------------------------------------

import type { Pool } from "pg";

import { InMemoryStemma } from "./adapters/inMemory";
import type { StemmaAdapter } from "./adapters/types";

export interface RehydrateInMemoryStemmaArgs {
  readonly pool: Pool;
  readonly stemma: StemmaAdapter;
  /**
   * Optional structured logger. Receives `(event, meta)` so callers can
   * pipe through pino/winston/etc. Defaults to a no-op (intentional — the
   * server's request logger handles ordinary lifecycle).
   */
  readonly logger?: (event: string, meta?: Record<string, unknown>) => void;
}

export interface RehydrateInMemoryStemmaResult {
  /** True when the adapter is the in-memory test-double; false otherwise. */
  readonly applied: boolean;
  /** Number of RIDs newly injected into the in-memory adapter. */
  readonly rehydrated: number;
  /** Number of RIDs already present in the adapter (idempotent skip). */
  readonly skipped: number;
  /** Number of RIDs whose seed call returned non-ok. */
  readonly failed: number;
  /** Total ACTIVE rows scanned. */
  readonly total: number;
}

/**
 * Rehydrate the in-memory Stemma adapter from Postgres `code_repository` rows.
 *
 * Returns immediately (with `applied: false`) if `stemma` is not an
 * `InMemoryStemma`. Errors during the scan/insert loop are logged via the
 * provided `logger` and counted in `failed`; they do not throw.
 */
export async function rehydrateInMemoryStemma(
  args: RehydrateInMemoryStemmaArgs,
): Promise<RehydrateInMemoryStemmaResult> {
  const log = args.logger ?? (() => {});

  // ---------------------------------------------------------------------
  // Production guard. Only the in-memory adapter accepts arbitrary
  // re-seeding. A real Stemma client persists its own state and must not
  // be poked from this metadata-driven loop.
  // ---------------------------------------------------------------------
  if (!(args.stemma instanceof InMemoryStemma)) {
    log("code-repos.rehydrate.skip-real-adapter");
    return { applied: false, rehydrated: 0, skipped: 0, failed: 0, total: 0 };
  }

  type Row = { rid: string; default_branch: string; created_by: string };
  let rows: ReadonlyArray<Row>;
  try {
    const r = await args.pool.query<Row>(
      `SELECT rid, default_branch, created_by
         FROM code_repository
        WHERE state = 'ACTIVE'`,
    );
    rows = r.rows;
  } catch (err) {
    log("code-repos.rehydrate.scan-failed", {
      message: (err as Error).message,
    });
    return { applied: true, rehydrated: 0, skipped: 0, failed: 0, total: 0 };
  }

  let rehydrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    if (args.stemma.exists(row.rid)) {
      skipped += 1;
      continue;
    }
    try {
      const out = await args.stemma.createRepository({
        proposedRid: row.rid,
        defaultBranchName: row.default_branch,
        principalSub: row.created_by,
      });
      if (out.kind === "ok") {
        rehydrated += 1;
        log("code-repos.rehydrate.seeded", {
          rid: row.rid,
          branch: row.default_branch,
        });
      } else {
        failed += 1;
        log("code-repos.rehydrate.seed-non-ok", {
          rid: row.rid,
          kind: out.kind,
        });
      }
    } catch (err) {
      failed += 1;
      log("code-repos.rehydrate.seed-threw", {
        rid: row.rid,
        message: (err as Error).message,
      });
    }
  }

  log("code-repos.rehydrate.done", {
    total: rows.length,
    rehydrated,
    skipped,
    failed,
  });

  return { applied: true, rehydrated, skipped, failed, total: rows.length };
}
